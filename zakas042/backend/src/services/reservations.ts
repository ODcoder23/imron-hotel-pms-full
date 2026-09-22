/**
 * Bron biznes-mantiqi
 *
 * Manba:
 *   07-AVAILABILITY-VA-RATES-SYNC.md §5 — overbooking himoyasi (3 qatlam)
 *   08-RESERVATION-STATUS-VA-TOLOV.md   — statuslar, to'lov
 *   12-PMS-DAN-BEDS24-GA-SYNC.md §1     — TZ 2-band 8 amal
 *
 * MUHIM (TZ 17, 19-band): hech bir amal Beds24 javobini kutmaydi.
 * DB transaction muvaffaqiyatli bo'lsa — amal bajarilgan hisoblanadi.
 * Beds24 tomoni navbat orqali, keyinroq (FAZA 7+ da ulanadi).
 */

import { Prisma, type ReservationStatus, type ReservationSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { NotFoundError, RoomUnavailableError, ValidationError } from "../lib/errors.js";
import { fromDateKey, toDateKey, serializeReservation } from "../lib/serialize.js";
import { serializableTx } from "../lib/tx.js";
import { onAvailabilityChanged } from "./availability.js";
import { onReservationChanged } from "./reservationSync.js";
import {
  notifyReservation, notifyPayment, notifyRoomStatus,
} from "../realtime/notify.js";
import {
  getMealPrice, getFreeCancelHours, getCancelFeeNights,
} from "./settings.js";
import { createOnCheckout } from "./cleaning.js";

/** Bron o'qishda har doim shu bog'liqliklar kerak (serializeReservation uchun) */
export const reservationInclude = {
  guest: true,
  charges: { orderBy: { createdAt: "asc" } },
  payments: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.ReservationInclude;

/** Faol bron statuslari — availability hisobida qatnashadi */
const ACTIVE_STATUSES: ReservationStatus[] = [
  "PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT",
];

/**
 * Status o'tishlari (SAVOLLAR.md S3).
 *
 * NEGA KERAK: ilgari hech qanday qoida yo'q edi — bekor qilingan
 * bronni check-in qilish, chiqib ketgan mehmonni yana kiritish
 * mumkin edi. Overbooking constraint bazani himoya qilardi, lekin
 * status ketma-ketligi ma'nosiz bo'lib qolardi.
 *
 * CHEGARA: bo'sh ro'yxat = yakuniy holat, undan chiqib bo'lmaydi.
 */
const ALLOWED_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  PENDING_PAYMENT: ["CONFIRMED", "CANCELLED", "NO_SHOW"],
  CONFIRMED:       ["CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CHECKED_IN:      ["CHECKED_OUT"],
  CHECKED_OUT:     [],
  CANCELLED:       [],
  NO_SHOW:         [],
};

/** Statusning o'zbekcha nomi — xato xabarlari uchun */
const STATUS_LABEL: Record<ReservationStatus, string> = {
  PENDING_PAYMENT: "to'lov kutilmoqda",
  CONFIRMED:       "tasdiqlangan",
  CHECKED_IN:      "mehmon kirgan",
  CHECKED_OUT:     "mehmon chiqqan",
  CANCELLED:       "bekor qilingan",
  NO_SHOW:         "kelmadi",
};

/**
 * O'tish mumkinmi — mumkin bo'lmasa tushunarli xato tashlaydi.
 *
 * Bir xil statusga o'tish (CHECKED_IN -> CHECKED_IN) ham rad
 * etiladi: bu odatda ikki marta bosilgan tugma, va checkedInAt
 * vaqtini buzadi.
 */
function assertTransition(from: ReservationStatus, to: ReservationStatus): void {
  if (ALLOWED_TRANSITIONS[from].includes(to)) return;

  throw new ValidationError(
    `Bron "${STATUS_LABEL[from]}" holatida — uni "${STATUS_LABEL[to]}" ` +
    `qilib bo'lmaydi`
  );
}

/**
 * Xona holatini bronga qarab aniqlaydi.
 * Frontenddagi roomStatusForReservation() bilan aynan bir xil
 * (08-fayl §1, Q5 bilan kengaytirilgan).
 */
export function roomStatusFor(status: ReservationStatus) {
  switch (status) {
    case "CHECKED_IN":      return "OCCUPIED" as const;
    case "CHECKED_OUT":     return "DIRTY" as const;
    case "CONFIRMED":       return "RESERVED" as const;
    case "PENDING_PAYMENT": return "RESERVED" as const;  // to'lanmagan ham band
    case "NO_SHOW":         return "AVAILABLE" as const;  // xona bo'shaydi
    case "CANCELLED":       return "AVAILABLE" as const;
  }
}

/**
 * Xona bo'shmi — IKKI shartni tekshiradi:
 *
 *   1. Sana oralig'i boshqa bron bilan kesishmasligi
 *      (Shaxmatkadagi `isRoomAvailable()` bilan bir xil:
 *       `ci < rco && co > rci`)
 *
 *   2. Oraliqdagi birorta kun ta'mir/xizmatdan chiqarilgan
 *      bo'lmasligi (`RoomDayStatus.isBlocked`)
 *
 * IKKINCHI SHART 2026-09-16 DA QO'SHILDI. Undan oldin yopiq
 * xonaga bron tushaverardi: admin Shaxmatkada ta'mirdagi xonani
 * tanlay olardi, Beds24'dan kelgan bron ham o'sha xonaga
 * biriktirilardi. Mehmon kelganda xona yopiq bo'lib chiqardi.
 *
 * YAGONA JOY: bu funksiya bron yaratish, xona almashtirish, sana
 * o'zgartirish, bo'sh xona qidirish va webhook ishlovida
 * chaqiriladi. Tekshiruv shu yerda bo'lgani uchun hammasi
 * bir vaqtda himoyalanadi.
 *
 * Yopilgan kunlar oralig'i: bron `[checkIn, checkOut)` — chiqish
 * kuni xona bo'sh, shuning uchun u tekshirilmaydi.
 */
export async function isRoomFree(
  roomId: string,
  checkIn: Date,
  checkOut: Date,
  excludeId?: string,
  tx: Prisma.TransactionClient = prisma
): Promise<boolean> {
  const conflict = await tx.reservation.findFirst({
    where: {
      roomId,
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (conflict !== null) return false;

  const blocked = await tx.roomDayStatus.findFirst({
    where: {
      roomId,
      isBlocked: true,
      date: { gte: checkIn, lt: checkOut },
    },
    select: { id: true },
  });
  return blocked === null;
}

/**
 * Xona holatini qayta hisoblaydi — bron o'zgargandan keyin chaqiriladi.
 *
 * `Room.status` — xonaning JORIY jismoniy holati, sanaga bog'liq emas.
 * Shuning uchun kelajakdagi bronlar unga ta'sir qilmaydi: 111-xonaga
 * keyingi oyga bron qilinsa, xona bugun baribir bo'sh.
 *
 * Ustuvorlik (yuqoridan pastga):
 *   1. CHECKED_IN  bron bugun faol  → OCCUPIED
 *   2. CHECKED_OUT bron bugun tugadi → DIRTY (tozalash kerak)
 *   3. CONFIRMED / PENDING_PAYMENT bugun boshlanadi → RESERVED
 *   4. Aks holda → AVAILABLE
 *
 * OUT_OF_ORDER / OUT_OF_SERVICE qo'lda qo'yiladi va bu funksiya
 * ularga tegmaydi — ta'mirdagi xona bron sababli "bo'sh" bo'lib
 * qolmasligi kerak.
 */
/** Xona holatini qo'lda o'rnatadi va event yuboradi */
export async function setRoomStatus(roomId: string, status: string) {
  const room = await prisma.room.update({
    where: { id: roomId },
    data: { status: status.toUpperCase() as never },
  });
  await notifyRoomStatus(roomId);
  return room;
}

export async function recalcRoomStatus(
  roomId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<void> {
  const room = await tx.room.findUnique({ where: { id: roomId } });
  if (!room) return;

  // Qo'lda qo'yilgan holatlarga tegilmaydi
  if (room.status === "OUT_OF_ORDER" || room.status === "OUT_OF_SERVICE") return;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  // Bugun xonada turgan mehmon
  const occupied = await tx.reservation.findFirst({
    where: {
      roomId,
      status: "CHECKED_IN",
      checkIn: { lte: today },
      checkOut: { gt: today },
    },
  });
  if (occupied) {
    await tx.room.update({ where: { id: roomId }, data: { status: "OCCUPIED" } });
    return;
  }

  // Bugun chiqib ketgan — tozalash kerak
  const justLeft = await tx.reservation.findFirst({
    where: { roomId, status: "CHECKED_OUT", checkOut: { gte: today } },
  });
  if (justLeft) {
    await tx.room.update({ where: { id: roomId }, data: { status: "DIRTY" } });
    return;
  }

  // Bugun kutilayotgan mehmon (hali kelmagan)
  const reserved = await tx.reservation.findFirst({
    where: {
      roomId,
      status: { in: ["CONFIRMED", "PENDING_PAYMENT"] },
      checkIn: { lte: today },
      checkOut: { gt: today },
    },
  });

  await tx.room.update({
    where: { id: roomId },
    data: { status: reserved ? "RESERVED" : "AVAILABLE" },
  });
}


// ============================================================
//  TZ 2-band — sakkiz amal
// ============================================================

type CreateInput = {
  roomId: string;
  guestName: string;
  phone?: string;
  email?: string;
  checkIn: string;          // "YYYY-MM-DD"
  checkOut: string;
  adults?: number;
  children?: number;
  source?: string;          // "direct" | "booking_com" | ...
  pricePerNight: number;
  priceReason?: string;
  notes?: string;
  withMeal?: boolean;
  status?: string;
  initialPayment?: number;
  paymentMethod?: string;
  /** To'lovni kim qabul qilgani (S13) — initialPayment uchun */
  userId?: string;
};

/**
 * Tarif narxi — kirish sanasidagi RatePlan (SAVOLLAR.md S4).
 *
 * Tarif topilmasa null: yangi xona turi yoki narx hali
 * kiritilmagan bo'lishi mumkin, bu bronni to'sish uchun sabab emas.
 */
async function tariffPrice(
  roomTypeId: string,
  date: Date,
  tx: Prisma.TransactionClient = prisma
): Promise<number | null> {
  const plan = await tx.ratePlan.findFirst({
    where: { roomTypeId, date },
    select: { price: true },
  });
  return plan ? Number(plan.price) : null;
}

/**
 * Narx tarifga mosmi (SAVOLLAR.md S4).
 *
 * QOIDA: chegirma mumkin, lekin sababsiz emas. Tarifdan past narx
 * `priceReason` talab qiladi — hisobotda "nega arzon sotilgan"
 * ko'rinib tursin. Tarifdan yuqori narx erkin: bayram kuni yoki
 * kelishuv narxi bo'lishi mumkin, u daromadni kamaytirmaydi.
 *
 * NEGA qat'iy taqiq emas: qabulxona kelishuv narxi bilan ishlaydi,
 * har chegirma uchun menejer chaqirish ishni to'xtatib qo'yardi.
 */
function assertPriceOk(
  price: number,
  tariff: number | null,
  reason: string | undefined
): void {
  if (tariff === null || price >= tariff) return;
  if (reason && reason.trim().length >= 3) return;

  throw new ValidationError(
    `Narx tarifdan past (tarif ${som(tariff)}, kiritilgan ${som(price)}) — ` +
    `chegirma sababini yozing`
  );
}

/**
 * Mehmonni topadi yoki yaratadi (SAVOLLAR.md S6, S7).
 *
 * TELEFON BOR: shu telefonli mehmon qidiriladi. Topilsa, ism
 * FARQ QILSA yangilanadi — ilgari eski ism qolib ketardi va
 * bron boshqa odam nomiga yozilgandek ko'rinardi.
 *
 * TELEFON YO'Q: har safar yangi yozuv. Bu ataylab — telefonsiz
 * ikki "Anonim mehmon" ni bir odam deb hisoblash xato bo'lardi.
 * Shuning uchun telefon qat'iy tavsiya etiladi (route'da
 * ogohlantirish bor).
 */
async function findOrCreateGuest(
  input: Pick<CreateInput, "guestName" | "phone" | "email">,
  tx: Prisma.TransactionClient
) {
  if (!input.phone) {
    return tx.guest.create({
      data: { fullName: input.guestName, email: input.email },
    });
  }

  const existing = await tx.guest.findFirst({ where: { phone: input.phone } });

  if (!existing) {
    return tx.guest.create({
      data: { fullName: input.guestName, phone: input.phone, email: input.email },
    });
  }

  // Ism yoki email o'zgargan bo'lsa yangilaymiz (S6)
  const changed =
    existing.fullName !== input.guestName ||
    (input.email !== undefined && existing.email !== input.email);

  if (!changed) return existing;

  return tx.guest.update({
    where: { id: existing.id },
    data: {
      fullName: input.guestName,
      ...(input.email ? { email: input.email } : {}),
    },
  });
}

/** 1. Yangi bron (TZ 2-band) */
export async function createReservation(input: CreateInput) {
  const checkIn = fromDateKey(input.checkIn);
  const checkOut = fromDateKey(input.checkOut);

  if (checkOut <= checkIn) {
    throw new ValidationError("Chiqish sanasi kirish sanasidan keyin bo'lishi kerak.");
  }

  // Transaction ichida emas: mavjudlik tekshiruvi tashqarida
  // bajarilsa transaction qulfini ushlab turmaydi
  const payerId = await resolveUserId(input.userId);

  /**
   * Nonushta narxi bron yaratilganda KO'CHIRILADI (S10).
   *
   * NEGA: narx keyin ko'tarilsa, eski bronlarning summasi
   * o'zgarib ketardi — mehmon kelishilgandan ko'p to'lardi.
   */
  const mealPrice = input.withMeal ? await getMealPrice() : 0;

  const result = await serializableTx(async (tx) => {
    const room = await tx.room.findUnique({ where: { id: input.roomId } });
    if (!room) throw new NotFoundError(`Xona ${input.roomId}`);

    // 2-qatlam himoya (07 §5): tushunarli xato berish uchun.
    // 1-qatlam — DB constraint, u baribir ishlaydi.
    if (!(await isRoomFree(input.roomId, checkIn, checkOut, undefined, tx))) {
      throw new RoomUnavailableError();
    }

    // Narx tarifdan past bo'lsa sabab talab qilinadi (S4)
    assertPriceOk(
      input.pricePerNight,
      await tariffPrice(room.roomTypeId, checkIn, tx),
      input.priceReason
    );

    // Boshlang'ich to'lov bron summasidan oshmasin (S1).
    // Bu yerda alohida tekshiriladi, chunki bron hali yaratilmagan
    // va currentBalance() uni topa olmaydi.
    if (input.initialPayment && input.initialPayment > 0) {
      const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000);
      const guests = (input.adults ?? 1) + (input.children ?? 0);
      const total =
        input.pricePerNight * nights + mealPrice * guests * nights;
      if (input.initialPayment > total) {
        throw new ValidationError(
          `Boshlang'ich to'lov bron summasidan ko'p: ` +
          `bron ${som(total)}, to'lov ${som(input.initialPayment)}`
        );
      }
    }

    const guest = await findOrCreateGuest(input, tx);

    const status = (input.status?.toUpperCase() ?? "CONFIRMED") as ReservationStatus;

    const reservation = await tx.reservation.create({
      data: {
        roomId: input.roomId,
        guestId: guest.id,
        checkIn,
        checkOut,
        adults: input.adults ?? 1,
        children: input.children ?? 0,
        source: (input.source?.toUpperCase() ?? "DIRECT") as ReservationSource,
        pricePerNight: new Prisma.Decimal(input.pricePerNight),
        priceReason: input.priceReason?.trim() || null,
        notes: input.notes,
        withMeal: input.withMeal ?? false,
        mealPricePerPerson: mealPrice > 0 ? new Prisma.Decimal(mealPrice) : null,
        status,
        syncStatus: "PENDING",
        ...(input.initialPayment && input.initialPayment > 0
          ? {
              payments: {
                create: {
                  amount: new Prisma.Decimal(input.initialPayment),
                  method: input.paymentMethod ?? "Naqd",
                  paymentDate: new Date(),
                  note: "Boshlang'ich to'lov",
                  userId: payerId,
                },
              },
            }
          : {}),
      },
      include: reservationInclude,
    });

    await recalcRoomStatus(input.roomId, tx);
    return { reservation, roomTypeId: room.roomTypeId };
  }, "createReservation");

  // Hisoblash + event + Beds24 navbati (07-fayl §3, FAZA 9)
  await onAvailabilityChanged([result.roomTypeId], checkIn, checkOut, "reservation_created");

  // TZ 15-band: boshqa ochiq Shaxmatka oynalari ham ko'radi
  await notifyReservation("reservation.created", result.reservation.id);

  // TZ 2-band 1-amal: Beds24'ga yangi bron (12-fayl §1)
  await onReservationChanged(result.reservation.id, "created");

  return result.reservation;
}

/** 2. Bronni o'zgartirish — mehmon soni, narx, izoh (TZ 2-band) */
export async function updateReservation(
  id: string,
  patch: Partial<Pick<CreateInput, "adults" | "children" | "pricePerNight" | "notes" | "withMeal" | "guestName" | "phone">>
) {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.reservation.findUnique({ where: { id }, include: { guest: true } });
    if (!existing) throw new NotFoundError("Bron");

    if (patch.guestName || patch.phone) {
      await tx.guest.update({
        where: { id: existing.guestId },
        data: {
          ...(patch.guestName ? { fullName: patch.guestName } : {}),
          ...(patch.phone ? { phone: patch.phone } : {}),
        },
      });
    }

    return tx.reservation.update({
      where: { id },
      data: {
        ...(patch.adults !== undefined ? { adults: patch.adults } : {}),
        ...(patch.children !== undefined ? { children: patch.children } : {}),
        ...(patch.pricePerNight !== undefined
          ? { pricePerNight: new Prisma.Decimal(patch.pricePerNight) } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.withMeal !== undefined ? { withMeal: patch.withMeal } : {}),
        syncStatus: "PENDING",
      },
      include: reservationInclude,
    });
  });

  await notifyReservation("reservation.updated", result.id);

  // TZ 2-band 2, 5, 6-amal: mehmon soni / narx / izoh o'zgarishi.
  // Uchalasi ham bitta yo'ldan ketadi — worker DB'dagi joriy
  // holatni to'liq yuboradi (12-fayl §2).
  await onReservationChanged(result.id, "updated");
  return result;
}

/** 3. Xonani almashtirish (TZ 2-band, mijoz qarori Q6) */
export async function changeRoom(id: string, newRoomId: string) {
  const r = await serializableTx(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id }, include: { room: true } });
    if (!res) throw new NotFoundError("Bron");

    const newRoom = await tx.room.findUnique({ where: { id: newRoomId } });
    if (!newRoom) throw new NotFoundError(`Xona ${newRoomId}`);

    if (!(await isRoomFree(newRoomId, res.checkIn, res.checkOut, id, tx))) {
      throw new RoomUnavailableError("Bu xona endi ushbu sanalar uchun mavjud emas.");
    }

    const oldRoomId = res.roomId;
    const oldTypeId = res.room.roomTypeId;

    const updated = await tx.reservation.update({
      where: { id },
      data: { roomId: newRoomId, syncStatus: "PENDING" },
      include: reservationInclude,
    });

    await recalcRoomStatus(oldRoomId, tx);
    await recalcRoomStatus(newRoomId, tx);

    // 12-fayl §4: tur o'zgarsa IKKALA tur ham qayta hisoblanadi
    const types = oldTypeId === newRoom.roomTypeId
      ? [oldTypeId]
      : [oldTypeId, newRoom.roomTypeId];

    return {
      updated, types, from: res.checkIn, to: res.checkOut,
      previousRoomId: oldRoomId,        // 12-fayl §4: job payload'i uchun
    };
  }, "changeRoom");

  // Xona almashdi — tur o'zgargan bo'lsa IKKALA tur (12-fayl §4)
  await onAvailabilityChanged(r.types, r.from, r.to, "room_changed");
  await notifyReservation("reservation.updated", r.updated.id);

  // TZ 2-band 3-amal (mijoz qarori Q6): Beds24'da ham ko'rinadi
  await onReservationChanged(r.updated.id, "room_changed", {
    previousState: { roomId: r.previousRoomId },
  });
  return r.updated;
}

