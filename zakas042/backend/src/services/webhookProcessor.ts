/**
 * Webhook -> Reservation — TZ 1, 4, 9-band
 *
 * Manba: 04-WEBHOOK-HANDLER.md §2 (6-7 qadam), §4, §5
 *        06-XONA-MAPPING.md §5 — avtomatik xona biriktirish (Q3)
 *        08-RESERVATION-STATUS-VA-TOLOV.md §2 — status mapping
 *
 * Bu FAZA 6 da to'plangan `QUEUED` event'larni qayta ishlaydi:
 *   a. externalReservationId bo'yicha mavjud bron qidiriladi
 *   b. Topilmasa -> mapping orqali xona aniqlanadi, yangi bron
 *   c. Topilsa -> mavjud bron yangilanadi
 *   d. Availability qayta hisoblanadi
 *   e. status = PROCESSED
 *
 * MIJOZ QARORI Q3: xona AVTOMATIK biriktiriladi, admin aralashmaydi.
 */

import { Prisma, type ReservationStatus, type ReservationSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { fromDateKey } from "../lib/serialize.js";
import { getChannel } from "./channel/registry.js";
import { findByExternal } from "./mapping.js";
import { recalcRoomStatus, isRoomFree } from "./reservations.js";
// Status mapping markaziy faylda (08-fayl §2, 12-fayl §6) — bu yerda
// faqat qayta eksport, chunki mavjud testlar shu yo'ldan import qiladi.
import { toPmsStatus } from "./beds24/statusMap.js";
export { toPmsStatus };
import { onAvailabilityChanged } from "./availability.js";
import { applyExternalRate } from "./rates.js";
import type { ExternalReservation } from "./channel/types.js";
import {
  notifyReservation, notifyPayment, notifyWebhookNeedsAttention,
} from "../realtime/notify.js";
import { channelBookingHasMeal } from "./kitchen.js";

export type ProcessResult = {
  status: "processed" | "skipped" | "needs_manual_action" | "failed";
  reservationId?: string;
  detail: string;
  /**
   * Yangi bron yaratildimi (true) yoki mavjudi yangilandimi (false).
   *
   * Polling fallback hisobot uchun ishlatadi. Matndan ("Yangi bron")
   * aniqlash mo'rt — matn o'zgarsa hisob jim buziladi.
   */
  created?: boolean;
};

// ============================================================
//  Status mapping (08-fayl §2)
// ============================================================


/** OTA nomini `ReservationSource` enum'iga aylantiradi */
export function toSource(referer?: string): ReservationSource {
  const r = (referer ?? "").toLowerCase();
  if (r.includes("booking")) return "BOOKING_COM";
  if (r.includes("airbnb")) return "AIRBNB";
  if (r.includes("expedia")) return "EXPEDIA";
  if (r.includes("pms")) return "DIRECT";
  return "OTHER";
}

// ============================================================
//  Avtomatik xona biriktirish (06-fayl §5, Q3)
// ============================================================

export type AssignResult =
  | { ok: true; roomId: string; roomTypeId: string; needsAttention: boolean }
  | { ok: false; reason: "no_mapping" | "no_free_room"; detail: string };

/**
 * Kelgan bron uchun xona tanlaydi.
 *
 * QAT'IY QOIDA (06-fayl §4): mapping topilmasa bron YARATILMAYDI.
 * Taxminiy mapping aslo ishlatilmaydi — noto'g'ri xonaga tushgan
 * bron real overbooking keltiradi.
 *
 * Bo'sh xona topilmasa — bu Beds24 bizda bo'lmagan xonani sotgan
 * degani. Bron baribir saqlanadi (`needsAttention`), chunki u real
 * mehmon va OTA'da tasdiqlangan. Rad etish OTA qoidalariga zid.
 */
export async function assignRoom(
  ext: ExternalReservation,
  excludeReservationId?: string
): Promise<AssignResult> {
  const mapping = await findByExternal(ext.externalRoomTypeId, ext.externalUnitId);

  if (!mapping) {
    return {
      ok: false,
      reason: "no_mapping",
      detail:
        `Beds24 room type ${ext.externalRoomTypeId} uchun mapping yo'q. ` +
        `/admin/mapping sahifasida bog'lang, keyin "Qayta ishlash" bosing.`,
    };
  }

  const checkIn = fromDateKey(ext.checkIn);
  const checkOut = fromDateKey(ext.checkOut);

  // 1) Unit darajasidagi mapping — aniq xona ko'rsatilgan
  if (mapping.roomId) {
    const free = await isRoomFree(mapping.roomId, checkIn, checkOut, excludeReservationId);
    if (free) {
      const room = await prisma.room.findUniqueOrThrow({ where: { id: mapping.roomId } });
      return { ok: true, roomId: room.id, roomTypeId: room.roomTypeId, needsAttention: false };
    }
    // Band bo'lsa — tur darajasiga tushamiz, lekin belgilaymiz
  }

  const roomTypeId = mapping.roomTypeId ?? mapping.room?.roomTypeId;
  if (!roomTypeId) {
    return { ok: false, reason: "no_mapping", detail: "Mapping'da xona turi ko'rsatilmagan" };
  }

  // 2) Tur bo'yicha bo'sh xona (06-fayl §5 algoritmi)
  const candidates = await prisma.room.findMany({
    where: {
      roomTypeId,
      isActive: true,
      status: { notIn: ["OUT_OF_ORDER", "OUT_OF_SERVICE"] },
    },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });

  for (const room of candidates) {
    if (await isRoomFree(room.id, checkIn, checkOut, excludeReservationId)) {
      return { ok: true, roomId: room.id, roomTypeId, needsAttention: false };
    }
  }

  // 3) Bo'sh xona yo'q — overbooking signali (06-fayl §5)
  return {
    ok: false,
    reason: "no_free_room",
    detail:
      `${roomTypeId} turida ${ext.checkIn}..${ext.checkOut} uchun bo'sh xona yo'q. ` +
      `Beds24 bizda mavjud bo'lmagan xonani sotgan — admin qo'lda hal qilishi kerak.`,
  };
}

// ============================================================
//  Asosiy ishlov (04-fayl §2, 6-qadam)
// ============================================================

export async function processWebhookEvent(webhookEventId: string): Promise<ProcessResult> {
  const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!event) return { status: "failed", detail: "WebhookEvent topilmadi" };

  // Allaqachon ishlangan
  if (event.status === "PROCESSED" || event.status === "IGNORED_DUPLICATE") {
    return { status: "skipped", detail: `Allaqachon ${event.status}` };
  }

  const parsed = getChannel().parseWebhook(event.rawPayload);

  // --- Echo loop himoyasi (04-fayl §6) ---
  //
  // Bizning o'z yuborgan bronimiz Beds24'dan qaytdi — qayta
  // yozish shart emas, aks holda cheksiz halqa bo'ladi.
  //
  // IKKI SHART (2026-09-16 da ikkinchisi qo'shildi):
  //
  //   1. `referer === "PMS"` — biz yuborgan bron belgisi
  //   2. Shu `externalId` bazada ALLAQACHON bor
  //
  // Nega ikkinchisi kerak: `referer` ni faqat biz emas, boshqa
  // tomon ham yozishi mumkin (Beds24 sozlamasi, mehmonxona nomi,
  // OTA maydoni). Faqat birinchi shartga tayanilganda OTA'dan
  // kelgan yangi bron JIMGINA YO'QOLARDI — na xato, na log.
  //
  // Endi "biz bilmagan bron" hech qachon echo deb hisoblanmaydi:
  // uni saqlaymiz, keyin `payloadHash` va `externalId` unique
  // constraint dublikatdan himoya qiladi.
  if (parsed.isOwnEcho && parsed.externalId) {
    const known = await prisma.reservation.findFirst({
      where: { externalReservationId: parsed.externalId },
      select: { id: true },
    });

    if (known) {
      await markProcessed(webhookEventId, "O'z aks-sadosi (referer=PMS) — e'tiborsiz qoldirildi");
      await logSync("webhook_echo_skipped", "SKIPPED", known.id, "referer=PMS");
      return { status: "skipped", detail: "O'z aks-sadosi" };
    }

    // referer="PMS", lekin bron bizda yo'q — demak bu echo emas.
    // Ogohlantirish yozamiz: sozlama noto'g'ri bo'lishi mumkin.
    console.warn(
      `[webhook] referer=PMS, lekin ${parsed.externalId} bazada yo'q — ` +
      `yangi bron sifatida qabul qilindi`
    );
  }

  // --- Narx o'zgarishi (TZ 7-band, 07-fayl §7) ---
  // Bron ma'lumoti yo'q, lekin e'tiborsiz qoldirib bo'lmaydi:
  // TZ "Beds24dan narx o'zgarsa PMSga ham update kelishi kerak"
  // deydi. Source of truth qaroriga `applyExternalRate` o'zi
  // qaraydi — halqa himoyasi o'sha yerda.
  if (parsed.event === "rate.changed" || parsed.event === "price.changed") {
    const applied = await applyRateEvent(event.rawPayload);
    await markProcessed(webhookEventId, applied);
    return { status: "processed", detail: applied };
  }

  // --- Bron ma'lumoti yo'q event (ping, noma'lum tur) ---
  if (!parsed.reservation) {
    await markProcessed(webhookEventId, `Event '${parsed.event}' bron ma'lumotisiz`);
    return { status: "skipped", detail: "Bron ma'lumoti yo'q" };
  }

  const ext = parsed.reservation;

  try {
    const result = await applyReservation(parsed.event, ext);

    if (result.status === "needs_manual_action") {
      await prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { status: "NEEDS_MANUAL_ACTION", errorMessage: result.detail },
      });
      await logSync("webhook_needs_action", "FAILED", null, result.detail);
      // Admin panelga ogohlantirish (09-fayl §2)
      notifyWebhookNeedsAttention(webhookEventId, result.detail);
      return result;
    }

    await markProcessed(webhookEventId, result.detail);
    await logSync(
      `webhook_${parsed.event.replace(/\./g, "_")}`,
      "SUCCESS",
      result.reservationId ?? null,
      result.detail
    );
    return result;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: {
        status: "FAILED",
        errorMessage: detail.slice(0, 500),
        attempts: { increment: 1 },
      },
    });
    await logSync("webhook_failed", "FAILED", null, detail);
    throw e;    // BullMQ retry qilishi uchun
  }
}

