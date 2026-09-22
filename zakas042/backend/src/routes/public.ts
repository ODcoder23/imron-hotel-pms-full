/**
 * Website public API — TZ 3, 20-band (FAZA 13)
 *
 * Manba: 13-WEBSITE-INTEGRATSIYA.md §2, §6
 *
 * ISH CHEGARASI: Customer Website kodiga kirish yo'q. Bu API to'liq
 * yoziladi va test qilinadi, Website'ni ulash scope'dan tashqarida.
 *
 * XAVFSIZLIK (13-fayl §6) — ommaviy endpoint asosiy hujum yuzasi:
 *   - JWT TALAB QILINMAYDI (mijoz ro'yxatdan o'tmagan)
 *   - Rate limiting: qidiruv 30/daqiqa, bron 5/soat
 *   - Honeypot maydon — bot himoyasi
 *   - Javobda hech qachon boshqa mehmonlar ma'lumoti yo'q
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler, ValidationError } from "../lib/errors.js";
import { publicReadLimiter, publicWriteLimiter } from "../lib/rateLimit.js";
import {
  searchAvailability,
  createPublicBooking,
  findByCode,
  listRoomTypes,
} from "../services/publicBooking.js";

export const publicRouter = Router();

// --- GET /api/public/room-types -----------------------------
// Sayt "Xonalar" bo'limi. Sana talab qilinmaydi — vitrina.
publicRouter.get("/room-types", publicReadLimiter, asyncHandler(async (_req, res) => {
  res.json(await listRoomTypes());
}));

// --- GET /api/public/availability ---------------------------
const searchSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from: YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to: YYYY-MM-DD"),
  adults: z.coerce.number().int().min(1).max(20).optional(),
  children: z.coerce.number().int().min(0).max(20).optional(),
});

publicRouter.get("/availability", publicReadLimiter, asyncHandler(async (req, res) => {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }

  res.json(await searchAvailability(parsed.data));
}));

// --- POST /api/public/reservations --------------------------
const bookingSchema = z.object({
  roomTypeId: z.string().min(1),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adults: z.number().int().min(1).max(20),
  children: z.number().int().min(0).max(20).optional(),
  /**
   * Nonushta (SAVOLLAR.md S10).
   *
   * Sayt bu maydonni yubormasa `false` — mehmon ataylab
   * tanlamagan bo'lsa qo'shimcha pul olinmasin.
   */
  withMeal: z.boolean().optional(),
  guest: z.object({
    fullName: z.string().min(2).max(100),
    phone: z.string().min(7).max(20),
    email: z.string().email().optional().or(z.literal("")),
  }),
  notes: z.string().max(500).optional(),

  /**
   * Honeypot (13-fayl §6).
   *
   * Formada ko'rinmas maydon: odam uni to'ldirmaydi, bot esa
   * barcha maydonlarni to'ldiradi. To'ldirilgan bo'lsa — bot.
   *
   * CAPTCHA'dan afzalligi: mijozga qo'shimcha ish yuklamaydi va
   * tashqi xizmatga bog'liq emas.
   */
  website: z.string().max(0).optional(),
});

publicRouter.post("/reservations", publicWriteLimiter, asyncHandler(async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }

  // Honeypot to'ldirilgan — bot. Xato xabari NEYTRAL: bot qaysi
  // maydon ushlaganini bilmasin.
  if (parsed.data.website) {
    throw new ValidationError("So'rovni qayta yuboring");
  }

  const { website: _honeypot, ...input } = parsed.data;

  const result = await createPublicBooking({
    ...input,
    guest: {
      ...input.guest,
      email: input.guest.email || undefined,
    },
  });

  res.status(201).json(result);
}));

// --- GET /api/public/reservations/:code ---------------------
publicRouter.get("/reservations/:code", publicReadLimiter, asyncHandler(async (req, res) => {
  const code = String(req.params.code ?? "");

  // Shakl tekshiruvi: noto'g'ri kodlar DB'ga bormaydi
  if (!/^IMR-[A-Z0-9]{5}$/i.test(code)) {
    res.status(404).json({ error: "Bron topilmadi", code: "NOT_FOUND" });
    return;
  }

  const found = await findByCode(code);
  if (!found) {
    // 404 — kod yo'qligi va kod noto'g'riligi BIR XIL javob beradi,
    // shunda kodlarni taxmin qilib bo'lmaydi
    res.status(404).json({ error: "Bron topilmadi", code: "NOT_FOUND" });
    return;
  }

  res.json(found);
}));
