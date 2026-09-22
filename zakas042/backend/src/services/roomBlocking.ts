/**
 * Xona va qavat yopish (ta'mir, xizmatdan chiqarish)
 *
 * Manba: TZ 6-band (availability sync), 13-band (`RoomDayStatus`),
 *        02-DATABASE-SXEMA.md — `RoomDayStatus` modeli
 *
 * NIMA UCHUN KERAK
 * ----------------
 * `RoomDayStatus` jadvali va uni hisobga oluvchi availability
 * agregatsiyasi allaqachon bor edi (`availability.ts` — `blockedRooms`),
 * lekin unga YOZADIGAN API yo'q edi. Ya'ni xonani yopish texnik
 * jihatdan mumkin emasdi.
 *
 * TARQALISH ZANJIRI
 * -----------------
 * Xona yopilgach `onAvailabilityChanged()` chaqiriladi va o'zgarish
 * o'zi barcha tarmoqlarga tarqaladi:
 *
 *   RoomDayStatus.isBlocked = true
 *     -> recalcAvailability()     -> Availability.blockedRooms oshadi,
 *                                    availableCount kamayadi
 *     -> notifyAvailability()     -> WebSocket: Shaxmatka va admin panel
 *                                    darhol ko'radi (TZ 15-band)
 *     -> enqueueAvailabilitySync() -> BullMQ -> Beds24 -> Booking.com,
 *                                    Airbnb, Expedia (TZ 6, 20-band)
 *
 * Ya'ni bitta amal butun inventarni yangilaydi. Bu TZ 20-bandining
 * "barcha tizimlar bir xil inventory asosida ishlashi" talabi.
 *
 * MUHIM QOIDA
 * -----------
 * Band xonani yopib bo'lmaydi. Aks holda mehmon kelganda xona
 * "ta'mirda" bo'lib chiqadi. Avval bron ko'chiriladi yoki bekor
 * qilinadi, keyin yopiladi.
 */

import { prisma } from "../lib/prisma.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { onAvailabilityChanged } from "./availability.js";
import { fromDateKey, toDateKey } from "../lib/serialize.js";
import { audit } from "./auditLog.js";

// ============================================================
//  Turlar
// ============================================================

export type BlockInput = {
  /** "YYYY-MM-DD" — shu kun ichida */
  from: string;
  /** "YYYY-MM-DD" — shu kun ham kiradi (inclusive) */
  to: string;
  /** "Ta'mir", "Mebel almashtirish" — SyncLog va hisobotda ko'rinadi */
  reason?: string;
};

export type BlockResult = {
  roomIds: string[];
  from: string;
  to: string;
  /** Nechta (xona × kun) yozuv o'zgardi */
  daysAffected: number;
  /** Beds24'ga yuborish uchun navbatga qo'yilgan turlar */
  roomTypeIds: string[];
};

/** Bron tufayli yopib bo'lmagan xona */
export type BlockConflict = {
  roomId: string;
  reservationId: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
};

// ============================================================
//  Yordamchi
// ============================================================

/** "YYYY-MM-DD" shaklini tekshiradi va `Date` ga o'giradi */
function parseDate(s: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new ValidationError(`${field}: sana "YYYY-MM-DD" shaklida bo'lishi kerak`);
  }
  const d = fromDateKey(s);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`${field}: sana noto'g'ri`);
  }
  return d;
}

/**
 * `from` dan `to` gacha har bir kun (ikkalasi ham kiradi).
 *
 * Bron oralig'idan farqli: bronda `checkOut` kuni xona bo'sh, shuning
 * uchun u chiqarib tashlanadi. Yopishda esa oxirgi kun ham yopiq —
 * "1-dan 3-gacha ta'mir" uchta kunni bildiradi.
 */
