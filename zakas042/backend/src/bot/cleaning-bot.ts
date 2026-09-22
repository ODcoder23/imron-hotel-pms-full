/**
 * 2-bot: TOZALIK (farroshlar guruhi) — BOTLAR-REJA.md
 *
 * OQIM
 * ----
 *   Mehmon chiqdi / admin yubordi
 *         ↓
 *   GURUHGA xabar + [Men olaman]
 *         ↓
 *   Farosh bosdi → xabar tahrirlanadi
 *         ↓
 *   "Oldi: Dilnoza" + [Tozaladim]
 *         ↓
 *   Bosdi → "Tasdiqlash kutilmoqda"
 *         ↓
 *   Admin panelda tasdiqlaydi → xona sotishga ochiladi
 *
 * NEGA ALOHIDA BOT
 * ----------------
 * Boshqaruv boti (`bot/index.ts`) moliya, bronlar va daromadni
 * ko'rsatadi. Farosh ularni ko'rmasligi kerak. Bitta bot ikkala
 * auditoriyaga xizmat qilsa, bitta token sizib ketganda
 * mehmonxona moliyasi ochilib qolardi.
 *
 * Bu botda moliya umuman yo'q — kod darajasida. Hech qanday
 * `screens.ts` importi yo'q.
 *
 * XAVFSIZLIK
 * ----------
 * Xabarlar FAQAT `TELEGRAM_CLEANING_GROUP_ID` guruhiga ketadi.
 * Tugmani o'sha guruhdagi har kim bosa oladi — guruhga faqat
 * farroshlar qo'shilgan deb hisoblanadi (2026-09-17 qarori).
 *
 * Kim bosgani ismi bilan yoziladi va guruhdagi hammaga
 * ko'rinadi — bu o'z-o'zini nazorat qiladi.
 *
 * Boshqa chatdan kelgan buyruq javobsiz qoladi: bot guruhdan
 * tashqarida hech narsa aytmaydi.
 *
 * ISHGA TUSHISH
 * -------------
 * Token yoki guruh ID bo'sh bo'lsa bot ishga tushmaydi, backend
 * esa normal ishlayveradi (TZ 19-band ruhida).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bot, GrammyError, type Context } from "grammy";
import { config } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { AppError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  taskMessage,
  taskKeyboard,
  tasksOverview,
  staleAlert,
  who,
  hhmm,
  minutesBetween,
  type TaskView,
} from "./cleaning.js";
import * as clean from "../services/cleaning.js";

let bot: Bot | null = null;

/** Qaysi farrosh qaysi topshiriq uchun rasm yuborishi kutilayotgani (telegramId -> taskId) */
const waitingPhotoTasks = new Map<string, string>();

/** Topshiriq + Telegram xabar havolasi */
type TaskRow = TaskView & { chatId: string | null; messageId: number | null };

/** Guruh ID — `config` dan, bo'sh bo'lsa bot ishlamaydi */
function groupId(): string {
  return config.telegram.cleaningGroupId;
}

// ============================================================
//  Xabar yuborish va yangilash
// ============================================================

/**
 * Yangi topshiriq — guruhga xabar.
 *
 * `chatId`/`messageId` saqlanadi: keyingi o'zgarishlarda
 * o'sha xabar TAHRIRLANADI, yangisi yuborilmaydi. Aks holda
 * bitta xona uchun guruhda to'rtta xabar to'planardi.
 */
async function sendTaskMessage(taskId: string): Promise<void> {
  if (!bot) return;

  const task = await prisma.cleaningTask.findUnique({
    where: { id: taskId },
    include: clean.taskInclude,
  });
  if (!task) return;

  const view = task as unknown as TaskView;

  try {
    const sent = await bot.api.sendMessage(groupId(), taskMessage(view), {
      parse_mode: "HTML",
      reply_markup: taskKeyboard(view),
    });

    await clean.saveMessageRef(taskId, String(sent.chat.id), sent.message_id);
  } catch (e) {
    // Xabar yuborilmagani topshiriqni bekor qilmaydi — u
    // admin panelda baribir ko'rinadi va qo'lda yuborilishi
    // mumkin (`POST /api/admin/cleaning/send-pending`).
    console.error("[tozalik-bot] xabar yuborilmadi:", String(e).slice(0, 200));
  }
}

