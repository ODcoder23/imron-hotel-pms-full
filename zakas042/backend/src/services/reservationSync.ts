/**
 * Reservation sync — PMS -> Beds24 (FAZA 10)
 *
 * Manba: 12-PMS-DAN-BEDS24-GA-SYNC.md §1–§7
 * TZ 2-band: Shaxmatkadagi SAKKIZ amal Beds24 bilan sinxronlanadi.
 * Mijoz qarorlari: Q6 (xona almashsa Beds24'da ham), Q7 (check-in/out).
 *
 * IDEMPOTENTLIK (12-fayl §2) — asosiy printsip:
 *   Worker job payload'idagi eski nusxaga emas, DB'dagi JORIY
 *   holatga qarab ish ko'radi. Job ikki marta bajarilsa ham natija
 *   bir xil. Job navbatda turganda bron yana o'zgarsa — eng oxirgi
 *   holat yuboriladi, eskisi emas.
 *
 * ECHO LOOP HIMOYASI (12-fayl §3) — ikki qatlam:
 *   1. `referer: "PMS"` — adapter qo'yadi, webhook'da qaytsa
 *      o'zimizning aks-sadomiz ekani bilinadi
 *   2. `payloadHash` solishtiruvi — kelgan ma'lumot DB'dagi holat
 *      bilan bir xil bo'lsa hech narsa yozilmaydi (04-fayl §3)
 */

import { prisma } from "../lib/prisma.js";
import { toDateKey } from "../lib/serialize.js";
import { logPush } from "../lib/syncLog.js";
import { findRoomTypeMapping } from "./mapping.js";
import { getChannel } from "./channel/registry.js";
import { toBeds24Status } from "./beds24/statusMap.js";
import { notifySyncFailed } from "../realtime/notify.js";
import { reservationSyncQueue, enqueueWithTimeout, type ReservationSyncJob } from "../queues/index.js";

export type ChangeType = ReservationSyncJob["changeType"];

/**
 * Jarayon ichidagi qulf: bir bron uchun bir vaqtda bitta push.
 *
 * Ikki chaqiruv parallel kelsa, ikkinchisi birinchisining
 * natijasini KUTADI va uning `externalReservationId`ini ko'radi —
 * ya'ni create emas, update yuboradi. Bo'lmasa Beds24'da ikkita
 * booking paydo bo'ladi (mehmon ikki marta band qilingan bo'lib
 * chiqadi).
 *
 * Bir instansiya doirasida ishlaydi. Ko'p instansiyada ham
 * `beds24-reservation-sync` navbati bitta bron uchun job'larni
 * ketma-ket beradi (05-fayl §6), shuning uchun bu yetarli.
 */
const inFlight = new Map<string, Promise<SyncOutcome>>();

export type SyncOutcome =
  | { status: "sent"; externalId?: string; created: boolean }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string; retryable: boolean };

/**
 * Ismni first/last ga ajratadi.
 *
 * Beds24 ikki maydonni alohida so'raydi, PMS'da esa bitta
 * `fullName` bor (02-fayl §3). Bir so'zli ism bo'lsa familiya
 * bo'sh qolmasligi uchun nuqta qo'yiladi — Beds24 bo'sh
 * `lastName`ni rad etadi.
 */
export function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "Mehmon", last: "." };
  if (parts.length === 1) return { first: parts[0]!, last: "." };
  return { first: parts[0]!, last: parts.slice(1).join(" ") };
}

/**
 * Boshqa jarayon bronni yuborib, `externalReservationId` yozishini
 * kutadi. Bo'lmasa `null` — chaqiruvchi job'ni qayta urinishga
 * qoldiradi.
 */
async function waitForExternalId(
  reservationId: string,
  timeoutMs = 8000
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const r = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { externalReservationId: true, syncStatus: true },
    });
    if (r?.externalReservationId) return r.externalReservationId;

    // Band qilgan jarayon yiqilib, SYNCING holatida qolib ketgan
    // bo'lishi mumkin — u holda o'zimiz davom etamiz
    if (r && r.syncStatus !== "SYNCING") return null;

    if (Date.now() >= deadline) return null;
    await new Promise((x) => setTimeout(x, 150));
  }
}

