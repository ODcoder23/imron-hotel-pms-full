/**
 * Seed — boshlang'ich ma'lumotlar
 *
 * Manba: 02-DATABASE-SXEMA.md §4
 * Xona ro'yxati mijozdan olingan (2026-09-16):
 * 18 xona (3 qavat x 6), 9 tarif. Narxlar so'mda.
 *
 * Ishga tushirish:  npm run db:seed
 */

import { PrismaClient, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// Bugundan N kun keyingi sana (soat 00:00)
const day = (n: number): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
};

const dec = (n: number) => new Prisma.Decimal(n);

async function main() {
  console.log("Seed boshlandi...\n");

  // --- Tozalash (bog'liqlik tartibida) ----------------------
  //
  // TARTIB MUHIM: har jadval o'ziga ishora qiluvchilardan KEYIN
  // o'chiriladi, aks holda foreign key xatosi chiqadi.
  //
  // `CleaningTask`, `Expense`, `BotAccess` 2026-09-17 da qo'shildi
  // (tozalik va moliya bo'limlari). Ular ro'yxatga kiritilmagani
  // uchun seed butunlay ishlamay qolgan edi:
  //   P2003 — CleaningTask_roomId_fkey
  // Natijada baza yarim tozalangan holatda qolardi: xonalar va
  // tariflar bor, narxlar esa yo'q — sayt bo'sh ro'yxat qaytarardi.
  await prisma.payment.deleteMany();
  await prisma.charge.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.guest.deleteMany();
  await prisma.availability.deleteMany();
  await prisma.roomDayStatus.deleteMany();
  await prisma.ratePlan.deleteMany();
  await prisma.cleaningTask.deleteMany();   // Room, User, Employee ga ishora qiladi
  await prisma.expense.deleteMany();        // User ga ishora qiladi
  await prisma.botAccess.deleteMany();
  await prisma.room.deleteMany();
  await prisma.floor.deleteMany();   // Room dan KEYIN: Room.floorId unga ishora qiladi
  await prisma.roomType.deleteMany();
  await prisma.syncLog.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.syncState.deleteMany();

  /**
   * Channel zanjiri — Channel'dan OLDIN unga ishora qiluvchilar.
   *
   * `channelMapping` ilgari ro'yxat boshida, `ratePlan` yonida
   * turardi. Backend fonda ishlаyotgan bo'lsa (worker'lar,
   * `catch_up` vazifasi) u oradagi vaqtda mappingni QAYTA
   * yaratib ulgurardi va `channel.deleteMany()` foreign key
   * xatosiga urilardi. Keyin `channel.create()` P2002 berardi:
   * eski Channel joyida qolgan.
   *
   * Uchalasi endi ketma-ket, Channel'ning o'zidan darhol oldin
   * o'chiriladi — oraliq qolmaydi.
   */
  await prisma.channelMapping.deleteMany();
  await prisma.channelConnection.deleteMany();
  await prisma.channel.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
  await prisma.settings.deleteMany();

  // --- RoomType (9 tarif — mijoz ro'yxati, 2026-09-16) -----
  //
  // `multiplier` — Shaxmatkadagi ROOM_TYPES.multiplier bilan bir xil
  // ma'noda: standart narxga nisbatan koeffitsient. Haqiqiy narx
  // `RatePlan` dan olinadi, bu faqat ko'rsatkich.
  //
  // `maxAdults` — sayt qidiruvida filtr (13-fayl §2). Mijoz
  // ro'yxatidagi "Максимальное количество взрослых" qiymati.
  const roomTypes = [
    { id: "standard3",  label: "Standart 3 kishilik",         multiplier: 1.0,  maxAdults: 3, sortOrder: 1, price: 400_000 },
    { id: "comfort3",   label: "Komfort 3 kishilik",          multiplier: 1.12, maxAdults: 3, sortOrder: 2, price: 450_000 },
    { id: "semilux",    label: "Oilaviy yarim lyuks",         multiplier: 1.25, maxAdults: 3, sortOrder: 3, price: 500_000 },
    { id: "comfort4",   label: "Komfort 4 kishilik",          multiplier: 1.38, maxAdults: 4, sortOrder: 4, price: 550_000 },
    { id: "premium4",   label: "Premium 4 kishilik",          multiplier: 1.5,  maxAdults: 4, sortOrder: 5, price: 600_000 },
    { id: "deluxe4",    label: "Delyuks 4 kishilik",          multiplier: 1.63, maxAdults: 4, sortOrder: 6, price: 650_000 },
    { id: "famdeluxe",  label: "Oilaviy Delyuks",             multiplier: 1.75, maxAdults: 3, sortOrder: 7, price: 700_000 },
    { id: "famlux201",  label: "Oilaviy lyuks balkonli 201",  multiplier: 2.0,  maxAdults: 4, sortOrder: 8, price: 800_000 },
    { id: "famlux301",  label: "Oilaviy lyuks balkonli 301",  multiplier: 2.0,  maxAdults: 3, sortOrder: 9, price: 800_000 },
  ];

  await prisma.roomType.createMany({
    data: roomTypes.map(({ price: _price, ...rt }) => rt),
  });
  console.log(`  RoomType: ${roomTypes.length} ta`);

  // --- Room (18 xona — 3 qavat × 6) -------------------------
  // Room.id = xona raqami (mijoz qarori Q2).
  // Manba: mijoz yuborgan Beds24 xona ro'yxati.
  const layout: Array<[string, string, number]> = [
    // 1-qavat
    ["101", "comfort3",  1], ["102", "standard3", 1], ["103", "comfort4",  1],
    ["104", "premium4",  1], ["105", "semilux",   1], ["106", "deluxe4",   1],
    // 2-qavat
    ["201", "famlux201", 2], ["202", "comfort3",  2], ["203", "premium4",  2],
    ["204", "premium4",  2], ["205", "famdeluxe", 2], ["206", "deluxe4",   2],
    // 3-qavat
    ["301", "famlux301", 3], ["302", "comfort3",  3], ["303", "premium4",  3],
    ["304", "comfort4",  3], ["305", "semilux",   3], ["306", "deluxe4",   3],
  ];

  // --- Floor ------------------------------------------------
  // Qavat ID'si ("F1") barcha tizimlarga shu qiymat bo'lib tarqaladi.
  // `layout` dagi qavat raqamlaridan hosil qilinadi, shunda xona
  // ro'yxati o'zgarsa qavatlar avtomatik moslashadi.
  const floorNumbers = [...new Set(layout.map(([, , f]) => f))].sort((a, b) => a - b);
  await prisma.floor.createMany({
    data: floorNumbers.map((n) => ({
      id: `F${n}`,
      number: n,
      label: `${n}-qavat`,
      sortOrder: n,
    })),
    skipDuplicates: true,
  });
  console.log(`  Floor: ${floorNumbers.length} ta — ${floorNumbers.map((n) => `F${n}`).join(", ")}`);

  await prisma.room.createMany({
    data: layout.map(([number, roomTypeId, floor], i) => ({
      id: number,
      number,
      floor,
      floorId: `F${floor}`,
      roomTypeId,
      status: "AVAILABLE" as const,
      sortOrder: i,
    })),
  });

  const counts = layout.reduce<Record<string, number>>((acc, [, t]) => {
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `  Room: ${layout.length} ta — ` +
    roomTypes.map((rt) => `${rt.id} ${counts[rt.id] ?? 0}`).join(", ")
  );

  // Yaxlitlik tekshiruvi: har tarifda kamida bitta xona bo'lsin va
  // jami son kutilganiga teng bo'lsin. Xona ro'yxati qo'lda
  // tahrirlanganda xato darhol ko'rinadi.
  const EXPECTED_ROOMS = 18;
  if (layout.length !== EXPECTED_ROOMS) {
    throw new Error(
      `Xona soni mos emas! Kutilgan ${EXPECTED_ROOMS}, olindi ${layout.length}`
    );
  }
  const emptyTypes = roomTypes.filter((rt) => !counts[rt.id]);
  if (emptyTypes.length > 0) {
    throw new Error(
      `Bu tariflarda xona yo'q: ${emptyTypes.map((t) => t.id).join(", ")}`
    );
  }
  const unknownTypes = [...new Set(layout.map(([, t]) => t))]
    .filter((t) => !roomTypes.some((rt) => rt.id === t));
  if (unknownTypes.length > 0) {
    throw new Error(`Noma'lum tarif ishlatilgan: ${unknownTypes.join(", ")}`);
  }

  // --- Channel (TZ 12-band: kelajakda boshqalar qo'shiladi) -
  //
  // `create` emas, `upsert`: backend fonda ishlayotgan bo'lsa
  // (`webhook.ts`, `mapping.ts`, `beds24/auth.ts` — uchalasi ham
  // `channel.upsert` qiladi) tozalash bilan shu qator orasida
  // Channel'ni qayta yaratib ulgurishi mumkin. `create` u holda
  // P2002 berardi va butun seed yiqilardi — baza yarim
  // tozalangan, narxsiz holatda qolardi.
  const beds24 = await prisma.channel.upsert({
    where: { code: "beds24" },
    update: { name: "Beds24", isActive: true },
    create: { code: "beds24", name: "Beds24", isActive: true },
  });
  console.log("  Channel: beds24");

  // --- Settings (TZ 7-band: source-of-truth) ---------------
  // `skipDuplicates`: sozlamani backend ham yozishi mumkin
  // (`services/settings.ts`), Channel bilan bir xil poyga.
  await prisma.settings.createMany({
    data: [
      { key: "SOURCE_OF_TRUTH_RATES", value: "pms" },
      { key: "SOURCE_OF_TRUTH_AVAILABILITY", value: "pms" },
      { key: "PENDING_PAYMENT_TIMEOUT_HOURS", value: "24" },
    ],
    skipDuplicates: true,
  });
  console.log("  Settings: 3 ta");

  // --- User (TZ 18-band: RBAC) ------------------------------
  //
  // Uchala rol ham yaratiladi: RBAC testlari uchun kerak va
  // dasturchi topshirishda har rolni sinab ko'ra oladi.
  //
  // DEV PAROLLARI. Topshirishda birinchi qadam — ularni
  // o'zgartirish (FAZA 15 ro'yxatida).
  const devPassword = await bcrypt.hash("admin12345", 10);

  await prisma.user.createMany({
    data: [
      { email: "founder@imron.local", passwordHash: devPassword, fullName: "Egasi",         role: "FOUNDER" },
      { email: "admin@imron.local",   passwordHash: devPassword, fullName: "Administrator", role: "ADMIN" },
      { email: "manager@imron.local", passwordHash: devPassword, fullName: "Menejer",       role: "MANAGER" },
      { email: "staff@imron.local",   passwordHash: devPassword, fullName: "Qabulxona",     role: "STAFF" },
    ],
  });
  console.log("  User: 4 ta (founder/admin/manager/staff, parol: admin12345)");

  // --- Employee (kadrlar hisobi) ----------------------------
  //
  // `User` dan farqli: bu mehmonxonada ishlaydigan odamlar.
  // Farrosh va oshpaz tizimga kirmaydi, lekin ular ham xodim.
  const staffUser = await prisma.user.findUnique({ where: { email: "staff@imron.local" } });

  const employees = [
    { fullName: "Aziz Rustamov",      position: "Bosh administrator", salary: 6_000_000, months: 36 },
    { fullName: "Dilnoza Yoqubova",   position: "Qabulxona xodimi",   salary: 3_500_000, months: 18 },
    { fullName: "Shahzod Qodirov",    position: "Qabulxona xodimi",   salary: 3_500_000, months: 12 },
    { fullName: "Malika Ismoilova",   position: "Farrosh",            salary: 2_500_000, months: 24 },
    { fullName: "Rustam Bekmurodov",  position: "Farrosh",            salary: 2_500_000, months: 8 },
    { fullName: "Farrux Toirov",      position: "Oshpaz",             salary: 4_000_000, months: 30 },
    { fullName: "Nodira Karimova",    position: "Oshpaz yordamchisi", salary: 2_800_000, months: 6 },
    { fullName: "Bekzod Umarov",      position: "Xavfsizlik",         salary: 3_000_000, months: 14 },
  ];

  await prisma.employee.createMany({
    data: employees.map((e, i) => ({
      fullName: e.fullName,
      position: e.position,
      phone: `+998 9${i} ${100 + i}${i} ${10 + i} ${20 + i}`,
      salary: dec(e.salary),
      hiredAt: day(-e.months * 30),
      isActive: true,
      // Qabulxona xodimining tizim hisobi ham bor
      userId: e.fullName === "Dilnoza Yoqubova" ? staffUser?.id ?? null : null,
    })),
  });

  const salaryTotal = employees.reduce((s, e) => s + e.salary, 0);
  console.log(`  Employee: ${employees.length} ta (oylik jami ${salaryTotal.toLocaleString("ru-RU")} so'm)`);

  // --- RatePlan (TZ 7-band) ---------------------------------
  //
  // Narxlar `roomTypes` dan olinadi — tarif qo'shilsa shu yerni
  // tahrirlash kerak emas.
  //
  // DAVOMIYLIK: 365 kun. Narx tugagan kunga qidiruv "xona yo'q"
  // qaytaradi (publicBooking.ts: `if (price <= 0) continue`), shuning
  // uchun oraliq qisqa bo'lmasligi kerak.
  const RATE_DAYS = 365;
  const rates: Prisma.RatePlanCreateManyInput[] = [];
  for (let d = 0; d < RATE_DAYS; d++) {
    for (const rt of roomTypes) {
      rates.push({
        roomTypeId: rt.id,
        date: day(d),
        price: dec(rt.price),
        minStay: 1,
        source: "pms",
      });
    }
  }
  await prisma.ratePlan.createMany({ data: rates });
  console.log(`  RatePlan: ${rates.length} ta (${RATE_DAYS} kun × ${roomTypes.length} tarif)`);

  // --- Guest + Reservation ----------------------------------
  // buildSeedReservations() bilan bir xil 6 ta test bron
  const guests = await Promise.all([
    prisma.guest.create({ data: { fullName: "Ali Valiyev", phone: "+998 90 123 45 67" } }),
    prisma.guest.create({ data: { fullName: "Karimov", phone: "+998 91 222 33 44" } }),
    prisma.guest.create({ data: { fullName: "Booking mehmoni", phone: "+998 93 555 66 77" } }),
    prisma.guest.create({ data: { fullName: "Airbnb mehmoni", phone: "+998 94 777 88 99" } }),
    prisma.guest.create({ data: { fullName: "Sardor (bevosita)", phone: "+998 95 111 22 33" } }),
    prisma.guest.create({ data: { fullName: "Aliyev", phone: "+998 97 444 55 66" } }),
  ]);
  console.log(`  Guest: ${guests.length} ta`);

  // Namunaviy bronlar. Xona raqamlari yangi ro'yxatdan (101-106,
  // 201-206, 301-306), narxlar so'mda va tarif narxiga mos.
  const reservations = [
    { roomId: "101", g: 0, ci: -2, co: 3,  price: 450_000, src: "DIRECT",      st: "CHECKED_IN",  paid: 2_250_000, method: "Naqd" },
    { roomId: "103", g: 1, ci: 1,  co: 4,  price: 550_000, src: "PHONE",       st: "CONFIRMED",   paid: 550_000,   method: "Karta" },
    { roomId: "104", g: 2, ci: -1, co: 2,  price: 600_000, src: "BOOKING_COM", st: "CHECKED_IN",  paid: 1_800_000, method: "Onlayn" },
    { roomId: "106", g: 3, ci: 0,  co: 5,  price: 650_000, src: "AIRBNB",      st: "CHECKED_IN",  paid: 1_950_000, method: "Onlayn" },
    { roomId: "205", g: 4, ci: -3, co: -1, price: 700_000, src: "WALK_IN",     st: "CHECKED_OUT", paid: 1_400_000, method: "Naqd" },
    { roomId: "301", g: 5, ci: -1, co: 4,  price: 800_000, src: "DIRECT",      st: "CHECKED_IN",  paid: 2_000_000, method: "Naqd" },
  ] as const;

  for (const r of reservations) {
    await prisma.reservation.create({
      data: {
        roomId: r.roomId,
        guestId: guests[r.g].id,
        checkIn: day(r.ci),
        checkOut: day(r.co),
        adults: 2,
        children: 0,
        source: r.src,
        pricePerNight: dec(r.price),
        currency: "USD",
        status: r.st,
        checkedInAt: r.st === "CHECKED_IN" || r.st === "CHECKED_OUT" ? day(r.ci) : null,
        checkedOutAt: r.st === "CHECKED_OUT" ? day(r.co) : null,
        syncStatus: "NOT_APPLICABLE",
        payments: {
          create: { amount: dec(r.paid), method: r.method, paymentDate: day(r.ci) },
        },
      },
    });
  }
  console.log(`  Reservation: ${reservations.length} ta (to'lovlari bilan)`);

  // --- Room.status bronlarga qarab yangilanadi --------------
  // roomStatusForReservation() mantig'i (08-fayl §1)
  const statusMap: Record<string, "OCCUPIED" | "DIRTY" | "RESERVED"> = {
    CHECKED_IN: "OCCUPIED",
    CHECKED_OUT: "DIRTY",
    CONFIRMED: "RESERVED",
    PENDING_PAYMENT: "RESERVED",
  };
  for (const r of reservations) {
    const st = statusMap[r.st];
    if (st) await prisma.room.update({ where: { id: r.roomId }, data: { status: st } });
  }

  // --- Availability (07-fayl §2 agregatsiyasi) --------------
  const rooms = await prisma.room.findMany({ where: { isActive: true } });
  const avail: Prisma.AvailabilityCreateManyInput[] = [];

  for (let d = 0; d < 30; d++) {
    const date = day(d);
    for (const roomTypeId of roomTypes.map((rt) => rt.id)) {
      const totalRooms = rooms.filter((x) => x.roomTypeId === roomTypeId).length;
      const bookedRooms = await prisma.reservation.count({
        where: {
          room: { roomTypeId },
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
          checkIn: { lte: date },
          checkOut: { gt: date },
        },
      });
      avail.push({
        roomTypeId,
        date,
        totalRooms,
        bookedRooms,
        blockedRooms: 0,
        availableCount: Math.max(0, totalRooms - bookedRooms),
      });
    }
  }
  await prisma.availability.createMany({ data: avail });
  console.log(`  Availability: ${avail.length} ta (30 kun × ${roomTypes.length} tarif)`);

  // --- Yakuniy tekshiruv ------------------------------------
  const today = avail.filter((a) => a.date.getTime() === day(0).getTime());
  console.log("\nBugungi availability:");
  for (const a of today) {
    console.log(
      `  ${a.roomTypeId.padEnd(9)} ${a.availableCount}/${a.totalRooms} bo'sh`
    );
  }

  console.log("\nSeed tugadi.");
}

/**
 * Seed'ni qayta urinish bilan ishga tushiradi.
 *
 * NEGA KERAK: testlar ishlayotganda server ham DB bilan ishlaydi
 * (worker'lar, WebSocket, davriy vazifalar). Seed `deleteMany`
 * qilayotganda worker o'sha qatorga tegib qolsa - deadlock yoki
 * serialization xatosi chiqadi. Bu o'tkinchi holat: bir necha yuz
 * millisekunddan keyin qayta urinish o'tadi.
 *
 * Aks holda butun test yurishi sababsiz yiqiladi va sabab
 * "PrismaClientUnknownRequestError" degan tushunarsiz xabar bo'ladi
 * (bir marta kuzatilgan: 26 test birdan qulagan).
 */
async function runWithRetry(attempts = 3): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await main();
      return;
    } catch (e) {
      if (i === attempts) throw e;
      console.warn(`\nSeed urinish ${i}/${attempts} yiqildi, qayta urinamiz...`);
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
}

runWithRetry()
  .catch((e) => {
    console.error("\nSeed XATOSI:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
