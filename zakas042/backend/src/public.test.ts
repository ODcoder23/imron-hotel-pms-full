/**
 * FAZA 13 — Website public API
 *
 * TZ 3-band:  Website -> PMS -> Database -> Shaxmatka -> Beds24 -> OTA.
 *             "Bron qilingan xona boshqa kanallarda mavjud bo'lmagan
 *             holatga o'tishi kerak. OVERBOOKING BO'LMASLIGI SHART."
 * TZ 20-band: yakuniy natijaning birinchi qismi.
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md, FAZA 13):
 *   "POST /api/public/reservations chaqirilganda -> Shaxmatkada
 *    darhol ko'rinadi -> xona band bo'ladi -> mock Beds24'ga
 *    yuboriladi -> availability kamayadi."
 *
 * ISH CHEGARASI: Website kodiga kirish yo'q — API va uning kontrakti
 * topshiriladi, ulash scope'dan tashqarida (13-fayl §8).
 *
 * Ishga tushirish:  npx vitest run src/public.test.ts
 * Shart: server (:3000), mock (:4000), PostgreSQL, Redis
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prisma } from "./lib/prisma.js";
import { setupConnection } from "./services/beds24/auth.js";
import { upsertMapping } from "./services/mapping.js";
import {
  generateCode, validateRange, pickRoom,
  searchAvailability, createPublicBooking, findByCode,
  expireUnpaidBookings,
} from "./services/publicBooking.js";
import { fromDateKey } from "./lib/serialize.js";
import { TYPES, loadTypes, tariffFor } from "./testUtils.js";

const PMS = process.env.PMS_URL ?? "http://127.0.0.1:3000";
const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:4000";

const EXT = { standard: "101001", double: "101002", deluxe: "101003" } as const;

/**
 * Tur bo'yicha xona soni — BAZADAN.
 *
 * Ilgari `{ standard: 6, double: 4, deluxe: 2 }` qattiq yozilgan
 * edi; loyiha 18 xonaga o'tganda bu sonlar noto'g'ri bo'lib qoldi.
 * `loadTotals()` beforeAll da to'ldiradi.
 */
const TOTAL = { a: 0, b: 0, c: 0 };

async function loadTotals() {
  for (const [key, typeId] of [["a", TYPES.a], ["b", TYPES.b], ["c", TYPES.c]] as const) {
    TOTAL[key] = await prisma.room.count({
      where: { roomTypeId: typeId, isActive: true },
    });
  }
}

/**
 * Public API tokensiz ishlashi KERAK.
 *
 * `vitest.setup.ts` global `fetch` ni o'rab, PMS so'rovlariga ADMIN
 * token qo'shadi (auth yoqilganda). Bu yerda aynan MIJOZ holatini
 * sinaymiz, shuning uchun bo'sh `Authorization` yuboramiz — o'ram
 * sarlavha bor deb hisoblab tegmaydi.
 */
const publicApi = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${PMS}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: "", ...init.headers },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
};

/** Ichki API — token bilan (setup o'zi qo'shadi) */
const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${PMS}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
};

