/**
 * Polling fallback va drift tekshiruvi — TZ 10, 17, 20-band (FAZA 14)
 *
 * Manba: 04-WEBHOOK-HANDLER.md §8 (polling),
 *        07-AVAILABILITY-VA-RATES-SYNC.md §6 (drift)
 *
 * IKKI MEXANIZM, BITTA MAQSAD: PMS va Beds24 bir xil ma'lumot
 * ko'rishi (TZ 20-band).
 *
 *   POLLING  — webhook yetib kelmagan bronlarni tutib oladi
 *   DRIFT    — availability farqini topadi va tuzatadi
 *
 * IKKALASI HAM ASOSIY OQIM EMAS. Asosiy oqim — real-time webhook va
 * darhol yuboriladigan sync job. Bular "tutib olish to'ri": bir
 * narsa o'tkazib yuborilsa, keyingi yurishda tuzatiladi.
 */

import { prisma } from "../lib/prisma.js";
import { config } from "../lib/config.js";
import { toDateKey, fromDateKey } from "../lib/serialize.js";
import { logSync } from "../lib/syncLog.js";
import { getChannel } from "./channel/registry.js";
import { applyReservation } from "./webhookProcessor.js";
import { findRoomTypeMapping } from "./mapping.js";
import { recalcAvailability, readRange, enqueueAvailabilitySync } from "./availability.js";
import { getAvailabilitySoT } from "./settings.js";
import { notifySyncFailed } from "../realtime/notify.js";

// ============================================================
//  1. Sync holati (SyncState)
// ============================================================

const KEY_BOOKINGS_PULL = "bookings_pull";

/**
 * Oxirgi muvaffaqiyatli polling vaqti.
 *
 * Yo'q bo'lsa — oxirgi 24 soat olinadi. Birinchi yurishda butun
 * tarixni tortib olish kredit isrofi bo'lardi (03-fayl §3).
 */
async function getLastPullAt(channelId: string): Promise<Date> {
  const state = await prisma.syncState.findUnique({
    where: { channelId_key: { channelId, key: KEY_BOOKINGS_PULL } },
  });

  return state?.lastSuccessfulAt ?? new Date(Date.now() - 24 * 3600_000);
}

async function setLastPullAt(channelId: string, at: Date): Promise<void> {
  await prisma.syncState.upsert({
    where: { channelId_key: { channelId, key: KEY_BOOKINGS_PULL } },
    create: { channelId, key: KEY_BOOKINGS_PULL, lastSuccessfulAt: at },
    update: { lastSuccessfulAt: at },
  });
}

// ============================================================
//  2. Polling fallback (TZ 10-band, 04-fayl §8)
// ============================================================

export type PollResult = {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  needsAction: number;
  since: string;
};

/**
 * Beds24'dan o'zgargan bronlarni tortib oladi.
 *
 * TZ 10-band: "Webhook ishlamasa polling/sync fallback mexanizmi
 * bo'lsin."
 *
 * KOD TAKRORLANMAYDI (04-fayl §8): har bron `applyReservation`
 * orqali o'tadi — webhook worker'i ham aynan shuni chaqiradi.
 * Natijada dedup, xona biriktirish, to'lov sinxronizatsiyasi va
 * echo himoyasi bir xil ishlaydi.
 *
 * `modifiedFrom` orqali FAQAT O'ZGARGANLAR so'raladi — kredit
 * tejaladi (03-fayl §3).
 *
 * VAQTNI OLDINDAN OLAMIZ: so'rov yuborilgan payt qayd etiladi,
 * javob kelgani emas. Aks holda so'rov davomida o'zgargan bron
 * ikki yurish orasiga tushib qolishi mumkin.
 */
