/**
 * API serializatsiya qatlami
 *
 * Manba: 02-DATABASE-SXEMA.md §3 — Shaxmatka moslik jadvali
 *
 * YAGONA JOY. Har controllerda alohida konvertatsiya yozilmaydi.
 * Prisma `Decimal` obyekt qaytaradi, frontend esa son kutadi
 * (`p.amount` ustida `reduce` qiladi) — shu yerda o'giriladi.
 */

import type { Prisma } from "@prisma/client";

// --- Ibtidoiy konvertorlar ----------------------------------

/** Prisma Decimal | number | string → number */
export const toNumber = (v: Prisma.Decimal | number | string | null): number => {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v.toString());
};

/** DateTime → "YYYY-MM-DD" (Shaxmatka toKey() bilan bir xil) */
export const toDateKey = (d: Date | null): string | null => {
  if (!d) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/** "YYYY-MM-DD" → Date (UTC yarim tunda, vaqt zonasi siljishisiz) */
export const fromDateKey = (s: string): Date => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

/** BOOKING_COM → "booking_com" (frontend SOURCES kaliti) */
export const enumToKey = (e: string): string => e.toLowerCase();

/** "booking_com" → BOOKING_COM */
export const keyToEnum = (k: string): string => k.toUpperCase();

// --- Room ---------------------------------------------------

type RoomRow = {
  id: string;
  number: string;
  floor: number;
  floorId?: string | null;
  roomTypeId: string;
  status: string;
  isActive: boolean;
  sortOrder: number;
};

/**
 * Shaxmatka `rooms` massivi elementi:
 *   { id, number, type, floor, status }
 *
 * `floorId` qo'shildi (2026-09-16): qavatning o'z ID'si barcha
 * tizimlarga bir xil qiymat bo'lib tarqaladi. Shaxmatka uni hozircha
 * ishlatmaydi va e'tiborsiz qoldiradi — `floor` (son) o'z joyida
 * qolgani uchun mavjud kod o'zgarmaydi.
 */
export function serializeRoom(r: RoomRow) {
  return {
    id: r.id,                      // "101" — Q2
    number: r.number,
    type: r.roomTypeId,            // "standard"
    floor: r.floor,
    floorId: r.floorId ?? null,    // "F1"
    status: enumToKey(r.status),   // "available"
    // Frontendda yo'q, e'tiborsiz qoldiriladi:
    isActive: r.isActive,
    sortOrder: r.sortOrder,
  };
}

// --- Floor --------------------------------------------------

type FloorRow = {
  id: string;
  number: number;
  label: string;
  isActive: boolean;
  sortOrder: number;
};

export const serializeFloor = (f: FloorRow) => ({
  id: f.id,           // "F1" — barcha tizimlarda shu qiymat
  number: f.number,   // 1
  label: f.label,     // "1-qavat"
  isActive: f.isActive,
  sortOrder: f.sortOrder,
});

// --- Charge / Payment ---------------------------------------

type ChargeRow = { id: string; label: string; amount: Prisma.Decimal };
type PaymentRow = {
  id: string;
  amount: Prisma.Decimal;
  method: string;
  paymentDate: Date;
  note: string | null;
  externalPaymentId: string | null;
};

export const serializeCharge = (c: ChargeRow) => ({
  id: c.id,
  label: c.label,
  amount: toNumber(c.amount),
});

export const serializePayment = (p: PaymentRow) => ({
  id: p.id,
  amount: toNumber(p.amount),
  method: p.method,
  date: toDateKey(p.paymentDate),   // frontend `p.date` kutadi
  note: p.note ?? "",
  externalPaymentId: p.externalPaymentId,
});

// --- Reservation --------------------------------------------

type ReservationRow = {
  id: string;
  roomId: string;
  guest: { fullName: string; phone: string | null; email: string | null };
  checkIn: Date;
  checkOut: Date;
  adults: number;
  children: number;
  source: string;
  pricePerNight: Prisma.Decimal;
  currency: string;
  notes: string | null;
  withMeal: boolean;
  mealPricePerPerson?: Prisma.Decimal | null;
  cancellationFee?: Prisma.Decimal | null;
  priceReason?: string | null;
  status: string;
  channelId: string | null;
  externalReservationId: string | null;
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
  syncStatus: string;
  createdAt: Date;
  charges?: ChargeRow[];
  payments?: PaymentRow[];
};

/**
 * Shaxmatka `reservations` massivi elementi.
 *
 * Muhim: `guest` obyekti FLATTEN qilinadi — frontend `res.guestName`
 * va `res.phone` kutadi, ichma-ich obyekt emas.
 */
export function serializeReservation(r: ReservationRow) {
  const charges = (r.charges ?? []).map(serializeCharge);
  const payments = (r.payments ?? []).map(serializePayment);

  // TZ 14-band formulasi (08-fayl §6) — frontend bilan bir xil
  const nights = Math.max(
    1,
    Math.round((r.checkOut.getTime() - r.checkIn.getTime()) / 86_400_000)
  );
  const chargesTotal = charges.reduce((s, c) => s + c.amount, 0);

  /**
   * Nonushta (SAVOLLAR.md S10): kishi boshiga, har kecha uchun.
   *
   * Narx BRONDAN olinadi (sozlamadan emas): bron yaratilganda
   * ko'chirilgan, keyin narx ko'tarilsa eski bron summasi
   * o'zgarmasin.
   */
  const guests = r.adults + r.children;
  const mealPrice = r.mealPricePerPerson ? toNumber(r.mealPricePerPerson) : 0;
  const mealTotal = r.withMeal ? mealPrice * guests * nights : 0;

  /**
   * Bekor qilish jarimasi (SAVOLLAR.md S11).
   *
   * Bekor qilingan bronda xona narxi hisoblanmaydi — mehmon
   * kelmagan. Faqat jarima to'lanadi.
   */
  const isCancelled = r.status === "CANCELLED" || r.status === "NO_SHOW";
  const cancellationFee = r.cancellationFee ? toNumber(r.cancellationFee) : 0;

  const totalPrice = isCancelled
    ? cancellationFee
    : toNumber(r.pricePerNight) * nights + chargesTotal + mealTotal;

  const paidAmount = payments.reduce((s, p) => s + p.amount, 0);

  return {
    id: r.id,
    roomId: r.roomId,
    guestName: r.guest.fullName,          // flatten
    phone: r.guest.phone ?? "",           // flatten
    checkIn: toDateKey(r.checkIn),
    checkOut: toDateKey(r.checkOut),
    adults: r.adults,
    children: r.children,
    source: enumToKey(r.source),          // "booking_com"
    pricePerNight: toNumber(r.pricePerNight),
    notes: r.notes ?? "",
    withMeal: r.withMeal,
    // Nonushta tafsiloti — Shaxmatka hisobni ko'rsatishi uchun
    mealPricePerPerson: mealPrice,
    mealTotal,
    // Bekor qilish jarimasi (0 bo'lsa bepul bekor qilingan)
    cancellationFee,
    priceReason: r.priceReason ?? "",
    status: enumToKey(r.status),          // "pending_payment" (Q5)
    charges,
    payments,
    createdAt: r.createdAt.getTime(),     // epoch ms

    // Hisoblangan (TZ 14-band) — frontend o'zi ham hisoblaydi,
    // lekin API tayyor qaytaradi
    totalPrice,
    paidAmount,
    remainingAmount: Math.max(totalPrice - paidAmount, 0),
    refundDue: Math.max(paidAmount - totalPrice, 0),

    // Yangi maydonlar — frontend e'tiborsiz qoldiradi
    currency: r.currency,
    channelId: r.channelId,
    externalReservationId: r.externalReservationId,
    checkedInAt: r.checkedInAt?.toISOString() ?? null,
    checkedOutAt: r.checkedOutAt?.toISOString() ?? null,
    syncStatus: enumToKey(r.syncStatus),
  };
}

// --- RoomType -----------------------------------------------

type RoomTypeRow = {
  id: string;
  label: string;
  multiplier: number;
  maxAdults: number;
  sortOrder: number;
};

/**
 * `maxAdults` qo'shildi (2026-09-16): admin panel "Maks. odam"
 * ustunini shu maydondan oladi. Shaxmatka uni e'tiborsiz
 * qoldiradi — qo'shimcha maydon zarar qilmaydi.
 */
export const serializeRoomType = (t: RoomTypeRow) => ({
  id: t.id,
  label: t.label,
  multiplier: t.multiplier,
  maxAdults: t.maxAdults,
  sortOrder: t.sortOrder,
});
