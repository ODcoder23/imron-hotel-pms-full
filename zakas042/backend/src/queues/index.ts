/**
 * Sync navbatlari — TZ 11-band
 *
 * Manba: 05-SYNC-QUEUE-BULLMQ.md
 *
 * TZ aynan beshtasini nomma-nom talab qiladi:
 *   beds24-reservation-sync
 *   beds24-availability-sync
 *   beds24-rate-sync
 *   beds24-webhook
 *   beds24-retry
 *
 * RETRY (TZ 11-band): "API xato bersa retry -> retry -> retry"
 *   attempts: 5, exponential backoff 5s, 10s, 20s, 40s, 80s
 *
 * MUHIM (05-fayl §3): kredit tugashi XATO EMAS. Job kechiktiriladi
 * va `attempts` hisobiga kirmaydi. Aks holda normal yuklamada
 * job'lar bekorga "failed" bo'lib qolardi.
 */

import { Queue, Worker, type JobsOptions, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { config } from "../lib/config.js";

// --- Redis ulanishi -----------------------------------------

/**
 * BullMQ `maxRetriesPerRequest: null` talab qiladi — aks holda
 * ulanish uzilganda job'lar yo'qoladi.
 */
export const redisConnection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: false,
});

redisConnection.on("error", (e) => {
  // Ulanish yo'qolsa BullMQ o'zi qayta ulanadi — bu yerda faqat log
  if (config.isDev) console.warn(`[redis] ${e.message}`);
});

const connection: ConnectionOptions = redisConnection as unknown as ConnectionOptions;

// --- Navbat nomlari (TZ 11-band) ----------------------------

export const QUEUE = {
  reservationSync: "beds24-reservation-sync",
  availabilitySync: "beds24-availability-sync",
  rateSync: "beds24-rate-sync",
  webhook: "beds24-webhook",
  retry: "beds24-retry",
  /** Davriy vazifalar: to'lanmagan bronlar, polling fallback */
  maintenance: "pms-maintenance",
} as const;

// --- Job payload tiplari ------------------------------------

export type WebhookJob = {
  webhookEventId: string;
};

export type ReservationSyncJob = {
  reservationId: string;
  changeType:
    | "created" | "updated" | "room_changed" | "dates_changed"
    | "guests_changed" | "price_changed" | "cancelled"
    | "checked_in" | "checked_out" | "no_show";
  previousState?: { roomId?: string; checkIn?: string; checkOut?: string };
  triggeredBy?: string;
  requestedAt: string;
};

export type AvailabilitySyncJob = {
  roomTypeIds: string[];
  from: string;
  to: string;
  reason: string;
};

export type RateSyncJob = {
  roomTypeIds: string[];
  from: string;
  to: string;
};

// --- Umumiy job sozlamalari (TZ 11-band) --------------------

export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },   // 5s 10s 20s 40s 80s
  removeOnComplete: { age: 86_400, count: 1000 },
  removeOnFail: false,        // xatolar saqlanadi — tahlil uchun
};

// --- Navbatlar ----------------------------------------------

export const webhookQueue = new Queue<WebhookJob>(QUEUE.webhook, {
  connection,
  defaultJobOptions,
});

export const reservationSyncQueue = new Queue<ReservationSyncJob>(QUEUE.reservationSync, {
  connection,
  defaultJobOptions,
});

export const availabilitySyncQueue = new Queue<AvailabilitySyncJob>(QUEUE.availabilitySync, {
  connection,
  defaultJobOptions,
});

export const rateSyncQueue = new Queue<RateSyncJob>(QUEUE.rateSync, {
  connection,
  defaultJobOptions,
});

export const allQueues = [
  webhookQueue,
  reservationSyncQueue,
  availabilitySyncQueue,
  rateSyncQueue,
];

/**
 * Navbatni monitoring ro'yxatiga qo'shadi.
 *
 * `scheduler.ts` shu faylni import qiladi, teskarisi emas —
 * sikl bo'lmasligi uchun o'zini ro'yxatga shu funksiya bilan
 * qo'shadi.
 */
export function registerQueue(q: Queue): void {
  if (!allQueues.includes(q)) allQueues.push(q);
}

// --- Monitoring (05-fayl §8) --------------------------------