export async function pollBookings(): Promise<PollResult> {
  const started = new Date();

  const channel = await prisma.channel.findUnique({ where: { code: "beds24" } });
  if (!channel) {
    return { fetched: 0, created: 0, updated: 0, skipped: 0, needsAction: 0, since: "" };
  }

  const since = await getLastPullAt(channel.id);

  // Kichik ustma-ustlik: chegarada turgan bron o'tkazib
  // yuborilmasligi uchun 2 daqiqa orqaga suramiz
  const from = new Date(since.getTime() - 2 * 60_000);

  const counts = { fetched: 0, created: 0, updated: 0, skipped: 0, needsAction: 0 };

  try {
    const list = await getChannel().pullReservations(from);
    counts.fetched = list.length;

    for (const ext of list) {
      try {
        const result = await applyReservation("booking.modified", ext);

        if (result.status === "processed") {
          if (result.created) counts.created++;
          else counts.updated++;
        } else if (result.status === "needs_manual_action") {
          counts.needsAction++;
          notifySyncFailed("poll_bookings", result.detail ?? "qo'lda hal qilish kerak");
        } else {
          counts.skipped++;
        }
      } catch (e) {
        // Bitta bron yiqilsa qolganlari davom etadi (TZ 17-band)
        counts.skipped++;
        console.warn(`[poll] bron ${ext.externalId}: ${String(e).slice(0, 100)}`);
      }
    }

    // Faqat muvaffaqiyatli yurishdan keyin belgilaymiz — xato bo'lsa
    // keyingi safar o'sha oraliq qayta so'raladi
    await setLastPullAt(channel.id, started);

    await logSync({
      action: "poll_bookings",
      direction: "CHANNEL_TO_PMS",
      status: "SUCCESS",
      response: counts,
    });
  } catch (e) {
    await logSync({
      action: "poll_bookings",
      direction: "CHANNEL_TO_PMS",
      status: "FAILED",
      errorMessage: String(e).slice(0, 300),
    });
    throw e;
  }

  return { ...counts, since: from.toISOString() };
}

// ============================================================
//  3. Drift tekshiruvi (TZ 20-band, 07-fayl §6)
// ============================================================

export type DriftDay = {
  roomTypeId: string;
  date: string;
  pms: number;
  beds24: number;
};

export type DriftResult = {
  checkedDays: number;
  driftDays: number;
  corrected: number;
  details: DriftDay[];
};

/**
 * PMS va Beds24 availability'sini solishtiradi.
 *
 * TZ 20-band barcha tizimlar bir xil inventory ko'rishini talab
 * qiladi. Uzoq ishlaganda kichik farqlar to'planadi: yuborilmay
 * qolgan job, Beds24 tomonidagi qo'lda o'zgarish, tarmoq uzilishi.
 * Drift sezilmay qolsa — OTA'da noto'g'ri son turadi va overbooking
 * yoki yo'qotilgan sotuv chiqadi.
 *
 * PMS QIYMATI TO'G'RI deb hisoblanadi (`SOURCE_OF_TRUTH_AVAILABILITY`
 * = "pms"). Sabab: PMS'da aniq bronlar bor va ular DB constraint'i
 * bilan himoyalangan; Beds24'dagi son esa hisoblangan qiymat.
 *
 * Teskari sozlamada (SoT = beds24) faqat QAYD ETILADI, tuzatilmaydi:
 * avtomatik tuzatish bu holda ma'lumot yo'qotishga olib kelardi.
 */
export async function checkDrift(daysAhead = 30): Promise<DriftResult> {
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + daysAhead);

  const fromKey = toDateKey(from) ?? "";
  const toKey = toDateKey(to) ?? "";

  const sot = await getAvailabilitySoT();
  const types = await prisma.roomType.findMany({ select: { id: true } });

  const details: DriftDay[] = [];
  let checkedDays = 0;
  const needFix = new Set<string>();

  for (const type of types) {
    const mapping = await findRoomTypeMapping(type.id);
    if (!mapping?.externalRoomTypeId) continue;    // mapping yo'q — solishtirib bo'lmaydi

    // PMS tomoni: hisobni yangilaymiz, keyin o'qiymiz
    await recalcAvailability([type.id], from, to);
    const pmsDays = await readRange(type.id, from, to);
    const pmsByDate = new Map(pmsDays.map((d) => [d.date, d.availableCount]));

    // Beds24 tomoni
    let remote: Array<{ date: string; available: number }>;
    try {
      remote = await getChannel().getAvailability(mapping.externalRoomTypeId, fromKey, toKey);
    } catch (e) {
      // Beds24 javob bermasa drift tekshirib bo'lmaydi — PMS
      // ishlashda davom etadi (TZ 17-band)
      console.warn(`[drift] ${type.id} o'qilmadi: ${String(e).slice(0, 100)}`);
      continue;
    }

    for (const r of remote) {
      const pms = pmsByDate.get(r.date);
      if (pms === undefined) continue;

      checkedDays++;
      if (pms !== r.available) {
        details.push({ roomTypeId: type.id, date: r.date, pms, beds24: r.available });
        needFix.add(type.id);
      }
    }
  }

  // --- Farq topildi ---
  let corrected = 0;

  if (details.length > 0) {
    await logSync({
      action: "drift_detected",
      direction: "PMS_TO_CHANNEL",
      status: "FAILED",
      request: { checkedDays, sot },
      response: { driftDays: details.length, sample: details.slice(0, 20) },
      errorMessage: `${details.length} kun farq qildi`,
    });

    notifySyncFailed(
      "drift_detected",
      `${details.length} kunda PMS va Beds24 farq qiladi (${[...needFix].join(", ")})`
    );

    if (sot === "pms") {
      // Tuzatuvchi job — `syncedCount` ni tozalab qayta yuboramiz,
      // aks holda "o'zgarish yo'q" deb o'tkazib yuborilardi
      for (const roomTypeId of needFix) {
        await prisma.availability.updateMany({
          where: { roomTypeId, date: { gte: from, lte: to } },
          data: { syncedCount: null },
        });
        await enqueueAvailabilitySync([roomTypeId], from, to, "drift_correction");
        corrected++;
      }
    }
  } else {
    await logSync({
      action: "drift_check",
      direction: "PMS_TO_CHANNEL",
      status: "SUCCESS",
      response: { checkedDays, driftDays: 0 },
    });
  }

  return { checkedDays, driftDays: details.length, corrected, details };
}

