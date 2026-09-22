/**
 * Umumiy hisobot — faqat FOUNDER uchun
 *
 * Bir joyda butun biznes: bron, moliya, xona, xodim, kanal.
 * `stats.ts` dan FARQI: u kundalik ish uchun (bugungi holat),
 * bu esa davr bo'yicha tahlil (oy, chorak, yil).
 *
 * NEGA ALOHIDA: bu yerda maosh, foyda va xarajat bor — ADMIN
 * texnik ishlarni qiladi, bu raqamlar unga kerak emas
 * (`PERMISSIONS["report.read"] = ["FOUNDER"]`).
 */

import { prisma } from "../lib/prisma.js";
import { toNumber, toDateKey } from "../lib/serialize.js";
import { expenseSummary, CATEGORY_LABEL } from "./expenses.js";

// ============================================================
//  Yordamchi
// ============================================================

const ACTIVE_STATUSES = ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT"] as const;

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function nightsOf(checkIn: Date, checkOut: Date): number {
  return Math.max(1, Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000));
}

// ============================================================
//  Turlar
// ============================================================

export type BookingReport = {
  total: number;
  /** Status bo'yicha: confirmed, checked_in, cancelled... */
  byStatus: Array<{ status: string; count: number }>;
  /** Manba bo'yicha: sayt, Booking.com, telefon... */
  bySource: Array<{ source: string; count: number; revenue: number }>;
  /** Tarif bo'yicha: qaysi xona turi ko'p sotiladi */
  byRoomType: Array<{ typeId: string; label: string; count: number; nights: number; revenue: number }>;
  /** O'rtacha qancha kecha qolishadi */
  avgNights: number;
  /** Bekor qilingan / jami (foizda) */
  cancellationRate: number;
};

export type MoneyReport = {
  roomRevenue: number;
  charges: number;
  totalRevenue: number;
  paid: number;
  debt: number;
  /** Xodimlar oylik maoshi (davr uchun hisoblangan) */
  salaryExpense: number;
  /**
   * Boshqa xarajatlar (SAVOLLAR.md S14): kommunal, oziq-ovqat,
   * soliq, reklama va OTA komissiyasi. Maosh bu yerga KIRMAYDI —
   * u `salaryExpense` da alohida.
   */
  otherExpenses: number;
  /** Xarajat turlari bo'yicha taqsimot */
  expenseBreakdown: Array<{ category: string; label: string; amount: number }>;
  /** salaryExpense + otherExpenses */
  totalExpenses: number;
  /**
   * totalRevenue - totalExpenses
   *
   * DIQQAT: 2026-09-17 gacha bu faqat maoshni ayirardi, shuning
   * uchun foyda haqiqatdan katta ko'rinardi (ayniqsa OTA
   * komissiyasi hisobga olinmagani uchun).
   */
  grossProfit: number;
  /** To'lov usuli bo'yicha: naqd, karta, onlayn */
  byMethod: Array<{ method: string; count: number; amount: number }>;
};

export type OccupancyReport = {
  /** Davrdagi jami (xona × kun) */
  roomNights: number;
  /** Sotilgan (xona × kun) */
  soldNights: number;
  /** Yopiq (ta'mir) */
  blockedNights: number;
  occupancyPercent: number;
  /** O'rtacha kunlik narx — ADR (Average Daily Rate) */
  adr: number;
  /** Mavjud xona boshiga daromad — RevPAR */
  revpar: number;
};

export type StaffReport = {
  total: number;
  active: number;
  /** Lavozim bo'yicha taqsimot */
  byPosition: Array<{ position: string; count: number; salaryTotal: number }>;
  monthlySalary: number;
  /** Tizimga kira oladigan hisoblar */
  systemUsers: Array<{ role: string; count: number }>;
};

export type ChannelReport = {
  /** Beds24 ulangan va mapping to'liqmi */
  connected: boolean;
  mappedTypes: number;
  totalTypes: number;
  /** Davrdagi sync xatolari */
  syncErrors: number;
  /** Ishlanmagan webhook'lar */
  pendingWebhooks: number;
};

export type FullReport = {
  from: string;
  to: string;
  days: number;
  bookings: BookingReport;
  money: MoneyReport;
  occupancy: OccupancyReport;
  staff: StaffReport;
  channel: ChannelReport;
};

// ============================================================
//  1. Bronlar
// ============================================================

