/**
 * 3-bot: OSHXONA (Imron Kitchen Bot) — BOTLAR-REJA.md
 *
 * MAQSAD:
 * Oshpazlar va oshxona xodimlari ertalabki nonushta va kunlik ovqatlanish
 * porsiyalarini (kattalar, bolalar, xonalar ro'yxati, hozir xonadagilar va
 * yangi keladiganlar) aniq bilishi uchun xizmat qiladi.
 *
 * XUSUSIYATLAR:
 * 1. Buyruqlar: /start, /menu, /bugun, /ertaga, /hisobot, /id
 * 2. Interaktiv Inline tugmalar orqali qulay boshqaruv
 * 3. Davriy avtomatik hisobot yuborish (ertalab va kechqurun)
 */

import { Bot, InlineKeyboard, GrammyError, type Context } from "grammy";
import { config } from "../lib/config.js";
import { kitchenReport, kitchenOverview, type KitchenReport } from "../services/kitchen.js";
import { esc } from "./format.js";
import {
  resolveAndBindBotUser,
  getActiveBotRecipients,
} from "../services/botAccess.js";

let bot: Bot | null = null;

// ============================================================
//  Kirish tekshiruvi (Ruxsatlar)
// ============================================================

function isAuthorizedChat(chatId: number | string | undefined): boolean {
  if (!chatId) return false;
  const allowed = config.telegram.kitchenChatIds;
  // Agar maxsus chat ID belgilanmagan bo'lsa, xavfsizlik uchun faqat founderIds tekshiriladi
  if (allowed.length === 0) {
    return config.telegram.founderIds.includes(String(chatId));
  }
  return allowed.includes(String(chatId)) || config.telegram.founderIds.includes(String(chatId));
}

// ============================================================
//  Tugmalar (Klaviaturasi)
// ============================================================

function kitchenMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🍳 Bugungi ovqatlar", "kitchen:today")
    .text("🥐 Ertangi ovqatlar", "kitchen:tomorrow")
    .row()
    .text("📊 Umumiy ko'rinish", "kitchen:overview")
    .text("🔄 Yangilash", "kitchen:refresh");
}

// ============================================================
//  Hisobotlarni formatlash (HTML)
// ============================================================

export function formatKitchenReport(report: KitchenReport, isTomorrow = false): string {
  const title = isTomorrow ? "🥐 ERTANGI OSHXONA HISOBOTI" : "🍳 BUGUNGI OSHXONA HISOBOTI";
  const dateStr = report.date;

  let text = `<b>${title}</b>\n`;
  text += `📅 Sana: <b>${dateStr}</b>\n`;
  text += `👥 Jami mehmonlar: <b>${report.totalGuests} nafar</b>\n`;
  text += `   ├ 🧑 Kattalar: <b>${report.totalAdults}</b>\n`;
  text += `   └ 🧒 Bolalar: <b>${report.totalChildren}</b>\n\n`;

  text += `📊 <b>Xonalar holati:</b>\n`;
  text += `   • 🏠 Hozir xonada: <b>${report.staying} ta xona</b>\n`;
  text += `   • 🚪 ${isTomorrow ? "Ertaga" : "Bugun"} keladi: <b>${report.arriving} ta xona</b>\n\n`;

  if (report.rooms.length === 0) {
    text += `<i>Ovqat bilan bron qilingan xonalar mavjud emas.</i>`;
    return text;
  }

  text += `📋 <b>Xonalar ro'yxati va porsiyalar:</b>\n`;
  for (const r of report.rooms) {
    const statusIcon = r.arriving ? "🚪" : "🏠";
    const statusText = r.arriving ? (isTomorrow ? "Ertaga keladi" : "Bugun keladi") : "Xonada";
    const guests = `${r.adults} katta${r.children > 0 ? `, ${r.children} bola` : ""}`;
    const mealCount = r.adults + r.children;

    text += `${statusIcon} <b>Xona ${esc(r.roomId)}</b> (${esc(r.roomLabel)})\n`;
    text += `   ├ Porsiya: <b>${mealCount} ta</b> (${guests})\n`;
    text += `   ├ Mehmon: ${esc(r.guestName)}\n`;
    text += `   └ Holat: ${statusText} [${esc(r.source)}]\n\n`;
  }

  return text.trim();
}