const mockControl = async (path: string, body?: unknown) =>
  (await fetch(`${MOCK}/control/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })).json() as any;

const mockState = async () =>
  (await fetch(`${MOCK}/control/state`).then((r) => r.json())) as {
    bookings: Array<Record<string, any>>;
    calendarPushes: Array<{ roomId: number; entries: Array<{ from: string; to: string; numAvail?: number }> }>;
  };

async function mapAll() {
  // EXT kalitlari tarixiy nomlar — ular faqat tashqi Beds24
  // ID'sini topish uchun. PMS turi TYPES dan keladi.
  const pairs: Array<[string, string]> = [
    [TYPES.a, EXT.standard],
    [TYPES.b, EXT.double],
    [TYPES.c, EXT.deluxe],
  ];

  for (const [pms, external] of pairs) {
    await upsertMapping({ roomTypeId: pms, externalRoomTypeId: external });
  }
}

/** Test sanalari — bugundan boshlab, validatsiya o'tishi uchun */
const day = (offset: number): string => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

/** Test oraliqlari uchun narx qo'yadi — narxsiz tur ko'rsatilmaydi */
async function setPrices(from: string, to: string) {
  await api("/api/rate-plans", {
    method: "PUT",
    body: JSON.stringify({
      from, to,
      prices: { [TYPES.a]: 40, [TYPES.b]: 55, [TYPES.c]: 90 },
    }),
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Test yaratgan bronlarni tozalash */
async function cleanupWebsiteBookings() {
  const list = await prisma.reservation.findMany({
    where: { source: "WEBSITE" },
    select: { id: true },
  });
  const ids = list.map((r) => r.id);
  if (ids.length === 0) return;
  await prisma.payment.deleteMany({ where: { reservationId: { in: ids } } });
  await prisma.charge.deleteMany({ where: { reservationId: { in: ids } } });
  await prisma.reservation.deleteMany({ where: { id: { in: ids } } });
}

describe("FAZA 13 — Website public API (TZ 3, 20-band)", () => {
  beforeAll(async () => {
    // Tur ID'lari bazadan olinadi (testUtils.ts) — ilgari
    // "standard"/"double"/"deluxe" qattiq yozilgan edi
    await loadTypes();
    await loadTotals();
    const health = await fetch(`${PMS}/health`).then((r) => r.json() as any);
    if (health.redis !== "connected") throw new Error("Redis ishlamayapti");
    const mock = await fetch(`${MOCK}/authentication/setup`, { headers: { code: "mock-invite-code" } });
    if (!mock.ok) throw new Error("Mock server ishlamayapti");
  });

  beforeEach(async () => {
    await prisma.syncLog.deleteMany();
    await prisma.webhookEvent.deleteMany();
    await cleanupWebsiteBookings();
    await mockControl("reset");
    // Kredit cheklovi test oqimini to'xtatmasin (03-fayl §3)
    await fetch(`${MOCK}/control/refill-credits`, { method: "POST" }).catch(() => {});

    const conn = await prisma.channelConnection.findFirst({
      where: { channel: { code: "beds24" }, isActive: true },
    });
    if (!conn) await setupConnection("mock-invite-code", "12345");

    // Mapping O'CHIRILMAYDI, faqat yangilanadi: o'chirish va
    // qayta yaratish orasidagi bo'shliqda oldingi test faylidan
    // qolgan job ishga tushib "mapping topilmadi" bilan
    // yiqilardi — keyingi test esa worker'ni kutib qolardi.
    // `upsertMapping` idempotent, o'chirish shart emas.
    await mapAll();
  });

  /**
   * Mapping'ni TIKLAB ketamiz.
   *
   * Ba'zi testlar mapping YO'QLIGINI sinaydi va uni o'chiradi.
   * Fayl shu holatda tugasa — keyingi fayllarning sync
   * worker'lari "mapping topilmadi" bilan yiqiladi va ular
   * worker'ni kutib 20 soniya o'tirib qoladi.
   *
   * Server worker'lari testlar orasida ham ishlab turadi, ya'ni
   * holat fayllar orasida oqib o'tadi.
   */
  afterAll(async () => {
    await mapAll();
  });

  // --- Bron kodi (13-fayl §6) --------------------------------
  describe("bron kodi", () => {
    it("IMR-XXXXX shaklida", () => {
      expect(generateCode()).toMatch(/^IMR-[A-Z0-9]{5}$/);
    });

    it("ketma-ket emas — taxmin qilib bo'lmaydi", () => {
      const codes = new Set(Array.from({ length: 200 }, () => generateCode()));
      // 200 ta kodning deyarli hammasi turlicha bo'lishi kerak
      expect(codes.size).toBeGreaterThan(190);
    });

    it("chalkashadigan belgilar yo'q (0/O, 1/I)", () => {
      // Faqat tasodifiy qism tekshiriladi — "IMR-" prefiksi doimiy
      const random = Array.from({ length: 100 }, () => generateCode().slice(4)).join("");
      expect(random).not.toMatch(/[01OI]/);
    });
  });

  // --- Validatsiya (13-fayl §6) ------------------------------
  describe("sana validatsiyasi", () => {
    it("o'tmishdagi sana rad etiladi", () => {
      expect(() => validateRange(day(-5), day(-2))).toThrow(/o'tmish/i);
    });

    it("teskari oraliq rad etiladi", () => {
      expect(() => validateRange(day(10), day(5))).toThrow();
    });

    it("bir yildan uzoq rad etiladi", () => {
      expect(() => validateRange(day(400), day(402))).toThrow(/bir yil/i);
    });

    it("to'g'ri oraliq kechalar sonini qaytaradi", () => {
      const r = validateRange(day(10), day(13));
      expect(r.nights).toBe(3);
    });

    it("HTTP orqali ham tekshiriladi", async () => {
      const res = await publicApi(`/api/public/availability?from=${day(-5)}&to=${day(-2)}&adults=2`);
      expect(res.status).toBe(400);
    });
  });

  // --- Qidiruv (13-fayl §2) ----------------------------------
  describe("bo'sh xonalarni qidirish", () => {
    it("tokensiz ishlaydi — mijoz ro'yxatdan o'tmagan", async () => {
      await setPrices(day(30), day(32));
      const res = await publicApi(`/api/public/availability?from=${day(30)}&to=${day(32)}&adults=2`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.roomTypes)).toBe(true);
    });

    it("narx va jami summa qaytariladi", async () => {
      await setPrices(day(35), day(38));
      const res = await publicApi(`/api/public/availability?from=${day(35)}&to=${day(38)}&adults=2`);

      const std = res.body.roomTypes.find((t: any) => t.id === TYPES.a);
      expect(std.pricePerNight).toBe(40);
      expect(res.body.nights).toBe(3);

      /**
       * `totalPrice` NONUSHTANI HAM O'Z ICHIGA OLADI (S10,
       * 2026-09-17). Ilgari `toBe(120)` — faqat xona narxi.
       *
       * Saytdan kelgan bron har doim ovqat tarifi bilan
       * (BOTLAR-REJA.md): mehmon darhol to'liq summani ko'radi,
       * tasdiqlashda kutilmagan qo'shimcha chiqmasin.
       *
       * Nonushta narxi sozlamadan keladi, shuning uchun qattiq
       * raqam yozilmaydi — javobning o'z maydonlaridan
       * hisoblanadi.
       */
      expect(std.roomTotal).toBe(120);          // 40 x 3 kecha
      expect(std.mealTotal).toBe(std.mealPricePerPerson * 2 * 3);
      expect(std.totalPrice).toBe(std.roomTotal + std.mealTotal);
    });

    it("narx belgilanmagan tur KO'RSATILMAYDI", async () => {
      // Mijozga "0 so'm" ko'rsatib keyin haqiqiy narx aytish
      // yomon tajriba
      await prisma.ratePlan.deleteMany({
        where: { date: { gte: fromDateKey(day(200)), lte: fromDateKey(day(203)) } },
      });

      const res = await publicApi(`/api/public/availability?from=${day(200)}&to=${day(203)}&adults=2`);
      expect(res.status).toBe(200);
      expect(res.body.roomTypes).toHaveLength(0);
    });

    it("sig'imi yetmaydigan tur ko'rsatilmaydi", async () => {
      await setPrices(day(40), day(42));
      const res = await publicApi(`/api/public/availability?from=${day(40)}&to=${day(42)}&adults=10`);
      // Seed'da maxAdults = 2
      expect(res.body.roomTypes).toHaveLength(0);
    });

    it("availableCount — butun oraliq bo'yicha MINIMAL qiymat", async () => {
      // 13-fayl §2: 15-da 3 ta, 17-da 1 ta bo'sh bo'lsa, javob 1
      await setPrices(day(50), day(55));

      // Oraliqning o'rtasiga bitta bron qo'yamiz
      const room = await prisma.room.findFirstOrThrow({
        where: { roomTypeId: TYPES.c, isActive: true },
      });
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: day(52),
          checkOut: day(53),
          guestName: "Min Testi",
          phone: "+99892200001",
          guestPhone: "+998900000090",
          adults: 1,
          pricePerNight: await tariffFor(room.id),
        }),
      });
      expect(created.status).toBe(201);

      const res = await publicApi(`/api/public/availability?from=${day(50)}&to=${day(55)}&adults=2`);
      const deluxe = res.body.roomTypes.find((t: any) => t.id === TYPES.c);

      // Oraliqning bir kunida 1 ta band -> butun oraliq uchun 1
      expect(deluxe.availableCount).toBe(TOTAL.c - 1);

      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    });
  });

  // --- Xona tanlash (13-fayl §3) -----------------------------
  describe("xona avtomatik tanlash", () => {
    it("bo'sh xona topiladi", async () => {
      const roomId = await pickRoom(TYPES.a, fromDateKey(day(60)), fromDateKey(day(62)));
      expect(roomId).toBeTruthy();
    });

    it("band xona tanlanmaydi", async () => {
      const room = await prisma.room.findFirstOrThrow({
        where: { roomTypeId: TYPES.c, isActive: true },
        orderBy: { sortOrder: "asc" },
      });

      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: day(65),
          checkOut: day(67),
          guestName: "Band Testi",
          phone: "+99892200002",
          guestPhone: "+998900000091",
          adults: 1,
          pricePerNight: await tariffFor(room.id),
        }),
      });

      const picked = await pickRoom(TYPES.c, fromDateKey(day(65)), fromDateKey(day(67)));
      expect(picked).not.toBe(room.id);

      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    });

    it("hammasi band bo'lsa null qaytaradi", async () => {
      const rooms = await prisma.room.findMany({
        where: { roomTypeId: TYPES.c, isActive: true },
      });

      const ids: string[] = [];
      for (const r of rooms) {
        const res = await api("/api/reservations", {
          method: "POST",
          body: JSON.stringify({
            roomId: r.id,
            checkIn: day(70),
            checkOut: day(72),
            guestName: `Toliq ${r.number}`,
            // Xona raqamiga bog'langan — bir xil telefon bitta
            // `Guest` yozuviga birlashadi va test noto'g'ri
            // sonlarni ko'rardi (S6: telefon bir xil bo'lsa
            // mehmon yangilanadi, yangisi yaratilmaydi).
            phone: `+9989220${r.number}`,
            adults: 1,
            pricePerNight: await tariffFor(r.id),
          }),
        });
        if (res.status === 201) ids.push(res.body.id);
      }

      const picked = await pickRoom(TYPES.c, fromDateKey(day(70)), fromDateKey(day(72)));
      expect(picked).toBeNull();

      await prisma.reservation.deleteMany({ where: { id: { in: ids } } });
    });

    it("xizmatdan chiqarilgan xona tanlanmaydi", async () => {
      const room = await prisma.room.findFirstOrThrow({
        where: { roomTypeId: TYPES.c, isActive: true },
        orderBy: { sortOrder: "asc" },
      });
      const before = room.status;

      await prisma.room.update({ where: { id: room.id }, data: { status: "OUT_OF_ORDER" } });

      const picked = await pickRoom(TYPES.c, fromDateKey(day(75)), fromDateKey(day(77)));
      expect(picked).not.toBe(room.id);

      await prisma.room.update({ where: { id: room.id }, data: { status: before } });
    });
  });

  // --- FAZA 13 ASOSIY MEZONI ---------------------------------
  describe("FAZA 13 mezoni — Website -> Shaxmatka -> Beds24", () => {
    it("bron yaratiladi, kod va xona qaytadi", async () => {
      await setPrices(day(80), day(83));

      const res = await publicApi("/api/public/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomTypeId: TYPES.c,
          checkIn: day(80),
          checkOut: day(83),
          adults: 2,
          guest: { fullName: "Website Mijozi", phone: "+998901110001" },
        }),
      });

      expect(res.status).toBe(201);
      expect(res.body.reservationCode).toMatch(/^IMR-[A-Z0-9]{5}$/);
      expect(res.body.roomNumber).toBeTruthy();
      // 13-fayl §5: darhol CONFIRMED emas — mijoz hali to'lamagan
      expect(res.body.status).toBe("pending_payment");
      expect(res.body.totalPrice).toBe(270);      // 90 x 3
    });

    it("Shaxmatkada DARHOL ko'rinadi", async () => {
      await setPrices(day(85), day(87));

      const created = await publicApi("/api/public/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomTypeId: TYPES.a,
          checkIn: day(85),
          checkOut: day(87),
          adults: 1,
          guest: { fullName: "Shaxmatka Testi", phone: "+998901110002" },
        }),
      });
      expect(created.status).toBe(201);

      // Ichki API (Shaxmatka o'qiydigan) darhol ko'radi
      const list = await api("/api/reservations");
      const found = list.body.find((r: any) => r.guestName === "Shaxmatka Testi");

      expect(found, "Shaxmatkada ko'rinmadi").toBeTruthy();
      expect(found.source).toBe("website");
      expect(found.status).toBe("pending_payment");
      expect(found.roomId).toBe(created.body.roomNumber);
    });

    it("xona BAND bo'ladi — availability kamayadi (TZ 3-band)", async () => {
      await setPrices(day(90), day(92));

      const before = await publicApi(`/api/public/availability?from=${day(90)}&to=${day(92)}&adults=2`);
      const deluxeBefore = before.body.roomTypes.find((t: any) => t.id === TYPES.c).availableCount;

      await publicApi("/api/public/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomTypeId: TYPES.c,
          checkIn: day(90),
          checkOut: day(92),
          adults: 2,
          guest: { fullName: "Band Qilish", phone: "+998901110003" },
        }),
      });

      const after = await publicApi(`/api/public/availability?from=${day(90)}&to=${day(92)}&adults=2`);
      const deluxeAfter = after.body.roomTypes.find((t: any) => t.id === TYPES.c).availableCount;

      expect(deluxeAfter).toBe(deluxeBefore - 1);
    });

    it("Beds24'ga yuboriladi va availability kamayadi", async () => {
      await setPrices(day(95), day(97));

      const created = await publicApi("/api/public/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomTypeId: TYPES.c,
          checkIn: day(95),
          checkOut: day(97),
          adults: 2,
          guest: { fullName: "Beds24 Zanjiri", phone: "+998901110004" },
        }),
      });
      expect(created.status).toBe(201);

      // Worker'lar yuborishini kutamiz.
      //
      // Mock kredit cheklovi 100/5daqiqa (03-fayl §3). Ko'p test
      // ketma-ket ishlaganda kredit tugab, job KECHIKTIRILADI —
      // bu xato emas, kutilgan xatti-harakat (05-fayl §3).
      //
      // `refill-credits`, `reset` EMAS (2026-09-17): `reset`
      // BRONLARNI HAM o'chiradi (mock-beds24/server.ts §112).
      // Bron yaratilgandan keyin chaqirilgani uchun test o'z
      // bronini o'chirib yuborardi va keyin uni 60 soniya
      // kutardi — "bron Beds24'ga yetmadi" deb yiqilardi,
      // aslida zanjir ishlardi.
      await mockControl("refill-credits");
      await mapAll();

      /**
       * Oxirgi turtki xatosi — sababni ko'rsatish uchun.
       *
       * Ilgari `.catch(() => {})` xatoni butunlay yutardi va
       * test "bron Beds24'ga yetmadi" deb yiqilardi, sabab esa
       * ko'rinmasdi. Endi xabar assert'ga qo'shiladi.
       */
      let lastPushError = "";

      const sent = await waitFor(async () => {
        const { bookings } = await mockState();
        if (bookings.some((b) => String(b.firstName).includes("Beds24"))) return true;

        // Job kechiktirilgan bo'lsa qo'lda turtki beramiz
        const r = await prisma.reservation.findUnique({
          where: { code: created.body.reservationCode },
          select: { id: true, externalReservationId: true },
        });
        if (r && !r.externalReservationId) {
          const { pushReservation } = await import("./services/reservationSync.js");
          await pushReservation(r.id).catch((e) => {
            lastPushError = e instanceof Error ? e.message : String(e);
          });
        }
        return false;
      }, 60000);

      /**
       * Kutish 60 s (ilgari 25 s).
       *
       * Baza SSH tunnel orqali kelganda har so'rov ~700 ms
       * (o'lchangan), bitta bron yaratish ~11 s. Worker
       * navbatdan olib, Beds24'ga yuborishi ham shuncha.
       * 25 s yetmasdi va test "bron Beds24'ga yetmadi" deb
       * yiqilardi — aslida zanjir ishlardi, jonli sinovda
       * `push_reservation` `success` qaytaradi.
       */
      expect(
        sent,
        `bron Beds24'ga yetmadi${lastPushError ? ` — ${lastPushError}` : ""}`
      ).toBe(true);

      const { bookings } = await mockState();
      const booking = bookings.find((b) => String(b.firstName).includes("Beds24"))!;

      // PENDING_PAYMENT -> Beds24'da "request" (08-fayl §2)
      expect(booking.status).toBe("request");
      expect(booking.referer).toBe("PMS");

      // Availability ham ketishi kerak. Lekin yuqorida kreditni
      // tiklash uchun `reset` qilingan bo'lishi mumkin, u esa
      // `calendarPushes` ni tozalaydi. Shuning uchun alohida
      // kutamiz: hisob DB'da to'g'ri, yuborish navbat orqali.
      const availSent = await waitFor(async () => {
        const { calendarPushes: pushes } = await mockState();
        return pushes.some(
          (p) => p.roomId === Number(EXT.deluxe) &&
                 p.entries.some((e) => typeof e.numAvail === "number")
        );
      }, 20000);

      expect(availSent, "availability yuborilmadi").toBe(true);
    }, 90000);
  });

  // --- PENDING_PAYMENT (13-fayl §5) --------------------------
  describe("PENDING_PAYMENT oqimi", () => {
    it("to'lov qo'shilsa admin CONFIRMED ga o'tkazadi", async () => {
      await setPrices(day(100), day(102));

      const created = await publicApi("/api/public/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomTypeId: TYPES.a,
          checkIn: day(100),
          checkOut: day(102),
          adults: 1,
          guest: { fullName: "Tolov Oqimi", phone: "+998901110005" },
        }),
      });

      const found = await findByCode(created.body.reservationCode);
      expect(found?.status).toBe("pending_payment");

      // Admin to'lovni qabul qiladi va statusni o'zgartiradi
      const reservation = await prisma.reservation.findUniqueOrThrow({
        where: { code: created.body.reservationCode },
      });

      await api(`/api/reservations/${reservation.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: 80, method: "cash" }),
      });
      await api(`/api/reservations/${reservation.id}/confirm`, { method: "POST" });

      const after = await findByCode(created.body.reservationCode);
      expect(after?.status).toBe("confirmed");
      expect(after?.paidAmount).toBe(80);
    });

    it("muddati o'tgan to'lanmagan bron avtomatik bekor qilinadi", async () => {
      await setPrices(day(105), day(107));

      const created = await publicApi("/api/public/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomTypeId: TYPES.c,
          checkIn: day(105),
          checkOut: day(107),
          adults: 1,
          guest: { fullName: "Muddat Testi", phone: "+998901110006" },
        }),
      });

      const reservation = await prisma.reservation.findUniqueOrThrow({
        where: { code: created.body.reservationCode },
      });

      // Yaratilgan vaqtni orqaga suramiz — 48 soat oldin
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: { createdAt: new Date(Date.now() - 48 * 3600_000) },
      });

      const result = await expireUnpaidBookings();
      expect(result.cancelled).toBeGreaterThanOrEqual(1);

      const after = await findByCode(created.body.reservationCode);
      expect(after?.status).toBe("cancelled");
    });

    it("yangi to'lanmagan bron bekor QILINMAYDI", async () => {
      await setPrices(day(110), day(112));

      const created = await publicApi("/api/public/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomTypeId: TYPES.a,
          checkIn: day(110),
          checkOut: day(112),
          adults: 1,
          guest: { fullName: "Yangi Bron", phone: "+998901110007" },
        }),
      });

      await expireUnpaidBookings();

      const after = await findByCode(created.body.reservationCode);
      expect(after?.status).toBe("pending_payment");
    });
  });

  // --- Davriy vazifa (13-fayl §5) ---------------------------
  describe("davriy tozalash jadvali", () => {
    it("maintenance navbati ro'yxatdan o'tgan", async () => {
      const res = await api("/api/admin/queues");
      expect(res.status).toBe(200);

      // Jadval Redis'da saqlanadi — server qayta ishga tushganda
      // ham yo'qolmaydi
      expect(res.body.queues["pms-maintenance"], "maintenance navbati yo'q").toBeTruthy();
    });

    it("davriy vazifa qo'lda ham ishga tushadi", async () => {
      // Jadval Redis'da saqlanadi va server ishga tushganda
      // o'rnatiladi. Redis tozalansa (test muhitida bo'ladi)
      // jadval faqat keyingi restartda qaytadi — shuning uchun
      // `delayed` sonini tekshirish mo'rt bo'lardi.
      //
      // Muhimi: vazifaning O'ZI ishlaydi. Admin uni istalgan
      // paytda qo'lda ishga tushira oladi (13-fayl §5).
      const res = await api("/api/admin/maintenance/expire-unpaid", { method: "POST" });

      expect(res.status).toBe(200);
      expect(typeof res.body.checked).toBe("number");
      expect(typeof res.body.cancelled).toBe("number");
    }, 20000);
  });

  // --- Bron kodi bilan tekshirish (13-fayl §2) ---------------
  describe("bronni kod bilan ko'rish", () => {
    it("mijoz o'z bronini ko'radi", async () => {
      await setPrices(day(115), day(118));

      const created = await publicApi("/api/public/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomTypeId: TYPES.b,
          checkIn: day(115),
          checkOut: day(118),
          adults: 2,
          guest: { fullName: "Kod Egasi", phone: "+998901110008" },
        }),
      });

      const res = await publicApi(`/api/public/reservations/${created.body.reservationCode}`);
      expect(res.status).toBe(200);
      expect(res.body.guestName).toBe("Kod Egasi");
      expect(res.body.nights).toBe(3);
    });

    it("javobda ICHKI ma'lumot yo'q (13-fayl §6)", async () => {
      await setPrices(day(120), day(122));

      const created = await publicApi("/api/public/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomTypeId: TYPES.a,
          checkIn: day(120),
          checkOut: day(122),
          adults: 1,
          guest: { fullName: "Sirlar Testi", phone: "+998901110009" },
        }),
      });

      const res = await publicApi(`/api/public/reservations/${created.body.reservationCode}`);
      const text = JSON.stringify(res.body).toLowerCase();

      // Ichki id, Beds24 bookingId, sync holati — mijozga kerak emas
      expect(text).not.toContain("externalreservationid");
      expect(text).not.toContain("syncstatus");
      expect(text).not.toContain("channelid");
      // Telefon ham — boshqa odam kodni topib qolsa
      expect(text).not.toContain("998901110009");
    });

    it("noto'g'ri kod 404 — mavjudlik oshkor qilinmaydi", async () => {
      const a = await publicApi("/api/public/reservations/IMR-ZZZZZ");
      const b = await publicApi("/api/public/reservations/umuman-kod-emas");

      expect(a.status).toBe(404);
      expect(b.status).toBe(404);
      // Ikkalasi ham bir xil javob — kodlarni taxmin qilib bo'lmaydi
      expect(a.body.error).toBe(b.body.error);
    });
  });

  // --- Xavfsizlik (13-fayl §6) -------------------------------
  describe("xavfsizlik", () => {
    it("honeypot to'ldirilgan so'rov rad etiladi (bot)", async () => {
      const res = await publicApi("/api/public/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomTypeId: TYPES.a,
          checkIn: day(125),
          checkOut: day(127),
          adults: 1,
          guest: { fullName: "Bot Nomi", phone: "+998901110010" },
          website: "http://spam.example.com",
        }),
      });

      expect(res.status).toBe(400);

      // Bron yaratilmadi
      const exists = await prisma.reservation.findFirst({
        where: { guest: { fullName: "Bot Nomi" } },
      });
      expect(exists).toBeNull();
    });

    it("bir raqamga 3 tadan ko'p to'lanmagan bron bo'lmaydi", async () => {
      await setPrices(day(130), day(145));
      const phone = "+998901119999";

      /**
       * ENG KO'P XONALI turni tanlaymiz.
       *
       * Ilgari `TYPES.a` qattiq yozilgan edi. 18 xonali
       * tuzilmada u `standard3` — BITTA xonali tarif, va
       * ikkinchi bron "bo'sh xona qolmadi" (409) olardi.
       * Spam himoyasi (400) umuman ishga tushmasdi va test
       * noto'g'ri sababdan yiqilardi.
       *
       * Har bron BOSHQA sanaga ketadi, shuning uchun bitta
       * xona ham yetardi — lekin `pickRoom` bandlikni sana
       * bo'yicha qaraydi va 1 xonali turda zaxira qolmaydi.
       */
      const roomType = (Object.entries(TOTAL) as Array<["a" | "b" | "c", number]>)
        .sort((x, y) => y[1] - x[1])[0][0];

      let lastStatus = 0;
      for (let i = 0; i < 5; i++) {
        const res = await publicApi("/api/public/reservations", {
          method: "POST",
          body: JSON.stringify({
            roomTypeId: TYPES[roomType],
            checkIn: day(130 + i * 2),
            checkOut: day(131 + i * 2),
            adults: 1,
            guest: { fullName: `Spam ${i}`, phone },
          }),
        });
        lastStatus = res.status;
        if (res.status !== 201) break;
      }

      // 4-urinishda to'xtaydi
      expect(lastStatus).toBe(400);
    }, 30000);

    it("qisqa ism rad etiladi", async () => {
      const res = await publicApi("/api/public/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomTypeId: TYPES.a,
          checkIn: day(150),
          checkOut: day(152),
          adults: 1,
          guest: { fullName: "A", phone: "+998901110011" },
        }),
      });
      expect(res.status).toBe(400);
    });

    it("mavjud bo'lmagan xona turi rad etiladi", async () => {
      const res = await publicApi("/api/public/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomTypeId: "prezident-lyuks",
          checkIn: day(155),
          checkOut: day(157),
          adults: 1,
          guest: { fullName: "Yoq Tur", phone: "+998901110012" },
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  // --- OVERBOOKING (TZ 3-band) -------------------------------
  describe("OVERBOOKING BO'LMASLIGI SHART (TZ 3-band)", () => {
    it("parallel bronlar xonalar sonidan oshmaydi", async () => {
      await setPrices(day(160), day(162));

      // Deluxe'da 2 ta xona — 6 ta parallel so'rov yuboramiz
      const requests = Array.from({ length: 6 }, (_, i) =>
        publicApi("/api/public/reservations", {
          method: "POST",
          body: JSON.stringify({
            roomTypeId: TYPES.c,
            checkIn: day(160),
            checkOut: day(162),
            adults: 1,
            // Har biri boshqa raqam — spam himoyasi aralashmasin
            guest: { fullName: `Parallel ${i}`, phone: `+99890222000${i}` },
          }),
        })
      );

      const results = await Promise.all(requests);
      const ok = results.filter((r) => r.status === 201);

      // Ko'pi bilan 2 ta — xonalar soni
      expect(ok.length).toBeLessThanOrEqual(TOTAL.c);
      expect(ok.length).toBeGreaterThan(0);

      // DB darajasida ham tekshiramiz: oraliqda kesishuvchi
      // deluxe bronlari xonalar sonidan oshmasligi kerak
      const active = await prisma.reservation.count({
        where: {
          room: { roomTypeId: TYPES.c },
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
          checkIn: { lt: fromDateKey(day(162)) },
          checkOut: { gt: fromDateKey(day(160)) },
        },
      });
      expect(active).toBeLessThanOrEqual(TOTAL.c);
    }, 30000);

    it("bo'sh xona qolmasa tushunarli xato beriladi", async () => {
      await setPrices(day(165), day(167));

      // Deluxe'ni to'ldiramiz
      const rooms = await prisma.room.findMany({
        where: { roomTypeId: TYPES.c, isActive: true },
      });
      const ids: string[] = [];
      for (const r of rooms) {
        const res = await api("/api/reservations", {
          method: "POST",
          body: JSON.stringify({
            roomId: r.id,
            checkIn: day(165),
            checkOut: day(167),
            guestName: `Band ${r.number}`,
            // Xona raqamiga bog'langan — izoh yuqoridagi
            // "Toliq" halqasida
            phone: `+9989221${r.number}`,
            adults: 1,
            pricePerNight: await tariffFor(r.id),
          }),
        });
        if (res.status === 201) ids.push(res.body.id);
      }

      const res = await publicApi("/api/public/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomTypeId: TYPES.c,
          checkIn: day(165),
          checkOut: day(167),
          adults: 1,
          guest: { fullName: "Kech Qolgan", phone: "+998901110013" },
        }),
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/bo'sh xona/i);

      await prisma.reservation.deleteMany({ where: { id: { in: ids } } });
    }, 30000);
  });
});
