/**
 * Beds24 ulanishini sozlash — FAZA 15, 1-2 qadam
 *
 * Dasturchi shu skriptni real invite code bilan ishga tushiradi:
 *   npm run beds24:connect
 *
 * Invite code Beds24 panelida yaratiladi:
 *   Settings -> Account -> Access -> Generate invite code
 *   Scope: bookings (read+write), inventory (read+write), properties (read)
 *
 * refreshToken shifrlab DB'ga yoziladi (TZ 18-band).
 */

import readline from "node:readline/promises";
import { setupConnection } from "../src/services/beds24/auth.js";
import { beds24Adapter } from "../src/services/beds24/adapter.js";
import { config } from "../src/lib/config.js";
import { prisma } from "../src/lib/prisma.js";

async function main() {
  console.log(`
  Beds24 ulanishini sozlash
  =========================
  Server: ${config.beds24.baseUrl}
`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const inviteCode = (process.argv[2] ?? await rl.question("  Invite code: ")).trim();
  const propertyId = (process.argv[3] ?? await rl.question("  Property ID: ")).trim();
  rl.close();

  if (!inviteCode || !propertyId) {
    console.error("\n  Invite code va property ID majburiy.\n");
    process.exit(1);
  }

  console.log("\n  Ulanmoqda...");

  try {
    await setupConnection(inviteCode, propertyId);
    console.log("  Token olindi va shifrlab saqlandi.");
  } catch (e) {
    console.error(`\n  XATO: ${(e as Error).message}\n`);
    process.exit(1);
  }

  console.log("  Tekshirilmoqda...");
  const ping = await beds24Adapter.ping();

  if (!ping.ok) {
    console.error(`\n  Ulanish tekshiruvi muvaffaqiyatsiz: ${ping.detail}\n`);
    process.exit(1);
  }

  const props = await beds24Adapter.getRoomTypes();
  console.log("\n  Ulanish muvaffaqiyatli.\n");

  for (const p of props) {
    console.log(`  Property: ${p.name} (${p.id}), valyuta ${p.currency}`);
    for (const rt of p.roomTypes) {
      const units = rt.units.length > 0 ? `, ${rt.units.length} unit` : "";
      console.log(`    ${rt.id}  ${rt.name.padEnd(18)} qty=${rt.qty}${units}`);
    }
  }

  const hasUnits = props.some((p) => p.roomTypes.some((rt) => rt.units.length > 0));
  console.log(`
  Mapping darajasi: ${hasUnits ? "UNIT-LEVEL (xonalar alohida)" : "ROOM-TYPE (tur bo'yicha)"}
  Kredit qoldi: ${ping.creditsRemaining ?? "?"}

  Keyingi qadam: /admin/mapping sahifasida turlarni bog'lang.
`);
}

let hadError = false;

main()
  .catch((e) => { console.error("Xato:", e); hadError = true; })
  .finally(async () => {
    await prisma.$disconnect();
    process.exitCode = hadError ? 1 : 0;
  });
