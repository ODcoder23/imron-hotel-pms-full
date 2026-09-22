/**
 * Beds24 <-> PMS status mapping — TZ 8-band
 *
 * Manba: 08-RESERVATION-STATUS-VA-TOLOV.md §2, §3 | 12-fayl §6
 * Mijoz qarori Q5 (ikki yangi status), Q7 (check-in/out sync).
 *
 * NEGA BITTA FAYL: aniq qiymatlar Beds24 hisobi sozlamasiga qarab
 * farq qilishi mumkin (`black` statusi bormi, `subStatus` maydonining
 * nomi qanday). Haqiqiy ulanishda nomuvofiqlik chiqsa — faqat shu
 * fayl o'zgaradi, qolgan kod tegilmaydi.
 *
 * TZ 8-band PMS'da OLTITA statusni talab qiladi:
 *   PENDING_PAYMENT, CONFIRMED, CHECKED_IN, CHECKED_OUT,
 *   CANCELLED, NO_SHOW
 * Beds24 biror statusni qo'llab-quvvatlamasa, PMS tomondagi status
 * baribir o'zgarmaydi — kanal cheklovi PMS'ga ta'sir qilmaydi.
 */

import type { ReservationStatus } from "@prisma/client";
import type { ExternalReservation } from "../channel/types.js";

/** Beds24'ga yuboriladigan status juftligi */
export type Beds24StatusPair = {
  status: string;
  subStatus?: string;
};

/**
 * Beds24 -> PMS.
 *
 * `new` statusi to'lov holatiga qarab hal qilinadi: Beds24'da
 * "new" hali tasdiqlanmagan bronni ham, oldindan to'langanini ham
 * bildiradi (08-fayl §2 jadvali).
 */
export function toPmsStatus(ext: ExternalReservation): ReservationStatus {
  const s = ext.status.toLowerCase();
  const sub = ext.subStatus?.toLowerCase();

  if (s === "cancelled" || s === "canceled") return "CANCELLED";
  if (s === "black") return "NO_SHOW";
  if (s === "request") return "PENDING_PAYMENT";

  if (s === "new") {
    const paid = (ext.payments ?? []).reduce((n, p) => n + p.amount, 0);
    return paid > 0 ? "CONFIRMED" : "PENDING_PAYMENT";
  }

  if (s === "confirmed") {
    if (sub === "departed") return "CHECKED_OUT";
    if (sub === "arrived") return "CHECKED_IN";
    return "CONFIRMED";
  }

  // Noma'lum status — eng xavfsiz taxmin. Bronni yo'qotgandan
  // ko'ra tasdiqlangan deb qabul qilish yaxshi (TZ 17-band).
  return "CONFIRMED";
}

/**
 * PMS -> Beds24 (12-fayl §6, mijoz qarori Q7).
 *
 * CHECK-IN / CHECK-OUT: Beds24'da alohida status yo'q, ular
 * `confirmed` + `subStatus` orqali beriladi. Mijoz tasdiqladi —
 * Beds24 buni qo'llab-quvvatlaydi.
 *
 * Agar hisob sozlamasi `subStatus`ni qabul qilmasa, bron baribir
 * `confirmed` sifatida ketadi va PMS tomonda check-in normal
 * ishlayveradi (TZ 17, 19-band).
 */
export function toBeds24Status(s: ReservationStatus): Beds24StatusPair {
  switch (s) {
    case "PENDING_PAYMENT": return { status: "request" };
    case "CONFIRMED":       return { status: "confirmed" };
    case "CHECKED_IN":      return { status: "confirmed", subStatus: "arrived" };
    case "CHECKED_OUT":     return { status: "confirmed", subStatus: "departed" };
    case "CANCELLED":       return { status: "cancelled" };
    case "NO_SHOW":         return { status: "black" };
  }
}

/**
 * Ikki tomonlama aylanish buzilmasligini tekshiradi.
 *
 * PMS -> Beds24 -> PMS zanjiri asl statusni qaytarishi kerak,
 * aks holda bron yuborilgandan keyin webhook qaytganda status
 * o'zgarib ketadi va cheksiz o'zgarish halqasi paydo bo'ladi.
 *
 * `PENDING_PAYMENT` bundan mustasno: Beds24'ga `request` bo'lib
 * ketadi, qaytganda ham `request` -> `PENDING_PAYMENT`. To'lov
 * qo'shilgan holat esa `new` orqali keladi, u boshqa yo'l.
 */
export function roundTripsCleanly(s: ReservationStatus): boolean {
  const pair = toBeds24Status(s);
  const back = toPmsStatus({
    externalId: "0",
    externalRoomTypeId: "0",
    status: pair.status,
    subStatus: pair.subStatus,
    checkIn: "2026-01-01",
    checkOut: "2026-01-02",
    adults: 1,
    children: 0,
    price: 0,
    currency: "USD",
    guest: { fullName: "x" },
    modifiedAt: new Date().toISOString(),
  });
  return back === s;
}