/** 4. Sanani o'zgartirish (TZ 2-band) */
export async function changeDates(id: string, checkInKey: string, checkOutKey: string) {
  const checkIn = fromDateKey(checkInKey);
  const checkOut = fromDateKey(checkOutKey);

  if (checkOut <= checkIn) {
    throw new ValidationError("Chiqish sanasi kirish sanasidan keyin bo'lishi kerak.");
  }

  const r = await serializableTx(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id }, include: { room: true } });
    if (!res) throw new NotFoundError("Bron");

    if (!(await isRoomFree(res.roomId, checkIn, checkOut, id, tx))) {
      throw new RoomUnavailableError("Yangi sanalar uchun xona to'qnashuvi.");
    }

    const updated = await tx.reservation.update({
      where: { id },
      data: { checkIn, checkOut, syncStatus: "PENDING" },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);

    // 12-fayl §5: eski ∪ yangi oraliq
    const from = res.checkIn < checkIn ? res.checkIn : checkIn;
    const to = res.checkOut > checkOut ? res.checkOut : checkOut;

    return {
      updated, roomTypeId: res.room.roomTypeId, from, to,
      // 12-fayl §5: job payload'i uchun eski oraliq
      previousCheckIn: toDateKey(res.checkIn) ?? undefined,
      previousCheckOut: toDateKey(res.checkOut) ?? undefined,
    };
  }, "changeDates");

  // Sana o'zgardi — eski ∪ yangi oraliq (12-fayl §5)
  await onAvailabilityChanged([r.roomTypeId], r.from, r.to, "dates_changed");
  await notifyReservation("reservation.updated", r.updated.id);

  // TZ 2-band 4-amal
  await onReservationChanged(r.updated.id, "dates_changed", {
    previousState: { checkIn: r.previousCheckIn, checkOut: r.previousCheckOut },
  });
  return r.updated;
}

