import { Bot, InlineKeyboard } from "grammy";
import { config } from "../src/lib/config.js";
import {
  screenDashboard,
  screenFinance,
  screenRooms,
  screenBookings,
} from "../src/bot/screens.js";
import { prisma } from "../src/lib/prisma.js";

async function main() {
  console.log("=== FOUNDER BOT TESTI ===");
  console.log("Bot Token:", config.telegram.token ? "Mavjud (888821...)" : "YO'Q");
  console.log("Founder IDlar:", config.telegram.founderIds);

  const token = config.telegram.token;
  const targetChatId = config.telegram.founderIds[0] || "1048572407";

  try {
    console.log("\n[1] 4 ta bo'limni tayyorlash:");
    const dash = await screenDashboard();
    console.log("-> Dashboard OK (uzunlik:", dash.length, ")");
    const fin = await screenFinance("month");
    console.log("-> Moliya OK (uzunlik:", fin.length, ")");
    const rooms = await screenRooms();
    console.log("-> Xona ma'lumoti OK (uzunlik:", rooms.length, ")");
    const bookings = await screenBookings();
    console.log("-> Bron tushishi OK (uzunlik:", bookings.length, ")");

    // 2. Telegramga haqiqiy asosiy menyuni yuborish
    if (token) {
      console.log(`\n[2] Telegramga xabar yuborilmoqda: Chat ${targetChatId}...`);
      const bot = new Bot(token);

      const kb = new InlineKeyboard()
        .text("📊 Dashboard", "dash")
        .text("💰 Moliya", "fin:month")
        .row()
        .text("🏨 Xona ma'lumoti", "rooms")
        .text("📋 Bron tushishi", "bookings");

      const welcomeText =
        `👔 <b>Assalomu alaykum, Hurmatli Asoschi!</b>\n\n` +
        `<b>Imron Hotel — Boshqaruv (Founder) Boti muvaffaqiyatli ulandi!</b>\n\n` +
        `Siz uchun 4 ta asosiy bo'lim tayyor:\n` +
        `1. 📊 <b>Dashboard</b> — Umumiy ko'rsatkichlar va bandlik\n` +
        `2. 💰 <b>Moliya</b> — Daromad, tushum va xarajatlar\n` +
        `3. 🏨 <b>Xona ma'lumoti</b> — Xonalar holati va bandligi\n` +
        `4. 📋 <b>Bron tushishi</b> — Yangi va oxirgi bronlar tarixi\n\n` +
        `<i>Istalgan bo'limni ko'rish uchun quyidagi tugmalardan birini bosing:</i>`;

      const sent = await bot.api.sendMessage(targetChatId, welcomeText, {
        parse_mode: "HTML",
        reply_markup: kb,
      });

      console.log(`[3] XABAR MUVAFFAQIYATLI YUBORILDI! Message ID: ${sent.message_id}`);
    }
  } catch (err) {
    console.error("Xatolik:", err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
