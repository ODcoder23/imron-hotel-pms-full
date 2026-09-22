/**
 * Xato boshqaruvi
 *
 * Manba: 02-DATABASE-SXEMA.md §2 — constraint xatosi (23P01) foydalanuvchi
 * tushunadigan xabarga aylantiriladi. Shaxmatkadagi mavjud `conflictMsg`
 * mexanizmi shu xabarni ko'rsatadi.
 */

import type { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** 409 — xona band (overbooking himoyasi ishga tushdi) */
export class RoomUnavailableError extends AppError {
  constructor(msg = "Bu xona ushbu sanalar uchun band.") {
    super(409, msg, "ROOM_UNAVAILABLE");
  }
}

/** 404 */
export class NotFoundError extends AppError {
  constructor(what: string) {
    super(404, `${what} topilmadi.`, "NOT_FOUND");
  }
}

/** 400 */
export class ValidationError extends AppError {
  constructor(msg: string) {
    super(400, msg, "VALIDATION");
  }
}

/**
 * PostgreSQL xato kodlarini AppError'ga aylantiradi.
 *
 * 23P01 — exclusion_violation: reservation_no_overlap constraint.
 *         TZ 3-bandning DB darajasidagi himoyasi ishga tushdi.
 * P2002 — Prisma unique constraint (TZ 9-band duplicate himoyasi).
 * P2025 — yozuv topilmadi.
 */
export function translatePrismaError(e: unknown): AppError | null {
  // Raw SQL constraint (EXCLUDE) — Prisma uni P2010 ichida beradi
  const raw = String(e);
  if (raw.includes("reservation_no_overlap") || raw.includes("23P01")) {
    return new RoomUnavailableError();
  }

  // P2034 / 40001 — serializatsiya konflikti.
  // Bu XATO EMAS: ikki tranzaksiya bir vaqtda bir xil ma'lumotga
  // tegdi va PostgreSQL birini bekor qildi. Qayta urinish kerak.
  // Bu yerga yetib kelsa — retry tugagan, demak haqiqiy to'qnashuv.
  if (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034" ||
    raw.includes("40001") ||
    raw.includes("could not serialize")
  ) {
    return new AppError(
      409,
      "Bir vaqtda bir nechta so'rov keldi. Qayta urinib ko'ring.",
      "CONCURRENT_CONFLICT"
    );
  }

  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002") {
      const fields = (e.meta?.target as string[] | undefined)?.join(", ") ?? "";
      if (fields.includes("externalReservationId")) {
        // TZ 9-band: bu xato emas, "aslida update" signali
        return new AppError(409, "Bu bron allaqachon mavjud.", "DUPLICATE_RESERVATION");
      }
      return new AppError(409, `Takrorlanuvchi qiymat: ${fields}`, "DUPLICATE");
    }
    if (e.code === "P2025") {
      return new NotFoundError("Yozuv");
    }
    if (e.code === "P2003") {
      return new ValidationError("Bog'liq yozuv topilmadi (foreign key).");
    }
  }

  return null;
}

/** Express xato handler — oxirgi middleware */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  /**
   * Buzilgan JSON — `express.json()` tashlaydi.
   *
   * Bu KLIENT xatosi, server nosozligi emas: 500 qaytarish
   * monitoring signalini buzadi (haqiqiy nosozlik ko'rinmay qoladi)
   * va klientga "qayta urinib ko'ring" degan noto'g'ri maslahat
   * beradi.
   */
  if (
    err instanceof SyntaxError &&
    "status" in err &&
    (err as { status?: number }).status === 400 &&
    "body" in err
  ) {
    res.status(400).json({
      error: "So'rov tanasi noto'g'ri (JSON kutilgan).",
      code: "BAD_JSON",
    });
    return;
  }

  /**
   * Zod validatsiya xatosi — bu ham KLIENT xatosi.
   *
   * Ko'p marshrut `parse()` yordamchisi orqali o'zi ushlaydi, lekin
   * `schema.parse()` to'g'ridan-to'g'ri chaqirilgan joylarda xato
   * shu yerga kelardi va 500 bo'lib chiqardi ("Serverda kutilmagan
   * xato") — aslida foydalanuvchi noto'g'ri qiymat yuborgan.
   *
   * Xabar shakli `parse()` bilan bir xil: "maydon: sabab".
   */
  if (err instanceof ZodError) {
    res.status(400).json({
      error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      code: "VALIDATION",
    });
    return;
  }

  const translated = err instanceof AppError ? err : translatePrismaError(err);

  if (translated) {
    res.status(translated.status).json({
      error: translated.message,
      code: translated.code,
    });
    return;
  }

  // Kutilmagan xato — to'liq log, foydalanuvchiga umumiy xabar
  console.error("[XATO]", err);
  res.status(500).json({
    error: "Serverda kutilmagan xato yuz berdi.",
    code: "INTERNAL",
  });
}

/**
 * Route handler ichida ishlatiladigan so'rov tipi.
 *
 * Express 5 da `req.params` qiymati `string | string[]` — bu wildcard
 * marshrutlar uchun. Bizda ularga ehtiyoj yo'q, shuning uchun
 * `params` ni `string` deb aniqlaymiz. Bitta joyda, har route'da emas.
 */
export type Req = Omit<Request, "params" | "query"> & {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
};

/** async route handler'larni o'raydi — try/catch takrorlanmasin */
export const asyncHandler =
  (fn: (req: Req, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req as unknown as Req, res, next).catch(next);
  };