/**
 * Bronni tasdiqlash: PENDING_PAYMENT -> CONFIRMED (13-fayl §5).
 *
 * Website'dan kelgan bron to'lov kutilayotgan holatda yaratiladi.
 * Admin to'lovni qabul qilgach shu amal chaqiriladi.
 *
 * NEGA ALOHIDA AMAL, `updateReservation` ichida emas: status
 * o'zgarishi biznes hodisasi — u Beds24'ga boshqa status yuboradi
 * (request -> confirmed), xona holatini qayta hisoblaydi va
 * kelajakda AuditLog talab qiladi. Uni oddiy maydon tahriri bilan
 * aralashtirish xatoga olib keladi.
 *
 * Faqat PENDING_PAYMENT dan o'tish mumkin: bekor qilingan yoki
 * chiqib ketgan bronni "tasdiqlash" ma'nosiz.
 */
export async function confirmReservation(id: string) {
  const r = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id } });
    if (!res) throw new NotFoundError("Bron");

    assertTransition(res.status, "CONFIRMED");

    const updated = await tx.reservation.update({
      where: { id },
      data: { status: "CONFIRMED", syncStatus: "PENDING" },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);
    return updated;
  });

  await notifyReservation("reservation.updated", r.id);
  await notifyRoomStatus(r.roomId);

  // Beds24'da status request -> confirmed (08-fayl §2)
  await onReservationChanged(r.id, "updated");
  return r;
}

