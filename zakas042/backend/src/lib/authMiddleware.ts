/**
 * JWT va RBAC middleware — TZ 18-band
 *
 * Manba: 10-SECURITY-VA-SYNCLOG.md §1 (3, 4-talab), §3
 *
 * IKKI BOSQICH:
 *   `requireAuth`         — token bormi va haqiqiymi
 *   `requirePermission()` — bu rol shu amalni qila oladimi
 *
 * Ikkisi alohida, chunki ba'zi endpoint'lar faqat kirishni talab
 * qiladi (masalan `/api/auth/me`), huquq tekshiruvi esa yo'q.
 */

import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "@prisma/client";
import { verifyToken, can, type Permission } from "../services/auth.js";
import { config } from "./config.js";
import type { Req } from "./errors.js";

/**
 * Foydalanuvchi qo'shilgan `Request`.
 *
 * `Req` asosida — u Express 5 dagi `params: string | string[]`
 * muammosini bir joyda hal qiladi (errors.ts izohiga qarang).
 */
export type AuthedRequest = Req & {
  user?: { id: string; role: UserRole; email: string };
};

/**
 * Auth majburiymi.
 *
 * DEV MUHITIDA O'CHIRILADI (`AUTH_REQUIRED=false`). Sabab: Shaxmatka
 * hozircha login ekranisiz ishlaydi va FAZA 3 dan beri to'g'ridan-
 * to'g'ri API'ga murojaat qiladi. Production'da har doim yoqilgan
 * bo'lishi kerak — `/health` buni ko'rsatadi.
 *
 * Ishlab chiqarishda `AUTH_REQUIRED=true` qo'yiladi va frontendga
 * login ekrani qo'shiladi (FAZA 15 topshirish ro'yxatida).
 */
export const authRequired = (): boolean => config.authRequired;

/**
 * Token'ni o'qiydi va `req.user` ga yozadi.
 *
 * TOKEN TOPILMASA HAM XATO BERMAYDI — faqat `req.user` bo'sh
 * qoladi. Majburiylikni `requireAuth` hal qiladi. Bu ajratish
 * ixtiyoriy autentifikatsiyali endpoint'lar uchun kerak
 * (public API — FAZA 13).
 */
export function parseAuth(req: Request, _res: Response, next: NextFunction): void {
  const r = req as unknown as AuthedRequest;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const payload = verifyToken(header.slice(7).trim());
    if (payload) {
      r.user = { id: payload.sub, role: payload.role, email: payload.email };
    }
  }
  next();
}

/** Kirish majburiy */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const r = req as unknown as AuthedRequest;

  if (!authRequired()) {
    // Dev rejimi: foydalanuvchi yo'q bo'lsa ADMIN deb qabul qilamiz,
    // shunda RBAC kodi ishlaydi va sinab ko'rish mumkin
    if (!r.user) r.user = { id: "dev", role: "ADMIN", email: "dev@local" };
    next();
    return;
  }

  if (!r.user) {
    res.status(401).json({ error: "Kirish talab qilinadi", code: "UNAUTHORIZED" });
    return;
  }
  next();
}

/**
 * Huquq tekshiruvi (10-fayl §3).
 *
 * `requireAuth` dan KEYIN ishlatiladi — o'zi token tekshirmaydi.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!authRequired()) { next(); return; }

    const r = req as unknown as AuthedRequest;

    if (!r.user) {
      res.status(401).json({ error: "Kirish talab qilinadi", code: "UNAUTHORIZED" });
      return;
    }

    if (!can(r.user.role, permission)) {
      // 403, 404 emas: foydalanuvchi kirgan, faqat huquqi yetmaydi.
      // Amal nomi aytiladi — xodim adminga nima so'rashni biladi.
      res.status(403).json({
        error: `Bu amal uchun huquq yetarli emas: ${permission}`,
        code: "FORBIDDEN",
        required: PERMISSION_LABEL[permission] ?? permission,
      });
      return;
    }
    next();
  };
}

/** Xato xabarida ko'rsatiladigan o'zbekcha nom */
const PERMISSION_LABEL: Partial<Record<Permission, string>> = {
  "channel.connect": "Beds24 ulanishi",
  "mapping.write": "Xona bog'lash",
  "settings.write": "Sozlamalar",
  "user.manage": "Foydalanuvchilar",
  "reservation.write": "Bron o'zgartirish",
  "reservation.cancel": "Bron bekor qilish",
  "rate.write": "Narx belgilash",
  "room.block": "Xona yopish",
  "synclog.read": "Sinxronizatsiya jurnali",
  "checkin.write": "Kirish/chiqish",
  "payment.write": "To'lov",
  "report.read": "Umumiy hisobot",
  "employee.read": "Xodimlar",
  "employee.write": "Xodim qo'shish",
};
