/**
 * Xarajatlar — SAVOLLAR.md S14
 *
 * MUAMMO: hisobotda faqat maosh xarajat sifatida hisoblanardi.
 * Kommunal, soliq va ayniqsa OTA komissiyasi (Booking.com 15-18%)
 * hisobga olinmagani uchun foyda haqiqatdan katta ko'rinardi.
 *
 * IKKI MANBA:
 *   1. Qo'lda kiritilgan — kommunal, oziq-ovqat, ta'mir, soliq
 *   2. Avtomatik — OTA komissiyasi, bron manbasidan hisoblanadi
 *
 * Maosh bu yerda EMAS: u `Employee` jadvalidan hisoblanadi
 * (report.ts), chunki oylik summa doimiy va har oy qo'lda
 * kiritish ortiqcha ish bo'lardi.
 */

import { Prisma, type ExpenseCategory } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { getOtaCommissionPercent } from "./settings.js";

/**
 * Qaysi bron manbalari komissiya oladi.
 *
 * Komissiya YO'Q: `DIRECT`, `WEBSITE`, `PHONE`, `WALK_IN` —
 * mehmon to'g'ridan-to'g'ri keladi, vositachi yo'q.
 *
 * Komissiya BOR: OTA (Online Travel Agency) kanallari.
 * `OTHER` bu yerda emas — u noaniq manba, komissiya
 * olinayotganiga ishonch yo'q.
 */
const OTA_SOURCES = ["BOOKING_COM", "AIRBNB", "EXPEDIA"] as const;

export type ExpenseInput = {
  date: string;              // "YYYY-MM-DD"
  category: ExpenseCategory;
  amount: number;
  note?: string;
  userId?: string;
};

/** Sana kalitini UTC yarim tuniga aylantiradi (@db.Date bilan mos) */
function toDate(key: string): Date {
  return new Date(key + "T00:00:00.000Z");
}

// ============================================================
//  Qo'lda kiritish
// ============================================================

/**
 * Xarajat qo'shadi.
 *
 * Summa musbat bo'lishi shart: manfiy xarajat "daromad" degani,
 * u alohida yo'l bilan yoziladi.
 */
export async function addExpense(input: ExpenseInput) {
  if (input.amount <= 0) {
    throw new ValidationError("Xarajat summasi musbat bo'lishi kerak");
  }

  // Foydalanuvchi mavjudligini tekshiramiz: dev rejimida soxta
  // `id: "dev"` keladi va foreign key buzilardi
  const userId = input.userId
    ? (await prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true },
      }))?.id ?? null
    : null;

  return prisma.expense.create({
    data: {
      date: toDate(input.date),
      category: input.category,
      amount: new Prisma.Decimal(input.amount),
      note: input.note?.trim() || null,
      userId,
      isAuto: false,
    },
  });
}

/**
 * Xarajatni o'chiradi.
 *
 * Avtomatik yozuvlarni (komissiya) qo'lda o'chirib bo'lmaydi —
 * ular keyingi hisoblashda qaytadan paydo bo'lardi va
 * foydalanuvchi buni tushunmasdi.
 */
export async function deleteExpense(id: string) {
  const row = await prisma.expense.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Xarajat");

  if (row.isAuto) {
    throw new ValidationError(
      "Avtomatik hisoblangan xarajatni o'chirib bo'lmaydi " +
      "(komissiya foizini sozlamalardan o'zgartiring)"
    );
  }

  return prisma.expense.delete({ where: { id } });
}

/** Davr bo'yicha ro'yxat */
export async function listExpenses(from: Date, toEx: Date) {
  return prisma.expense.findMany({
    where: { date: { gte: from, lt: toEx } },
    include: { user: { select: { fullName: true } } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
  });
}

// ============================================================
//  OTA komissiyasi — avtomatik
// ============================================================

/**
 * Davrdagi OTA komissiyasini qaytadan hisoblaydi.
 *
 * NEGA QAYTA HISOBLASH: bron bekor qilinishi, narxi o'zgarishi
 * yoki komissiya foizi yangilanishi mumkin. Har safar noldan
 * hisoblash eng sodda va eng ishonchli yo'l — oraliq holat
 * saqlanmaydi, demak u eskirib qolmaydi.
 *
 * FAQAT avtomatik yozuvlar o'chiriladi; qo'lda kiritilgan
 * xarajatlarga tegilmaydi.
 */
export async function recalcCommissions(from: Date, toEx: Date): Promise<{
  count: number;
  total: number;
}> {
  const percent = await getOtaCommissionPercent();

  const bookings = await prisma.reservation.findMany({
    where: {
      checkIn: { gte: from, lt: toEx },
      source: { in: [...OTA_SOURCES] as never },
      // Bekor qilingan bron uchun komissiya to'lanmaydi
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
    },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      pricePerNight: true,
      charges: { select: { amount: true } },
    },
  });

  const rows = bookings.map((b) => {
    const nights = Math.max(
      1,
      Math.round((b.checkOut.getTime() - b.checkIn.getTime()) / 86_400_000)
    );
    const chargesTotal = b.charges.reduce((sum, c) => sum + Number(c.amount), 0);
    const revenue = Number(b.pricePerNight) * nights + chargesTotal;

    return {
      date: b.checkIn,
      category: "COMMISSION" as ExpenseCategory,
      amount: new Prisma.Decimal(Math.round((revenue * percent) / 100)),
      note: `${percent}% komissiya`,
      isAuto: true,
      reservationId: b.id,
    };
  });

  // Eski avtomatik yozuvlarni tozalab, yangisini yozamiz
  await prisma.$transaction([
    prisma.expense.deleteMany({
      where: { date: { gte: from, lt: toEx }, isAuto: true, category: "COMMISSION" },
    }),
    ...(rows.length > 0
      ? [prisma.expense.createMany({ data: rows })]
      : []),
  ]);

  return {
    count: rows.length,
    total: rows.reduce((sum, r) => sum + Number(r.amount), 0),
  };
}

// ============================================================
//  Hisobot uchun
// ============================================================

export type ExpenseSummary = {
  total: number;
  byCategory: Array<{ category: ExpenseCategory; amount: number; count: number }>;
};

/**
 * Davr bo'yicha xarajat yig'indisi.
 *
 * Komissiya avval qayta hisoblanadi — hisobot ochilganda eng
 * yangi raqamni ko'rsatsin.
 */
export async function expenseSummary(from: Date, toEx: Date): Promise<ExpenseSummary> {
  await recalcCommissions(from, toEx);

  const grouped = await prisma.expense.groupBy({
    by: ["category"],
    where: { date: { gte: from, lt: toEx } },
    _sum: { amount: true },
    _count: true,
  });

  const byCategory = grouped
    .map((g) => ({
      category: g.category,
      amount: Number(g._sum.amount ?? 0),
      count: g._count,
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    total: byCategory.reduce((sum, c) => sum + c.amount, 0),
    byCategory,
  };
}

/** Kategoriya nomlari — panel va hisobot uchun */
export const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  UTILITIES: "Kommunal",
  FOOD: "Oziq-ovqat",
  MAINTENANCE: "Ta'mir va jihoz",
  TAX: "Soliq",
  MARKETING: "Reklama",
  COMMISSION: "OTA komissiyasi",
  SALARY: "Maosh",
  OTHER: "Boshqa",
};