/** 5. Check-in (TZ 2-band, mijoz qarori Q7) */
export async function checkIn(id: string) {
  const r = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.findUnique({
      where: { id },
      include: { room: true },
    });
    if (!res) throw new NotFoundError("Bron");
    assertTransition(res.status, "CHECKED_IN");

    /**
     * Tozalanmagan xonaga mehmon kiritilmaydi (SAVOLLAR.md S12).
     *
     * NEGA check-in da, bron yaratishda emas: bron kelajakka
     * qilinadi va xona o'shangacha tozalanadi. Faqat mehmon
     * eshik oldida turganda xona haqiqatan tayyor bo'lishi kerak.
     *
     * Farrosh xonani tozalab, panelda "tayyor" belgilaydi ->
     * status AVAILABLE bo'ladi -> check-in ochiladi.
     */
    if (res.room.status === "DIRTY") {
      throw new ValidationError(
        `Xona ${res.roomId} hali tozalanmagan — tozalangandan keyin ` +
        `mehmonni kiriting`
      );
    }

    if (res.room.status === "OUT_OF_ORDER" || res.room.status === "OUT_OF_SERVICE") {
      throw new ValidationError(
        `Xona ${res.roomId} ishlatishdan chiqarilgan — boshqa xona tanlang`
      );
    }

    const updated = await tx.reservation.update({
      where: { id },
      data: { status: "CHECKED_IN", checkedInAt: new Date(), syncStatus: "PENDING" },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);
    return updated;
  });

  await notifyReservation("reservation.updated", r.id);
  await notifyRoomStatus(r.roomId);

  // TZ 2-band 8-amal (mijoz qarori Q7): Beds24'da subStatus=arrived
  await onReservationChanged(r.id, "checked_in");
  return r;
}

