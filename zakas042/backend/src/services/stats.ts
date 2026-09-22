/**
 * Hisobot va statistika
 *
 * Telegram bot va admin panel uchun umumiy qatlam. Ikkalasi bir xil
 * raqamni ko'rsatishi shart — aks holda "botda boshqa, panelda
 * boshqa" degan savol chiqadi.
 *
 * NEGA ALOHIDA FAYL: bu yerda faqat O'QISH bor, hech narsa
 * o'zgarmaydi. Shuning uchun `reservations.ts` (biznes amallar)
 * ichiga aralashtirilmadi.
 */

import { prisma } from "../lib/prisma.js";
import { toNumber, toDateKey } from "../lib/serialize.js";

// ============================================================
//  Yordamchi
// ============================================================

/** Bugungi sana, UTC yarim tunda (baza `@db.Date` bilan mos) */
function todayUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/** Bron xonani band qiladigan statuslar */
const ACTIVE_STATUSES = ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT"] as const;

// ============================================================
//  1. Bugungi holat (Dashboard)
// ============================================================

export type TodaySnapshot = {
  date: string;
  /** Bugun kirishi kerak bo'lgan bronlar */
  arrivals: number;
  /** Bugun chiqishi kerak bo'lganlar */
  departures: number;
  /** Hozir xonada turgan mehmonlar */
  staying: number;
  totalRooms: number;
  occupiedRooms: number;
  freeRooms: number;
  /** Ta'mir yoki xizmatdan chiqarilgan (bugungi kun) */
  blockedRooms: number;
  occupancyPercent: number;
  /** Bugun boshlangan bronlarning jami summasi */
  todayRevenue: number;
};

export async function getTodaySnapshot(): Promise<TodaySnapshot> {
  const today = todayUtc();
  const tomorrow = addDays(today, 1);

  const [rooms, blocked, arrivals, departures, staying] = await Promise.all([
    prisma.room.count({ where: { isActive: true } }),

    prisma.roomDayStatus.count({
      where: { date: today, isBlocked: true },
    }),

    prisma.reservation.findMany({
      where: { checkIn: today, status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true, pricePerNight: true, checkIn: true, checkOut: true },
    }),

    prisma.reservation.count({
      where: { checkOut: today, status: { in: [...ACTIVE_STATUSES] } },
    }),

    // Hozir xonada: checkIn <= bugun < checkOut
    prisma.reservation.findMany({
      where: {
        checkIn: { lte: today },
        checkOut: { gt: today },
        status: { in: [...ACTIVE_STATUSES] },
      },
      select: { roomId: true },
    }),
  ]);

  // Bir xonada bir vaqtda bitta bron bo'ladi (overbooking constraint),
  // lekin ehtiyot uchun noyob sanaymiz.
  const occupiedRooms = new Set(staying.map((r) => r.roomId)).size;

  // Bugun boshlangan bronlarning jami qiymati.
  // `pricePerNight × kechalar` — qo'shimcha xarajatlarsiz, chunki
  // ular keyinroq qo'shiladi.
  const todayRevenue = arrivals.reduce((sum, r) => {
    const nights = Math.max(
      1,
      Math.round((r.checkOut.getTime() - r.checkIn.getTime()) / 86_400_000)
    );
    return sum + toNumber(r.pricePerNight) * nights;
  }, 0);

  const freeRooms = Math.max(0, rooms - occupiedRooms - blocked);

  return {
    date: toDateKey(today) ?? "",
    arrivals: arrivals.length,
    departures,
    staying: staying.length,
    totalRooms: rooms,
    occupiedRooms,
    freeRooms,
    blockedRooms: blocked,
    occupancyPercent: rooms > 0 ? Math.round((occupiedRooms / rooms) * 100) : 0,
    todayRevenue,
  };
}

// ============================================================
//  2. Moliya
// ============================================================

export type FinanceReport = {
  from: string;
  to: string;
  /** Oraliqda boshlangan bronlar soni */
  bookings: number;
  /** Xona narxi × kechalar */
  roomRevenue: number;
  /** Qo'shimcha xarajatlar (mini-bar, transfer va h.k.) */
  charges: number;
  /** roomRevenue + charges */
  total: number;
  /** Haqiqatda qabul qilingan to'lovlar */
  paid: number;
  /** total - paid (manfiy bo'lmaydi) */
  debt: number;
  /** Manba bo'yicha taqsimot */
  bySource: Array<{ source: string; count: number; amount: number }>;
};

/**
 * Oraliq bo'yicha moliyaviy hisobot.
 *
 * `from` va `to` ikkalasi ham kiradi (inclusive). Bron `checkIn`
 * sanasi bo'yicha hisoblanadi — ya'ni "shu kunlarda kelgan
 * mehmonlar qancha pul olib keldi".
 */