export async function formatKitchenOverview(): Promise<string> {
  const { today, tomorrow } = await kitchenOverview();

  let text = `<b>🍽 IMRON HOTEL — OSHXONA UMUMIY HISOBOTI</b>\n\n`;

  text += `🍳 <b>BUGUN (${today.date}):</b>\n`;
  text += `• Jami ovqatlanuvchilar: <b>${today.totalGuests} kishi</b>\n`;
  text += `• Kattalar: <b>${today.totalAdults}</b> | Bolalar: <b>${today.totalChildren}</b>\n`;
  text += `• Xonalar: <b>${today.rooms.length} ta</b> (🏠 ${today.staying} xonada, 🚪 ${today.arriving} keladi)\n\n`;

  text += `🥐 <b>ERTAGA (${tomorrow.date}):</b>\n`;
  text += `• Kutilayotganlar: <b>${tomorrow.totalGuests} kishi</b>\n`;
  text += `• Kattalar: <b>${tomorrow.totalAdults}</b> | Bolalar: <b>${tomorrow.totalChildren}</b>\n`;
  text += `• Xonalar: <b>${tomorrow.rooms.length} ta</b> (🏠 ${tomorrow.staying} xonada, 🚪 ${tomorrow.arriving} keladi)\n\n`;

  text += `<i>Batafsil ma'lumot olish uchun quyidagi tugmalardan birini bosing:</i>`;

  return text;
}

// ============================================================
//  Avtomatik Xabar Yuborish (Broadcaster)
// ============================================================

/**
 * Oshxona chatlariga kunlik hisobotni avtomatik yuborish.
 * @param offset 0 = Bugun, 1 = Ertaga
 */
export async function sendDailyKitchenReport(offset: 0 | 1 = 0): Promise<{ sent: number }> {
  if (!bot) return { sent: 0 };

  const dbRecipients = await getActiveBotRecipients("KITCHEN").catch(() => []);
  const allRecipients = Array.from(new Set([...config.telegram.kitchenChatIds, ...dbRecipients]));
  if (allRecipients.length === 0) return { sent: 0 };

  const report = await kitchenReport(offset);
  const message = formatKitchenReport(report, offset === 1);
  const kb = kitchenMenu();

  let sent = 0;
  for (const chatId of allRecipients) {
    try {
      await bot.api.sendMessage(chatId, message, {
        parse_mode: "HTML",
        reply_markup: kb,
      });
      sent++;
    } catch (e) {
      console.error(`[kitchen-bot] Chat ${chatId} ga xabar yuborilmadi:`, String(e).slice(0, 150));
    }
  }

  return { sent };
}

// ============================================================
//  Botni Ishga Tushirish
// ============================================================