/** 6. Check-out (TZ 2-band, mijoz qarori Q7) */
export async function checkOut(id: string) {
  const r = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id }, include: { room: true } });
    if (!res) throw new NotFoundError("Bron");
    assertTransition(res.status, "CHECKED_OUT");

    const updated = await tx.reservation.update({
      where: { id },
      data: { status: "CHECKED_OUT", checkedOutAt: new Date(), syncStatus: "PENDING" },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);
    return { updated, roomTypeId: res.room.roomTypeId, from: res.checkIn, to: res.checkOut };
  });

  // Erta check-out — qolgan kunlar bo'shaydi (07-fayl §3)
  await onAvailabilityChanged([r.roomTypeId], r.from, r.to, "checked_out");

  /**
   * Tozalash topshirig'i (TOZALIK-BOT.md §2A).
   *
   * Xona DIRTY bo'ldi — navbatdagi faroshga xabar ketadi.
   * Xato tashlamaydi: topshiriq yaratilmagani uchun check-out
   * bekor qilinmasligi kerak.
   */
  await createOnCheckout(r.updated.roomId);
  await notifyReservation("reservation.updated", r.updated.id);
  await notifyRoomStatus(r.updated.roomId);

  // TZ 2-band 8-amal: Beds24'da subStatus=departed
  await onReservationChanged(r.updated.id, "checked_out");
  return r.updated;
}