/**
 * Holat o'zgardi — o'sha xabarni tahrirlaymiz.
 *
 * Xabar topilmasa (guruhdan o'chirilgan, 48 soatdan eski)
 * jim o'tkazib yuboriladi: bu xato emas.
 */
async function refreshTaskMessage(task: TaskRow): Promise<void> {
  if (!bot || !task.chatId || !task.messageId) return;

  try {
    await bot.api.editMessageText(
      task.chatId,
      task.messageId,
      taskMessage(task),
      { parse_mode: "HTML", reply_markup: taskKeyboard(task) }
    );
  } catch (e) {
    /**
     * "message is not modified" — matn o'zgarmagan.
     *
     * Bu normal holat: bir necha manba bir vaqtda yangilashni
     * so'rashi mumkin. Telegram xato deb qaytaradi, biz
     * e'tiborsiz qoldiramiz.
     */
    const msg = e instanceof GrammyError ? e.description : String(e);
    if (msg.includes("not modified") || msg.includes("message to edit not found")) return;
    console.error("[tozalik-bot] xabar tahrirlanmadi:", msg.slice(0, 200));
  }
}

/**
 * Admin tozalashni tasdiqlaganda guruhga yangi bildirishnoma xabari yuborish.
 * Bu orqali guruhdagi barcha farroshlar darhol ovozli bildirishnoma oladi va xona qabul qilinganini ko'radi.
 */
async function sendApprovedNotification(task: TaskRow): Promise<void> {
  if (!bot) return;
  const chat = groupId();
  if (!chat) return;

  const roomType = task.room.roomType?.label ? ` · ${task.room.roomType.label}` : "";
  const cleaner = who(task);
  const timeInfo =
    task.acceptedAt && task.finishedAt
      ? `⏱ Davomiyligi: <b>${minutesBetween(task.acceptedAt, task.finishedAt)} daqiqa</b> (${hhmm(task.acceptedAt)} → ${hhmm(task.finishedAt)})`
      : task.finishedAt
      ? `⏱ Tugatilgan vaqt: <b>${hhmm(task.finishedAt)}</b>`
      : "";

  const lines = [
    "✅ <b>TOZALIK TASDIQLANDI!</b>",
    "",
    `🏠 <b>${task.room.id}-xona</b>${roomType}`,
    `📍 ${task.room.floor}-qavat`,
    `👤 Farrosh: <b>${cleaner}</b>`,
    ...(timeInfo ? [timeInfo] : []),
    ...(task.photoUrl ? ["📸 <i>Xona rasmi tekshirildi va tasdiqlandi</i>"] : []),
    "",
    "🚪 <b>Xona toza holatda sotuvga ochildi. Rahmat!</b>",
  ];

  const text = lines.join("\n");

  try {
    if (task.messageId) {
      await bot.api.sendMessage(chat, text, {
        parse_mode: "HTML",
        reply_parameters: { message_id: task.messageId },
      });
    } else {
      await bot.api.sendMessage(chat, text, { parse_mode: "HTML" });
    }
  } catch (e) {
    try {
      await bot.api.sendMessage(chat, text, { parse_mode: "HTML" });
    } catch (e2) {
      console.error("[tozalik-bot] tasdiqlash xabari yuborilmadi:", e2);
    }
  }
}

/**
 * Admin tozalashni rad etganda (qayta tozalash) guruhga yangi bildirishnoma xabari yuborish.
 */
async function sendRejectedNotification(task: TaskRow): Promise<void> {
  if (!bot) return;
  const chat = groupId();
  if (!chat) return;

  const roomType = task.room.roomType?.label ? ` · ${task.room.roomType.label}` : "";
  const cleaner = who(task);

  const lines = [
    "⚠️ <b>TOZALIK QAYTARILDI (RAD ETILDI)</b>",
    "",
    `🏠 <b>${task.room.id}-xona</b>${roomType}`,
    `📍 ${task.room.floor}-qavat`,
    `👤 Farrosh: <b>${cleaner}</b>`,
    "",
    `Sabab: ${task.reason}`,
    "",
    "❗️ <i>Iltimos, ko'rsatilgan kamchiliklarni to'g'irlab, qaytadan tozalang!</i>",
  ];

  const text = lines.join("\n");

  try {
    if (task.messageId) {
      await bot.api.sendMessage(chat, text, {
        parse_mode: "HTML",
        reply_parameters: { message_id: task.messageId },
      });
    } else {
      await bot.api.sendMessage(chat, text, { parse_mode: "HTML" });
    }
  } catch (e) {
    try {
      await bot.api.sendMessage(chat, text, { parse_mode: "HTML" });
    } catch (e2) {
      console.error("[tozalik-bot] rad etish xabari yuborilmadi:", e2);
    }
  }
}

