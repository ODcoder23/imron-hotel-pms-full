/**
 * Telegram bot — TELEGRAM-BOT.md va TOZALIK-BOT.md
 *
 * IKKI XIL FOYDALANUVCHI, bir bot:
 *
 *   Egasi    — Moliya, Xonalar, Bronlar, Dashboard
 *   Menejer  — Xonalar, Bronlar, Dashboard (moliya YO'Q)
 *
 * TOZALASH BU BOTDA YO'Q (2026-09-17, BOTLAR-REJA.md).
 * U alohida botga ko'chdi: `bot/cleaning-bot.ts`, farroshlar
 * guruhiga yuboradi. Sabab: farosh mehmonxona moliyasini
 * ko'rmasligi kerak va bitta token ikkala auditoriyaga ochiq
 * bo'lmasligi kerak.
 *
 * XAVFSIZLIK
 * ----------
 * Egasi/menejer — `BotAccess` jadvalidagi chat ID'lar.
 * Boshqa har kimga qisqa rad javobi, hech qanday ma'lumot yo'q.
 *
 * Parol ishlatilmadi ataylab: parol chat tarixida qolib ketadi
 * va Telegram serverlarida saqlanadi. Chat ID esa o'zgarmaydi
 * va uni soxtalashtirib bo'lmaydi.
 *
 * ISHGA TUSHISH
 * -------------
 * `TELEGRAM_BOT_TOKEN` bo'sh bo'lsa bot umuman ishga tushmaydi,
 * backend esa normal ishlayveradi. Token yo'qligi xato emas —
 * shunchaki bot o'chirilgan degani (TZ 19-band ruhida: bir
 * qism ishlamasa butun tizim to'xtamaydi).
 */

import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import {
  screenDashboard,
  screenFinance,
  screenRooms,
  screenBookings,
  notifyNewBooking,
} from "./screens.js";
import { esc } from "./format.js";
import {
  resolveAndBindBotUser,
  getActiveBotRecipients,
} from "../services/botAccess.js";


let bot: Bot | null = null;

/** Middleware aniqlagan rol shu yerda saqlanadi */
type CtxWithRole = Context & { who: { role: Role; name: string } };

// ============================================================
//  Klaviatura
// ============================================================

/**
 * Asosiy menyu.
 *
 * Menejerda "Moliya" tugmasi YO'Q — oylik foyda va maoshlar
 * unga kerak emas (TOZALIK-BOT.md §7).
 */
function mainMenu(role: Role): InlineKeyboard {
  const kb = new InlineKeyboard().text("📊 Dashboard", "dash");

  if (canSeeMoney(role)) kb.text("💰 Moliya", "fin:month");

  return kb.row().text("🏨 Xona ma'lumoti", "rooms").text("📋 Bron tushishi", "bookings");
}

function financeMenu(active: string): InlineKeyboard {
  const mark = (p: string, label: string) => (p === active ? `· ${label} ·` : label);
  return new InlineKeyboard()
    .text(mark("today", "Bugun"), "fin:today")
    .text(mark("week", "Hafta"), "fin:week")
    .text(mark("month", "Oy"), "fin:month")
    .row()
    .text("⬅️ Orqaga", "menu");
}

function backMenu(): InlineKeyboard {
  return new InlineKeyboard().text("🔄 Yangilash", "same").text("⬅️ Orqaga", "menu");
}

// ============================================================
//  Kirish tekshiruvi
// ============================================================

/**
 * Foydalanuvchi turi (TOZALIK-BOT.md §6).
 *
 * `owner`   — hammasi, moliya ham
 * `manager` — moliyadan boshqa hammasi
 * `none`    — begona
 *
 * `cleaner` roli OLIB TASHLANDI (2026-09-17): tozalash alohida
 * botga ko'chdi (`bot/cleaning-bot.ts`).
 */
type Role = "owner" | "manager" | "none";

/**
 * Kim ekanini aniqlaydi.
 *
 * TARTIB MUHIM: avval egasi/menejer tekshiriladi. Agar bir odam
 * ham egasi, ham xodim bo'lsa (kichik mehmonxonada bo'ladi),
 * u to'liq huquqni oladi.
 *
 * `.env` dagi `TELEGRAM_FOUNDER_IDS` — zaxira yo'l: baza
 * ishlamasa ham egasi kira olsin.
 */
