/**
 * Autentifikatsiya endpoint'lari — TZ 18-band
 *
 * Manba: 10-SECURITY-VA-SYNCLOG.md §1 (3-talab), §3, §7
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, ValidationError } from "../lib/errors.js";
import { loginLimiter } from "../lib/rateLimit.js";
import {
  requireAuth,
  requirePermission,
  type AuthedRequest,
} from "../lib/authMiddleware.js";
import { login, createUser, PERMISSIONS, can, type Permission } from "../services/auth.js";
import { audit } from "../services/auditLog.js";
import type { UserRole } from "@prisma/client";

export const authRouter = Router();

// --- POST /api/auth/login -----------------------------------
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", loginLimiter, asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    // Shakl xatosi ham bir xil xabar beradi — qaysi maydon
    // noto'g'ri ekanini aytish hujumchiga yordam beradi
    res.status(401).json({ error: "Email yoki parol noto'g'ri", code: "INVALID_CREDENTIALS" });
    return;
  }

  const result = await login(parsed.data.email, parsed.data.password);

  if (!result.ok) {
    res.status(401).json({ error: result.error, code: "INVALID_CREDENTIALS" });
    return;
  }

  await audit({
    userId: result.user.id,
    action: "user.login",
    entityType: "User",
    entityId: result.user.id,
    ipAddress: req.ip,
  });

  // passwordHash javobda YO'Q (TZ 18-band 1-talab)
  res.json({ token: result.token, user: result.user });
}));

// --- GET /api/auth/me ---------------------------------------
authRouter.get("/me", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: "Kirish talab qilinadi", code: "UNAUTHORIZED" });
    return;
  }

  // Rol o'zgargan bo'lishi mumkin — token'dagi emas, DB'dagi
  // qiymat ishonchli
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, email: true, fullName: true, role: true, isActive: true },
  });

  const role = user?.role ?? req.user.role;

  res.json({
    user: user ?? { id: req.user.id, email: req.user.email, role: req.user.role },
    // Frontend qaysi tugmalarni ko'rsatishni shu ro'yxatdan biladi
    permissions: Object.keys(PERMISSIONS).filter((p) => can(role, p as Permission)),
  });
}));

// --- POST /api/auth/users — foydalanuvchi yaratish ----------
const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Parol kamida 8 belgi"),
  fullName: z.string().min(1),
  role: z.enum(["FOUNDER", "ADMIN", "MANAGER", "STAFF"]),
});

/**
 * Kim kimni boshqara oladi.
 *
 * Hozir `user.manage` faqat FOUNDER'da (2026-09-16 qarori), ya'ni
 * bu yergacha boshqa rol yetib kelmaydi. Funksiya baribir qoldi:
 * ruxsat kengaytirilsa (masalan ADMIN'ga menejer qo'shish huquqi
 * berilsa) ierarxiya shu yerda, bitta joyda boshqariladi.
 *
 * QOIDA: hech kim o'ziga teng yoki yuqori rol bera olmaydi —
 * aks holda har qanday admin o'zini founder qilib qo'yardi.
 */
function canManageRole(actor: UserRole, target: UserRole): boolean {
  if (actor === "FOUNDER") return true;
  if (actor === "ADMIN") return target === "MANAGER" || target === "STAFF";
  return false;
}

authRouter.post(
  "/users",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      );
    }

    // Rol ierarxiyasi: ADMIN o'ziga teng yoki yuqori rol
    // yarata olmaydi
    const actorRole = req.user?.role;
    if (!actorRole || !canManageRole(actorRole, parsed.data.role)) {
      throw new ValidationError(
        `Sizda '${parsed.data.role}' rolidagi foydalanuvchi yaratish huquqi yo'q`
      );
    }

    const exists = await prisma.user.findUnique({
      where: { email: parsed.data.email.toLowerCase().trim() },
    });
    if (exists) throw new ValidationError("Bu email allaqachon ro'yxatdan o'tgan");

    const user = await createUser(parsed.data);

    await audit({
      userId: req.user?.id,
      action: "user.created",
      entityType: "User",
      entityId: user.id,
      after: { email: user.email, role: user.role },
      ipAddress: req.ip,
    });

    res.status(201).json(user);
  })
);