export async function getQueueCounts() {
  const out: Record<string, Record<string, number>> = {};
  for (const q of allQueues) {
    out[q.name] = await q.getJobCounts("waiting", "active", "completed", "failed", "delayed");
  }
  return out;
}

/** Eski yiqilgan va tugagan job'larni tozalaydi */
export async function cleanQueueHistory(): Promise<Record<string, { failed: number; completed: number }>> {
  const result: Record<string, { failed: number; completed: number }> = {};
  for (const q of allQueues) {
    const failedCleaned = await q.clean(0, 10000, "failed");
    const completedCleaned = await q.clean(0, 10000, "completed");
    result[q.name] = {
      failed: failedCleaned.length,
      completed: completedCleaned.length,
    };
  }
  return result;
}


/** Redis ishlayaptimi — /health uchun */
export async function isRedisHealthy(): Promise<boolean> {
  // MUHIM: `redisConnection` da `maxRetriesPerRequest: null` — bu
  // BullMQ uchun shart (ulanish uzilganda job yo'qolmasligi uchun),
  // lekin `ping()` cheksiz kutadi degani. Redis o'chganda `/health`
  // umuman javob bermay qolardi va TZ 17, 19-band buzilardi:
  // "Beds24/Redis ishlamasa PMS ishlashda davom etishi kerak".
  //
  // Shuning uchun ping TIMEOUT bilan o'raladi. 1 soniya yetarli:
  // lokal Redis millisekundlarda javob beradi, javob bermasa
  // "o'chgan" deb hisoblash to'g'ri.
  try {
    const ping = redisConnection.ping();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("redis ping timeout")), 1000)
    );
    await Promise.race([ping, timeout]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Navbatga qo'yishni TIMEOUT bilan o'raydi.
 *
 * MUAMMO: `redisConnection` da `maxRetriesPerRequest: null` — BullMQ
 * uchun shart (ulanish uzilganda job yo'qolmasligi uchun). Lekin bu
 * `queue.add()` Redis javobini CHEKSIZ kutadi degani: Redis o'chsa
 * `try/catch` ham yordam bermaydi, chunki xato tashlanmaydi —
 * so'rov shunchaki osilib qoladi.
 *
 * Natijada bron yaratish 15+ soniya kutardi va TZ 17, 19-band
 * buzilardi: "PMSning ichki ishlashi Beds24ga (va Redis'ga)
 * bog'lanib qolmasin."
 *
 * Endi 2 soniyada javob kelmasa navbatga qo'yish TASHLAB
 * YUBORILADI. Bron DB'da saqlangan, sync esa `catch_up` davriy
 * vazifasi orqali keyinroq yuboriladi (14-faza).
 */
/**
 * Redis oxirgi marta qachon javob bermagani.
 *
 * Redis uzoq o'chgan bo'lsa har amal 2 soniya kutib turishi
 * ma'nosiz: bron yaratish, check-in, bekor qilish — hammasi
 * sekinlashadi. Bir marta javob bermasa, keyingi 30 soniya
 * davomida umuman urinmaymiz.
 *
 * Redis qaytganda birinchi urinish o'tadi va bayroq tozalanadi.
 */
let redisDownUntil = 0;
const DOWN_COOLDOWN_MS = 30_000;

export async function enqueueWithTimeout<T>(
  fn: () => Promise<T>,
  label: string,
  timeoutMs = 2000
): Promise<T | null> {
  if (Date.now() < redisDownUntil) {
    // Redis yaqinda javob bermagan — kutmaymiz
    return null;
  }

  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: navbat javob bermadi`)), timeoutMs)
    );
    const result = await Promise.race([fn(), timeout]);
    redisDownUntil = 0;      // javob keldi — bayroq tozalanadi
    return result;
  } catch (e) {
    redisDownUntil = Date.now() + DOWN_COOLDOWN_MS;
    console.warn(`[queue] ${label} qo'yilmadi: ${String(e).slice(0, 120)}`);
    return null;
  }
}

// --- Toza to'xtatish ----------------------------------------

const workers: Worker[] = [];

export function registerWorker(w: Worker): void {
  workers.push(w);
}

export async function shutdownQueues(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(allQueues.map((q) => q.close()));
  await redisConnection.quit();
}
