/**
 * Oshxona — ovqat hisobi (BOTLAR-REJA.md)
 *
 * MAQSAD: oshpazlar ertalab qancha porsiya tayyorlashni bilsin.
 *
 * KIM HISOBLANADI (2026-09-17 qarori):
 *   1. Hozir xonada turganlar (`CHECKED_IN`)
 *   2. Bugun keladiganlar (`CONFIRMED`, checkIn = bugun)
 *
 * Ikkinchisi kerak: mehmon kechqurun kelsa ham ertangi
 * nonushtaga hisoblanadi. Faqat `CHECKED_IN` bo'lsa, kech
 * kelgan mehmon uchun ovqat tayyorlanmay qolardi.
 *
 * BOLALAR: alohida sanaladi, lekin porsiya bir xil. Narx ham
 * bir xil (25 000) — 2026-09-17 qarori.
 */

import { prisma } from "../lib/prisma.js";

export type RoomMeals = {
  roomId: string;
  roomLabel: string;
  adults: number;
  children: number;
  guestName: string;
  /** "Sayt", "Qabulxona", "Booking.com" */
  source: string;
  /** Hozir xonadami yoki bugun keladimi */
  arriving: boolean;
};

export type KitchenReport = {
  date: string;
  totalGuests: number;
  totalAdults: number;
  totalChildren: number;
  /** Hozir xonada turganlar */
  staying: number;
  /** Bugun keladiganlar */
  arriving: number;
  rooms: RoomMeals[];
};

/** Bron manbai nomlari — oshpazga tushunarli bo'lsin */
const SOURCE_LABEL: Record<string, string> = {
  DIRECT: "Qabulxona",
  WEBSITE: "Sayt",
  BOOKING_COM: "Booking.com",
  AIRBNB: "Airbnb",
  EXPEDIA: "Expedia",
  PHONE: "Telefon",
  WALK_IN: "Kelgan mehmon",
  OTHER: "Boshqa",
};

/** Kun boshi (O'zbekiston / Toshkent vaqti bo'yicha UTC chegarasi) */
function dayStart(offset = 0): Date {
  const d = new Date(Date.now() + 5 * 3_600_000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate() + offset;
  return new Date(Date.UTC(y, m, day, 0, 0, 0, 0));
}

/**
 * Berilgan kun uchun ovqat hisoboti.
 *
 * `offset = 0` bugun, `1` ertaga.
 */
export async function kitchenReport(offset = 0): Promise<KitchenReport> {
  const start = dayStart(offset);
  const end = dayStart(offset + 1);

  /**
   * IKKI GURUH, bir so'rovda.
   *
   * `CHECKED_IN` — hozir xonada (kecha kelgan ham kiradi)
   * `CONFIRMED` + checkIn bugun — bugun keladi
   *
   * `withMeal = true` shart: ovqat tarifi bo'lmagan mehmon
   * hisoblanmaydi.
   */
  const rows = await prisma.reservation.findMany({
    where: {
      withMeal: true,
      OR: [
        // Xonada turganlar: kirish o'tgan, chiqish hali emas
        {
          status: "CHECKED_IN",
          checkIn: { lt: end },
          checkOut: { gt: start },
        },
        // Bugun keladiganlar
        {
          status: { in: ["CONFIRMED", "PENDING_PAYMENT"] },
          checkIn: { gte: start, lt: end },
        },
      ],
    },
    select: {
      roomId: true,
      adults: true,
      children: true,
      status: true,
      source: true,
      guest: { select: { fullName: true } },
      room: { select: { roomType: { select: { label: true } } } },
    },
    orderBy: { roomId: "asc" },
  });

  const rooms: RoomMeals[] = rows.map((r) => ({
    roomId: r.roomId,
    roomLabel: r.room.roomType?.label ?? "",
    adults: r.adults,
    children: r.children,
    guestName: r.guest.fullName,
    source: SOURCE_LABEL[r.source] ?? r.source,
    arriving: r.status !== "CHECKED_IN",
  }));

  const totalAdults = rooms.reduce((s, r) => s + r.adults, 0);
  const totalChildren = rooms.reduce((s, r) => s + r.children, 0);

  return {
    date: start.toISOString().slice(0, 10),
    totalGuests: totalAdults + totalChildren,
    totalAdults,
    totalChildren,
    staying: rooms.filter((r) => !r.arriving).length,
    arriving: rooms.filter((r) => r.arriving).length,
    rooms,
  };
}

/**
 * Bugun va ertaga — panel uchun.
 *
 * Ertangi son oshpazga tayyorgarlik uchun kerak: mahsulot
 * buyurtma qilish, non yopish.
 */
export async function kitchenOverview(): Promise<{
  today: KitchenReport;
  tomorrow: KitchenReport;
}> {
  const [today, tomorrow] = await Promise.all([
    kitchenReport(0),
    kitchenReport(1),
  ]);

  return { today, tomorrow };
}

/**
 * Beds24'dan kelgan bron ovqatli bo'ladimi (BOTLAR-REJA.md).
 *
 * Beds24 standart maydon bermaydi — ular "nonushta bilan" va
 * "nonushtasiz" alohida tariflar yaratadi. Mapping paytida
 * `includesMeal` belgilanadi.
 *
 * Mapping topilmasa `false`: noma'lum holatda ovqat
 * tayyorlamaganimiz, ortiqcha tayyorlagandan yaxshiroq —
 * mehmon so'rasa qo'shib beriladi.
 */
export async function channelBookingHasMeal(
  channelId: string,
  externalRoomTypeId: string
): Promise<boolean> {
  const mapping = await prisma.channelMapping.findFirst({
    where: { channelId, externalRoomTypeId, isActive: true },
    select: { includesMeal: true },
  });

  return mapping?.includesMeal ?? false;
}
