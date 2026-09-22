/**
 * Beds24 ulanishini tekshirish — FAZA 15, 6-qadam
 *
 *   npm run beds24:verify
 *
 * Dasturchi credentials qo'ygandan keyin shu skript hammasini
 * tekshiradi: token, kredit, property, mapping, webhook.
 */

import { beds24Adapter } from "../src/services/beds24/adapter.js";
import { getConnectionStatus } from "../src/services/beds24/auth.js";
import { getCreditState } from "../src/services/beds24/client.js";
import { config } from "../src/lib/config.js";
import { prisma } from "../src/lib/prisma.js";

let failed = 0;
const ok = (m: string) => console.log(`  \x1b[32mOK\x1b[0m    ${m}`);
const bad = (m: string) => { console.log(`  \x1b[31mXATO\x1b[0m  ${m}`); failed++; };
const warn = (m: string) => console.log(`  \x1b[33m!\x1b[0m     ${m}`);

async function main() {
  console.log(`\n  Beds24 ulanish tekshiruvi\n  Server: ${config.beds24.baseUrl}\n`);

  // 1. Ulanish sozlanganmi
  const status = await getConnectionStatus();
  status.isConnected
    ? ok(`ulanish bor, property ${status.propertyId}`)
    : bad("ulanish yo'q — npm run beds24:connect ishga tushiring");
  if (!status.isConnected) { finish(); return; }

  // 2. Token ishlaydimi
  const ping = await beds24Adapter.ping();
  ping.ok ? ok("token yaroqli, API javob beradi") : bad(`API javob bermadi: ${ping.detail}`);
  if (!ping.ok) { finish(); return; }

  // 3. Kredit
  const c = getCreditState();
  c.remaining > config.beds24.creditSafetyThreshold
    ? ok(`kredit yetarli: ${c.remaining}`)
    : warn(`kredit kam: ${c.remaining}, ${c.resetsIn}s ichida tiklanadi`);

  // 4. Property va room type'lar
  const props = await beds24Adapter.getRoomTypes();
  props.length > 0 ? ok(`${props.length} property topildi`) : bad("property topilmadi");

  const allTypes = props.flatMap((p) => p.roomTypes);
  allTypes.length > 0
    ? ok(`${allTypes.length} room type: ${allTypes.map((t) => t.name).join(", ")}`)
    : bad("room type topilmadi");

  // 5. Mapping darajasi (FAZA 0.5 dagi 1-fakt)
  const hasUnits = allTypes.some((t) => t.units.length > 0);
  ok(`mapping darajasi: ${hasUnits ? "unit-level" : "room-type"}`);

  // 6. PMS mapping to'liqmi (06-fayl §7)
  const pmsTypes = await prisma.roomType.findMany({ include: { mappings: true } });
  const unmapped = pmsTypes.filter((t) => t.mappings.length === 0);
  unmapped.length === 0
    ? ok(`mapping to'liq: ${pmsTypes.length} tur bog'langan`)
    : warn(`mapping yo'q: ${unmapped.map((t) => t.id).join(", ")} — /admin/mapping da bog'lang`);

  // 7. Xona sonlari mos keladimi (07-fayl §2 agregatsiya asosi)
  for (const pmsType of pmsTypes) {
    const mapping = pmsType.mappings[0];
    if (!mapping) continue;
    const external = allTypes.find((t) => t.id === mapping.externalRoomTypeId);
    if (!external) {
      bad(`${pmsType.id}: Beds24'da ${mapping.externalRoomTypeId} topilmadi`);
      continue;
    }
    const pmsCount = await prisma.room.count({ where: { roomTypeId: pmsType.id, isActive: true } });
    pmsCount === external.qty
      ? ok(`${pmsType.id}: ${pmsCount} xona, Beds24'da ham ${external.qty}`)
      : warn(`${pmsType.id}: PMS'da ${pmsCount}, Beds24'da ${external.qty} — availability noto'g'ri bo'ladi`);
  }

  finish();
}

function finish() {
  console.log("\n" + "=".repeat(52));
  console.log(failed === 0
    ? "\x1b[32m  TAYYOR — Beds24 ulanishi ishlaydi\x1b[0m"
    : `\x1b[31m  ${failed} ta xato\x1b[0m`);
  console.log("=".repeat(52) + "\n");
}

// Prisma ulanishi yopilgandan KEYIN chiqish kodi qo'yiladi.
// `process.exit()` disconnect'ni uzib qo'yadi va Windows'da
// libuv assertion xatosi beradi.
main()
  .catch((e) => { console.error("Tekshiruv xatosi:", e); failed++; })
  .finally(async () => {
    await prisma.$disconnect();
    process.exitCode = failed === 0 ? 0 : 1;
  });