/**
 * Kechikkan topshiriqlar haqida guruhga eslatma.
 *
 * Davriy vazifadan chaqiriladi (`queues/scheduler.ts`).
 *
 * Eslatma ALOHIDA xabar sifatida ketadi (asl xabar
 * tahrirlanmaydi): guruh tepasida ko'rinsin va e'tibor
 * tortsin.
 *
 * Ilgari bu eslatma EGASIGA shaxsiy chatga ketardi va "boshqa
 * faroshga berish" tugmasi bor edi. Guruh mantig'ida bu keraksiz:
 * xabar hammaga ko'rinadi, kim bo'sh bo'lsa oladi.
 */
export async function remindStaleTasks(): Promise<{ sent: number }> {
  if (!bot) return { sent: 0 };

  const [stale, minutes] = await Promise.all([
    clean.findStaleTasks(),
    import("../services/settings.js").then((m) => m.getCleaningRemindMinutes()),
  ]);

  let sent = 0;

  for (const task of stale) {
    try {
      await bot.api.sendMessage(
        groupId(),
        staleAlert(task as unknown as TaskView, minutes),
        { parse_mode: "HTML" }
      );
      sent += 1;
    } catch (e) {
      console.error("[tozalik-bot] eslatma yuborilmadi:", String(e).slice(0, 200));
    }
  }

  return { sent };
}

// ============================================================
//  Bot
// ============================================================

