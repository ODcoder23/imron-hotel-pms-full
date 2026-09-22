/**
 * BullMQ worker'lari — TZ 11, 17-band
 *
 * Manba: 05-SYNC-QUEUE-BULLMQ.md
 *
 * MUHIM FARQ (05-fayl §3, §4):
 *   RateLimitError  -> job KECHIKTIRILADI, attempts hisobiga kirmaydi
 *   Boshqa xatolar  -> retry (5 urinish, exponential backoff)
 *   Retryable emas  -> darhol failed (validatsiya xatosi, mapping yo'q)
 *
 * Kredit tugashi xato emas — aks holda normal yuklamada job'lar
 * bekorga "failed" bo'lib qolardi.
 */

import { Worker, UnrecoverableError, DelayedError, type Job } from "bullmq";
import { config } from "../lib/config.js";
import {
  QUEUE,
  redisConnection,
  registerWorker,
  type WebhookJob,
  type ReservationSyncJob,
  type AvailabilitySyncJob,
  type RateSyncJob,
} from "./index.js";
import { processWebhookEvent } from "../services/webhookProcessor.js";
import { syncAvailabilityRange } from "../services/availability.js";
import { pushReservation } from "../services/reservationSync.js";
import { syncRatesRange } from "../services/rates.js";
import { moveToDeadLetter } from "./deadLetter.js";
import { notifySyncFailed } from "../realtime/notify.js";
import { RateLimitError, isRetryable, getRetryDelay } from "../services/beds24/client.js";

const connection = redisConnection as never;

/** Kredit tugaganda job'ni kechiktiradi (05-fayl §3) */
async function delayForRateLimit(job: Job, e: RateLimitError, token?: string): Promise<never> {
  const ms = e.retryAfterSeconds * 1000;
  console.warn(`[worker] ${job.queueName} kredit tugadi, ${e.retryAfterSeconds}s kechiktirildi`);
  await job.moveToDelayed(Date.now() + ms, token);
  throw new DelayedError();
}

// ============================================================
//  1. Webhook worker — WebhookEvent -> Reservation
// ============================================================

export const webhookWorker = new Worker<WebhookJob>(
  QUEUE.webhook,
  async (job) => {
    const result = await processWebhookEvent(job.data.webhookEventId);

    // Mapping yo'q / bo'sh xona yo'q — qayta urinish FOYDASIZ.
    // Admin mapping'ni to'g'irlab, qo'lda "Qayta ishlash" bosadi
    // (04-fayl §7). UnrecoverableError retry'ni to'xtatadi.
    if (result.status === "needs_manual_action") {
      throw new UnrecoverableError(result.detail);
    }

    return result;
  },
  {
    connection,
    concurrency: 3,
    // Bir bron uchun bir vaqtda bitta job — ketma-ketlik kafolati
    // (05-fayl §6). Tartib buzilsa ham processor DB'dagi joriy
    // holatga qarab ishlaydi, shuning uchun natija baribir to'g'ri.
  }
);

// ============================================================
//  2. Reservation sync — PMS -> Beds24 (FAZA 10 da to'ldiriladi)
// ============================================================

export const reservationSyncWorker = new Worker<ReservationSyncJob>(
  QUEUE.reservationSync,
  async (job, token) => {
    const { reservationId, changeType } = job.data;

    try {
      if (config.isDev) {
        console.log(`[worker] reservation-sync: ${changeType} #${reservationId}`);
      }

      // IDEMPOTENTLIK (12-fayl §2): payload'dagi eski nusxa emas,
      // DB'dagi joriy holat yuboriladi. Job navbatda turganda bron
      // yana o'zgargan bo'lsa — eng oxirgi holat ketadi.
      const outcome = await pushReservation(reservationId);

      if (outcome.status === "failed") {
        notifySyncFailed("push_reservation", outcome.error, reservationId);

        // Mapping yo'q / validatsiya xatosi — qayta urinish
        // foydasiz, admin aralashuvi kerak (06-fayl §3).
        if (!outcome.retryable) {
          throw new UnrecoverableError(outcome.error.slice(0, 200));
        }
        throw new Error(outcome.error);
      }

      if (config.isDev && outcome.status === "sent") {
        console.log(
          `[worker] bron ${outcome.created ? "yaratildi" : "yangilandi"}: ` +
          `Beds24 #${outcome.externalId ?? "?"}`
        );
      }

      return { ok: true, ...outcome };
    } catch (e) {
      if (e instanceof RateLimitError) return delayForRateLimit(job, e, token);
      if (e instanceof UnrecoverableError) throw e;
      if (!isRetryable(e)) throw new UnrecoverableError(String(e).slice(0, 200));
      throw e;
    }
  },
  { connection, concurrency: 2 }
);

// ============================================================
//  3. Availability sync — PMS -> Beds24 (FAZA 9)
// ============================================================