export function startKitchenBot(): void {
  const token = config.telegram.kitchenToken;
  if (!token) {
    if (config.isDev) {
      console.log("  [kitchen-bot] TELEGRAM_KITCHEN_BOT_TOKEN berilmagan — bot o'chirilgan");
    }
    return;
  }

  bot = new Bot(token);

  // Ruxsat tekshirish middleware
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const username = ctx.from?.username;

    // /id buyrug'i har kimga o'z ID'sini bilish uchun ochiq
    if (ctx.message?.text?.trim() === "/id") {
      await ctx.reply(
        `Sizning Telegram Chat ID: <code>${chatId}</code>\nFoydalanuvchi: @${username ?? "noma'lum"}`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // 1. .env ro'yxat
    const inEnv = isAuthorizedChat(chatId);

    // 2. Bazadagi ruxsat va auto-binding
    const resolved = await resolveAndBindBotUser("KITCHEN", userId, username).catch(() => ({ allowed: false }));

    if (!inEnv && !resolved.allowed) {
      const u = username ? ` (@${username})` : "";
      await ctx.reply(
        `⚠️ <b>Kirish taqiqlangan</b>\n\n` +
        `Ushbu bot faqat Imron Hotel oshxona xodimlari uchun.\n` +
        `Sizning Chat ID: <code>${chatId}</code>${u}\n\n` +
        `Botdan foydalanish uchun ma'muriyat (Founder) ga murojaat qiling. Admin panelda sizga ruxsat biriktirilgach, bot avtomatik ishga tushadi.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    await next();
  });

  // --- Buyruqlar ---

  bot.command(["start", "menu"], async (ctx) => {
    const text =
      `👨‍🍳 <b>Assalomu alaykum, Imron Hotel Oshxona Botiga xush kelibsiz!</b>\n\n` +
      `Ushbu bot orqali har kuni ertalabki nonushta va porsiyalar sonini kuzatib borishingiz mumkin.\n\n` +
      `Kerakli bo'limni tanlang:`;

    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: kitchenMenu(),
    });
  });

  bot.command(["bugun", "today"], async (ctx) => {
    const report = await kitchenReport(0);
    await ctx.reply(formatKitchenReport(report, false), {
      parse_mode: "HTML",
      reply_markup: kitchenMenu(),
    });
  });

  bot.command(["ertaga", "tomorrow"], async (ctx) => {
    const report = await kitchenReport(1);
    await ctx.reply(formatKitchenReport(report, true), {
      parse_mode: "HTML",
      reply_markup: kitchenMenu(),
    });
  });

  bot.command(["hisobot", "report"], async (ctx) => {
    const text = await formatKitchenOverview();
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: kitchenMenu(),
    });
  });

  // --- Inline Tugmalar ---

  bot.callbackQuery("kitchen:today", async (ctx) => {
    await ctx.answerCallbackQuery();
    const report = await kitchenReport(0);
    try {
      await ctx.editMessageText(formatKitchenReport(report, false), {
        parse_mode: "HTML",
        reply_markup: kitchenMenu(),
      });
    } catch (e) {
      if (!(e instanceof GrammyError && e.description.includes("not modified"))) {
        console.error("[kitchen-bot] xabar tahrirlashda xato:", e);
      }
    }
  });

  bot.callbackQuery("kitchen:tomorrow", async (ctx) => {
    await ctx.answerCallbackQuery();
    const report = await kitchenReport(1);
    try {
      await ctx.editMessageText(formatKitchenReport(report, true), {
        parse_mode: "HTML",
        reply_markup: kitchenMenu(),
      });
    } catch (e) {
      if (!(e instanceof GrammyError && e.description.includes("not modified"))) {
        console.error("[kitchen-bot] xabar tahrirlashda xato:", e);
      }
    }
  });

  bot.callbackQuery("kitchen:overview", async (ctx) => {
    await ctx.answerCallbackQuery();
    const text = await formatKitchenOverview();
    try {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: kitchenMenu(),
      });
    } catch (e) {
      if (!(e instanceof GrammyError && e.description.includes("not modified"))) {
        console.error("[kitchen-bot] xabar tahrirlashda xato:", e);
      }
    }
  });

  bot.callbackQuery("kitchen:refresh", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Yangilandi ✅" });
    const text = await formatKitchenOverview();
    try {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: kitchenMenu(),
      });
    } catch (e) {
      if (!(e instanceof GrammyError && e.description.includes("not modified"))) {
        console.error("[kitchen-bot] xabar tahrirlashda xato:", e);
      }
    }
  });

  // Bot xatolarini ushlash
  bot.catch((err) => {
    console.error("[kitchen-bot] Telegram xatosi:", err.error);
  });

  // Ishga tushirish (background)
  bot.start({
    onStart: (info) => {
      console.log(`  [kitchen-bot] @${info.username} muvaffaqiyatli ishga tushdi`);
    },
  }).catch((e) => {
    console.error("[kitchen-bot] Ishga tushirishda xato:", String(e).slice(0, 200));
  });
}

export async function stopKitchenBot(): Promise<void> {
  if (bot) {
    try {
      await bot.stop();
      bot = null;
    } catch {
      // To'xtatishda xatolik bo'lsa jim o'tkazamiz
    }
  }
}
