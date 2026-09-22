/**
 * Narx sinxronizatsiyasi — TZ 7-band (FAZA 11)
 *
 * Manba: 07-AVAILABILITY-VA-RATES-SYNC.md §7, §8
 * Mijoz qarori Q8: avtomatik o'suvchi narx mexanizmi YO'Q, admin
 * narxni qo'lda belgilaydi.
 *
 * IKKI YO'NALISH:
 *   PMS -> Beds24   `pushRates` (SoT = "pms" bo'lganda)
 *   Beds24 -> PMS   `applyExternalRate` (SoT = "beds24" bo'lganda)
 *
 * LOOP HIMOYASI (07-fayl §7) — uch qatlam:
 *   1. Bir vaqtda faqat BITTA tomon g'olib (`SOURCE_OF_TRUTH_RATES`)
 *   2. Yutqazgan tomon narxni QAYTA YOZIB YUBORMAYDI ham — faqat
 *      rad etadi va SyncLog'ga SKIPPED yozadi
 *   3. Kelgan qiymat DB'dagi bilan bir xil bo'lsa hech narsa
 *      yozilmaydi (`syncedAt` solishtiruvi)
 *
 * IKKI XIL "NARX" (07-fayl §7) — chalkashtirmaslik kerak:
 *   `Reservation.pricePerNight` — faqat shu bron, SoT ga
 *       BO'YSUNMAYDI, har doim Beds24'ga yuboriladi (12-fayl)
 *   `RatePlan.price` — butun room type, kelajak bronlar, SoT ga
 *       bo'ysunadi (shu fayl)
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { toDateKey, fromDateKey, toNumber } from "../lib/serialize.js";
import { logPush, logSync } from "../lib/syncLog.js";
import { findRoomTypeMapping } from "./mapping.js";
import { getChannel } from "./channel/registry.js";
import { getRatesSoT } from "./settings.js";
import { notifyRateSync } from "../realtime/notify.js";
import { rateSyncQueue, enqueueWithTimeout } from "../queues/index.js";

/** Debounce oynasi — availability bilan bir xil sabab (07-fayl §4) */
const DEBOUNCE_MS = 3000;

export type RateDay = {
  date: string;
  price: number;
  minStay: number;
  source: string;
  syncedAt: Date | null;
  syncError: string | null;
};

export type RatePushOutcome =
  | { status: "sent"; roomTypeId: string; days: number }
  | { status: "skipped"; roomTypeId: string; reason: string }
  | { status: "failed"; roomTypeId: string; error: string };

// ============================================================
//  1. O'qish
// ============================================================

export async function readRates(
  roomTypeId: string,
  from: Date,
  to: Date
): Promise<RateDay[]> {
  const rows = await prisma.ratePlan.findMany({
    where: { roomTypeId, date: { gte: from, lte: to } },
    orderBy: { date: "asc" },
  });

  return rows.map((r) => ({
    date: toDateKey(r.date) ?? "",
    price: toNumber(r.price),
    minStay: r.minStay,
    source: r.source,
    syncedAt: r.syncedAt,
    syncError: r.syncError,
  }));
}

// ============================================================
//  2. PMS -> Beds24
// ============================================================

/**
 * Bir room type narxlarini Beds24'ga yuboradi.
 *
 * `syncedAt = null` bo'lgan kunlargina yuboriladi — yuborilgani
 * qayta ketmaydi (kredit tejash, 07-fayl §4).
 */
