/** Prisma klient — yagona instansiya (connection pool tejash) */
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],

  /**
   * Transaction chegaralari.
   *
   * MUAMMO (2026-09-17): baza SSH tunnel orqali kelganda har
   * so'rov ~700 ms oladi. `confirmReservation()` ichida 4-5
   * so'rov bor va Prisma standart 5 soniyalik chegarasiga
   * urilardi — `P2028 Transaction not found`.
   *
   * `maxWait`  — transaction boshlanishini kutish
   * `timeout`  — transaction ichida ishlash vaqti
   *
   * Mahalliy bazada bu chegaralar sezilmaydi. Production'da
   * server bilan baza bir joyda bo'ladi va kechikish yo'qoladi,
   * lekin katta oraliqni yopish uchun qoldirish zarar qilmaydi.
   */
  transactionOptions: {
    maxWait: 15_000,
    timeout: 30_000,
  },
});