/**
 * Bronni yaratadi yoki yangilaydi.
 *
 * TZ 9-band: `@@unique([channelId, externalReservationId])` —
 * hatto mantiq xato qilsa ham ikkinchi bron jismonan yaratilmaydi.
 */
/**
 * Kelgan bronni PMS'ga qo'llaydi — yaratish yoki yangilash.
 *
 * EKSPORT QILINGAN (04-fayl §8): polling fallback aynan shu
 * funksiyani ishlatadi, o'z mantig'ini yozmaydi. Aks holda ikki
 * yo'l bir-biridan uzoqlashadi va webhook'da tuzatilgan xato
 * polling'da qolib ketadi.
 */
export async function applyReservation(
  eventType: string,
  ext: ExternalReservation
): Promise<ProcessResult> {
  const channel = await prisma.channel.findUniqueOrThrow({ where: { code: "beds24" } });

  const existing = await prisma.reservation.findFirst({
    where: { channelId: channel.id, externalReservationId: ext.externalId },
    include: { room: true },
  });

  const status = toPmsStatus(ext);
  const nights = Math.max(
    1,
    Math.round(
      (fromDateKey(ext.checkOut).getTime() - fromDateKey(ext.checkIn).getTime()) / 86_400_000
    )
  );
  const pricePerNight = ext.price > 0 ? ext.price / nights : 0;

  // ===== MAVJUD BRONNI YANGILASH =====
  if (existing) {
    const dateChanged =
      existing.checkIn.toISOString().slice(0, 10) !== ext.checkIn ||
      existing.checkOut.toISOString().slice(0, 10) !== ext.checkOut;

    // Sana o'zgargan bo'lsa xona bo'shligini qayta tekshirish kerak
    let roomId = existing.roomId;
    if (dateChanged && status !== "CANCELLED" && status !== "NO_SHOW") {
      const free = await isRoomFree(
        existing.roomId,
        fromDateKey(ext.checkIn),
        fromDateKey(ext.checkOut),
        existing.id
      );
      if (!free) {
        const assigned = await assignRoom(ext, existing.id);
        if (!assigned.ok) {
          return {
            status: "needs_manual_action",
            reservationId: existing.id,
            detail: `Sana o'zgardi, lekin ${assigned.detail}`,
          };
        }
        roomId = assigned.roomId;
      }
    }

    const updated = await prisma.reservation.update({
      where: { id: existing.id },
      data: {
        roomId,
        checkIn: fromDateKey(ext.checkIn),
        checkOut: fromDateKey(ext.checkOut),
        adults: ext.adults,
        children: ext.children,
        pricePerNight: new Prisma.Decimal(pricePerNight.toFixed(2)),
        currency: ext.currency,
        status,
        notes: ext.notes ?? existing.notes,
        checkedInAt: status === "CHECKED_IN" ? (existing.checkedInAt ?? new Date()) : existing.checkedInAt,
        checkedOutAt: status === "CHECKED_OUT" ? (existing.checkedOutAt ?? new Date()) : existing.checkedOutAt,
        cancelledAt: status === "CANCELLED" ? (existing.cancelledAt ?? new Date()) : existing.cancelledAt,
        syncStatus: "SYNCED",       // Beds24'dan keldi, qayta yuborish kerak emas
        lastSyncedAt: new Date(),
      },
    });

    await syncPayments(updated.id, channel.id, ext);
    await recalcRoomStatus(existing.roomId);
    if (roomId !== existing.roomId) await recalcRoomStatus(roomId);

    const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });

    // Eski ∪ yangi oraliq, ikkala tur (12-fayl §4, §5). Bekor
    // qilinish ham shu yo'ldan o'tadi — kunlar bo'shaydi.
    await onAvailabilityChanged(
      [...new Set([existing.room.roomTypeId, room.roomTypeId])],
      fromDateKey(ext.checkIn) < existing.checkIn ? fromDateKey(ext.checkIn) : existing.checkIn,
      fromDateKey(ext.checkOut) > existing.checkOut ? fromDateKey(ext.checkOut) : existing.checkOut,
      "ota_reservation_updated"
    );

    // TZ 4, 15-band: Shaxmatka sahifani yangilamasdan ko'radi.
    // DB transaction tugagandan KEYIN yuboriladi (09-fayl §1).
    await notifyReservation(
      status === "CANCELLED" ? "reservation.cancelled" : "reservation.updated",
      updated.id
    );
    if ((ext.payments ?? []).length > 0) await notifyPayment(updated.id);

    return {
      status: "processed",
      reservationId: updated.id,
      detail: `Bron yangilandi: ${status}, xona ${roomId}`,
      created: false,
    };
  }

  // ===== YANGI BRON =====

  // Bekor qilingan bronni yaratish ma'nosiz
  if (status === "CANCELLED" || status === "NO_SHOW") {
    return {
      status: "skipped",
      detail: `Yangi bron ${status} holatida keldi — yaratilmadi`,
    };
  }

  const assigned = await assignRoom(ext);
  if (!assigned.ok) {
    return { status: "needs_manual_action", detail: assigned.detail };
  }

  // Mehmon: telefon yoki email bo'yicha qidiriladi
  const guest = await findOrCreateGuest(ext);

  /**
   * Ovqat tarifi (BOTLAR-REJA.md, 2026-09-17).
   *
   * Beds24 ovqat haqida standart maydon bermaydi — ular
   * "nonushta bilan" va "nonushtasiz" alohida tariflar
   * yaratadi. Mapping'da `includesMeal` belgilanadi.
   *
   * Belgilanmagan bo'lsa `false`: ortiqcha ovqat tayyorlagandan
   * ko'ra, mehmon so'raganda qo'shib bergan yaxshiroq.
   */
  const withMeal = await channelBookingHasMeal(
    channel.id,
    ext.externalRoomTypeId
  );

  let created;
  try {
    created = await prisma.reservation.create({
      data: {
        roomId: assigned.roomId,
        guestId: guest.id,
        checkIn: fromDateKey(ext.checkIn),
        checkOut: fromDateKey(ext.checkOut),
        adults: ext.adults,
        children: ext.children,
        source: toSource(ext.source),
        withMeal,
        channelId: channel.id,
        externalReservationId: ext.externalId,
        pricePerNight: new Prisma.Decimal(pricePerNight.toFixed(2)),
        currency: ext.currency,
        notes: ext.notes,
        status,
        checkedInAt: status === "CHECKED_IN" ? new Date() : null,
        checkedOutAt: status === "CHECKED_OUT" ? new Date() : null,
        syncStatus: "SYNCED",
        lastSyncedAt: new Date(),
      },
    });
  } catch (e) {
    // TZ 9-band: unique constraint ishga tushdi — poyga holati.
    // Boshqa worker allaqachon yaratgan, bu "aslida update".
    const raw = String(e);
    if (raw.includes("externalReservationId") || raw.includes("P2002")) {
      return applyReservation(eventType, ext);
    }
    // Overbooking constraint (23P01) — bo'sh xona tekshiruvi o'tib ketdi
    if (raw.includes("reservation_no_overlap") || raw.includes("23P01")) {
      return {
        status: "needs_manual_action",
        detail:
          `Xona ${assigned.roomId} band bo'lib qoldi (poyga holati). ` +
          `Admin qo'lda boshqa xona tanlashi kerak.`,
      };
    }
    throw e;
  }

  await syncPayments(created.id, channel.id, ext);
  await recalcRoomStatus(assigned.roomId);

  // Hisoblash + event + Beds24 navbati (FAZA 9).
  //
  // NEGA BEDS24'GA QAYTA YUBORAMIZ: bron Booking.com'dan keldi,
  // lekin qolgan kanallar (Airbnb, Expedia, o'z sayt) hali eski
  // sonni ko'radi. Beds24 o'zining numAvail'ini yangilaydi va
  // boshqa kanallarga tarqatadi (TZ 6, 20-band).
  //
  // Eko-sikl xavfi yo'q: `syncedCount` solishtiruvi o'zgarmagan
  // kunni yubormaydi, ya'ni yuborish -> webhook -> yuborish
  // zanjiri ikkinchi qadamda to'xtaydi (07-fayl §4).
  await onAvailabilityChanged(
    [assigned.roomTypeId],
    fromDateKey(ext.checkIn),
    fromDateKey(ext.checkOut),
    "ota_reservation_created"
  );

  // TZ 4-band: OTA'dan kelgan bron Shaxmatkada DARHOL ko'rinadi
  await notifyReservation("reservation.created", created.id);
  if ((ext.payments ?? []).length > 0) await notifyPayment(created.id);

  return {
    status: "processed",
    reservationId: created.id,
    detail: `Yangi bron: xona ${assigned.roomId}, ${status}, ${ext.guest.fullName}`,
    created: true,
  };
}

