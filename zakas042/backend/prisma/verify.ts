/**
 * FAZA 1 tayyorlik tekshiruvi
 *
 * 11-BOSQICHLAR-ROADMAP.md FAZA 1 mezoni:
 *   "barcha jadvallar bor; seed'da 12 xona (standard 6, double 4,
 *    deluxe 2); constraint mavjudligi tasdiqlangan"
 *
 * Ishga tushirish:  npx tsx prisma/verify.ts
 */

import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
let failed = 0;

const ok = (msg: string) => console.log(`  \x1b[32mOK\x1b[0m    ${msg}`);
const bad = (msg: string) => { console.log(`  \x1b[31mXATO\x1b[0m  ${msg}`); failed++; };

const day = (n: number): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
};

async function main() {
  console.log("\nFAZA 1 — tayyorlik tekshiruvi\n");

  // --- 1. TZ 13-band: 12 majburiy jadval --------------------
  console.log("[1] TZ 13-band — majburiy jadvallar");
  const required = [
    "Channel", "ChannelConnection", "ChannelMapping", "WebhookEvent",
    "SyncLog", "Reservation", "Room", "RoomType", "Guest", "Payment",
    "RatePlan", "Availability",
  ];
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
  `;
  const names = new Set(tables.map((t) => t.table_name));
  const missing = required.filter((t) => !names.has(t));
  missing.length === 0
    ? ok(`12/12 jadval mavjud (jami ${names.size - 1} ta)`)
    : bad(`yo'q: ${missing.join(", ")}`);

  // --- 2. Seed raqamlari ------------------------------------
  console.log("\n[2] Seed raqamlari (02-DATABASE-SXEMA.md §4)");
  const expected: Record<string, number> = { standard: 6, double: 4, deluxe: 2 };
  for (const [type, want] of Object.entries(expected)) {
    const got = await prisma.room.count({ where: { roomTypeId: type } });
    got === want ? ok(`${type}: ${got}`) : bad(`${type}: ${got}, kutilgan ${want}`);
  }
  const total = await prisma.room.count();
  total === 12 ? ok(`jami 12 xona`) : bad(`jami ${total} xona, kutilgan 12`);

  // --- 3. Room.id = xona raqami (mijoz qarori Q2) -----------
  console.log("\n[3] Room.id = xona raqami (Q2)");
  const room101 = await prisma.room.findUnique({ where: { id: "101" } });
  room101?.number === "101"
    ? ok(`Room.id "101" topildi, number mos`)
    : bad(`Room.id "101" topilmadi yoki number mos emas`);

  // --- 4. Overbooking constraint (TZ 3-band) ----------------
  console.log("\n[4] TZ 3-band — overbooking constraint");
  const con = await prisma.$queryRaw<Array<{ conname: string }>>`
    SELECT conname FROM pg_constraint WHERE conname = 'reservation_no_overlap'
  `;
  con.length === 1 ? ok("constraint mavjud") : bad("constraint TOPILMADI");

  // Haqiqiy sinov: band xonaga qoplanuvchi bron
  const guest = await prisma.guest.findFirst();
  if (!guest) { bad("test uchun mehmon topilmadi"); return; }

  try {
    await prisma.reservation.create({
      data: {
        roomId: "101", guestId: guest.id,
        checkIn: day(0), checkOut: day(2),   // 101 hozir band (-2..3)
        adults: 1, source: "DIRECT",
        pricePerNight: new Prisma.Decimal(35),
        status: "CONFIRMED",
      },
    });
    bad("qoplanuvchi bron YARATILDI — himoya ishlamadi!");
  } catch (e) {
    const msg = String(e);
    msg.includes("23P01") || msg.includes("reservation_no_overlap")
      ? ok("qoplanuvchi bron rad etildi (23P01)")
      : bad(`boshqa xato: ${msg.slice(0, 80)}`);
  }

  // Chegara qoidasi '[)': checkOut kuni boshqa bron kirishi mumkin
  // 108-xona: -3..-1 band. Yangi bron -1 dan boshlansa — o'tishi kerak.
  try {
    const r = await prisma.reservation.create({
      data: {
        roomId: "108", guestId: guest.id,
        checkIn: day(-1), checkOut: day(1),
        adults: 1, source: "DIRECT",
        pricePerNight: new Prisma.Decimal(30),
        status: "CONFIRMED",
      },
    });
    ok("chegara '[)' to'g'ri — checkOut kuni yangi bron kirdi");
    await prisma.reservation.delete({ where: { id: r.id } });
  } catch (e) {
    bad(`chegara qoidasi xato: ${String(e).slice(0, 80)}`);
  }

  // --- 5. Duplicate himoyasi (TZ 9-band) --------------------
  console.log("\n[5] TZ 9-band — duplicate constraint");
  const uniq = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'Reservation'
      AND indexdef LIKE '%channelId%externalReservationId%'
  `;
  uniq.length > 0 ? ok("unique(channelId, externalReservationId)") : bad("unique constraint yo'q");

  // --- 6. Availability agregatsiyasi (07 §2) ----------------
  console.log("\n[6] Availability agregatsiyasi");
  const av = await prisma.availability.findMany({
    where: { date: day(0) }, orderBy: { roomTypeId: "asc" },
  });
  if (av.length !== 3) bad(`bugun uchun ${av.length} yozuv, kutilgan 3`);
  for (const a of av) {
    const valid = a.availableCount === a.totalRooms - a.bookedRooms - a.blockedRooms
      && a.availableCount >= 0 && a.availableCount <= a.totalRooms;
    valid
      ? ok(`${a.roomTypeId}: ${a.availableCount}/${a.totalRooms} (band ${a.bookedRooms})`)
      : bad(`${a.roomTypeId}: hisob noto'g'ri`);
  }

  // --- 7. Enum qiymatlari (TZ 8-band) -----------------------
  console.log("\n[7] TZ 8-band — 6 status");
  const statuses = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT enumlabel FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'ReservationStatus'
  `;
  const want = ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"];
  const have = statuses.map((s) => s.enumlabel);
  const miss = want.filter((w) => !have.includes(w));
  miss.length === 0 ? ok(`6/6 status`) : bad(`yo'q: ${miss.join(", ")}`);

  // --- Natija -----------------------------------------------
  console.log("\n" + "=".repeat(50));
  if (failed === 0) {
    console.log("\x1b[32m FAZA 1 TAYYOR — barcha tekshiruvlar o'tdi\x1b[0m");
  } else {
    console.log(`\x1b[31m ${failed} ta xato — FAZA 1 tugallanmagan\x1b[0m`);
  }
  console.log("=".repeat(50) + "\n");
  process.exit(failed === 0 ? 0 : 1);
}

main()
  .catch((e) => { console.error("Tekshiruv xatosi:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