// ============================================================
//  4. Qolib ketgan sync'larni tozalash (TZ 17-band)
// ============================================================

export type CatchUpResult = {
  pendingWebhooks: number;
  pendingReservations: number;
  requeued: number;
};

/**
 * Beds24 uzoq o'chib turgandan keyin qolib ketgan ishni yuboradi.
 *
 * TZ 17-band: "Beds24 qayta ishlaganda avtomatik yuborilsin."
 *
 * Navbat o'zi retry qiladi, lekin 5 urinishdan keyin job `failed`
 * bo'ladi va u yerda qolib ketadi. Beds24 bir necha soatdan keyin
 * qaytsa — hech kim ularni qayta yubormaydi. Shu funksiya aynan
 * shu bo'shliqni yopadi.
 */
export async function catchUpPending(): Promise<CatchUpResult> {
  const { processPendingEvents } = await import("./webhookProcessor.js");
  const { resyncFailed } = await import("./reservationSync.js");

  // 1) QUEUED holatida qolgan webhook'lar
  const webhooks = await processPendingEvents(100);

  // 2) FAILED / NOT_APPLICABLE bronlar
  const reservations = await resyncFailed(100);

  // 3) Yuborilmagan availability — `syncedCount` null bo'lgan
  //    kelajak kunlar
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const unsent = await prisma.availability.groupBy({
    by: ["roomTypeId"],
    where: { syncedCount: null, date: { gte: today } },
    _min: { date: true },
    _max: { date: true },
  });

  let requeued = 0;
  for (const row of unsent) {
    if (!row._min.date || !row._max.date) continue;
    const to = new Date(row._max.date);
    to.setUTCDate(to.getUTCDate() + 1);     // `to` chiqmaydi

    const r = await enqueueAvailabilitySync([row.roomTypeId], row._min.date, to, "catch_up");
    if (r.queued) requeued++;
  }

  return {
    pendingWebhooks: webhooks.processed + webhooks.needsAction,
    pendingReservations: reservations.sent,
    requeued,
  };
}

// ============================================================
//  5. Beds24 holati
// ============================================================

/**
 * Beds24 javob beryaptimi.
 *
 * `/health` uchun: admin kanal o'chganini darhol ko'radi va
 * "nega OTA'da yangilanmayapti" degan savol tug'ilmaydi.
 */
export async function checkChannelHealth(): Promise<{
  reachable: boolean;
  credits?: number;
  error?: string;
}> {
  try {
    // Kanal javob beryaptimi — kesh chetlab o'tiladi, aks holda
    // o'chgan kanal ham "ishlayapti" bo'lib ko'rinardi
    const props = await getChannel().getRoomTypes();
    return { reachable: true, credits: props.length > 0 ? undefined : 0 };
  } catch (e) {
    return { reachable: false, error: String(e).slice(0, 200) };
  }
}

/** Polling oralig'i — `.env` dan (04-fayl §8: 15 daqiqa) */
export const POLL_INTERVAL_MINUTES = config.pollIntervalMinutes;
