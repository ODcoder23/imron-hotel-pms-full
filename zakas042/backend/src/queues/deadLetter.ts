/**
 * `beds24-retry` navbati — TZ 11-band
 *
 * Manba: 05-SYNC-QUEUE-BULLMQ.md §3, TZ 11-band navbatlar ro'yxati
 *
 * TZ beshta navbatni sanaydi, shundan to'rttasi — ish navbatlari
 * (webhook, reservation, availability, rate). Beshinchisi —
 * `beds24-retry` — retry MEXANIZMI emas: retry allaqachon har
 * navbatning o'zida ishlaydi (BullMQ `attempts: 5`, exponential
 * backoff).
 *
 * SHUNING UCHUN BU NAVBAT — "O'LIK XAT" (dead letter):
 *   5 urinishdan keyin ham bo'lmagan job shu yerga tushadi
 *        ↓
 *   Admin ro'yxatda ko'radi: nima, qachon, nega yiqildi
 *        ↓
 *   Sabab tuzatilgach (mapping bog'landi, Beds24 qaytdi) —
 *   bitta tugma bilan qayta yuboriladi
 *
 * NEGA KERAK: `failed` job BullMQ ichida qoladi va uni faqat
 * Redis'ga kirib ko'rish mumkin. Admin panelda ko'rinmaydi, ya'ni
 * yo'qolgan sync jim qoladi. TZ 11-band "Errorlar SyncLog'ga
 * yozilsin" deydi — bu esa uning amaliy davomi: xato yozilgan,
 * endi u bilan nima qilish kerakligi ham bor.
 */

import { Queue, Worker, type Job } from "bullmq";
import { config } from "../lib/config.js";
import { QUEUE, redisConnection, registerWorker, registerQueue } from "./index.js";
import { logSync } from "../lib/syncLog.js";

const connection = redisConnection as never;

export type DeadLetterJob = {
  /** Qaysi navbatdan tushdi */
  sourceQueue: string;
  /** Asl job nomi va ma'lumoti */
  jobName: string;
  payload: unknown;
  /** Nega yiqildi */
  failedReason: string;
  attempts: number;
  failedAt: string;
};

export const deadLetterQueue = new Queue<DeadLetterJob>(QUEUE.retry, {
  connection,
  defaultJobOptions: {
    // Bu yerda retry YO'Q — job shunchaki saqlanadi va kutadi.
    // Qayta urinish admin qarori bilan bo'ladi.
    attempts: 1,
    removeOnComplete: { age: 604_800, count: 500 },   // bir hafta
    removeOnFail: false,
  },
});

registerQueue(deadLetterQueue);

/**
 * Yiqilgan job'ni o'lik xat navbatiga ko'chiradi.
 *
 * Har navbatning `failed` hodisasidan chaqiriladi (workers.ts).
 * Xato tashlamaydi — o'lik xat yozilmagani uchun asosiy oqim
 * to'xtamasligi kerak (TZ 17-band).
 */
export async function moveToDeadLetter(
  job: Job,
  reason: string,
  isFinal?: boolean
): Promise<void> {
  try {
    // Faqat HAMMA urinish tugagach — oraliq xatolar tushmaydi.
    //
    // `isFinal` chaqiruvchidan keladi: `UnrecoverableError` da
    // `attemptsMade` maksimumga yetmaydi (BullMQ qayta urinmaydi),
    // shuning uchun faqat sonni solishtirish yetarli emas.
    if (isFinal !== true) {
      const maxAttempts = job.opts.attempts ?? 1;
      if (job.attemptsMade < maxAttempts) return;
    }

    await deadLetterQueue.add("dead", {
      sourceQueue: job.queueName,
      jobName: job.name,
      payload: job.data,
      failedReason: reason.slice(0, 500),
      attempts: job.attemptsMade,
      failedAt: new Date().toISOString(),
    });

    await logSync({
      action: "job_dead_lettered",
      direction: "PMS_TO_CHANNEL",
      status: "FAILED",
      request: { queue: job.queueName, job: job.name },
      errorMessage: reason.slice(0, 300),
      attempt: job.attemptsMade,
    });
  } catch (e) {
    console.warn(`[dead-letter] yozilmadi: ${String(e).slice(0, 120)}`);
  }
}

/**
 * O'lik xat worker'i.
 *
 * Job'ni BAJARMAYDI — faqat saqlaydi. `waiting` holatida turadi
 * va admin ro'yxatda ko'radi. Shuning uchun worker `completed`
 * qilmaydi: aks holda job ro'yxatdan yo'qolardi.
 *
 * Faqat qayta yuborish so'ralganda ishlaydi (`requeue: true`).
 */
export const deadLetterWorker = new Worker<DeadLetterJob>(
  QUEUE.retry,
  async (job: Job<DeadLetterJob>) => {
    if (config.isDev) {
      console.log(
        `[dead-letter] ${job.data.sourceQueue}/${job.data.jobName}: ` +
        job.data.failedReason.slice(0, 80)
      );
    }
    // Hech narsa qilmaydi — saqlash uchun
    return { stored: true };
  },
  { connection, concurrency: 1 }
);

registerWorker(deadLetterWorker);

// ============================================================
//  Admin uchun
// ============================================================

export type DeadLetterEntry = DeadLetterJob & { id: string };

/** O'lik xatdagi job'lar ro'yxati */
export async function listDeadLetters(limit = 50): Promise<DeadLetterEntry[]> {
  const jobs = await deadLetterQueue.getJobs(
    ["waiting", "completed", "failed", "delayed"],
    0,
    Math.min(limit, 200)
  );

  return jobs
    .filter((j): j is Job<DeadLetterJob> => Boolean(j?.data))
    .map((j) => ({ id: j.id ?? "", ...j.data }))
    .sort((a, b) => b.failedAt.localeCompare(a.failedAt));
}

export type RequeueResult = { requeued: number; notFound: number };

/**
 * O'lik xatdagi job'ni asl navbatiga qaytaradi.
 *
 * Sabab tuzatilgandan keyin (mapping bog'landi, Beds24 qaytdi)
 * admin shu tugmani bosadi.
 */
export async function requeueDeadLetter(ids: string[]): Promise<RequeueResult> {
  const {
    webhookQueue, reservationSyncQueue, availabilitySyncQueue, rateSyncQueue,
  } = await import("./index.js");

  const byName: Record<string, Queue> = {
    [QUEUE.webhook]: webhookQueue as never,
    [QUEUE.reservationSync]: reservationSyncQueue as never,
    [QUEUE.availabilitySync]: availabilitySyncQueue as never,
    [QUEUE.rateSync]: rateSyncQueue as never,
  };

  let requeued = 0;
  let notFound = 0;

  for (const id of ids) {
    const job = await deadLetterQueue.getJob(id);
    if (!job?.data) { notFound++; continue; }

    const target = byName[job.data.sourceQueue];
    if (!target) { notFound++; continue; }

    // Yangi `jobId` — eski id bloklab qo'ymasligi uchun
    await target.add(job.data.jobName, job.data.payload as never, {
      jobId: `requeue_${id}_${Date.now()}`,
    });

    await job.remove();
    requeued++;
  }

  return { requeued, notFound };
}

/** O'lik xatni tozalash — eski yozuvlar */
export async function clearDeadLetters(): Promise<number> {
  const jobs = await deadLetterQueue.getJobs(["waiting", "completed", "failed", "delayed"]);
  let removed = 0;
  for (const j of jobs) {
    await j.remove().catch(() => {});
    removed++;
  }
  return removed;
}