/** Kechalar soni — `'[)'` qoidasi bo'yicha */
export function nights(checkIn: Date, checkOut: Date): number {
  const ms = checkOut.getTime() - checkIn.getTime();
  return Math.max(1, Math.round(ms / 86_400_000));
}

// ============================================================
//  1. Bronni Beds24'ga yuborish
// ============================================================

/**
 * Bir bronni Beds24'ga yuboradi — yaratish yoki yangilash.
 *
 * `externalReservationId` bo'lsa update, bo'lmasa create. Ya'ni
 * sakkizta amalning hammasi bitta yo'ldan o'tadi: "shu bron hozir
 * mana bunday" (12-fayl §2).
 */
export function pushReservation(reservationId: string): Promise<SyncOutcome> {
  const running = inFlight.get(reservationId);
  if (running) {
    // Birinchisi tugagach biz ham yuboramiz — natija o'sha paytdagi
    // DB holatiga mos bo'ladi (12-fayl §2 idempotentlik)
    return running.then(() => pushReservation(reservationId));
  }

  const task = doPush(reservationId).finally(() => {
    inFlight.delete(reservationId);
  });
  inFlight.set(reservationId, task);
  return task;
}

async function doPush(reservationId: string): Promise<SyncOutcome> {
  const started = Date.now();

  const res = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      guest: true,
      room: { include: { roomType: true } },
      payments: true,
      charges: true,
    },
  });

  if (!res) {
    return { status: "skipped", reason: "bron topilmadi (o'chirilgan)" };
  }

  // --- 1. Mapping majburiy (06-fayl §3) ---
  // Taxminiy mapping ASLO ishlatilmaydi: noto'g'ri room type'ga
  // ketgan bron real overbooking keltiradi.
  const mapping = await findRoomTypeMapping(res.room.roomTypeId);
  if (!mapping?.externalRoomTypeId) {
    const reason = `mapping topilmadi: ${res.room.roomTypeId}`;

    // Mapping o'z-o'zidan paydo bo'lmaydi — qayta urinish foydasiz.
    // Admin bog'lagandan keyin qo'lda qayta yuboriladi.
    await prisma.reservation.update({
      where: { id: res.id },
      data: { syncStatus: "NOT_APPLICABLE" },
    });
    await logPush("push_reservation", "FAILED", {
      reservationId: res.id,
      roomId: res.roomId,
      errorMessage: reason,
    });

    return { status: "failed", error: reason, retryable: false };
  }

  // --- 2. Payload (12-fayl §3) ---
  const { first, last } = splitName(res.guest.fullName);
  const statusPair = toBeds24Status(res.status);
  const nightCount = nights(res.checkIn, res.checkOut);

  const payload = {
    ...(res.externalReservationId ? { externalId: res.externalReservationId } : {}),
    externalRoomTypeId: mapping.externalRoomTypeId,
    ...(mapping.externalUnitId ? { externalUnitId: mapping.externalUnitId } : {}),
    status: statusPair.status,
    ...(statusPair.subStatus ? { subStatus: statusPair.subStatus } : {}),
    checkIn: toDateKey(res.checkIn) ?? "",
    checkOut: toDateKey(res.checkOut) ?? "",
    adults: res.adults,
    children: res.children,
    totalPrice: Number(res.pricePerNight) * nightCount,
    guestFirstName: first,
    guestLastName: last,
    ...(res.guest.phone ? { phone: res.guest.phone } : {}),
    ...(res.guest.email ? { email: res.guest.email } : {}),
    ...(res.notes ? { notes: res.notes } : {}),
  };

  // --- 3. Yuborish ---
  //
  // POYGA HIMOYASI — ikki qatlam.
  //
  // MUAMMO: ikki jarayon (API server worker'i va, masalan, admin
  // resync skripti) bir vaqtda shu bronni yuborsa, ikkalasi ham
  // `externalReservationId` bo'sh deb ko'rib Beds24'da IKKITA
  // booking yaratadi. Mehmon ikki marta band qilingan bo'lib
  // chiqadi — real overbooking.
  //
  // 1-QATLAM (yuqorida): jarayon ichidagi `inFlight` map — bir
  //    jarayonda bir bron uchun bitta push.
  //
  // 2-QATLAM (shu yerda): jarayonlararo band qilish. Faqat YANGI
  //    bron uchun kerak (update xavfsiz — id allaqachon bor).
  //    `updateMany` + `where` sharti atomar: DB bitta qatorga
  //    faqat bitta yangilashni o'tkazadi. 0 qaytsa — boshqa jarayon
  //    band qilgan, biz kutamiz va uning id'sini ishlatamiz.
  //
  // NEGA ADVISORY LOCK EMAS: Prisma connection pool ishlatadi, har
  // so'rov ixtiyoriy ulanishdan ketadi. `pg_advisory_lock` esa
  // SESSIYAGA bog'langan — qulf bir ulanishda olinib tekshiruv
  // boshqasidan ketishi mumkin. Tekshirilgan: himoya bermaydi va
  // bo'shatilmay osilib qoladi.
  let existingId = res.externalReservationId;

  if (!existingId) {
    const claimed = await prisma.reservation.updateMany({
      where: { id: res.id, externalReservationId: null, syncStatus: { not: "SYNCING" } },
      data: { syncStatus: "SYNCING" },
    });

    if (claimed.count === 0) {
      // Boshqa jarayon band qilgan — u tugatishini kutamiz
      const settled = await waitForExternalId(res.id);
      if (!settled) {
        return {
          status: "failed",
          error: "bron hozir boshqa jarayon tomonidan yuborilmoqda",
          retryable: true,
        };
      }
      existingId = settled;
    }
  }

  if (existingId && !payload.externalId) {
    (payload as { externalId?: string }).externalId = existingId;
  }

  const result = await getChannel().pushReservation(payload);

  const durationMs = Date.now() - started;

  if (!result.ok) {
    await prisma.reservation.update({
      where: { id: res.id },
      data: { syncStatus: "FAILED" },
    });
    await logPush("push_reservation", "FAILED", {
      reservationId: res.id,
      roomId: res.roomId,
      request: payload,
      errorMessage: result.error,
      durationMs,
    });

    return {
      status: "failed",
      error: result.error ?? "noma'lum xato",
      retryable: result.retryable !== false,
    };
  }

  // --- 4. Yangi booking id'sini saqlaymiz ---
  const wasCreated = !existingId;

  if (wasCreated && result.externalId) {
    const channel = await prisma.channel.findUnique({ where: { code: "beds24" } });
    try {
      await prisma.reservation.update({
        where: { id: res.id },
        data: {
          externalReservationId: result.externalId,
          ...(channel ? { channelId: channel.id } : {}),
          syncStatus: "SYNCED",
          lastSyncedAt: new Date(),
        },
      });
    } catch (e) {
      // P2002 — parallel chaqiruv bizdan oldin yozib ulgurgan.
      // Bu xato emas: bron sinxronlangan, faqat boshqa id bilan.
      if ((e as { code?: string }).code !== "P2002") throw e;
      await prisma.reservation.update({
        where: { id: res.id },
        data: { syncStatus: "SYNCED", lastSyncedAt: new Date() },
      });
    }
  } else {
    await prisma.reservation.update({
      where: { id: res.id },
      data: { syncStatus: "SYNCED", lastSyncedAt: new Date() },
    });
  }

  await logPush("push_reservation", "SUCCESS", {
    reservationId: res.id,
    roomId: res.roomId,
    request: payload,
    response: { externalId: result.externalId, created: wasCreated },
    durationMs,
  });

  return { status: "sent", externalId: result.externalId, created: wasCreated };
}

