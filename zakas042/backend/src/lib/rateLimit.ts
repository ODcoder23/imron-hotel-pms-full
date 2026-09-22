/**
 * Rate limiting — TZ 18-band (6-talab)
 *
 * Manba: 10-SECURITY-VA-SYNCLOG.md §7
 *
 * MUHIM FARQ: bu BIZNING himoyamiz — tashqi hujumdan. Beds24'ning
 * bizga qo'ygan kredit cheklovi butunlay boshqa narsa va
 * `services/beds24/client.ts` da boshqariladi (03-fayl §3).
 * Ikkalasini aralashtirmaslik kerak.
 *
 * Cheklovlar (10-fayl §7 jadvali):
 *   webhook        100/daqiqa   tashqi hujumdan
 *   login          5/daqiqa     brute-force
 *   public GET     30/daqiqa    scraping
 *   public POST    5/soat       spam bron
 *   ichki API      300/daqiqa   yumshoq
 */

import rateLimit, { type Options } from "express-rate-limit";
import { config } from "./config.js";

/**
 * Umumiy sozlama.
 *
 * `standardHeaders` — RFC qoidasiga mos `RateLimit-*` sarlavhalari,
 * klient qachon qayta urinishni biladi.
 *
 * TEST MUHITIDA O'CHIRILADI: testlar o'nlab so'rov yuboradi va
 * cheklovga urilib qolishi mumkin — bu tekshirilayotgan xatti-
 * harakat emas. Rate limit'ning o'zi alohida test bilan sinaladi.
 */
const base: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.rateLimitDisabled,
  message: { error: "So'rovlar juda tez-tez. Birozdan keyin urinib ko'ring.", code: "RATE_LIMITED" },
};

/** Webhook — tashqi, eng katta hujum yuzasi */
export const webhookLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 100,
});

/**
 * Login — brute-force himoyasi.
 *
 * 5/daqiqa qat'iy ko'rinadi, lekin haqiqiy foydalanuvchi parolni
 * 5 marta xato kiritmaydi. Hujumchi uchun esa bu soatiga 300
 * urinish — parol lug'ati bilan ishlash imkonsiz.
 */
export const loginLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 5,
  // Muvaffaqiyatli kirish hisobga olinmaydi — xodim ishlashda
  // davom etaveradi
  skipSuccessfulRequests: true,
});

/** Public API o'qish — scraping himoyasi (FAZA 13) */
export const publicReadLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 30,
});

/** Public API bron — spam himoyasi (FAZA 13) */
export const publicWriteLimiter = rateLimit({
  ...base,
  windowMs: 3_600_000,
  limit: 5,
});

/** Ichki API — yumshoq, faqat noto'g'ri sozlangan klientdan himoya */
export const internalLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 300,
});
