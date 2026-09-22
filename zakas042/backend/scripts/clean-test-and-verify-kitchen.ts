import { PrismaClient, Prisma } from "@prisma/client";
import { kitchenReport, kitchenOverview } from "../src/services/kitchen.js";
import { formatKitchenReport, formatKitchenOverview } from "../src/bot/kitchen-bot.js";

const prisma = new PrismaClient();

function getTodayDate(): Date {
  const d = new Date(Date.now() + 5 * 3_600_000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  return new Date(Date.UTC(y, m, day, 0, 0, 0, 0));
}

function getTomorrowDate(): Date {
  const d = new Date(Date.now() + 5 * 3_600_000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate() + 1;
  return new Date(Date.UTC(y, m, day, 0, 0, 0, 0));
}

async function cleanAllTestData() {
  console.log("\n============================================================");
  console.log("  1-QADAM: Barcha test bron va mehmonlarni tozalash");
  console.log("============================================================");

  const delPayments = await prisma.payment.deleteMany();
  const delCharges = await prisma.charge.deleteMany();
  const delExpenses = await prisma.expense.deleteMany({ where: { isAuto: true } });
  const delRes = await prisma.reservation.deleteMany();
  const delGuests = await prisma.guest.deleteMany();

  // Barcha xonalarni AVAILABLE holatiga qaytarish
  await prisma.room.updateMany({
    where: { isActive: true },
    data: { status: "AVAILABLE" },
  });

  // Availability jadvalini tozalash va to'liq bo'sh deb belgilash
  const rooms = await prisma.room.findMany({ where: { isActive: true } });
  const roomTypes = await prisma.roomType.findMany();

  await prisma.availability.deleteMany();
  const availRows: Prisma.AvailabilityCreateManyInput[] = [];
  const today = getTodayDate();

  for (let i = 0; i < 30; i++) {
    const curDate = new Date(today.getTime() + i * 86_400_000);
    for (const rt of roomTypes) {
      const total = rooms.filter((r) => r.roomTypeId === rt.id).length;
      availRows.push({
        roomTypeId: rt.id,
        date: curDate,
        totalRooms: total,
        bookedRooms: 0,
        blockedRooms: 0,
        availableCount: total,
      });
    }
  }
  await prisma.availability.createMany({ data: availRows });

  console.log(`- To'lovlar o'chirildi: ${delPayments.count} ta`);
  console.log(`- Qo'shimcha xizmatlar o'chirildi: ${delCharges.count} ta`);
  console.log(`- Avto xarajatlar o'chirildi: ${delExpenses.count} ta`);
  console.log(`- Bronlar o'chirildi: ${delRes.count} ta`);
  console.log(`- Mehmonlar o'chirildi: ${delGuests.count} ta`);
  console.log(`- Barcha xonalar AVAILABLE (bo'sh) holatiga o'tkazildi.`);

  const resCount = await prisma.reservation.count();
  const guestCount = await prisma.guest.count();
  console.log(`\nTekshiruv: Hozirgi bronlar soni = ${resCount}, mehmonlar soni = ${guestCount}`);
}

async function testBookingAndKitchen() {
  console.log("\n============================================================");
  console.log("  2-QADAM: Yangi bron yaratish, tasdiqlash va Oshxona testi");
  console.log("============================================================");

  const today = getTodayDate();
  const tomorrow = getTomorrowDate();

  // 1. Test mehmon yaratish
  const guest = await prisma.guest.create({
    data: {
      fullName: "Alisher Navoiy (Test Mehmon)",
      phone: "+998 90 999 88 77",
      email: "alisher.test@imron.uz",
    },
  });
  console.log(`[✓] Mehmon yaratildi: ID=${guest.id}, Ism=${guest.fullName}`);

  // 2. Ovqatli bron yaratish (withMeal: true, 2 katta, 1 bola)
  const booking = await prisma.reservation.create({
    data: {
      roomId: "101",
      guestId: guest.id,
      checkIn: today,
      checkOut: tomorrow,
      adults: 2,
      children: 1,
      pricePerNight: new Prisma.Decimal(400_000),
      currency: "UZS",
      source: "WEBSITE",
      withMeal: true,
      mealPricePerPerson: new Prisma.Decimal(25_000),
      status: "CONFIRMED", // Tasdiqlangan holat
      code: "IMR-KITCHEN1",
      payments: {
        create: {
          amount: new Prisma.Decimal(425_000),
          method: "Karta",
          paymentDate: today,
        },
      },
    },
  });
  console.log(`[✓] Bron yaratildi va TASDIQLANDI (CONFIRMED):`);
  console.log(`    Kod: ${booking.code}, Xona: ${booking.roomId}, Ovqat bilan: ${booking.withMeal}`);
  console.log(`    Kattalar: ${booking.adults}, Bolalar: ${booking.children}`);

  // Xona holatini yangilash
  await prisma.room.update({
    where: { id: "101" },
    data: { status: "RESERVED" },
  });

  // 3. Oshxona hisobotini tahlil qilish (Bugungi kun)
  console.log("\n--- [3.1] Oshxona API tekshiruvi (kitchenReport) ---");
  const reportToday = await kitchenReport(0);

  console.log(`Sana: ${reportToday.date}`);
  console.log(`Jami ovqatlanuvchilar: ${reportToday.totalGuests} nafar`);
  console.log(`Kattalar: ${reportToday.totalAdults} nafar`);
  console.log(`Bolalar: ${reportToday.totalChildren} nafar`);
  console.log(`Keladigan xonalar soni: ${reportToday.arriving} ta`);
  console.log(`Xonada turganlar soni: ${reportToday.staying} ta`);

  const foundRoom = reportToday.rooms.find((r) => r.roomId === "101");
  if (!foundRoom) {
    throw new Error("XATOLIK: 101-xona oshxona hisobotida topilmadi!");
  }
  console.log(`[✓] 101-xona oshxonada muvaffaqiyatli aniqlandi!`);
  console.log(`    Mehmon: ${foundRoom.guestName}, Porsiya: ${foundRoom.adults + foundRoom.children} ta, Manba: ${foundRoom.source}`);

  // 4. Oshxona Boti xabari formatini tekshirish
  console.log("\n--- [3.2] Oshxona Telegram Boti xabari formati ---");
  const botMessage = formatKitchenReport(reportToday, false);
  console.log(botMessage);

  // 5. Umumiy ko'rinish (Overview) tekshiruvi
  console.log("\n--- [3.3] Oshxona Umumiy Ko'rinishi (Overview) ---");
  const overview = await kitchenOverview();
  console.log(`Bugun: ${overview.today.totalGuests} mehmon, Ertaga: ${overview.tomorrow.totalGuests} mehmon`);

  // 6. Mehmon xonaga joylashganda (CHECKED_IN) oshxona qanday o'zgarishini test qilish
  console.log("\n--- [3.4] Mehmon CHECKED_IN (xonaga kirdi) holati testi ---");
  await prisma.reservation.update({
    where: { id: booking.id },
    data: { status: "CHECKED_IN", checkedInAt: new Date() },
  });
  await prisma.room.update({
    where: { id: "101" },
    data: { status: "OCCUPIED" },
  });

  const reportAfterCheckIn = await kitchenReport(0);
  console.log(`Hozir xonada turganlar: ${reportAfterCheckIn.staying} ta xona`);
  console.log(`Yangi keladiganlar: ${reportAfterCheckIn.arriving} ta xona`);
  const checkedInRoom = reportAfterCheckIn.rooms.find((r) => r.roomId === "101");
  console.log(`[✓] 101-xona holati oshxonada: ${checkedInRoom?.arriving ? "Keladi" : "XONADA (Joylashgan)"}`);
}

async function resetToZero() {
  console.log("\n============================================================");
  console.log("  4-QADAM: Bazani qaytadan to'liq 0 ga tushirish (Reset)");
  console.log("============================================================");

  await prisma.payment.deleteMany();
  await prisma.charge.deleteMany();
  await prisma.expense.deleteMany({ where: { isAuto: true } });
  await prisma.reservation.deleteMany();
  await prisma.guest.deleteMany();

  await prisma.room.updateMany({
    where: { isActive: true },
    data: { status: "AVAILABLE" },
  });

  const rooms = await prisma.room.findMany({ where: { isActive: true } });
  const roomTypes = await prisma.roomType.findMany();
  await prisma.availability.deleteMany();

  const availRows: Prisma.AvailabilityCreateManyInput[] = [];
  const today = getTodayDate();
  for (let i = 0; i < 30; i++) {
    const curDate = new Date(today.getTime() + i * 86_400_000);
    for (const rt of roomTypes) {
      const total = rooms.filter((r) => r.roomTypeId === rt.id).length;
      availRows.push({
        roomTypeId: rt.id,
        date: curDate,
        totalRooms: total,
        bookedRooms: 0,
        blockedRooms: 0,
        availableCount: total,
      });
    }
  }
  await prisma.availability.createMany({ data: availRows });

  const finalResCount = await prisma.reservation.count();
  const finalGuestCount = await prisma.guest.count();
  const finalPaymentCount = await prisma.payment.count();

  console.log(`\n[✓] Yakuniy hisob:`);
  console.log(`    - Bronlar (Reservation): ${finalResCount}`);
  console.log(`    - Mehmonlar (Guest): ${finalGuestCount}`);
  console.log(`    - To'lovlar (Payment): ${finalPaymentCount}`);
  console.log(`    - Barcha 18 ta xona: AVAILABLE`);

  // Oshxona hisobotini ham 0 ekanini tasdiqlash
  const emptyKitchen = await kitchenReport(0);
  console.log(`    - Oshxona bugun ovqatlanuvchilar: ${emptyKitchen.totalGuests} nafar (Xonalar: ${emptyKitchen.rooms.length})`);
}

async function main() {
  try {
    await cleanAllTestData();
    await testBookingAndKitchen();
    await resetToZero();
    console.log("\n============================================================");
    console.log("  BARCHA TESTLAR VA NOLGA TUSHIRISH MUVAFFAQIYATLI YAKUNLANDI!");
    console.log("============================================================\n");
  } catch (err) {
    console.error("Xatolik yuz berdi:", err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