function createBot(): Bot | null {
  const token = config.telegram.cleaningToken;

  if (!token || !groupId()) {
    if (config.isDev) {
      console.log(
        "  Tozalik bot: TELEGRAM_CLEANING_BOT_TOKEN yoki " +
        "TELEGRAM_CLEANING_GROUP_ID yo'q — o'chirilgan"
      );
    }
    return null;
  }

  const b = new Bot(token);

  /**
   * FAQAT BELGILANGAN GURUH.
   *
   * Boshqa chatdan kelgan har qanday xabar javobsiz qoladi.
   * Bot o'zi haqida hech narsa aytmaydi — begona odam uni
   * topib qolsa ham foydasi yo'q.
   */
  b.use(async (ctx, next) => {
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id ?? "");
    if (chatId !== groupId()) return;
    await next();
  });

  // --- Buyruqlar ---------------------------------------------

  /**
   * `/start` va `/tasks` — ochiq topshiriqlar.
   *
   * Farosh guruhga kirganda nima borligini ko'rsin. Tugmalar
   * ro'yxatda emas, har topshiriqning o'z xabarida.
   */
  const showTasks = async (ctx: Context) => {
    const rows = await prisma.cleaningTask.findMany({
      where: { status: { in: ["NEW", "IN_PROGRESS"] } },
      include: clean.taskInclude,
      orderBy: { createdAt: "asc" },
      take: 20,
    });

    await ctx.reply(tasksOverview(rows as unknown as TaskView[]), {
      parse_mode: "HTML",
    });
  };

  b.command("start", showTasks);
  b.command("tasks", showTasks);

  // --- Tugmalar ----------------------------------------------
  //
  //  Format: cl:<amal>:<taskId>

  b.callbackQuery(/^cl:/, async (ctx) => {
    const parts = (ctx.callbackQuery.data ?? "").split(":");
    const action = parts[1];
    const taskId = parts[2];

    /**
     * Kim bosgani — Telegram'dan.
     *
     * `Employee` yozuvi kerak emas: guruhda faqat farroshlar
     * bor va ism hisobot uchun yetarli (BOTLAR-REJA.md).
     */
    const from = ctx.callbackQuery.from;
    const telegramId = String(from.id);
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ")
      || from.username
      || `id${from.id}`;

    try {
      if (action === "accept") {
        const task = await clean.acceptTask(taskId, telegramId, name);
        await ctx.answerCallbackQuery({ text: "Qabul qilindi! Tozalash boshlandi." });
        await refreshTaskMessage(task as unknown as TaskRow);
        return;
      }

      if (action === "done") {
        const task = await prisma.cleaningTask.findUnique({
          where: { id: taskId },
          include: clean.taskInclude,
        });
        if (!task) throw new NotFoundError("Topshiriq");
        if (task.status !== "IN_PROGRESS") {
          throw new ValidationError("Bu topshiriq yopilgan");
        }
        const owner = task.claimedByTelegramId ?? task.employee?.telegramId ?? null;
        if (owner && owner !== telegramId) {
          const who = task.claimedByName ?? task.employee?.fullName ?? "boshqa xodim";
          throw new ValidationError(`Bu xonani ${who} olgan`);
        }

        await ctx.answerCallbackQuery({ text: "Tozalab bo'ldingizmi? Tasdiqlang." });
        if (ctx.callbackQuery.message) {
          await ctx.editMessageReplyMarkup({
            reply_markup: taskKeyboard(task as unknown as TaskView, "confirm_done"),
          });
        }
        return;
      }

      if (action === "ask_photo") {
        const task = await prisma.cleaningTask.findUnique({
          where: { id: taskId },
          include: clean.taskInclude,
        });
        if (!task) throw new NotFoundError("Topshiriq");
        if (task.status !== "IN_PROGRESS") {
          throw new ValidationError("Bu topshiriq yopilgan");
        }
        waitingPhotoTasks.set(telegramId, taskId);

        await ctx.answerCallbackQuery({
          text: "Iltimos, tozalangan xona rasmini galereyadan tanlab yuboring!",
          show_alert: false,
        });

        if (ctx.callbackQuery.message) {
          await ctx.editMessageText(taskMessage(task as unknown as TaskView, true), {
            parse_mode: "HTML",
            reply_markup: taskKeyboard(task as unknown as TaskView, "prompt_photo"),
          });
        }
        return;
      }

      if (action === "photo_info") {
        waitingPhotoTasks.set(telegramId, taskId);
        await ctx.answerCallbackQuery({
          text: "📎 Pastdagi skrepka (galereya) belgisini bosing va xona rasmini tanlab yuboring!",
          show_alert: true,
        });
        return;
      }

      if (action === "confirm_done") {
        waitingPhotoTasks.delete(telegramId);
        const task = await clean.completeTask(taskId, telegramId);
        await ctx.answerCallbackQuery({ text: "Tozalash yakunlandi! Admin tasdiqlashi kutilmoqda." });
        await refreshTaskMessage(task as unknown as TaskRow);
        return;
      }

      if (action === "cancel_done") {
        waitingPhotoTasks.delete(telegramId);
        const task = await prisma.cleaningTask.findUnique({
          where: { id: taskId },
          include: clean.taskInclude,
        });
        await ctx.answerCallbackQuery({ text: "Tozalash davom etmoqda" });
        if (task && ctx.callbackQuery.message) {
          await ctx.editMessageText(taskMessage(task as unknown as TaskView, false), {
            parse_mode: "HTML",
            reply_markup: taskKeyboard(task as unknown as TaskView, "normal"),
          });
        }
        return;
      }

      await ctx.answerCallbackQuery();
    } catch (e) {
      /**
       * Kutilgan xatolar (`AppError`) foydalanuvchiga
       * ko'rsatiladi: "Bu xonani Dilnoza oldi" kabi.
       * Kutilmaganlari log'ga, foydalanuvchiga umumiy xabar.
       */
      const text = e instanceof AppError
        ? e.message
        : "Xatolik. Qayta urinib ko'ring.";

      if (!(e instanceof AppError)) {
        console.error("[tozalik-bot] tugma xatosi:", String(e).slice(0, 200));
      }

      // `show_alert` — muhim xabar oynada chiqadi, yo'qolmaydi
      await ctx.answerCallbackQuery({ text, show_alert: true });

      /**
       * Topshiriq holati o'zgargan bo'lishi mumkin (boshqa
       * birov olgan) — xabarni yangilaymiz, shunda guruhda
       * to'g'ri holat ko'rinadi.
       */
      const fresh = await prisma.cleaningTask.findUnique({
        where: { id: taskId },
        include: clean.taskInclude,
      });
      if (fresh) await refreshTaskMessage(fresh as unknown as TaskRow);
    }
  });

  // --- Rasm qabul qilish (galereyadan yuborilganda) -----------
  b.on("message:photo", async (ctx) => {
    const fromId = String(ctx.from?.id ?? "");
    if (!fromId) return;

    let taskId = waitingPhotoTasks.get(fromId);
    if (!taskId) {
      const activeTask = await prisma.cleaningTask.findFirst({
        where: { claimedByTelegramId: fromId, status: "IN_PROGRESS" },
        orderBy: { createdAt: "desc" },
      });
      if (activeTask) taskId = activeTask.id;
    }

    if (!taskId) return;

    try {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const file = await b!.api.getFile(largest.file_id);
      if (!file.file_path) return;

      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const uploadsDir = fileURLToPath(new URL("../../public/uploads/cleaning", import.meta.url));
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      const fileName = `${taskId}_${Date.now()}.jpg`;
      const localFilePath = path.join(uploadsDir, fileName);

      const resp = await fetch(fileUrl);
      if (!resp.ok) throw new Error("Telegramdan rasmni yuklab bo'lmadi");
      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(localFilePath, buffer);

      const photoUrl = `/uploads/cleaning/${fileName}`;
      waitingPhotoTasks.delete(fromId);

      const task = await clean.completeTask(taskId, fromId, photoUrl);

      await ctx.reply("📸 Rasm muvaffaqiyatli qabul qilindi! Admin tasdiqlashi kutilmoqda.", {
        reply_to_message_id: ctx.message.message_id,
      }).catch(() => {});

      await refreshTaskMessage(task as unknown as TaskRow);
    } catch (err) {
      console.error("[tozalik-bot] rasm saqlashda xatolik:", err);
      await ctx.reply("⚠️ Rasmni yuklab olishda xatolik yuz berdi. Qaytadan yuboring.").catch(() => {});
    }
  });

  b.catch((err) => {
    console.error("[tozalik-bot] xato:", String(err.error).slice(0, 200));
  });

  return b;
}