export async function pushRates(
  roomTypeId: string,
  from: Date,
  to: Date
): Promise<RatePushOutcome> {
  const started = Date.now();

  // --- 1. Source of truth (TZ 7-band) ---
  const sot = await getRatesSoT();
  if (sot !== "pms") {
    // Beds24 g'olib — PMS narxi yuborilmaydi. Bu xato emas,
    // qasddan qilingan sozlama.
    await logPush("push_rates", "SKIPPED", {
      response: { detail: `source of truth = ${sot}` },
    });
    return { status: "skipped", roomTypeId, reason: `source of truth = ${sot}` };
  }

  // --- 2. Mapping (06-fayl §3) ---
  const mapping = await findRoomTypeMapping(roomTypeId);
  if (!mapping?.externalRoomTypeId) {
    const reason = `mapping topilmadi: ${roomTypeId}`;
    await markRateError(roomTypeId, from, to, reason);
    await logPush("push_rates", "FAILED", { errorMessage: reason });
    return { status: "failed", roomTypeId, error: reason };
  }

  // --- 3. Yuborilmagan kunlar ---
  const all = await readRates(roomTypeId, from, to);
  const pending = all.filter((d) => d.syncedAt === null);

  if (pending.length === 0) {
    await logPush("push_rates", "SKIPPED", {
      response: { detail: `${all.length} kun tekshirildi, yangisi yo'q` },
    });
    return { status: "skipped", roomTypeId, reason: "o'zgarish yo'q" };
  }

  // --- 4. Yuborish ---
  const result = await getChannel().pushRates({
    externalRoomTypeId: mapping.externalRoomTypeId,
    days: pending.map((d) => ({ date: d.date, price: d.price, minStay: d.minStay })),
  });

  const durationMs = Date.now() - started;

  if (!result.ok) {
    await markRateError(roomTypeId, from, to, result.error ?? "noma'lum xato");
    await logPush("push_rates", "FAILED", {
      request: { roomTypeId, days: pending.length },
      errorMessage: result.error,
      durationMs,
    });

    // Panel ⚠ belgisini ko'rsatadi (07-fayl §8)
    for (const d of pending) notifyRateSync(roomTypeId, d.date, "error");

    return { status: "failed", roomTypeId, error: result.error ?? "noma'lum xato" };
  }

  // --- 5. Yuborilgan deb belgilaymiz ---
  await prisma.ratePlan.updateMany({
    where: { roomTypeId, date: { gte: from, lte: to }, syncedAt: null },
    data: { syncedAt: new Date(), syncError: null },
  });

  await logPush("push_rates", "SUCCESS", {
    request: { roomTypeId, externalRoomTypeId: mapping.externalRoomTypeId, days: pending.length },
    response: { detail: result.detail },
    durationMs,
  });

  // Panel ● belgisiga o'tadi
  for (const d of pending) notifyRateSync(roomTypeId, d.date, "synced");

  return { status: "sent", roomTypeId, days: pending.length };
}

async function markRateError(
  roomTypeId: string,
  from: Date,
  to: Date,
  error: string
): Promise<void> {
  await prisma.ratePlan.updateMany({
    where: { roomTypeId, date: { gte: from, lte: to }, syncedAt: null },
    data: { syncError: error.slice(0, 300) },
  });
}

// ============================================================
//  3. Beds24 -> PMS (TZ 7-band teskari yo'nalish)
// ============================================================

export type ExternalRate = {
  externalRoomTypeId: string;
  date: string;            // "YYYY-MM-DD"
  price: number;
  minStay?: number;
};

export type ApplyOutcome =
  | { status: "applied"; roomTypeId: string; date: string; price: number }
  | { status: "skipped"; reason: string };

/**
 * Beds24'dan kelgan narxni PMS'ga qo'llaydi.
 *
 * TZ 7-band: "Agar Beds24dan narx o'zgarsa, PMSga ham update kelishi
 * kerak." Lekin bu SOURCE OF TRUTH ga bo'ysunadi.
 *
 * SoT = "pms" bo'lsa narx RAD ETILADI va — muhimi — PMS narxi
 * Beds24'ga QAYTA YOZIB YUBORILMAYDI. Aks holda: Beds24 yuboradi ->
 * PMS rad etib o'zinikini yuboradi -> Beds24 yana yuboradi ->
 * cheksiz halqa.
 */