/**
 * Bekor qilish jarimasi (SAVOLLAR.md S11).
 *
 * QOIDA (2026-09-17 kelishuvi): kirish sanasiga `freeCancelHours`
 * dan kam qolgan bo'lsa `cancelFeeNights` kecha narxi olinadi.
 * Sozlamalardan o'zgartiriladi.
 *
 * NEGA JARIMA DAROMAD: xona band turgan va boshqa mehmonga
 * sotilmagan. Hisobotda "bekor qilingan = 0 daromad" ko'rsatish
 * haqiqatni buzardi.
 *
 * Beds24'dan kelgan bronlarga jarima QO'LLANMAYDI: OTA o'z
 * siyosatini yuritadi va ikki marta jarima olish noto'g'ri.
 */
async function cancellationFeeFor(res: {
  checkIn: Date;
  pricePerNight: Prisma.Decimal;
  channelId: string | null;
}): Promise<number> {
  if (res.channelId) return 0;   // OTA o'z siyosatini qo'llaydi

  const [freeHours, feeNights] = await Promise.all([
    getFreeCancelHours(),
    getCancelFeeNights(),
  ]);

  const hoursLeft = (res.checkIn.getTime() - Date.now()) / 3_600_000;
  if (hoursLeft >= freeHours) return 0;

  return Math.round(Number(res.pricePerNight) * feeNights);
}

