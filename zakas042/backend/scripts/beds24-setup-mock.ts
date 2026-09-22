/**
 * Mock Beds24 ulanishi va mappingni bir buyruqda tiklaydi.
 *
 *   npm run beds24:mock
 *
 * NEGA KERAK: `prisma/seed.ts` `ChannelConnection` va
 * `ChannelMapping` ni o'chiradi (ular `Channel` ga bog'liq).
 * Seed'dan keyin Beds24 ulanishi uzilib qoladi va 9 tarifni
 * qayta bog'lash kerak bo'ladi — qo'lda 10 ta qadam.
 *
 * Bu skript o'shani avtomatlashtiradi:
 *   1. `mock-invite-code` bilan ulanadi (property 12345)
 *   2. To'qqiz tarifni Beds24 turlariga bog'laydi
 *   3. Natijani tekshiradi va ko'rsatadi
 *
 * FAQAT MOCK UCHUN. Real Beds24 da `npm run beds24:connect`
 * ishlatiladi va mapping `/admin/mapping` sahifasida qo'lda
 * qilinadi — real panelda room type ID'lari boshqacha.
 */

import { setupConnection } from "../src/services/beds24/auth.js";
import * as mapping from "../src/services/mapping.js";
import { config } from "../src/lib/config.js";
import { prisma } from "../src/lib/prisma.js";

/**
 * PMS tarifi -> mock Beds24 room type.
 *
 * `mock-beds24/fixtures/properties.ts` bilan bir xil bo'lishi
 * SHART. U yerda o'zgartirsangiz bu yerni ham yangilang.
 */
const PAIRS: Array<[string, string]> = [
  ["standard3", "101001"],
  ["comfort3",  "101002"],
  ["semilux",   "101003"],
  ["comfort4",  "101004"],
  ["premium4",  "101005"],
  ["deluxe4",   "101006"],
  ["famdeluxe", "101007"],
  ["famlux201", "101008"],
  ["famlux301", "101009"],
];

async function main() {
  // Real serverga ulanib qolmaslik uchun himoya: bu skript
  // mock ma'lumotini yozadi, real hisobda u noto'g'ri bo'ladi.
  if (!/localhost|127\.0\.0\.1/.test(config.beds24.baseUrl)) {
    console.error(
      `\n  BEDS24_BASE_URL mahalliy emas: ${config.beds24.baseUrl}\n` +
      `  Bu skript faqat mock uchun. Real ulanish:\n` +
      `    npm run beds24:connect\n`
    );
    process.exit(1);
  }

  console.log(`\n  Mock Beds24 sozlanmoqda — ${config.beds24.baseUrl}\n`);

  // --- 1. Ulanish ---
  await setupConnection("mock-invite-code", "12345");
  console.log("  Ulanish: ok");

  // --- 2. Mapping ---
  let created = 0;
  for (const [roomTypeId, externalRoomTypeId] of PAIRS) {
    const exists = await prisma.roomType.findUnique({ where: { id: roomTypeId } });
    if (!exists) {
      console.log(`  ${roomTypeId}: PMS'da bunday tarif yo'q — o'tkazildi`);
      continue;
    }
    await mapping.upsertMapping({ roomTypeId, externalRoomTypeId });
    created++;
  }
  console.log(`  Mapping: ${created} ta`);

  // --- 3. Tekshirish ---
  const health = await mapping.getMappingHealth();
  console.log("");

  for (const t of health.roomTypes) {
    const mark = t.warning ? "!" : " ";
    const ext = t.externalQty ?? "-";
    console.log(
      `  ${mark} ${t.id.padEnd(12)} PMS=${String(t.rooms).padStart(2)}  ` +
      `B24=${String(ext).padStart(2)}  ${t.warning ?? ""}`
    );
  }

  const total = health.roomTypes.reduce((n, t) => n + t.rooms, 0);
  console.log(
    `\n  isComplete: ${health.isComplete}   ` +
    `bog'lanmagan xona: ${health.unmappedRoomCount}   jami xona: ${total}\n`
  );

  if (!health.isComplete) {
    console.error(
      "  DIQQAT: mapping to'liq emas. Yuqoridagi ogohlantirishlarga qarang.\n" +
      "  Mock fixture'i PMS bilan mos kelmasa:\n" +
      "    zakas042/mock-beds24/fixtures/properties.ts\n"
    );
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error("\n  XATO:", e instanceof Error ? e.message : e, "\n");
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
