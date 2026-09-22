/**
 * Davriy vazifalar — TZ 3, 10, 17-band
 *
 * Manba: 13-WEBSITE-INTEGRATSIYA.md §5 (to'lanmagan bron),
 *        04-WEBHOOK-HANDLER.md §8 (polling fallback)
 *
 * NEGA BullMQ REPEATABLE, `setInterval` EMAS:
 *   - Bir nechta instansiya ko'tarilganda `setInterval` har birida
 *     ishlaydi va vazifa N marta bajariladi
 *   - BullMQ repeatable job bitta instansiyada bajariladi
 *   - Server qayta ishga tushganda jadval Redis'da saqlanib qoladi
 *
 * REDIS YO'Q BO'LSA: jadval o'rnatilmaydi, lekin PMS ishlashda
 * davom etadi (TZ 17, 19-band). Vazifalarni qo'lda ham chaqirish
 * mumkin — admin endpoint'lari orqali.
 */

import { Queue, Worker, type Job } from "bullmq";
import { config } from "../lib/config.js";
import { QUEUE, redisConnection, registerWorker, registerQueue } from "./index.js";
import { expireUnpaidBookings } from "../services/publicBooking.js";
import { pollBookings, checkDrift, catchUpPending } from "../services/reconciliation.js";
import { pruneAuditLog } from "../services/auditLog.js";
import { sendPendingTasks } from "../services/cleaning.js";
import { remindStaleTasks } from "../bot/cleaning-bot.js";
import { sendDailyKitchenReport } from "../bot/kitchen-bot.js";

const connection = redisConnection as never;

/** Vazifa turlari */
export type MaintenanceJob =
  | { task: "expire_unpaid" }
  | { task: "poll_beds24" }
  | { task: "drift_check" }
  | { task: "catch_up" }
  | { task: "prune_audit" }
  | { task: "cleaning_check" }
  | { task: "kitchen_report"; offset: 0 | 1 };

export const maintenanceQueue = new Queue<MaintenanceJob>(QUEUE.maintenance, {
  connection,
  defaultJobOptions: {
    // Davriy vazifa — bir marta yiqilsa keyingi safar qayta uriniladi.
    // Ko'p retry navbatni to'ldiradi va foyda bermaydi.
    attempts: 2,
    backoff: { type: "fixed", delay: 30_000 },
    removeOnComplete: { age: 86_400, count: 100 },
    removeOnFail: { age: 604_800, count: 100 },
  },
});

// ============================================================
//  Worker
// ============================================================

export const maintenanceWorker = new Worker<MaintenanceJob>(
  QUEUE.maintenance,
  async (job: Job<MaintenanceJob>) => {
    switch (job.data.task) {
      case "expire_unpaid": {
        // 13-fayl §5: to'lanmagan bron abadiy band qilib tursa
        // real sotuv yo'qoladi
        const result = await expireUnpaidBookings();
        if (result.cancelled > 0) {
          console.log(
            `[maintenance] ${result.cancelled} to'lanmagan bron bekor qilindi: ` +
            result.codes.join(", ")
          );
        }
        return result;
      }

      case "poll_beds24": {
        // TZ 10-band: webhook ishlamasa ham o'zgarishlar tushadi
        // (04-fayl §8). Asosiy oqim emas — "tutib olish to'ri".
        const result = await pollBookings();
        if (config.isDev && result.fetched > 0) {
          console.log(
            `[maintenance] polling: ${result.fetched} bron tekshirildi, ` +
            `${result.created} yangi, ${result.updated} yangilandi`
          );
        }
        return result;
      }

      case "drift_check": {
        // TZ 20-band: PMS va Beds24 bir xil inventory ko'rishi
        // (07-fayl §6)
        const result = await checkDrift(30);
        if (result.driftDays > 0) {
          console.warn(
            `[maintenance] DRIFT: ${result.driftDays} kun farq qildi, ` +
            `${result.corrected} tur tuzatishga qo'yildi`
          );
        }
        return result;
      }

      case "catch_up": {
        // TZ 17-band: "Beds24 qayta ishlaganda avtomatik yuborilsin"
        const result = await catchUpPending();
        const total = result.pendingWebhooks + result.pendingReservations + result.requeued;
        if (config.isDev && total > 0) {
          console.log(
            `[maintenance] catch-up: ${result.pendingWebhooks} webhook, ` +
            `${result.pendingReservations} bron, ${result.requeued} availability`
          );
        }
        return result;
      }

      case "cleaning_check": {
        /**
         * Tozalash tekshiruvi (TOZALIK-BOT.md).
         *
         * Ikki ish:
         *   1. Tunda to'plangan topshiriqlarni yuborish
         *      (ish vaqti boshlanganda)
         *   2. Javob bermaganlar haqida egasiga eslatma
         */
        const [pending, reminded] = await Promise.all([
          sendPendingTasks(),
          remindStaleTasks(),
        ]);

        if (pending.sent > 0 || reminded.sent > 0) {
          console.log(
            `[maintenance] tozalash: ${pending.sent} yuborildi, ` +
            `${reminded.sent} eslatma`
          );
        }
        return { pending: pending.sent, reminded: reminded.sent };
      }

      case "kitchen_report": {
        const res = await sendDailyKitchenReport(job.data.offset);
        if (res.sent > 0) {
          console.log(`[maintenance] oshxona: ${res.sent} chatga hisobot yuborildi`);
        }
        return res;
      }

      default:
        return { ok: true, skipped: true };
    }
  },
  { connection, concurrency: 1 }
);

