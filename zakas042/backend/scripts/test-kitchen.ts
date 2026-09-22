import { kitchenReport, kitchenOverview } from "../src/services/kitchen.js";
import { formatKitchenReport, formatKitchenOverview } from "../src/bot/kitchen-bot.js";
import { Bot, InlineKeyboard } from "grammy";
import { config } from "../src/lib/config.js";
import { prisma } from "../src/lib/prisma.js";

async function main() {
  console.log("=== OSHXONA BOTI TESTI ===");
  console.log("Bot Token:", config.telegram.kitchenToken ? "Mavjud (891939...)" : "YO'Q");
  console.log("Chat IDlar:", config.telegram.kitchenChatIds);

  const token = config.telegram.kitchenToken;
  const targetChatId = config.telegram.kitchenChatIds[0] || "1048572407";

  // 1. DB tekshirish
  try {
    const today = await kitchenReport(0);
    console.log(`\n[1] Bugungi hisobot (DB): ${today.totalGuests} nafar mehmon, ${today.rooms.length} ta xona`);
    const tomorrow = await kitchenReport(1);
    console.log(`[2] Ertangi hisobot (DB): ${tomorrow.totalGuests} nafar mehmon, ${tomorrow.rooms.length} ta xona`);

    const overviewText = await formatKitchenOverview();
    console.log("\n[3] Tayyorlangan hisobot matni:");
    console.log(overviewText);

    // 2. Telegramga haqiqiy xabar yuborish
    if (token) {
      console.log(`\n[4] Telegramga xabar yuborilmoqda: Chat ${targetChatId}...`);
      const bot = new Bot(token);
      
      const kb = new InlineKeyboard()
        .text("🍳 Bugungi ovqatlar", "kitchen:today")
        .text("🥐 Ertangi ovqatlar", "kitchen:tomorrow")
        .row()
        .text("📊 Umumiy ko'rinish", "kitchen:overview")
        .text("🔄 Yangilash", "kitchen:refresh");

      const sent = await bot.api.sendMessage(targetChatId, overviewText, {
        parse_mode: "HTML",
        reply_markup: kb,
      });

      console.log(`[5] XABAR MUVAFFAQIYATLI YUBORILDI! Message ID: ${sent.message_id}`);
    }
  } catch (err) {
    console.error("Xatolik:", err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