async function roleOf(ctx: Context): Promise<{ role: Role; name: string }> {
  const id = ctx.from?.id;
  if (!id) return { role: "none", name: "" };

  const tgId = String(id);
  const name = ctx.from?.first_name ?? "";

  // 1. .env dagi ro'yxat — har doim to'liq huquq
  if (config.telegram.founderIds.includes(tgId)) {
    return { role: "owner", name };
  }

  // 2. Bazadagi ruxsatlar (Telegram ID yoki @username orqali auto-bind)
  try {
    const resolved = await resolveAndBindBotUser("FOUNDER", id, ctx.from?.username);
    if (resolved.allowed && resolved.record) {
      return {
        role: resolved.role,
        name: resolved.record.label || name,
      };
    }
  } catch (e) {
    console.error("[bot] ruxsat tekshiruvi:", String(e).slice(0, 120));
  }

  return { role: "none", name };
}

/** Moliyani ko'ra oladimi */
function canSeeMoney(role: Role): boolean {
  return role === "owner";
}

// ============================================================
//  Bot qurish
// ============================================================

export function createBot(): Bot | null {
  const { token, founderIds } = config.telegram;

  if (!token) {
    console.log("  Telegram bot: o'chirilgan (TELEGRAM_BOT_TOKEN yo'q)");
    return null;
  }

  if (founderIds.length === 0) {
    // Token bor, lekin kim kirishi mumkinligi aytilmagan — bu
    // xavfli holat, shuning uchun bot ishga tushmaydi.
    console.warn(
      "  Telegram bot: TELEGRAM_FOUNDER_IDS bo'sh — bot ishga tushmadi.\n" +
      "  Kirish ruxsati berilmagan botni ochiq qoldirib bo'lmaydi."
    );
    return null;
  }

  const b = new Bot(token);

  // --- Har so'rovda kim ekanini aniqlaymiz ---
  b.use(async (ctx, next) => {
    const who = await roleOf(ctx);

    if (who.role === "none") {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery("Kirish yo'q");
      else {
        const u = ctx.from?.username ? ` (@${ctx.from.username})` : "";
        await ctx.reply(
          `⚠️ <b>Kirish huquqi berilmagan</b>\n\n` +
          `Sizning Telegram ID: <code>${ctx.from?.id}</code>${u}\n\n` +
          `Ushbu bot faqat Imron Hotel rahbariyati (Founder) uchun. Admin panelda ruxsat berilgach, bot avtomatik ishga tushadi.`,
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    // Keyingi ishlovchilar kim ekanini bilsin
    (ctx as CtxWithRole).who = who;
    await next();
  });

  // --- /start ---
  b.command(["start", "menu"], async (ctx) => {
    const who = (ctx as CtxWithRole).who;

    await ctx.reply(
      `👔 <b>Assalomu alaykum, ${esc(who.name || "Hurmatli Asoschi")}!</b>\n\n` +
      `<b>Imron Hotel — Boshqaruv (Founder) Boti</b>\n\n` +
      `Kerakli bo'limni tanlang:\n` +
      `• 📊 <b>Dashboard</b> — Umumiy ko'rsatkichlar\n` +
      `• 💰 <b>Moliya</b> — Daromad va hisobotlar\n` +
      `• 🏨 <b>Xona ma'lumoti</b> — Xonalar bandligi va holati\n` +
      `• 📋 <b>Bron tushishi</b> — Yangi va so'nggi bronlar`,
      { parse_mode: "HTML", reply_markup: mainMenu(who.role) }
    );
  });

  // --- To'g'ridan-to'g'ri buyruqlar ---
  b.command("dashboard", async (ctx) => {

    await ctx.reply(await screenDashboard(), {
      parse_mode: "HTML",
      reply_markup: backMenu(),
    });
  });

  b.command("moliya", async (ctx) => {
    // Menejer va farosh moliyani ko'rmaydi (TOZALIK-BOT.md §6)
    if (!canSeeMoney((ctx as CtxWithRole).who.role)) {
      await ctx.reply("Bu bo'lim faqat egasi uchun.");
      return;
    }

    await ctx.reply(await screenFinance("month"), {
      parse_mode: "HTML",
      reply_markup: financeMenu("month"),
    });
  });

  b.command("xonalar", async (ctx) => {

    await ctx.reply(await screenRooms(), {
      parse_mode: "HTML",
      reply_markup: backMenu(),
    });
  });

  b.command("bronlar", async (ctx) => {

    await ctx.reply(await screenBookings(), {
      parse_mode: "HTML",
      reply_markup: backMenu(),
    });
  });

  b.command("id", async (ctx) => {
    await ctx.reply(`Sizning chat ID: <code>${ctx.from?.id}</code>`, {
      parse_mode: "HTML",
    });
  });

  // --- Tugmalar ---
  b.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Moliya faqat egasida
    if (data.startsWith("fin:") && !canSeeMoney((ctx as CtxWithRole).who.role)) {
      await ctx.answerCallbackQuery("Bu bo'lim faqat egasi uchun");
      return;
    }

    try {
      let text: string;
      let keyboard: InlineKeyboard;

      if (data === "menu") {
        text =
          `👔 <b>Imron Hotel — Boshqaruv (Founder) Boti</b>\n\n` +
          `Kerakli bo'limni tanlang:\n` +
          `• 📊 <b>Dashboard</b> — Umumiy ko'rsatkichlar\n` +
          `• 💰 <b>Moliya</b> — Daromad va hisobotlar\n` +
          `• 🏨 <b>Xona ma'lumoti</b> — Xonalar bandligi va holati\n` +
          `• 📋 <b>Bron tushishi</b> — Yangi va so'nggi bronlar`;
        keyboard = mainMenu((ctx as CtxWithRole).who.role);
      } else if (data === "dash") {
        text = await screenDashboard();
        keyboard = backMenu();
      } else if (data.startsWith("fin:")) {
        const p = data.slice(4) as "today" | "week" | "month";
        text = await screenFinance(p);
        keyboard = financeMenu(p);
      } else if (data === "rooms") {
        text = await screenRooms();
        keyboard = backMenu();
      } else if (data === "bookings") {
        text = await screenBookings();
        keyboard = backMenu();
      } else {
        await ctx.answerCallbackQuery();
        return;
      }

      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      await ctx.answerCallbackQuery();
    } catch (e) {
      // Telegram bir xil matnni qayta yuborishni rad etadi —
      // "Yangilash" bosilganda ma'lumot o'zgarmagan bo'lsa shu
      // xato chiqadi. Foydalanuvchiga ko'rsatish shart emas.
      const msg = String(e);
      if (msg.includes("message is not modified")) {
        await ctx.answerCallbackQuery("O'zgarish yo'q");
      } else {
        console.error("[bot] callback xatosi:", msg.slice(0, 200));
        await ctx.answerCallbackQuery("Xatolik yuz berdi");
      }
    }
  });

  // --- Kutilmagan xatolar ---
  b.catch((err) => {
    console.error("[bot] xato:", String(err.error).slice(0, 300));
  });

  return b;
}

// ============================================================
//  Ishga tushirish va to'xtatish
// ============================================================

export async function startBot(): Promise<void> {
  bot = createBot();
  if (!bot) return;

  /**
   * Tozalash bu botda YO'Q (2026-09-17).
   *
   * `clean.onTaskChanged` endi `bot/cleaning-bot.ts` da
   * ulanadi. Ikkalasi ulansa bittasi ikkinchisini almashtirib
   * qo'yardi — listener bitta.
   */

  /**
   * `start()` cheksiz kutadi (long polling), shuning uchun
   * `await` qilinmaydi — aks holda server ishga tushmaydi.
   *
   * XATO USHLANADI (2026-09-17): ilgari `void bot.start(...)`
   * edi va token yaroqsiz bo'lsa (401 Unauthorized) rad etilgan
   * promise'ni hech kim ushlamasdi — Node BUTUN SERVERNI
   * o'ldirardi. Mehmonxona sayti bitta bot tokeni eskirgani
   * uchun ishlamay qolardi.
   *
   * Endi bot jim o'chadi, backend ishlayveradi (TZ 19-band).
   */
  bot.start({
    onStart: (info) => {
      console.log(`  Telegram bot: @${info.username} ishlayapti`);
    },
  }).catch((e) => {
    console.error(
      "[bot] ishga tushmadi (backend ishlayveradi):",
      String(e).slice(0, 200)
    );
    bot = null;
  });
}

export async function stopBot(): Promise<void> {
  if (bot) {
    await bot.stop();
    bot = null;
  }
}

// ============================================================
//  Bildirishnoma (bron tushishi)
// ============================================================

/**
 * Yangi bron haqida founder'ga xabar yuboradi.
 *
 * Xato bo'lsa jim yutiladi: Telegram ishlamasligi bron
 * yaratilishini to'xtatmasligi kerak (TZ 17, 19-band).
 */
export async function sendBookingAlert(b: {
  guestName: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  total: number;
  source: string;
  status: string;
  phone?: string;
}): Promise<void> {
  if (!bot || !config.telegram.notifyBookings) return;

  const text = notifyNewBooking(b);
  const dbRecipients = await getActiveBotRecipients("FOUNDER").catch(() => []);
  const allRecipients = Array.from(new Set([...config.telegram.founderIds, ...dbRecipients]));

  for (const id of allRecipients) {
    try {
      await bot.api.sendMessage(id, text, { parse_mode: "HTML" });
    } catch (e) {
      console.error(`[bot] xabar yuborilmadi (${id}):`, String(e).slice(0, 150));
    }
  }
}