/**
 * Mehmonni topadi yoki yaratadi (TZ 1-band: mehmon ma'lumotlari).
 *
 * Telefon/email — tabiiy kalit: bir raqam = bir mehmon, shuning uchun
 * takroriy yozuv yaratilmaydi. Lekin mavjud yozuv TO'LDIRILADI:
 * OTA ko'pincha birinchi bronda faqat ismni, keyingilarida email va
 * manzilni ham yuboradi. Eski ma'lumot bo'sh bo'lsa yangisi yoziladi.
 */
async function findOrCreateGuest(ext: ExternalReservation) {
  const { fullName, phone, email, country, address } = ext.guest;

  const existing =
    (phone ? await prisma.guest.findFirst({ where: { phone } }) : null) ??
    (email ? await prisma.guest.findFirst({ where: { email } }) : null);

  if (existing) {
    // Faqat yangi ma'lumot kelganda yangilaymiz — bo'sh qiymat
    // bilan mavjudini o'chirib tashlamaslik uchun
    const patch: Record<string, string> = {};
    if (fullName && fullName !== "Noma'lum mehmon" && fullName !== existing.fullName) {
      patch.fullName = fullName;
    }
    if (email && !existing.email) patch.email = email;
    if (phone && !existing.phone) patch.phone = phone;
    if (country && !existing.country) patch.country = country;
    if (address && !existing.address) patch.address = address;

    if (Object.keys(patch).length > 0) {
      return prisma.guest.update({ where: { id: existing.id }, data: patch });
    }
    return existing;
  }

  return prisma.guest.create({
    data: { fullName, phone, email, country, address },
  });
}