// ============================================================
//  Ishga tushirish
// ============================================================

export async function startCleaningBot(): Promise<void> {
  bot = createBot();
  if (!bot) return;

  /**
   * Tozalash servisini botga ulaymiz.
   *
   * Servis Telegram'ni bilmaydi — u faqat "topshiriq o'zgardi"
   * deb aytadi. Shu sabab bot o'chirilgan bo'lsa ham tozalash
   * tizimi (admin panel, API) ishlayveradi.
   */
  clean.onTaskChanged(async (taskId, event) => {
    try {
      if (event === "created") {
        await sendTaskMessage(taskId);
        return;
      }

      const task = await prisma.cleaningTask.findUnique({
        where: { id: taskId },
        include: clean.taskInclude,
      });
      if (!task) return;

      const row = task as unknown as TaskRow;
      // 1. Asl xabarni yangilaymiz (tugmalar tozalanadi va matn yangilanadi)
      await refreshTaskMessage(row);

      // 2. Admin tasdiqlasa yoki rad etsa, guruhga darhol yangi ovozli xabar boradi
      if (event === "approved") {
        await sendApprovedNotification(row);
      } else if (event === "rejected") {
        await sendRejectedNotification(row);
      }
    } catch (err) {
      console.error("[tozalik-bot] onTaskChanged xatosi:", err);
    }
  });

  /**
   * `start()` cheksiz kutadi (long polling), shuning uchun
   * `await` qilinmaydi — aks holda server ishga tushmaydi.
   *
   * Xato ushlanadi: token yaroqsiz bo'lsa (401) rad etilgan
   * promise Node jarayonini o'ldirardi va butun backend
   * to'xtardi. Bot ixtiyoriy qism — u ishlamasa ham tozalash
   * tizimi admin panelda ishlayveradi.
   */
  bot.start({
    onStart: (info) => {
      console.log(`  Tozalik bot: @${info.username} → guruh ${groupId()}`);
    },
  }).catch((e) => {
    console.error(
      "[tozalik-bot] ishga tushmadi (backend ishlayveradi):",
      String(e).slice(0, 200)
    );
    bot = null;
  });
}

export async function stopCleaningBot(): Promise<void> {
  if (bot) {
    await bot.stop();
    bot = null;
  }
}

/** Bot ishlayaptimi — admin panel holatni ko'rsatishi uchun */
export function isCleaningBotRunning(): boolean {
  return bot !== null;
}