/** 7. Bekor qilish (TZ 2-band) */
export async function cancelReservation(id: string) {
  // Jarima transaction'dan TASHQARIDA hisoblanadi: sozlamalarni
  // o'qish qulfni ushlab turmasin
  const before = await prisma.reservation.findUnique({
    where: { id },
    select: { checkIn: true, pricePerNight: true, channelId: true, status: true },
  });
  if (!before) throw new NotFoundError("Bron");

  const fee = await cancellationFeeFor(before);

  const r = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id }, include: { room: true } });
    if (!res) throw new NotFoundError("Bron");
    assertTransition(res.status, "CANCELLED");

    const updated = await tx.reservation.update({
      where: { id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        syncStatus: "PENDING",
        ...(fee > 0 ? { cancellationFee: new Prisma.Decimal(fee) } : {}),
      },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);
    return { updated, roomTypeId: res.room.roomTypeId, from: res.checkIn, to: res.checkOut };
  });

  // Bekor qilindi — kunlar bo'shaydi, Beds24'da availability oshadi
  // (TZ 6-band)
  await onAvailabilityChanged([r.roomTypeId], r.from, r.to, "reservation_cancelled");
  await notifyReservation("reservation.cancelled", r.updated.id);
  await notifyRoomStatus(r.updated.roomId);

  // TZ 2-band 7-amal: Beds24'da status=cancelled
  await onReservationChanged(r.updated.id, "cancelled");
  return r.updated;
}

/**
 * Bekor qilishdan OLDIN jarimani ko'rsatadi.
 *
 * Frontend buni bekor qilish tugmasi bosilganda chaqiradi va
 * xodimga "1 kecha narxi olinadi, davom etasizmi?" deb so'raydi.
 * Jarima kutilmaganda paydo bo'lmasin.
 */
export async function previewCancellation(id: string): Promise<{
  fee: number;
  freeUntilHours: number;
  isFree: boolean;
}> {
  const res = await prisma.reservation.findUnique({
    where: { id },
    select: { checkIn: true, pricePerNight: true, channelId: true },
  });
  if (!res) throw new NotFoundError("Bron");

  const [fee, freeHours] = await Promise.all([
    cancellationFeeFor(res),
    getFreeCancelHours(),
  ]);

  return { fee, freeUntilHours: freeHours, isFree: fee === 0 };
}

/** No-show (08-fayl §4 — faqat qo'lda, avtomatik emas) */
export async function markNoShow(id: string) {
  const r = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.findUnique({ where: { id }, include: { room: true } });
    if (!res) throw new NotFoundError("Bron");
    assertTransition(res.status, "NO_SHOW");

    const updated = await tx.reservation.update({
      where: { id },
      data: { status: "NO_SHOW", syncStatus: "PENDING" },
      include: reservationInclude,
    });

    await recalcRoomStatus(res.roomId, tx);
    return { updated, roomTypeId: res.room.roomTypeId, from: res.checkIn, to: res.checkOut };
  });

  // No-show — xona bo'shaydi (TZ 6-band)
  await onAvailabilityChanged([r.roomTypeId], r.from, r.to, "no_show");
  await notifyReservation("reservation.cancelled", r.updated.id);
  await notifyRoomStatus(r.updated.roomId);

  // Beds24'da status=black (08-fayl §2)
  await onReservationChanged(r.updated.id, "no_show");
  return r.updated;
}

// --- To'lov va xarajat (TZ 14-band) -------------------------

/**
 * Bronning hozirgi qarzi (SAVOLLAR.md S1).
 *
 * Formula serializeReservation() bilan bir xil bo'lishi SHART:
 * xona narxi x kecha + qo'shimcha xizmatlar - to'langan.
 */
async function currentBalance(
  reservationId: string
): Promise<{ total: number; paid: number; due: number }> {
  const res = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: reservationInclude,
  });
  if (!res) throw new NotFoundError("Bron");

  /**
   * Formula `serializeReservation()` dan olinadi — YAGONA MANBA.
   *
   * NEGA: ilgari formula ikki joyda yozilgan edi. Nonushta
   * qo'shilganda biri yangilanib, ikkinchisi eski qolsa, xodim
   * to'liq to'lay olmay qolardi ("qarz 0" deydi, lekin to'lovni
   * rad etadi) — sababini hech kim topa olmasdi.
   */
  const view = serializeReservation(res);

  return {
    total: view.totalPrice,
    paid: view.paidAmount,
    due: view.totalPrice - view.paidAmount,
  };
}

/** So'm formatlash — xato xabarlarida "450 000 so'm" ko'rinishi uchun */
function som(n: number): string {
  return Math.round(n).toLocaleString("ru-RU").replace(/\u00a0/g, " ") + " so'm";
}

/**
 * Haqiqatan mavjud foydalanuvchi ID'sini qaytaradi, aks holda null.
 *
 * NEGA KERAK: dev rejimida `authMiddleware` soxta `id: "dev"`
 * beradi (AUTH_REQUIRED=false), bunday User yo'q va to'lov yozish
 * foreign key xatosi bilan yiqilardi. Beds24 webhook'idan kelgan
 * to'lovda ham xodim yo'q.
 *
 * To'lovni yozish — asosiy amal, "kim qabul qildi" esa qo'shimcha
 * ma'lumot. Noma'lum xodim tufayli mehmonning puli yozilmay
 * qolishi mumkin emas.
 */
async function resolveUserId(userId?: string): Promise<string | null> {
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  return user?.id ?? null;
}