async function bookingReport(from: Date, toEx: Date): Promise<BookingReport> {
  const rows = await prisma.reservation.findMany({
    where: { checkIn: { gte: from, lt: toEx } },
    select: {
      status: true, source: true, checkIn: true, checkOut: true,
      pricePerNight: true,
      room: { select: { roomTypeId: true, roomType: { select: { label: true } } } },
      charges: { select: { amount: true } },
    },
  });

  const byStatus = new Map<string, number>();
  const bySource = new Map<string, { count: number; revenue: number }>();
  const byType = new Map<string, { label: string; count: number; nights: number; revenue: number }>();

  let totalNights = 0;
  let cancelled = 0;

  for (const r of rows) {
    const st = r.status.toLowerCase();
    byStatus.set(st, (byStatus.get(st) ?? 0) + 1);
    if (r.status === "CANCELLED") cancelled++;

    // Bekor qilinganlar daromadga kirmaydi, lekin statistikada bor
    if (!ACTIVE_STATUSES.includes(r.status as never)) continue;

    const n = nightsOf(r.checkIn, r.checkOut);
    const rev = toNumber(r.pricePerNight) * n
      + r.charges.reduce((s, c) => s + toNumber(c.amount), 0);

    totalNights += n;

    const src = r.source.toLowerCase();
    const curSrc = bySource.get(src) ?? { count: 0, revenue: 0 };
    bySource.set(src, { count: curSrc.count + 1, revenue: curSrc.revenue + rev });

    const tid = r.room.roomTypeId;
    const curType = byType.get(tid) ?? { label: r.room.roomType.label, count: 0, nights: 0, revenue: 0 };
    byType.set(tid, {
      label: curType.label,
      count: curType.count + 1,
      nights: curType.nights + n,
      revenue: curType.revenue + rev,
    });
  }

  const active = rows.length - cancelled;

  return {
    total: rows.length,
    byStatus: [...byStatus.entries()].map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
    bySource: [...bySource.entries()].map(([source, v]) => ({ source, ...v }))
      .sort((a, b) => b.revenue - a.revenue),
    byRoomType: [...byType.entries()].map(([typeId, v]) => ({ typeId, ...v }))
      .sort((a, b) => b.revenue - a.revenue),
    avgNights: active > 0 ? Math.round((totalNights / active) * 10) / 10 : 0,
    cancellationRate: rows.length > 0 ? Math.round((cancelled / rows.length) * 1000) / 10 : 0,
  };
}

// ============================================================
//  2. Pul
// ============================================================

async function moneyReport(from: Date, toEx: Date, days: number): Promise<MoneyReport> {
  const [rows, periodPayments] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        checkIn: { lt: toEx },
        checkOut: { gt: from },
        status: { in: [...ACTIVE_STATUSES] },
      },
      select: {
        pricePerNight: true,
        checkIn: true,
        checkOut: true,
        charges: { select: { amount: true } },
        payments: { select: { amount: true, method: true, paymentDate: true } },
      },
    }),
    prisma.payment.findMany({
      where: {
        paymentDate: { gte: from, lt: toEx },
      },
      select: { amount: true, method: true },
    }),
  ]);

  let roomRevenue = 0;
  let charges = 0;
  let paid = 0;
  const byMethod = new Map<string, { count: number; amount: number }>();

  for (const r of rows) {
    const start = r.checkIn > from ? r.checkIn : from;
    const end = r.checkOut < toEx ? r.checkOut : toEx;
    const stayNights = Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
    roomRevenue += toNumber(r.pricePerNight) * stayNights;
    charges += r.charges.reduce((s, c) => s + toNumber(c.amount), 0);
  }

  // To'lovlarni hisoblash: avval to'g'ridan-to'g'ri paymentDate bo'yicha
  if (periodPayments.length > 0) {
    for (const p of periodPayments) {
      const amt = toNumber(p.amount);
      paid += amt;
      const cur = byMethod.get(p.method) ?? { count: 0, amount: 0 };
      byMethod.set(p.method, { count: cur.count + 1, amount: cur.amount + amt });
    }
  } else {
    // Agar alohida paymentDate yozilmagan bo'lsa, davrdagi bronlar to'lovlaridan olamiz
    for (const r of rows) {
      for (const p of r.payments) {
        const amt = toNumber(p.amount);
        paid += amt;
        const cur = byMethod.get(p.method) ?? { count: 0, amount: 0 };
        byMethod.set(p.method, { count: cur.count + 1, amount: cur.amount + amt });
      }
    }
  }

  // Maosh: oylik summa davr uzunligiga moslanadi.
  // 30 kunlik oy deb hisoblanadi — aniq kun soni har oyda farq
  // qiladi, lekin hisobot uchun bu yetarli aniqlik.
  const employees = await prisma.employee.findMany({
    where: { isActive: true },
    select: { salary: true },
  });
  const monthlySalary = employees.reduce((s, e) => s + toNumber(e.salary), 0);
  const salaryExpense = Math.round((monthlySalary / 30) * days);

  /**
   * Boshqa xarajatlar (S14) — OTA komissiyasi shu yerda
   * avtomatik qayta hisoblanadi.
   *
   * `SALARY` kategoriyasi chiqarib tashlanadi: maosh
   * `Employee` jadvalidan hisoblanadi va ikki marta
   * qo'shilmasligi kerak.
   */
  const expenses = await expenseSummary(from, toEx);
  const otherExpenses = expenses.byCategory
    .filter((c) => c.category !== "SALARY")
    .reduce((sum, c) => sum + c.amount, 0);

  const totalRevenue = roomRevenue + charges;
  const totalExpenses = salaryExpense + otherExpenses;

  return {
    roomRevenue,
    charges,
    totalRevenue,
    paid,
    debt: Math.max(0, totalRevenue - paid),
    salaryExpense,
    otherExpenses,
    expenseBreakdown: expenses.byCategory
      .filter((c) => c.category !== "SALARY")
      .map((c) => ({
        category: c.category,
        label: CATEGORY_LABEL[c.category],
        amount: c.amount,
      })),
    totalExpenses,
    grossProfit: totalRevenue - totalExpenses,
    byMethod: [...byMethod.entries()].map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.amount - a.amount),
  };
}