function eachDay(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  const cur = new Date(from);
  while (cur <= to) {
    days.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/** Sana oralig'ini tekshiradi va kunlar ro'yxatini qaytaradi */
function validateRange(input: BlockInput): { from: Date; to: Date; days: Date[] } {
  const from = parseDate(input.from, "from");
  const to = parseDate(input.to, "to");

  if (to < from) {
    throw new ValidationError("'to' sanasi 'from' dan oldin bo'lishi mumkin emas");
  }

  const days = eachDay(from, to);

  // Himoya: bir amalda bir yildan ortiq yopib bo'lmaydi. Xato
  // kiritilgan sana (masalan 2260-yil) butun jadvalni to'ldirib
  // yuborishi mumkin.
  if (days.length > 366) {
    throw new ValidationError("Bir amalda 366 kundan ortiq yopib bo'lmaydi");
  }

  return { from, to, days };
}

// ============================================================
//  1. Bron tekshiruvi
// ============================================================

/**
 * Berilgan oraliqda bu xonalarda faol bron bormi.
 *
 * `CANCELLED` va `NO_SHOW` hisobga olinmaydi — ular xonani
 * bandlamaydi.
 */
export async function findBlockingReservations(
  roomIds: string[],
  from: Date,
  to: Date
): Promise<BlockConflict[]> {
  // Yopish oralig'i inclusive, bron oralig'i esa yarim ochiq
  // ([checkIn, checkOut)). Kesishish: checkIn <= to && checkOut > from
  const rows = await prisma.reservation.findMany({
    where: {
      roomId: { in: roomIds },
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
      checkIn: { lte: to },
      checkOut: { gt: from },
    },
    select: {
      id: true,
      roomId: true,
      checkIn: true,
      checkOut: true,
      guest: { select: { fullName: true } },
    },
    orderBy: { checkIn: "asc" },
  });

  return rows.map((r) => ({
    roomId: r.roomId,
    reservationId: r.id,
    guestName: r.guest.fullName,
    checkIn: toDateKey(r.checkIn) ?? "",
    checkOut: toDateKey(r.checkOut) ?? "",
  }));
}

// ============================================================
//  2. Yopish
// ============================================================

/**
 * Xonalarni berilgan oraliqda yopadi.
 *
 * @param force  `true` bo'lsa bron bo'lsa ham yopadi. Faqat ADMIN
 *               uchun va ataylab: masalan suv toshqini bo'lib,
 *               mehmonlar baribir ko'chiriladi.
 */
export async function blockRooms(
  roomIds: string[],
  input: BlockInput,
  opts: { userId?: string | null; force?: boolean; ipAddress?: string } = {}
): Promise<BlockResult> {
  if (roomIds.length === 0) {
    throw new ValidationError("Kamida bitta xona tanlanishi kerak");
  }

  const { from, to, days } = validateRange(input);

  const rooms = await prisma.room.findMany({
    where: { id: { in: roomIds } },
    select: { id: true, roomTypeId: true },
  });

  if (rooms.length !== roomIds.length) {
    const found = new Set(rooms.map((r) => r.id));
    const missing = roomIds.filter((id) => !found.has(id));
    throw new NotFoundError(`Xona topilmadi: ${missing.join(", ")}`);
  }

  if (!opts.force) {
    const conflicts = await findBlockingReservations(roomIds, from, to);
    if (conflicts.length > 0) {
      const first = conflicts[0];
      throw new ValidationError(
        `${first.roomId}-xonada shu kunlarda bron bor ` +
          `(${first.guestName}, ${first.checkIn}..${first.checkOut}). ` +
          `Avval bronni ko'chiring yoki bekor qiling.`
      );
    }
  }

  // Har (xona × kun) uchun bitta yozuv. `upsert` — kun allaqachon
  // yopilgan bo'lsa sababini yangilaydi, dublikat yaratmaydi.
  let daysAffected = 0;
  for (const room of rooms) {
    for (const date of days) {
      await prisma.roomDayStatus.upsert({
        where: { roomId_date: { roomId: room.id, date } },
        create: {
          roomId: room.id,
          date,
          isBlocked: true,
          blockReason: input.reason ?? null,
        },
        update: {
          isBlocked: true,
          blockReason: input.reason ?? null,
        },
      });
      daysAffected++;
    }
  }

  const roomTypeIds = [...new Set(rooms.map((r) => r.roomTypeId))];

  // Butun zanjir: hisoblash -> WebSocket -> Beds24 -> OTA.
  // `to` ga +1 kun: `onAvailabilityChanged` yarim ochiq oraliq
  // kutadi, yopish esa inclusive.
  const toExclusive = new Date(to);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  await onAvailabilityChanged(roomTypeIds, from, toExclusive, "room_blocked");

  await audit({
    userId: opts.userId ?? null,
    action: "room.blocked",
    entityType: "Room",
    entityId: roomIds.join(","),
    after: { from: input.from, to: input.to, reason: input.reason ?? null, force: !!opts.force },
    ipAddress: opts.ipAddress,
  });

  return { roomIds, from: input.from, to: input.to, daysAffected, roomTypeIds };
}

/**
 * Yopiqni bekor qiladi — xona yana sotuvga chiqadi.
 *
 * Yozuv o'chirilmaydi, `isBlocked = false` qilinadi: kim, qachon,
 * nima sababdan yopganini ko'rish uchun tarix qoladi.
 */
export async function unblockRooms(
  roomIds: string[],
  input: BlockInput,
  opts: { userId?: string | null; ipAddress?: string } = {}
): Promise<BlockResult> {
  if (roomIds.length === 0) {
    throw new ValidationError("Kamida bitta xona tanlanishi kerak");
  }

  const { from, to, days } = validateRange(input);

  const rooms = await prisma.room.findMany({
    where: { id: { in: roomIds } },
    select: { id: true, roomTypeId: true },
  });

  if (rooms.length === 0) {
    throw new NotFoundError(`Xona topilmadi: ${roomIds.join(", ")}`);
  }

  const result = await prisma.roomDayStatus.updateMany({
    where: {
      roomId: { in: rooms.map((r) => r.id) },
      date: { in: days },
      isBlocked: true,
    },
    data: { isBlocked: false, blockReason: null },
  });

  const roomTypeIds = [...new Set(rooms.map((r) => r.roomTypeId))];

  const toExclusive = new Date(to);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  await onAvailabilityChanged(roomTypeIds, from, toExclusive, "room_unblocked");

  await audit({
    userId: opts.userId ?? null,
    action: "room.unblocked",
    entityType: "Room",
    entityId: roomIds.join(","),
    after: { from: input.from, to: input.to },
    ipAddress: opts.ipAddress,
  });

  return {
    roomIds: rooms.map((r) => r.id),
    from: input.from,
    to: input.to,
    daysAffected: result.count,
    roomTypeIds,
  };
}

// ============================================================
//  3. Butun qavatni yopish
// ============================================================

/**
 * Qavatdagi barcha faol xonalarni yopadi.
 *
 * Qavat ID'si bilan ishlaydi ("F2"), raqami bilan emas — shu ID
 * barcha tizimlarda bir xil.
 */
export async function blockFloor(
  floorId: string,
  input: BlockInput,
  opts: { userId?: string | null; force?: boolean; ipAddress?: string } = {}
): Promise<BlockResult & { floorId: string }> {
  const floor = await prisma.floor.findUnique({
    where: { id: floorId },
    select: { id: true, label: true, rooms: { where: { isActive: true }, select: { id: true } } },
  });

  if (!floor) throw new NotFoundError(`Qavat topilmadi: ${floorId}`);
  if (floor.rooms.length === 0) {
    throw new ValidationError(`${floor.label}da faol xona yo'q`);
  }

  const result = await blockRooms(
    floor.rooms.map((r) => r.id),
    input,
    opts
  );

  await audit({
    userId: opts.userId ?? null,
    action: "floor.blocked",
    entityType: "Floor",
    entityId: floorId,
    after: { from: input.from, to: input.to, rooms: result.roomIds.length },
    ipAddress: opts.ipAddress,
  });

  return { ...result, floorId };
}

/** Qavatdagi barcha xonalarni ochadi */
export async function unblockFloor(
  floorId: string,
  input: BlockInput,
  opts: { userId?: string | null; ipAddress?: string } = {}
): Promise<BlockResult & { floorId: string }> {
  const floor = await prisma.floor.findUnique({
    where: { id: floorId },
    select: { id: true, label: true, rooms: { select: { id: true } } },
  });

  if (!floor) throw new NotFoundError(`Qavat topilmadi: ${floorId}`);

  const result = await unblockRooms(
    floor.rooms.map((r) => r.id),
    input,
    opts
  );

  await audit({
    userId: opts.userId ?? null,
    action: "floor.unblocked",
    entityType: "Floor",
    entityId: floorId,
    after: { from: input.from, to: input.to },
    ipAddress: opts.ipAddress,
  });

  return { ...result, floorId };
}

// ============================================================
//  4. O'qish
// ============================================================

export type BlockedDay = {
  roomId: string;
  date: string;
  reason: string | null;
};

/** Oraliqdagi barcha yopiq kunlar (Shaxmatka ularni kulrang ko'rsatadi) */
export async function listBlocked(
  from: string,
  to: string,
  roomIds?: string[]
): Promise<BlockedDay[]> {
  const fromD = parseDate(from, "from");
  const toD = parseDate(to, "to");

  const rows = await prisma.roomDayStatus.findMany({
    where: {
      isBlocked: true,
      date: { gte: fromD, lte: toD },
      ...(roomIds && roomIds.length > 0 ? { roomId: { in: roomIds } } : {}),
    },
    select: { roomId: true, date: true, blockReason: true },
    orderBy: [{ roomId: "asc" }, { date: "asc" }],
  });

  return rows.map((r) => ({
    roomId: r.roomId,
    date: toDateKey(r.date) ?? "",
    reason: r.blockReason,
  }));
}