/**
 * Beds24'dan kelgan to'lovlarni PMS'ga yozadi (TZ 14-band, 08-fayl §7).
 *
 * `@@unique([channelId, externalPaymentId])` — bir to'lov ikki marta
 * yozilmaydi. Beds24 `invoiceItems` da id bermasa, summa+izoh bo'yicha
 * taqqoslaymiz.
 */
async function syncPayments(
  reservationId: string,
  channelId: string,
  ext: ExternalReservation
): Promise<void> {
  for (const p of ext.payments ?? []) {
    if (p.amount === 0) continue;

    const externalPaymentId = p.externalId ?? `${ext.externalId}:${p.amount}:${p.description ?? ""}`;

    const existing = await prisma.payment.findFirst({
      where: { channelId, externalPaymentId },
    });
    if (existing) continue;

    await prisma.payment.create({
      data: {
        reservationId,
        amount: new Prisma.Decimal(p.amount),
        // OTA to'lovi — kassa hisobotida ajratish uchun (08-fayl §7)
        method: `Onlayn (${ext.source ?? "OTA"})`,
        paymentDate: new Date(),
        note: p.description,
        externalPaymentId,
        channelId,
      },
    });
  }
}

// --- Yordamchilar -------------------------------------------

async function markProcessed(id: string, detail: string): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id },
    data: { status: "PROCESSED", processedAt: new Date(), errorMessage: null },
  });
  if (process.env.NODE_ENV === "development") {
    console.log(`[webhook] ishlandi: ${detail}`);
  }
}