// --- GET /api/auth/users ------------------------------------
authRouter.get(
  "/users",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      // passwordHash tanlanmaydi (TZ 18-band)
      select: { id: true, email: true, fullName: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    res.json(users);
  })
);

// --- PATCH /api/auth/users/:id — rol o'zgartirish -----------
const roleSchema = z.object({
  role: z.enum(["FOUNDER", "ADMIN", "MANAGER", "STAFF"]).optional(),
  isActive: z.boolean().optional(),
});

authRouter.patch(
  "/users/:id",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("role yoki isActive kerak");

    const id = String(req.params.id);
    const before = await prisma.user.findUnique({
      where: { id },
      select: { role: true, isActive: true, email: true },
    });
    if (!before) throw new ValidationError("Foydalanuvchi topilmadi");

    const actorRole = req.user?.role;
    if (!actorRole) throw new ValidationError("Kirish talab qilinadi");

    // --- 1. O'zini o'chirib bo'lmaydi ---
    //
    // Aks holda founder o'zini nofaol qilib, tizimga kira
    // olmay qolardi.
    if (id === req.user?.id && parsed.data.isActive === false) {
      throw new ValidationError("O'zingizni o'chirib bo'lmaydi");
    }

    // --- 2. O'z rolini pasaytirib bo'lmaydi ---
    if (id === req.user?.id && parsed.data.role && parsed.data.role !== before.role) {
      throw new ValidationError("O'z rolingizni o'zgartirib bo'lmaydi");
    }

    // --- 3. Rol ierarxiyasi ---
    //
    // ADMIN boshqa ADMIN yoki FOUNDER bilan ishlay olmaydi.
    // Tekshiruv IKKI tomonlama: hozirgi rol ham, yangi rol ham.
    if (!canManageRole(actorRole, before.role)) {
      throw new ValidationError(
        `Sizda '${before.role}' rolidagi foydalanuvchini o'zgartirish huquqi yo'q`
      );
    }
    if (parsed.data.role && !canManageRole(actorRole, parsed.data.role)) {
      throw new ValidationError(
        `Sizda '${parsed.data.role}' roli berish huquqi yo'q`
      );
    }

    // --- 4. Oxirgi FOUNDER himoyasi ---
    //
    // Founder qolmasa umumiy hisobot va foydalanuvchi boshqaruvi
    // butunlay yopiladi — bazaga qo'lda kirmasdan tuzatib
    // bo'lmaydi.
    const losesFounder =
      before.role === "FOUNDER" &&
      ((parsed.data.role && parsed.data.role !== "FOUNDER") ||
        parsed.data.isActive === false);

    if (losesFounder) {
      const founders = await prisma.user.count({
        where: { role: "FOUNDER", isActive: true },
      });
      if (founders <= 1) {
        throw new ValidationError(
          "Oxirgi FOUNDER — avval boshqa founder tayinlang"
        );
      }
    }

    // --- 5. Oxirgi ADMIN himoyasi ---
    const losesAdmin =
      before.role === "ADMIN" &&
      ((parsed.data.role && parsed.data.role !== "ADMIN") ||
        parsed.data.isActive === false);

    if (losesAdmin) {
      const admins = await prisma.user.count({
        where: { role: "ADMIN", isActive: true },
      });
      if (admins <= 1) {
        throw new ValidationError("Oxirgi ADMIN — avval boshqa admin tayinlang");
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: parsed.data,
      select: { id: true, email: true, fullName: true, role: true, isActive: true },
    });

    await audit({
      userId: req.user?.id,
      action: "user.role_changed",
      entityType: "User",
      entityId: id,
      before,
      after: parsed.data,
      ipAddress: req.ip,
    });

    res.json(user);
  })
);
