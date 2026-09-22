/**
 * Autentifikatsiya va RBAC — TZ 18-band
 *
 * Manba: 10-SECURITY-VA-SYNCLOG.md §1 (3, 4-talab), §3
 *
 * TO'RT ROL (10-fayl §3, FOUNDER 2026-09-16 da qo'shildi):
 *   FOUNDER — egasi: hamma narsa + umumiy hisobot bo'limi
 *   ADMIN   — texnik: ulanish, mapping, sozlamalar, foydalanuvchilar
 *   MANAGER — bron, narx. Beds24 sozlamalariga KIROLMAYDI
 *   STAFF   — check-in/out, to'lov, xona holati. Narxga tegmaydi
 *
 * ISH CHEGARASI (10-fayl §3): mavjud Admin Panel kodiga kirish yo'q,
 * shuning uchun undagi rollar bilan moslik tekshirilmaydi. Backend
 * o'z RBAC tizimini yuritadi.
 */

import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import type { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { config } from "../lib/config.js";

/**
 * Huquqlar jadvali (10-fayl §3).
 *
 * NEGA BITTA JOYDA: har endpoint o'z tekshiruvini yozsa, yangi rol
 * qo'shilganda o'nlab joyni tahrirlash kerak bo'ladi va bittasi
 * esdan chiqsa xavfsizlik teshigi ochiladi.
 */
export const PERMISSIONS = {
  // Umumiy hisobot va moliya ko'rinishi — FAQAT egasi (FOUNDER)
  "report.read":        ["FOUNDER"],
  // Xodimlar kadrlar hisobi — maosh ma'lumoti bor
  "employee.read":      ["FOUNDER", "ADMIN"],
  "employee.write":     ["FOUNDER", "ADMIN"],

  "channel.connect":    ["FOUNDER", "ADMIN"],
  "mapping.write":      ["FOUNDER", "ADMIN"],
  "settings.write":     ["FOUNDER", "ADMIN"],
  // Foydalanuvchi boshqaruvi — FAQAT egasi (2026-09-16 qarori).
  // "Founder adminlarni nazorat qiladi" talabi: admin boshqa
  // adminlarni ko'rmasligi ham, o'zgartirmasligi ham kerak.
  "user.manage":        ["FOUNDER"],
  "reservation.write":  ["FOUNDER", "ADMIN", "MANAGER"],
  "reservation.cancel": ["FOUNDER", "ADMIN", "MANAGER"],
  "rate.write":         ["FOUNDER", "ADMIN", "MANAGER"],
  // Xona/qavat yopish inventarni kamaytiradi va Beds24 orqali barcha
  // OTA kanallariga tarqaladi — qabulxona xodimi uchun emas.
  "room.block":         ["FOUNDER", "ADMIN", "MANAGER"],
  "synclog.read":       ["FOUNDER", "ADMIN", "MANAGER"],
  "checkin.write":      ["FOUNDER", "ADMIN", "MANAGER", "STAFF"],
  "payment.write":      ["FOUNDER", "ADMIN", "MANAGER", "STAFF"],
  "reservation.read":   ["FOUNDER", "ADMIN", "MANAGER", "STAFF"],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: UserRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly UserRole[]).includes(role);
}

// ============================================================
//  Parol
// ============================================================

/**
 * bcrypt cost 10 — hozirgi standart.
 *
 * Kattaroq qiymat xavfsizroq, lekin login sekinlashadi; 10 da
 * ~60ms, bu brute-force uchun qimmat, foydalanuvchi uchun sezilmas.
 */
const BCRYPT_ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  // Seed'dagi placeholder hech qachon mos kelmasligi kerak
  if (!hash || !hash.startsWith("$2")) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}

// ============================================================
//  JWT
// ============================================================

export type TokenPayload = {
  sub: string;          // userId
  role: UserRole;
  email: string;
};

/**
 * JWT yaratadi.
 *
 * Muddat 12 soat — bir ish smenasi. Uzunroq muddat o'g'irlangan
 * token'ning foydali umrini uzaytiradi, qisqaroq esa xodimni ish
 * o'rtasida chiqarib yuboradi.
 */
export function signToken(payload: TokenPayload, expiresIn = "12h"): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    if (typeof decoded === "string") return null;

    const { sub, role, email } = decoded as jwt.JwtPayload & Partial<TokenPayload>;
    if (!sub || !role || !email) return null;

    return { sub: String(sub), role: role as UserRole, email: String(email) };
  } catch {
    // Muddati o'tgan, imzo noto'g'ri, buzilgan — hammasi bir xil
    // natija: kirish yo'q. Sababni aytmaymiz (ma'lumot sizishi).
    return null;
  }
}

// ============================================================
//  Login
// ============================================================

export type LoginResult =
  | { ok: true; token: string; user: { id: string; email: string; fullName: string; role: UserRole } }
  | { ok: false; error: string };

/**
 * Email + parol bilan kirish.
 *
 * MUHIM: foydalanuvchi topilmasa ham, parol noto'g'ri bo'lsa ham
 * BIR XIL xabar qaytariladi. Aks holda hujumchi qaysi email'lar
 * mavjudligini aniqlab oladi.
 */
export async function login(email: string, password: string): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

  if (!user || !user.isActive) {
    // Vaqt hujumidan himoya: foydalanuvchi yo'q bo'lsa ham
    // bcrypt ishlatamiz, javob vaqti bir xil bo'lsin
    await bcrypt.compare(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
    return { ok: false, error: "Email yoki parol noto'g'ri" };
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, error: "Email yoki parol noto'g'ri" };
  }

  return {
    ok: true,
    token: signToken({ sub: user.id, role: user.role, email: user.email }),
    user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
  };
}

/** Foydalanuvchi yaratish (admin qo'lida) */
export async function createUser(input: {
  email: string;
  password: string;
  fullName: string;
  role: UserRole;
}) {
  return prisma.user.create({
    data: {
      email: input.email.toLowerCase().trim(),
      passwordHash: await hashPassword(input.password),
      fullName: input.fullName,
      role: input.role,
    },
    // passwordHash javobga TUSHMAYDI (TZ 18-band 1-talab)
    select: { id: true, email: true, fullName: true, role: true, isActive: true, createdAt: true },
  });
}