// ============================================================
//  3. Bandlik
// ============================================================

async function occupancyReport(from: Date, toEx: Date, days: number): Promise<OccupancyReport> {
  const [totalRooms, blocked, reservations] = await Promise.all([
    prisma.room.count({ where: { isActive: true } }),

    prisma.roomDayStatus.count({
      where: { date: { gte: from, lt: toEx }, isBlocked: true },
    }),

    // Davr bilan kesishadigan bronlar
    prisma.reservation.findMany({
      where: {
        status: { in: [...ACTIVE_STATUSES] },
        checkIn: { lt: toEx },
        checkOut: { gt: from },
      },
      select: { checkIn: true, checkOut: true, pricePerNight: true },
    }),
  ]);

  // Faqat davr ichidagi kechalarni sanaymiz — bron davrdan
  // tashqariga chiqishi mumkin
  let soldNights = 0;
  let revenue = 0;

  for (const r of reservations) {
    const start = r.checkIn > from ? r.checkIn : from;
    const end = r.checkOut < toEx ? r.checkOut : toEx;
    const n = Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
    soldNights += n;
    revenue += toNumber(r.pricePerNight) * n;
  }

  const roomNights = totalRooms * days;
  const available = Math.max(0, roomNights - blocked);

  return {
    roomNights,
    soldNights,
    blockedNights: blocked,
    occupancyPercent: available > 0 ? Math.round((soldNights / available) * 1000) / 10 : 0,
    adr: soldNights > 0 ? Math.round(revenue / soldNights) : 0,
    revpar: available > 0 ? Math.round(revenue / available) : 0,
  };
}

// ============================================================
//  4. Xodimlar
// ============================================================

async function staffReport(): Promise<StaffReport> {
  const [employees, users] = await Promise.all([
    prisma.employee.findMany({
      select: { position: true, salary: true, isActive: true },
    }),
    prisma.user.groupBy({
      by: ["role"],
      where: { isActive: true },
      _count: true,
    }),
  ]);

  const byPosition = new Map<string, { count: number; salaryTotal: number }>();
  let monthlySalary = 0;

  for (const e of employees) {
    if (!e.isActive) continue;
    const sal = toNumber(e.salary);
    monthlySalary += sal;
    const cur = byPosition.get(e.position) ?? { count: 0, salaryTotal: 0 };
    byPosition.set(e.position, { count: cur.count + 1, salaryTotal: cur.salaryTotal + sal });
  }

  return {
    total: employees.length,
    active: employees.filter((e) => e.isActive).length,
    byPosition: [...byPosition.entries()].map(([position, v]) => ({ position, ...v }))
      .sort((a, b) => b.count - a.count),
    monthlySalary,
    systemUsers: users.map((u) => ({ role: u.role, count: u._count })),
  };
}

// ============================================================
//  5. Kanal (Beds24)
// ============================================================

async function channelReport(from: Date, toEx: Date): Promise<ChannelReport> {
  const [conn, mappings, totalTypes, syncErrors, pendingWebhooks] = await Promise.all([
    prisma.channelConnection.findFirst({ where: { isActive: true }, select: { id: true } }),
    prisma.channelMapping.count({ where: { isActive: true, roomTypeId: { not: null } } }),
    prisma.roomType.count(),
    prisma.syncLog.count({
      where: { status: "FAILED", createdAt: { gte: from, lt: toEx } },
    }),
    prisma.webhookEvent.count({
      where: { status: { in: ["RECEIVED", "QUEUED", "FAILED", "NEEDS_MANUAL_ACTION"] } },
    }),
  ]);

  return {
    connected: conn !== null,
    mappedTypes: mappings,
    totalTypes,
    syncErrors,
    pendingWebhooks,
  };
}

// ============================================================
//  Umumiy hisobot
// ============================================================

/**
 * Davr bo'yicha to'liq hisobot.
 *
 * `from` va `to` ikkalasi ham kiradi (inclusive).
 */
export async function getFullReport(from: Date, to: Date): Promise<FullReport> {
  const toEx = addDays(to, 1);
  const days = Math.max(1, Math.round((toEx.getTime() - from.getTime()) / 86_400_000));

  const [bookings, money, occupancy, staff, channel] = await Promise.all([
    bookingReport(from, toEx),
    moneyReport(from, toEx, days),
    occupancyReport(from, toEx, days),
    staffReport(),
    channelReport(from, toEx),
  ]);

  return {
    from: toDateKey(from) ?? "",
    to: toDateKey(to) ?? "",
    days,
    bookings,
    money,
    occupancy,
    staff,
    channel,
  };
}