export async function applyExternalRate(rate: ExternalRate): Promise<ApplyOutcome> {
  const sot = await getRatesSoT();

  if (sot !== "beds24") {
    await logSync({
      action: "rate_changed",
      direction: "CHANNEL_TO_PMS",
      status: "SKIPPED",
      response: { detail: "pms is source of truth", ...rate },
    });
    return { status: "skipped", reason: "pms is source of truth" };
  }

  // Mapping bo'yicha PMS turini topamiz
  const channel = await prisma.channel.findUnique({ where: { code: "beds24" } });
  if (!channel) return { status: "skipped", reason: "kanal topilmadi" };

  const mapping = await prisma.channelMapping.findFirst({
    where: {
      channelId: channel.id,
      externalRoomTypeId: rate.externalRoomTypeId,
      isActive: true,
    },
  });

  if (!mapping?.roomTypeId) {
    await logSync({
      action: "rate_changed",
      direction: "CHANNEL_TO_PMS",
      status: "FAILED",
      errorMessage: `mapping topilmadi: ${rate.externalRoomTypeId}`,
    });
    return { status: "skipped", reason: "mapping topilmadi" };
  }

  const date = fromDateKey(rate.date);
  const roomTypeId = mapping.roomTypeId;

  // Kelgan qiymat DB'dagi bilan bir xil bo'lsa — hech narsa
  // yozilmaydi (loop himoyasining 3-qatlami)
  const existing = await prisma.ratePlan.findUnique({
    where: { roomTypeId_date: { roomTypeId, date } },
  });

  if (existing && toNumber(existing.price) === rate.price) {
    await logSync({
      action: "rate_changed",
      direction: "CHANNEL_TO_PMS",
      status: "SKIPPED",
      response: { detail: "narx o'zgarmagan", roomTypeId, date: rate.date },
    });
    return { status: "skipped", reason: "narx o'zgarmagan" };
  }

  await prisma.ratePlan.upsert({
    where: { roomTypeId_date: { roomTypeId, date } },
    create: {
      roomTypeId,
      date,
      price: new Prisma.Decimal(rate.price),
      minStay: rate.minStay ?? 1,
      source: "beds24",
      // Beds24'dan kelgan narx allaqachon "sinxron" — qayta
      // yuborish kerak emas va zararli (halqa)
      syncedAt: new Date(),
      syncError: null,
    },
    update: {
      price: new Prisma.Decimal(rate.price),
      ...(rate.minStay !== undefined ? { minStay: rate.minStay } : {}),
      source: "beds24",
      syncedAt: new Date(),
      syncError: null,
    },
  });

  await logSync({
    action: "rate_changed",
    direction: "CHANNEL_TO_PMS",
    status: "SUCCESS",
    response: { roomTypeId, date: rate.date, price: rate.price },
  });

  // Admin panel narx o'zgarganini darhol ko'radi (TZ 15-band)
  notifyRateSync(roomTypeId, rate.date, "synced");

  return { status: "applied", roomTypeId, date: rate.date, price: rate.price };
}

// ============================================================
//  4. Navbat
// ============================================================

export type RateSyncResult = {
  outcomes: RatePushOutcome[];
  sent: number;
  skipped: number;
  failed: number;
};

export async function syncRatesRange(
  roomTypeIds: string[],
  fromKey: string,
  toKey: string
): Promise<RateSyncResult> {
  const from = fromDateKey(fromKey);
  const to = fromDateKey(toKey);

  const outcomes: RatePushOutcome[] = [];
  for (const roomTypeId of roomTypeIds) {
    outcomes.push(await pushRates(roomTypeId, from, to));
  }

  return {
    outcomes,
    sent: outcomes.filter((o) => o.status === "sent").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
  };
}

/**
 * Narx sync'ini navbatga qo'yadi.
 *
 * `jobId` da oyna raqami — availability bilan bir xil sabab:
 * BullMQ tugagan job'ni 24 soat saqlaydi va o'sha id'ni rad etadi,
 * natijada narx ikkinchi marta o'zgartirilganda yuborilmay qolardi.
 */
export async function enqueueRateSync(
  roomTypeIds: string[],
  from: Date,
  to: Date
): Promise<{ queued: boolean; jobId?: string }> {
  if (roomTypeIds.length === 0) return { queued: false };

  const fromKey = toDateKey(from) ?? "";
  const toKey = toDateKey(to) ?? "";
  const types = [...new Set(roomTypeIds)].sort();

  const dateKey = (k: string) => k.replace(/-/g, "");
  const window = Math.floor(Date.now() / DEBOUNCE_MS);
  const jobId = `rate_${types.join("-")}_${dateKey(fromKey)}_${dateKey(toKey)}_${window}`;

  // Redis yo'q bo'lsa narx baribir DB'da saqlangan (TZ 17, 19-band)
  const added = await enqueueWithTimeout(
    () => rateSyncQueue.add(
      "sync",
      { roomTypeIds: types, from: fromKey, to: toKey },
      { jobId, delay: DEBOUNCE_MS }
    ),
    "rate-sync"
  );

  return added ? { queued: true, jobId } : { queued: false };
}

/**
 * Admin narx belgilaganda chaqiriladi (07-fayl §8).
 *
 * TARTIB: DB'ga yozish darhol (admin kutmaydi), Beds24'ga yuborish
 * fonda. Panel `rate.sync.updated` event'i orqali holatni ko'radi.
 */
export async function onRatesChanged(
  roomTypeIds: string[],
  from: Date,
  to: Date
): Promise<void> {
  if (roomTypeIds.length === 0) return;

  // Panel ○ "kutmoqda" belgisini darhol ko'rsatadi
  const fromKey = toDateKey(from) ?? "";
  for (const id of roomTypeIds) notifyRateSync(id, fromKey, "pending");

  await enqueueRateSync(roomTypeIds, from, to);
}