/**
 * `rate.changed` payload'idan narxlarni ajratib qo'llaydi.
 *
 * Beds24 bir nechta shakl yuborishi mumkin (bitta kun yoki massiv),
 * shuning uchun ikkalasini ham qabul qilamiz. Shakl tanilmasa —
 * xato emas, shunchaki e'tiborsiz (TZ 17-band).
 */
async function applyRateEvent(raw: unknown): Promise<string> {
  const body = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(body.rates)
    ? body.rates
    : Array.isArray(body.calendar)
      ? body.calendar
      : body.rate
        ? [body.rate]
        : [];

  const roomId = String(body.roomId ?? body.propertyRoomId ?? "");
  let applied = 0;
  let skipped = 0;

  for (const item of list as Array<Record<string, unknown>>) {
    const date = String(item.date ?? item.from ?? "");
    const priceRaw = item.price ?? item.price1;
    const external = String(item.roomId ?? roomId);

    if (!date || priceRaw === undefined || !external) { skipped++; continue; }

    const outcome = await applyExternalRate({
      externalRoomTypeId: external,
      date,
      price: Number(priceRaw),
      ...(item.minStay !== undefined ? { minStay: Number(item.minStay) } : {}),
    });

    if (outcome.status === "applied") applied++;
    else skipped++;
  }

  return `narx event'i: ${applied} qo'llandi, ${skipped} o'tkazildi`;
}