export const availabilitySyncWorker = new Worker<AvailabilitySyncJob>(
  QUEUE.availabilitySync,
  async (job, token) => {
    const { roomTypeIds, from, to, reason } = job.data;

    try {
      if (config.isDev) {
        console.log(
          `[worker] availability-sync: ${roomTypeIds.join(",")} ${from}..${to} (${reason})`
        );
      }

      // Job navbatda kutgan vaqtda yana bron kelishi mumkin —
      // yuborishdan oldin qayta hisoblaymiz (07-fayl §4).
      const result = await syncAvailabilityRange(roomTypeIds, from, to, { recalc: true });

      // Mapping yo'q kabi xatolar qayta urinishda ham tuzalmaydi:
      // admin aralashuvi kerak (06-fayl §3). Shuning uchun job'ni
      // failed qilamiz va adminni ogohlantiramiz.
      if (result.failed > 0) {
        const errors = result.outcomes
          .filter((o) => o.status === "failed")
          .map((o) => (o.status === "failed" ? `${o.roomTypeId}: ${o.error}` : ""))
          .join("; ");

        notifySyncFailed("push_availability", errors);
        throw new Error(errors);
      }

      if (config.isDev && result.sent > 0) {
        const sentDetail = result.outcomes
          .filter((o) => o.status === "sent")
          .map((o) => (o.status === "sent" ? `${o.roomTypeId}(${o.days}k)` : ""))
          .join(" ");
        console.log(`[worker] availability yuborildi: ${sentDetail}`);
      }

      return { ok: true, sent: result.sent, skipped: result.skipped };
    } catch (e) {
      if (e instanceof RateLimitError) return delayForRateLimit(job, e, token);
      if (!isRetryable(e)) throw new UnrecoverableError(String(e).slice(0, 200));
      throw e;
    }
  },
  { connection, concurrency: 2 }
);

// ============================================================
//  4. Rate sync — PMS -> Beds24 (FAZA 11)
// ============================================================

export const rateSyncWorker = new Worker<RateSyncJob>(
  QUEUE.rateSync,
  async (job, token) => {
    const { roomTypeIds, from, to } = job.data;

    try {
      if (config.isDev) {
        console.log(`[worker] rate-sync: ${roomTypeIds.join(",")} ${from}..${to}`);
      }

      const result = await syncRatesRange(roomTypeIds, from, to);

      // Mapping yo'q kabi xatolar qayta urinishda tuzalmaydi —
      // admin aralashuvi kerak (06-fayl §3).
      if (result.failed > 0) {
        const errors = result.outcomes
          .filter((o) => o.status === "failed")
          .map((o) => (o.status === "failed" ? `${o.roomTypeId}: ${o.error}` : ""))
          .join("; ");

        notifySyncFailed("push_rates", errors);
        throw new Error(errors);
      }

      if (config.isDev && result.sent > 0) {
        console.log(`[worker] narx yuborildi: ${result.sent} tur`);
      }

      return { ok: true, sent: result.sent, skipped: result.skipped };
    } catch (e) {
      if (e instanceof RateLimitError) return delayForRateLimit(job, e, token);
      if (!isRetryable(e)) throw new UnrecoverableError(String(e).slice(0, 200));
      throw e;
    }
  },
  { connection, concurrency: 1 }
);

// ============================================================
//  Umumiy event log
// ============================================================

const allWorkers = [
  webhookWorker,
  reservationSyncWorker,
  availabilitySyncWorker,
  rateSyncWorker,
];

for (const w of allWorkers) {
  registerWorker(w);

  w.on("failed", (job, err) => {
    const attempts = job?.attemptsMade ?? 0;
    const max = job?.opts.attempts ?? 1;
    const final = attempts >= max || err instanceof UnrecoverableError;

    console.error(
      `[worker] ${w.name} ${final ? "TUGADI" : `urinish ${attempts}/${max}`}: ` +
      `${err.message.slice(0, 160)}`
    );

    // Barcha urinish tugagach — o'lik xat navbatiga (TZ 11-band).
    // Aks holda yiqilgan job faqat Redis ichida qoladi va admin
    // panelda ko'rinmaydi, ya'ni yo'qolgan sync jim o'tib ketadi.
    if (final && job) {
      // `final` yuqorida hisoblangan: urinishlar tugadi YOKI
      // UnrecoverableError (mapping yo'q kabi — qayta urinish
      // foydasiz). Ikkala holat ham o'lik xatga tushadi.
      void moveToDeadLetter(job, err.message, true);
    }
  });

  if (config.isDev) {
    w.on("completed", (job) => {
      console.log(`[worker] ${w.name} #${job.id} bajarildi`);
    });
  }

  w.on("error", (err) => {
    // Redis uzilishi — BullMQ o'zi qayta ulanadi
    if (config.isDev) console.warn(`[worker] ${w.name} xatosi: ${err.message}`);
  });
}

export { allWorkers };