// ============================================================
//  2. Navbatga qo'yish (12-fayl §1)
// ============================================================

/**
 * Reservation sync'ni navbatga qo'yadi.
 *
 * DEBOUNCE YO'Q — availability'dan farqli. Sabab: har amal alohida
 * ma'noga ega (yaratish, bekor qilish, check-in), ularni birlashtirib
 * bo'lmaydi. Buning o'rniga `jobId` bron + amal + oyna bo'yicha
 * tuziladi: bir xil amal darhol takrorlansa birlashadi, turli
 * amallar esa alohida ketadi.
 *
 * Redis yo'q bo'lsa xato TASHLANMAYDI — bron PMS'da baribir
 * yaratilgan (TZ 17, 19-band). `syncStatus` PENDING bo'lib qoladi,
 * admin `/admin/sync-log` da ko'radi va qayta yuboradi.
 */
export async function enqueueReservationSync(
  reservationId: string,
  changeType: ChangeType,
  opts: {
    previousState?: ReservationSyncJob["previousState"];
    triggeredBy?: string;
  } = {}
): Promise<{ queued: boolean; jobId?: string }> {
  // BullMQ `jobId`da ":" taqiqlangan (Redis ajratgichi).
  // Oyna raqami — tugagan job 24 soat saqlanib, o'sha id'ni
  // bloklab qo'ymasligi uchun (availability.ts dagi bilan bir xil
  // sabab).
  const window = Math.floor(Date.now() / 2000);
  const jobId = `res_${reservationId}_${changeType}_${window}`;

  const added = await enqueueWithTimeout(
    () => reservationSyncQueue.add(
      "sync",
      {
        reservationId,
        changeType,
        previousState: opts.previousState,
        triggeredBy: opts.triggeredBy,
        requestedAt: new Date().toISOString(),
      },
      { jobId },
    ),
    `reservation-sync (${changeType})`
  );

  return added ? { queued: true, jobId } : { queued: false };
}