registerWorker(maintenanceWorker);
registerQueue(maintenanceQueue);

// ============================================================
//  Jadval
// ============================================================

/**
 * Davriy vazifalarni ro'yxatdan o'tkazadi.
 *
 * `jobId` barqaror — server qayta ishga tushganda jadval
 * takrorlanmaydi, BullMQ mavjudini qayta ishlatadi.
 */
export async function scheduleMaintenance(): Promise<void> {
  try {
    // To'lanmagan bronlar — har soatda (13-fayl §5).
    //
    // BullMQ v6 da `add({ repeat })` o'rniga `upsertJobScheduler`
    // ishlatiladi: scheduler alohida obyekt bo'lib, bir xil kalit
    // bilan qayta chaqirilsa jadval TAKRORLANMAYDI — server qayta
    // ishga tushganda dublikat yaratilmaydi.
    await maintenanceQueue.upsertJobScheduler(
      "cron_expire_unpaid",
      { pattern: "0 * * * *" },              // har soat boshida
      { name: "expire_unpaid", data: { task: "expire_unpaid" } }
    );

    // Polling fallback — har 15 daqiqada (04-fayl §8, TZ 10-band)
    await maintenanceQueue.upsertJobScheduler(
      "cron_poll_beds24",
      { every: config.pollIntervalMinutes * 60_000 },
      { name: "poll_beds24", data: { task: "poll_beds24" } }
    );

    // Qolib ketgan sync — har 15 daqiqada (TZ 17-band).
    // Polling'dan keyin ishlaydi: u yangi ma'lumot olib keladi,
    // bu esa yuborilmay qolganlarni tozalaydi.
    await maintenanceQueue.upsertJobScheduler(
      "cron_catch_up",
      { every: config.pollIntervalMinutes * 60_000, offset: 60_000 },
      { name: "catch_up", data: { task: "catch_up" } }
    );

    // Drift tekshiruvi — kuniga bir marta, kam yuklamali vaqtda
    // (07-fayl §6, TZ 20-band). Har kuni 04:00 da.
    await maintenanceQueue.upsertJobScheduler(
      "cron_drift_check",
      { pattern: "0 4 * * *" },
      { name: "drift_check", data: { task: "drift_check" } }
    );

    // Tozalash tekshiruvi — har 10 daqiqada.
    //
    // Tez-tez: ish vaqti boshlanganda to'plangan topshiriqlar
    // darhol ketishi kerak, va kechikkan ishni uzoq kutmaslik
    // kerak. Yengil so'rov — indeksli, bir nechta qator.
    await maintenanceQueue.upsertJobScheduler(
      "cron_cleaning_check",
      { every: 10 * 60_000 },
      { name: "cleaning_check", data: { task: "cleaning_check" } }
    );

    // Oshxona hisoboti: ertalab 07:30 da bugungi nonushta,
    // kechqurun 20:00 da ertangi kun uchun mahsulot tayyorlash
    await maintenanceQueue.upsertJobScheduler(
      "cron_kitchen_morning",
      { pattern: "30 7 * * *" },
      { name: "kitchen_morning", data: { task: "kitchen_report", offset: 0 } }
    );
    await maintenanceQueue.upsertJobScheduler(
      "cron_kitchen_evening",
      { pattern: "0 20 * * *" },
      { name: "kitchen_evening", data: { task: "kitchen_report", offset: 1 } }
    );

    if (config.isDev) {
      console.log(
        `  Davriy vazifalar: to'lanmagan bronlar (soatlik), ` +
        `polling + catch-up (${config.pollIntervalMinutes} daq), drift (kunlik), oshxona (kuniga 2 mahal)`
      );
    }
  } catch (e) {
    // Redis yo'q — PMS baribir ishlaydi (TZ 17, 19-band)
    console.warn(`[maintenance] jadval o'rnatilmadi: ${String(e).slice(0, 100)}`);
  }
}

// --- Qo'lda ishga tushirish (admin endpoint'lari uchun) -----
//
// Dasturchi topshirishda va admin nosozlikda kutmasdan
// tekshirishi uchun. Jadval o'z vaqtida baribir ishlaydi.

export const runExpireNow = () => expireUnpaidBookings();
export const runPruneAuditNow = () => pruneAuditLog();
export const runPollNow = () => pollBookings();
export const runDriftCheckNow = (days?: number) => checkDrift(days ?? 30);
export const runCatchUpNow = () => catchUpPending();
export const runKitchenReportNow = (offset: 0 | 1 = 0) => sendDailyKitchenReport(offset);