/** SyncLog (TZ 16-band) — 8 maydon */
async function logSync(
  action: string,
  status: "SUCCESS" | "FAILED" | "SKIPPED",
  reservationId: string | null,
  detail: string
): Promise<void> {
  const channel = await prisma.channel.findUnique({ where: { code: "beds24" } });
  if (!channel) return;

  await prisma.syncLog.create({
    data: {
      channelId: channel.id,
      action,
      direction: "CHANNEL_TO_PMS",
      status,
      reservationId,
      errorMessage: status === "FAILED" ? detail.slice(0, 500) : null,
      response: status === "SUCCESS" ? { detail } : undefined,
    },
  });
}

/**
 * Navbatga qo'yilmagan (yoki worker yo'q bo'lganda to'planib qolgan)
 * event'larni qayta ishlaydi. FAZA 6 da QUEUED holatida qolganlar
 * uchun ham ishlaydi.
 */
export async function processPendingEvents(limit = 50): Promise<{
  processed: number;
  skipped: number;
  needsAction: number;
  failed: number;
}> {
  const pending = await prisma.webhookEvent.findMany({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const counts = { processed: 0, skipped: 0, needsAction: 0, failed: 0 };

  for (const event of pending) {
    try {
      const r = await processWebhookEvent(event.id);
      if (r.status === "processed") counts.processed++;
      else if (r.status === "skipped") counts.skipped++;
      else if (r.status === "needs_manual_action") counts.needsAction++;
    } catch {
      counts.failed++;
    }
  }

  return counts;
}
