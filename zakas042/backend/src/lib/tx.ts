/**
 * Tranzaksiya yordamchisi — serializatsiya konfliktida qayta urinish
 *
 * Manba: 07-AVAILABILITY-VA-RATES-SYNC.md §5 — uch qatlamli himoya
 *
 * MUAMMO. `Serializable` izolyatsiya darajasi overbooking'ni to'xtatish
 * uchun kerak, lekin u haddan tashqari keng ham ishlaydi: ikki turli
 * xonaga parallel bron kelsa, ikkalasi ham bir room type'ning
 * `Availability` yozuvlariga tegadi va PostgreSQL birini
 * `40001 could not serialize access` xatosi bilan bekor qiladi.
 *
 * Bu HAQIQIY to'qnashuv emas — shunchaki ikki tranzaksiya bir vaqtda
 * bir xil sahifaga tegdi. To'g'ri javob: qayta urinish, rad etish emas.
 *
 * FARQ MUHIM:
 *   40001 / P2034  → qayta urinish (tasodifiy to'qnashuv)
 *   23P01          → RAD ETISH (haqiqiy overbooking urinishi)
 *
 * Ikkinchisiga hech qachon qayta urinilmaydi — u TZ 3-bandning
 * himoyasi va u ishga tushsa, demak xona haqiqatan band.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 15;

/** Serializatsiya konfliktimi (qayta urinish mumkin)? */
function isSerializationError(e: unknown): boolean {
  // Overbooking constraint — BU QAYTA URINILMAYDI
  const raw = String(e);
  if (raw.includes("reservation_no_overlap") || raw.includes("23P01")) return false;

  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") return true;
  return raw.includes("40001") || raw.includes("could not serialize");
}

/** Kichik tasodifiy kechikish — barcha urinishlar bir vaqtda qaytmasin */
const jitter = (attempt: number): Promise<void> => {
  const ms = BASE_DELAY_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
  return new Promise((r) => setTimeout(r, ms));
};

/**
 * Serializable tranzaksiya + avtomatik qayta urinish.
 *
 * Odatiy holatda 1-urinishda o'tadi. Yuqori yuklamada 2-3 urinish
 * bo'lishi mumkin. 5 urinishdan keyin ham bo'lmasa — haqiqiy
 * muammo, foydalanuvchiga 409 qaytariladi.
 */
export async function serializableTx<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  label = "tx"
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      });
    } catch (e) {
      lastError = e;

      if (!isSerializationError(e)) throw e;   // 23P01 va boshqalar — darhol

      if (attempt < MAX_ATTEMPTS) {
        await jitter(attempt);
        continue;
      }

      console.warn(`[${label}] ${MAX_ATTEMPTS} urinish ham serializatsiya konflikti bilan tugadi`);
    }
  }

  throw lastError;
}