/**
 * Bron o'zgarganda chaqiriladi — `syncStatus` + navbat.
 *
 * `syncStatus = PENDING` darhol qo'yiladi: Shaxmatka bronda
 * "yuborilmoqda" belgisini ko'rsatadi, worker tugatgach `SYNCED`
 * bo'ladi (TZ 13-band).
 */
export async function onReservationChanged(
  reservationId: string,
  changeType: ChangeType,
  opts: {
    previousState?: ReservationSyncJob["previousState"];
    triggeredBy?: string;
  } = {}
): Promise<void> {
  await prisma.reservation
    .update({ where: { id: reservationId }, data: { syncStatus: "PENDING" } })
    .catch(() => {});

  await enqueueReservationSync(reservationId, changeType, opts);
}

// ============================================================
//  3. Qayta yuborish (admin qo'lda)
// ============================================================

/**
 * `FAILED` / `NOT_APPLICABLE` bronlarni qayta yuboradi.
 *
 * Mapping tuzatilgandan keyin admin shu funksiyani ishga tushiradi
 * (`POST /api/admin/reservations/resync`).
 */
export async function resyncFailed(limit = 50): Promise<{
  total: number;
  sent: number;
  failed: number;
}> {
  /**
   * `PENDING` ham qo'shiladi, lekin FAQAT ESKILARI.
   *
   * NEGA: Redis o'chganda `enqueueWithTimeout` job qo'ya olmaydi va
   * bron `PENDING` holatida qoladi. Redis qaytganda hech kim uni
   * yubormaydi — abadiy shu holatda turib qoladi va Beds24 bronni
   * bilmaydi (TZ 17-band buzilishi).
   *
   * NEGA "ESKILARI": hozirgina yaratilgan bron ham `PENDING` —
   * uning job'i navbatda turibdi va bir necha soniyada bajariladi.
   * Uni bu yerdan ham yuborish ikki marta yuborishga olib kelardi.
   * 5 daqiqadan eski bo'lsa navbat allaqachon bajargan yoki
   * umuman qo'yilmagan.
   */
  const staleAfter = new Date(Date.now() - 5 * 60_000);

  const pending = await prisma.reservation.findMany({
    where: {
      status: { notIn: ["CHECKED_OUT"] },
      OR: [
        { syncStatus: { in: ["FAILED", "NOT_APPLICABLE"] } },
        { syncStatus: "PENDING", updatedAt: { lt: staleAfter } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { id: true },
  });

  let sent = 0;
  let failed = 0;

  for (const r of pending) {
    const outcome = await pushReservation(r.id);
    if (outcome.status === "sent") sent++;
    else if (outcome.status === "failed") {
      failed++;
      notifySyncFailed("push_reservation", outcome.error, r.id);
    }
  }

  return { total: pending.length, sent, failed };
}