export async function getFinanceReport(from: Date, to: Date): Promise<FinanceReport> {
  const toExclusive = addDays(to, 1);

  const reservations = await prisma.reservation.findMany({
    where: {
      checkIn: { gte: from, lt: toExclusive },
      status: { in: [...ACTIVE_STATUSES] },
    },
    select: {
      pricePerNight: true,
      checkIn: true,
      checkOut: true,
      source: true,
      charges: { select: { amount: true } },
      payments: { select: { amount: true } },
    },
  });

  let roomRevenue = 0;
  let charges = 0;
  let paid = 0;
  const bySource = new Map<string, { count: number; amount: number }>();

  for (const r of reservations) {
    const nights = Math.max(
      1,
      Math.round((r.checkOut.getTime() - r.checkIn.getTime()) / 86_400_000)
    );
    const room = toNumber(r.pricePerNight) * nights;
    const extra = r.charges.reduce((s, c) => s + toNumber(c.amount), 0);

    roomRevenue += room;
    charges += extra;
    paid += r.payments.reduce((s, p) => s + toNumber(p.amount), 0);

    const key = r.source.toLowerCase();
    const cur = bySource.get(key) ?? { count: 0, amount: 0 };
    bySource.set(key, { count: cur.count + 1, amount: cur.amount + room + extra });
  }

  const total = roomRevenue + charges;

  return {
    from: toDateKey(from) ?? "",
    to: toDateKey(to) ?? "",
    bookings: reservations.length,
    roomRevenue,
    charges,
    total,
    paid,
    debt: Math.max(0, total - paid),
    bySource: [...bySource.entries()]
      .map(([source, v]) => ({ source, ...v }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/** Bugun / shu hafta / shu oy uchun tayyor oraliqlar */
export function periodRange(period: "today" | "week" | "month"): { from: Date; to: Date } {
  const today = todayUtc();

  if (period === "today") return { from: today, to: today };

  if (period === "week") {
    // Dushanbadan boshlanadi (O'zbekistonda hafta shunday)
    const dow = today.getUTCDay();          // 0 = yakshanba
    const backToMonday = dow === 0 ? 6 : dow - 1;
    return { from: addDays(today, -backToMonday), to: today };
  }

  // month
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  return { from: first, to: today };
}

// ============================================================
//  3. Xona holati
// ============================================================

export type RoomStateRow = {
  id: string;
  floor: number;
  typeId: string;
  typeLabel: string;
  /** Xonaning jismoniy holati (`Room.status`) */
  status: string;
  /** Bugun mehmon bormi */
  occupied: boolean;
  /** Bugun ta'mir/yopiq */
  blocked: boolean;
  /** Mehmon ismi — band bo'lsa */
  guestName?: string;
  /** Qachon chiqadi — band bo'lsa */
  until?: string;
};

export async function getRoomStates(): Promise<RoomStateRow[]> {
  const today = todayUtc();

  const [rooms, staying, blocked] = await Promise.all([
    prisma.room.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      include: { roomType: { select: { label: true } } },
    }),

    prisma.reservation.findMany({
      where: {
        checkIn: { lte: today },
        checkOut: { gt: today },
        status: { in: [...ACTIVE_STATUSES] },
      },
      select: { roomId: true, checkOut: true, guest: { select: { fullName: true } } },
    }),

    prisma.roomDayStatus.findMany({
      where: { date: today, isBlocked: true },
      select: { roomId: true },
    }),
  ]);

  const byRoom = new Map(staying.map((r) => [r.roomId, r]));
  const blockedIds = new Set(blocked.map((b) => b.roomId));

  return rooms.map((r) => {
    const res = byRoom.get(r.id);
    return {
      id: r.id,
      floor: r.floor,
      typeId: r.roomTypeId,
      typeLabel: r.roomType.label,
      status: r.status.toLowerCase(),
      occupied: !!res,
      blocked: blockedIds.has(r.id),
      guestName: res?.guest.fullName,
      until: res ? toDateKey(res.checkOut) ?? undefined : undefined,
    };
  });
}

// ============================================================
//  4. Yaqin bronlar
// ============================================================

export type UpcomingBooking = {
  id: string;
  roomId: string;
  guestName: string;
  phone: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  source: string;
  status: string;
  total: number;
  createdAt: string;
};

/** Oxirgi yaratilgan bronlar — bot "so'nggi bronlar" uchun */
export async function getRecentBookings(limit = 10): Promise<UpcomingBooking[]> {
  const rows = await prisma.reservation.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 50),
    select: {
      id: true, roomId: true, checkIn: true, checkOut: true,
      pricePerNight: true, source: true, status: true, createdAt: true,
      guest: { select: { fullName: true, phone: true } },
      charges: { select: { amount: true } },
    },
  });

  return rows.map((r) => {
    const nights = Math.max(
      1,
      Math.round((r.checkOut.getTime() - r.checkIn.getTime()) / 86_400_000)
    );
    const extra = r.charges.reduce((s, c) => s + toNumber(c.amount), 0);
    return {
      id: r.id,
      roomId: r.roomId,
      guestName: r.guest.fullName,
      phone: r.guest.phone ?? "",
      checkIn: toDateKey(r.checkIn) ?? "",
      checkOut: toDateKey(r.checkOut) ?? "",
      nights,
      source: r.source.toLowerCase(),
      status: r.status.toLowerCase(),
      total: toNumber(r.pricePerNight) * nights + extra,
      createdAt: r.createdAt.toISOString(),
    };
  });
}