/**
 * To'lov qo'shish.
 *
 * IKKI CHEGARA (SAVOLLAR.md S1, S2):
 *   1. Musbat to'lov qarzdan oshmasin — kassada ortiqcha pul
 *      ko'rinib, hisobot daromadi haqiqatdan katta bo'lib qolardi
 *   2. Manfiy to'lov (qaytarish) to'langandan oshmasin — aks holda
 *      balans manfiyga tushib, mehmonxona mehmondan qarzdor
 *      bo'lib qolardi
 */
export async function addPayment(
  reservationId: string,
  amount: number,
  method: string,
  note?: string,
  userId?: string
) {
  const res = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!res) throw new NotFoundError("Bron");

  if (amount === 0) {
    throw new ValidationError("To'lov summasi noldan farqli bo'lishi kerak");
  }

  const { paid, due } = await currentBalance(reservationId);

  if (amount > 0 && amount > due) {
    throw new ValidationError(
      due <= 0
        ? "Bron to'liq to'langan — qo'shimcha to'lov qabul qilinmaydi"
        : `To'lov qarzdan oshib ketdi: qarz ${som(due)}, kiritilgan ${som(amount)}`
    );
  }

  if (amount < 0 && -amount > paid) {
    throw new ValidationError(
      `Qaytarish summasi to'langandan ko'p: to'langan ${som(paid)}, ` +
      `qaytarilmoqchi ${som(-amount)}`
    );
  }

  await prisma.payment.create({
    data: {
      reservationId,
      amount: new Prisma.Decimal(amount),
      method,
      paymentDate: new Date(),
      note,
      userId: await resolveUserId(userId),
    },
  });

  const updated = await prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: reservationInclude,
  });
  await notifyPayment(reservationId);
  return updated;
}

/** To'lovni qaytarish — manfiy summa sifatida (frontend mantiqi bilan bir xil) */
/**
 * To'lovni qaytarish — manfiy summa sifatida yoziladi.
 *
 * Asl to'lov o'chirilmaydi: audit uchun "qabul qilindi, keyin
 * qaytarildi" ikkalasi ham ko'rinib tursin.
 */
export async function reversePayment(
  reservationId: string,
  paymentId: string,
  userId?: string
) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new NotFoundError("To'lov");

  if (payment.reservationId !== reservationId) {
    throw new ValidationError("To'lov bu bronga tegishli emas");
  }

  const amount = Number(payment.amount.toString());

  if (amount < 0) {
    throw new ValidationError("Qaytarilgan to'lovni yana qaytarib bo'lmaydi");
  }

  // Balansni manfiyga tushirmaslik (S2): bir to'lov ikki marta
  // qaytarilsa yoki qo'lda manfiy to'lov kiritilgan bo'lsa to'sadi
  const { paid } = await currentBalance(reservationId);
  if (amount > paid) {
    throw new ValidationError(
      `Bu to'lov allaqachon qaytarilgan (to'langan qoldiq ${som(paid)})`
    );
  }

  await prisma.payment.create({
    data: {
      reservationId,
      amount: new Prisma.Decimal(-amount),
      method: payment.method,
      paymentDate: new Date(),
      note: `Qaytarildi: ${som(amount)} (${payment.method})`,
      userId: await resolveUserId(userId),
    },
  });

  const updated = await prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: reservationInclude,
  });
  await notifyPayment(reservationId);
  return updated;
}

/**
 * Qo'shimcha xizmat (kir yuvish, minibar, transfer).
 *
 * Musbat bo'lishi shart: chegirma xarajat orqali emas, narxni
 * o'zgartirish orqali beriladi (SAVOLLAR.md S4).
 */
export async function addCharge(reservationId: string, label: string, amount: number) {
  const res = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!res) throw new NotFoundError("Bron");

  if (amount <= 0) {
    throw new ValidationError("Xizmat summasi musbat bo'lishi kerak");
  }

  await prisma.charge.create({
    data: { reservationId, label, amount: new Prisma.Decimal(amount) },
  });

  const updated = await prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: reservationInclude,
  });
  // Xarajat total'ni o'zgartiradi -> PayPill yangilanishi kerak
  await notifyPayment(reservationId);
  return updated;
}

// --- O'qish -------------------------------------------------

export async function listReservations(from?: string, to?: string) {
  const where: Prisma.ReservationWhereInput = {};
  if (from && to) {
    where.checkIn = { lt: fromDateKey(to) };
    where.checkOut = { gt: fromDateKey(from) };
  }
  return prisma.reservation.findMany({
    where,
    include: reservationInclude,
    orderBy: { checkIn: "asc" },
  });
}

export async function getReservation(id: string) {
  const res = await prisma.reservation.findUnique({ where: { id }, include: reservationInclude });
  if (!res) throw new NotFoundError("Bron");
  return res;
}

export { ACTIVE_STATUSES };
