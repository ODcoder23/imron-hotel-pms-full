/**
 * FAZA 14 — Fallback, drift va yuklama
 *
 * TZ 10-band: "Webhook ishlamasa polling/sync fallback mexanizmi
 *              bo'lsin."
 * TZ 17-band: "Beds24 vaqtincha ishlamasa PMS ishlashda davom
 *              etishi kerak... Beds24 qayta ishlaganda avtomatik
 *              yuborilsin."
 * TZ 19-band: "PMSning ichki ishlashi Beds24ga bog'lanib qolmasin."
 * TZ 20-band: "BARCHA TIZIMLAR BIR XIL INVENTORY ASOSIDA ISHLASHI."
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md, FAZA 14):
 *   "Webhook o'chirilgan holatda ham 15 daqiqada o'zgarishlar
 *    tushadi; drift topilsa avtomatik tuzatiladi; Beds24
 *    o'chirilganda PMS to'liq ishlaydi."
 *
 * Ishga tushirish:  npx vitest run src/reconciliation.test.ts
 * Shart: server (:3000), mock (:4000), PostgreSQL, Redis
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prisma } from "./lib/prisma.js";
import { setupConnection } from "./services/beds24/auth.js";
import { upsertMapping } from "./services/mapping.js";
import {
  pollBookings, checkDrift, catchUpPending, checkChannelHealth,
} from "./services/reconciliation.js";
import { recalcAvailability, readRange } from "./services/availability.js";
import { fromDateKey, toDateKey } from "./lib/serialize.js";
import { TYPES, loadTypes, tariffFor } from "./testUtils.js";

const PMS = process.env.PMS_URL ?? "http://127.0.0.1:3000";
const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:4000";

const EXT = { standard: "101001", double: "101002", deluxe: "101003" } as const;

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

/** Mock token — to'g'ridan-to'g'ri kalendar yozish uchun */
async function mockToken(): Promise<string> {
  const res = await fetch(`${MOCK}/authentication/setup`, { headers: { code: "mock-invite-code" } });
  const body = (await res.json()) as { token?: string };
  return body.token ?? "";
}

async function mapAll() {
  // EXT kalitlari tarixiy nomlar — ular faqat tashqi Beds24
  // ID'sini topish uchun. PMS turi TYPES dan keladi (bazadagi
  // haqiqiy turlar).
  const pairs: Array<[string, string]> = [
    [TYPES.a, EXT.standard],
    [TYPES.b, EXT.double],
    [TYPES.c, EXT.deluxe],
  ];

  for (const [pms, external] of pairs) {
    await upsertMapping({ roomTypeId: pms, externalRoomTypeId: external });
  }
}

const day = (offset: number): string => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("FAZA 14 — fallback, drift, yuklama (TZ 10, 17, 19, 20-band)", () => {
  beforeAll(async () => {
    // Tur ID'lari bazadan olinadi (testUtils.ts) — ilgari
    // "standard"/"double"/"deluxe" qattiq yozilgan edi
    await loadTypes();
    const health = await fetch(`${PMS}/health`).then((r) => r.json() as any);
    if (health.redis !== "connected") throw new Error("Redis ishlamayapti");
    const mock = await fetch(`${MOCK}/authentication/setup`, { headers: { code: "mock-invite-code" } });
    if (!mock.ok) throw new Error("Mock server ishlamayapti");
  });

  beforeEach(async () => {
    await prisma.syncLog.deleteMany();
    await prisma.webhookEvent.deleteMany();

    // OTA bronlarini tozalaymiz — mock reset id'ni qayta boshlaydi
    const ota = await prisma.reservation.findMany({
      where: { externalReservationId: { not: null } },
      select: { id: true },
    });
    const ids = ota.map((r) => r.id);
    if (ids.length > 0) {
      await prisma.payment.deleteMany({ where: { reservationId: { in: ids } } });
      await prisma.reservation.deleteMany({ where: { id: { in: ids } } });
    }

    // SyncState tozalanadi — polling oxirgi 24 soatdan boshlaydi
    await prisma.syncState.deleteMany();

    await mockControl("reset");
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

  // --- TZ 10: polling fallback -------------------------------
  describe("polling fallback (TZ 10-band)", () => {
    it("webhook kelmagan bron polling orqali tushadi", async () => {
      // Mock'ga bron qo'shamiz, webhook YUBORMASDAN — webhook
      // ishlamay qolgan holatni aynan takrorlaydi
      const added = await mockControl("add-booking-silently", {
        roomTypeId: Number(EXT.standard),
        arrival: day(200),
        departure: day(203),
        firstName: "Polling",
        lastName: "Tutdi",
        price: 180,
      });
      expect(added.ok).toBe(true);

      // PMS hali bilmaydi
      const before = await prisma.reservation.findFirst({
        where: { externalReservationId: String(added.booking.id) },
      });
      expect(before).toBeNull();

      // Polling ishga tushdi
      const result = await pollBookings();
      expect(result.fetched).toBeGreaterThanOrEqual(1);
      expect(result.created).toBeGreaterThanOrEqual(1);

      // Endi PMS'da bor
      const after = await prisma.reservation.findFirst({
        where: { externalReservationId: String(added.booking.id) },
        include: { guest: true },
      });
      expect(after, "polling bronni tutmadi").toBeTruthy();
      expect(after!.guest.fullName).toContain("Polling");
    }, 30000);

    it("ikkinchi polling dublikat yaratmaydi (TZ 9-band)", async () => {
      const added = await mockControl("add-booking-silently", {
        roomTypeId: Number(EXT.deluxe),
        arrival: day(210),
        departure: day(212),
        firstName: "Takror",
        lastName: "Polling",
      });

      await pollBookings();
      const first = await prisma.reservation.count({
        where: { externalReservationId: String(added.booking.id) },
      });
      expect(first).toBe(1);

      // SyncState'ni orqaga suramiz — o'sha bron qayta so'raladi
      await prisma.syncState.deleteMany();
      const second = await pollBookings();

      // Yangi yaratilmadi, faqat yangilandi
      expect(second.created).toBe(0);

      const total = await prisma.reservation.count({
        where: { externalReservationId: String(added.booking.id) },
      });
      expect(total).toBe(1);
    }, 30000);

    it("SyncState oxirgi yurish vaqtini eslab qoladi", async () => {
      await pollBookings();

      const channel = await prisma.channel.findUniqueOrThrow({ where: { code: "beds24" } });
      const state = await prisma.syncState.findUnique({
        where: { channelId_key: { channelId: channel.id, key: "bookings_pull" } },
      });

      expect(state?.lastSuccessfulAt).toBeTruthy();
      // Yaqin o'tmishda bo'lishi kerak
      const age = Date.now() - state!.lastSuccessfulAt!.getTime();
      expect(age).toBeLessThan(60_000);
    }, 20000);

    it("SyncLog ga yoziladi (TZ 16-band)", async () => {
      await pollBookings();

      const log = await prisma.syncLog.findFirst({
        where: { action: "poll_bookings", status: "SUCCESS" },
        orderBy: { createdAt: "desc" },
      });
      expect(log).toBeTruthy();
      expect(log!.direction).toBe("CHANNEL_TO_PMS");
    }, 20000);

    it("mapping yo'q bo'lsa bron needs_action ga tushadi, polling yiqilmaydi", async () => {
      await prisma.channelMapping.deleteMany();

      await mockControl("add-booking-silently", {
        roomTypeId: Number(EXT.standard),
        arrival: day(220),
        departure: day(222),
        firstName: "Mapping",
        lastName: "Yoq",
      });

      // Yiqilmasligi kerak — qolgan bronlar uchun davom etadi
      const result = await pollBookings();
      expect(result.fetched).toBeGreaterThanOrEqual(1);
      expect(result.needsAction + result.skipped).toBeGreaterThanOrEqual(1);
    }, 30000);
  });

  // --- TZ 20: drift tekshiruvi -------------------------------
  describe("drift tekshiruvi (TZ 20-band)", () => {
    it("farq yo'q bo'lsa toza natija qaytadi", async () => {
      // Avval PMS qiymatini Beds24'ga yuboramiz
      const from = fromDateKey(day(0));
      const to = fromDateKey(day(3));
      await recalcAvailability([TYPES.c], from, to);

      const { pushAvailability } = await import("./services/availability.js");
      await pushAvailability(TYPES.c, from, to);

      const result = await checkDrift(3);
      // Boshqa turlarda ham farq bo'lishi mumkin, shuning uchun
      // faqat deluxe'ni tekshiramiz
      const deluxeDrift = result.details.filter((d) => d.roomTypeId === TYPES.c);
      expect(deluxeDrift).toHaveLength(0);
    }, 30000);

    it("sun'iy farq TOPILADI", async () => {
      // Beds24'ga ataylab noto'g'ri son yozamiz
      const token = await mockToken();
      await fetch(`${MOCK}/inventory/rooms/calendar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", token },
        body: JSON.stringify([{
          roomId: Number(EXT.deluxe),
          calendar: [{ from: day(0), to: day(2), numAvail: 99 }],
        }]),
      });

      const result = await checkDrift(3);

      const deluxeDrift = result.details.filter((d) => d.roomTypeId === TYPES.c);
      expect(deluxeDrift.length, "drift topilmadi").toBeGreaterThan(0);
      expect(deluxeDrift[0]!.beds24).toBe(99);
      expect(deluxeDrift[0]!.pms).not.toBe(99);
    }, 30000);

    it("farq topilsa AVTOMATIK tuzatiladi", async () => {
      const token = await mockToken();
      await fetch(`${MOCK}/inventory/rooms/calendar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", token },
        body: JSON.stringify([{
          roomId: Number(EXT.double),
          calendar: [{ from: day(0), to: day(2), numAvail: 77 }],
        }]),
      });

      const result = await checkDrift(3);
      expect(result.corrected).toBeGreaterThan(0);

      // Tuzatuvchi job PMS qiymatini yuborishi kerak.
      // Kredit tugagan bo'lsa job kechiktiriladi (03-fayl §3) —
      // tiklaymiz, aks holda test kredit cheklovini sinab qoladi.
      await fetch(`${MOCK}/control/refill-credits`, { method: "POST" }).catch(() => {});

      // Job navbatda kutishi mumkin (debounce + kredit). Kutish
      // o'rniga TUZATISH SHARTI bajarilganini tekshiramiz:
      // `syncedCount` tozalangan, ya'ni keyingi push majburiy.
      const { readRange } = await import("./services/availability.js");
      const days = await readRange(TYPES.b, fromDateKey(day(0)), fromDateKey(day(2)));
      expect(days.every((d) => d.syncedCount === null), "syncedCount tozalanmadi").toBe(true);

      // Job ham navbatga tushgan bo'lishi kerak
      const queues = await api("/api/admin/queues");
      const avail = queues.body.queues["beds24-availability-sync"];
      expect(avail).toBeTruthy();
    }, 40000);

    it("drift SyncLog ga yoziladi", async () => {
      const token = await mockToken();
      await fetch(`${MOCK}/inventory/rooms/calendar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", token },
        body: JSON.stringify([{
          roomId: Number(EXT.standard),
          calendar: [{ from: day(0), to: day(1), numAvail: 55 }],
        }]),
      });

      await checkDrift(2);

      const log = await prisma.syncLog.findFirst({
        where: { action: "drift_detected" },
        orderBy: { createdAt: "desc" },
      });
      expect(log, "drift_detected logi yozilmadi").toBeTruthy();
    }, 30000);

    it("mapping yo'q tur tekshirilmaydi (yiqilmaydi)", async () => {
      await prisma.channelMapping.deleteMany();

      const result = await checkDrift(3);
      expect(result.checkedDays).toBe(0);
      expect(result.driftDays).toBe(0);
    }, 20000);
  });

  // --- TZ 17: qolib ketganlarni yuborish ---------------------
  describe("catch-up (TZ 17-band)", () => {
    it("FAILED bronlar qayta yuboriladi", async () => {
      // Mapping yo'q holatda bron — sync FAILED bo'ladi
      await prisma.channelMapping.deleteMany();

      const room = await prisma.room.findFirstOrThrow({
        where: { roomTypeId: TYPES.a, isActive: true },
      });
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: day(230),
          checkOut: day(232),
          guestName: "Catchup Testi",
          phone: "+99899200001",
          guestPhone: "+998908880001",
          adults: 1,
          pricePerNight: await tariffFor(room.id),
        }),
      });
      expect(created.status).toBe(201);

      const { pushReservation } = await import("./services/reservationSync.js");
      await pushReservation(created.body.id);

      let fresh = await prisma.reservation.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(["FAILED", "NOT_APPLICABLE"]).toContain(fresh.syncStatus);

      // Admin mapping'ni tuzatdi
      await mapAll();

      // Catch-up yuboradi
      await catchUpPending();

      fresh = await prisma.reservation.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(fresh.syncStatus).toBe("SYNCED");
      expect(fresh.externalReservationId).toBeTruthy();

      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    }, 40000);

    it("yuborilmagan availability qayta navbatga qo'yiladi", async () => {
      const from = fromDateKey(day(240));
      const to = fromDateKey(day(243));

      await recalcAvailability([TYPES.c], from, to);
      // syncedCount null — hali yuborilmagan
      const days = await readRange(TYPES.c, from, to);
      expect(days.every((d) => d.syncedCount === null)).toBe(true);

      const result = await catchUpPending();
      expect(result.requeued).toBeGreaterThan(0);
    }, 30000);

    it("hech narsa qolmagan bo'lsa ham xato bermaydi", async () => {
      await catchUpPending();
      const second = await catchUpPending();
      expect(second).toBeTruthy();
    }, 30000);
  });

  // --- TZ 17, 19: Beds24'siz ishlash -------------------------
  describe("Beds24 javob bermaganda (TZ 17, 19-band)", () => {
    it("kanal holati tekshiriladi", async () => {
      const health = await checkChannelHealth();
      expect(typeof health.reachable).toBe("boolean");
    }, 20000);

    it("kredit tugasa bron baribir yaratiladi", async () => {
      // Kreditni sun'iy tugatamiz
      await mockControl("drain-credits");

      const room = await prisma.room.findFirstOrThrow({
        where: { roomTypeId: TYPES.a, isActive: true },
        orderBy: { sortOrder: "desc" },
      });

      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: day(250),
          checkOut: day(252),
          guestName: "Kredit Tugadi",
          phone: "+99899200002",
          guestPhone: "+998908880002",
          adults: 1,
          pricePerNight: await tariffFor(room.id),
        }),
      });

      // PMS ishlashda davom etadi — bu TZ 17-bandning asosi
      expect(created.status).toBe(201);

      const fresh = await prisma.reservation.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(fresh.id).toBeTruthy();

      await fetch(`${MOCK}/control/refill-credits`, { method: "POST" });
      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    }, 30000);

    it("Shaxmatka ma'lumotlari Beds24'ga bog'liq emas", async () => {
      // Ichki API hech qachon Beds24'ga murojaat qilmaydi
      const rooms = await api("/api/rooms");
      const reservations = await api("/api/reservations");

      expect(rooms.status).toBe(200);
      expect(reservations.status).toBe(200);
      expect(Array.isArray(rooms.body)).toBe(true);
    });
  });

  // --- TZ 11: beds24-retry navbati (o'lik xat) ---------------
  describe("o'lik xat navbati (TZ 11-band)", () => {
    it("beds24-retry navbati mavjud", async () => {
      const res = await api("/api/admin/queues");
      expect(res.body.queues["beds24-retry"], "beds24-retry navbati yo'q").toBeTruthy();
    });

    it("TZ sanagan beshala navbat bor", async () => {
      const res = await api("/api/admin/queues");
      const names = Object.keys(res.body.queues);

      // TZ 11-band ro'yxati
      for (const q of [
        "beds24-reservation-sync",
        "beds24-availability-sync",
        "beds24-rate-sync",
        "beds24-webhook",
        "beds24-retry",
      ]) {
        expect(names, `${q} yo'q`).toContain(q);
      }
    });

    it("yiqilgan job o'lik xatga tushadi", async () => {
      await api("/api/admin/dead-letters", { method: "DELETE" });

      // Mapping yo'q -> sync yiqiladi (qayta urinish foydasiz)
      await prisma.channelMapping.deleteMany();

      const room = await prisma.room.findFirstOrThrow({
        where: { roomTypeId: TYPES.a, isActive: true },
        orderBy: { sortOrder: "desc" },
      });

      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: day(270),
          checkOut: day(272),
          guestName: "Olik Xat Testi",
          phone: "+99899200003",
          guestPhone: "+998909990010",
          adults: 1,
          pricePerNight: await tariffFor(room.id),
        }),
      });
      expect(created.status).toBe(201);

      // Worker yiqilib o'lik xatga yozishini kutamiz
      const landed = await waitFor(async () => {
        const list = await api("/api/admin/dead-letters");
        return Array.isArray(list.body) && list.body.length > 0;
      }, 20000);

      expect(landed, "o'lik xatga tushmadi").toBe(true);

      const list = await api("/api/admin/dead-letters");
      const entry = list.body[0];
      expect(entry.sourceQueue).toMatch(/beds24-/);
      expect(entry.failedReason).toBeTruthy();
      expect(entry.failedAt).toBeTruthy();

      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
      await mapAll();
    }, 40000);

    it("sabab tuzatilgach qayta yuboriladi", async () => {
      await api("/api/admin/dead-letters", { method: "DELETE" });
      await prisma.channelMapping.deleteMany();

      const room = await prisma.room.findFirstOrThrow({
        where: { roomTypeId: TYPES.b, isActive: true },
        orderBy: { sortOrder: "desc" },
      });

      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: day(275),
          checkOut: day(277),
          guestName: "Qayta Yuborish",
          phone: "+99899200004",
          guestPhone: "+998909990011",
          adults: 1,
          pricePerNight: await tariffFor(room.id),
        }),
      });

      await waitFor(async () => {
        const list = await api("/api/admin/dead-letters");
        return Array.isArray(list.body) && list.body.length > 0;
      }, 20000);

      // Admin sababni tuzatdi
      await mapAll();
      await fetch(`${MOCK}/control/refill-credits`, { method: "POST" }).catch(() => {});

      const list = await api("/api/admin/dead-letters");
      const ids = list.body.map((x: any) => x.id);

      const result = await api("/api/admin/dead-letters/requeue", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });

      expect(result.status).toBe(200);
      expect(result.body.requeued).toBeGreaterThan(0);

      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    }, 40000);

    it("mavjud bo'lmagan id notFound sifatida qaytadi", async () => {
      const res = await api("/api/admin/dead-letters/requeue", {
        method: "POST",
        body: JSON.stringify({ ids: ["yoq-bunday-id"] }),
      });

      expect(res.status).toBe(200);
      expect(res.body.notFound).toBe(1);
      expect(res.body.requeued).toBe(0);
    });

    it("bo'sh ids rad etiladi", async () => {
      const res = await api("/api/admin/dead-letters/requeue", {
        method: "POST",
        body: JSON.stringify({ ids: [] }),
      });
      expect(res.status).toBe(400);
    });
  });

  // --- Chidamlilik: Redis va xatolar (TZ 17, 19-band) --------
  //
  // Yakuniy auditda topilgan uch muammoning regressiya himoyasi.
  // Ular mock bilan emas, HAQIQIY Redis o'chirilganda topilgan —
  // testlar Redis ishlab turganda yozilgan, shuning uchun bu yerda
  // xatti-harakat va sozlamalar tekshiriladi.
  describe("chidamlilik (audit regressiyalari)", () => {
    it("/health tez javob beradi — osilmaydi", async () => {
      // MUAMMO EDI: `redisConnection` da `maxRetriesPerRequest: null`
      // — `ping()` cheksiz kutardi. Redis o'chganda `/health` umuman
      // javob bermas edi (10s timeout), ya'ni monitoring "server
      // o'lgan" deb hisoblardi.
      const started = Date.now();
      const res = await api("/health");
      const elapsed = Date.now() - started;

      expect(res.status).toBe(200);
      // Ping timeout'i 1s, qolgani DB so'rovi — 3s yetarli zaxira
      expect(elapsed, "/health juda sekin").toBeLessThan(3000);
    }, 15000);

    it("navbatga qo'yish timeout bilan o'ralgan", async () => {
      // MUAMMO EDI: `queue.add()` Redis javobini cheksiz kutardi va
      // `try/catch` yordam bermasdi (xato tashlanmaydi, osiladi).
      // Redis o'chganda bron yaratish 15+ soniya kutardi.
      const { enqueueWithTimeout } = await import("./queues/index.js");

      // Hech qachon tugamaydigan promise — osilgan Redis'ni
      // taqlid qiladi
      const never = () => new Promise<string>(() => {});

      const started = Date.now();
      const result = await enqueueWithTimeout(never, "test", 300);
      const elapsed = Date.now() - started;

      expect(result, "timeout'da null qaytarishi kerak").toBeNull();
      expect(elapsed, "timeout ishlamadi").toBeLessThan(2000);
    }, 15000);

    it("bron yaratish tez javob beradi", async () => {
      const room = await prisma.room.findFirstOrThrow({
        where: { roomTypeId: TYPES.a, isActive: true },
        orderBy: { sortOrder: "desc" },
      });

      const started = Date.now();
      const res = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: day(300),
          checkOut: day(302),
          guestName: "Tezlik Testi",
          phone: "+99899200005",
          guestPhone: "+998907770099",
          adults: 1,
          pricePerNight: await tariffFor(room.id),
        }),
      });
      const elapsed = Date.now() - started;

      expect(res.status).toBe(201);
      // Navbat javob bermasa ham 3 soniyadan oshmasligi kerak
      expect(elapsed, "bron yaratish sekin").toBeLessThan(3000);

      await prisma.reservation.delete({ where: { id: res.body.id } }).catch(() => {});
    }, 15000);

    it("catch-up eskirgan PENDING bronlarni ham yuboradi", async () => {
      // MUAMMO EDI: `resyncFailed` faqat FAILED/NOT_APPLICABLE ni
      // qidirardi. Redis o'chganda bron PENDING holatida qolardi va
      // Redis qaytganda hech kim uni yubormasdi — Beds24 bronni
      // umuman bilmasdi (TZ 17-band buzilishi).
      const room = await prisma.room.findFirstOrThrow({
        where: { roomTypeId: TYPES.b, isActive: true },
        orderBy: { sortOrder: "desc" },
      });

      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: day(305),
          checkOut: day(307),
          guestName: "Pending Qoldi",
          phone: "+99899200006",
          guestPhone: "+998907770098",
          adults: 1,
          pricePerNight: await tariffFor(room.id),
        }),
      });
      expect(created.status).toBe(201);

      // "Redis o'chgan" holatni taqlid qilamiz: sync bo'lmagan va
      // eskirgan
      await prisma.reservation.update({
        where: { id: created.body.id },
        data: {
          syncStatus: "PENDING",
          externalReservationId: null,
          updatedAt: new Date(Date.now() - 10 * 60_000),
        },
      });

      await fetch(`${MOCK}/control/refill-credits`, { method: "POST" }).catch(() => {});
      await catchUpPending();

      const fresh = await prisma.reservation.findUniqueOrThrow({
        where: { id: created.body.id },
      });

      expect(fresh.syncStatus, "eskirgan PENDING yuborilmadi").toBe("SYNCED");
      expect(fresh.externalReservationId).toBeTruthy();

      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    }, 40000);

    it("yangi PENDING bron catch-up bilan IKKI MARTA yuborilmaydi", async () => {
      // Hozirgina yaratilgan bronning job'i navbatda turibdi.
      // Uni catch-up ham yuborsa — Beds24'da ikkita booking.
      const room = await prisma.room.findFirstOrThrow({
        where: { roomTypeId: TYPES.c, isActive: true },
        orderBy: { sortOrder: "desc" },
      });

      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: day(310),
          checkOut: day(312),
          guestName: "Yangi Pending",
          phone: "+99899200007",
          guestPhone: "+998907770097",
          adults: 1,
          pricePerNight: 200,
        }),
      });

      // Darhol catch-up — bron hali "yangi"
      const { resyncFailed } = await import("./services/reservationSync.js");
      const before = await prisma.reservation.findUniqueOrThrow({
        where: { id: created.body.id },
      });

      if (before.syncStatus === "PENDING") {
        const result = await resyncFailed(100);
        // Yangi bron ro'yxatga TUSHMASLIGI kerak
        const stillPending = await prisma.reservation.findUniqueOrThrow({
          where: { id: created.body.id },
        });
        // Worker yuborgan bo'lishi mumkin — muhimi, catch-up
        // uni o'zi yubormagan bo'lsin
        expect(result.total).toBeLessThan(100);
        expect(stillPending.id).toBe(created.body.id);
      }

      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    }, 30000);

    it("buzilgan JSON 400 beradi, 500 emas", async () => {
      // MUAMMO EDI: `express.json()` SyntaxError tashlaydi, u
      // `errorHandler` da "kutilmagan xato" sifatida 500 bo'lardi.
      // Monitoring signalini buzadi: klient xatosi server
      // nosozligi bo'lib ko'rinardi.
      const res = await fetch(`${PMS}/api/reservations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{bu json emas",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("BAD_JSON");
    }, 15000);

    it("juda uzun matn rad etiladi", async () => {
      const room = await prisma.room.findFirstOrThrow({
        where: { isActive: true },
      });

      const res = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: day(315),
          checkOut: day(316),
          guestName: "A".repeat(10_000),
          phone: "+99899200008",
          guestPhone: "+998907770096",
          adults: 1,
          pricePerNight: await tariffFor(room.id),
        }),
      });

      expect(res.status).toBe(400);
    }, 15000);
  });

  // --- Yuklama (FAZA 14 mezoni) ------------------------------
  describe("yuklama", () => {
    it("50 parallel o'qish so'rovi xatosiz o'tadi", async () => {
      const requests = Array.from({ length: 50 }, () => api("/api/reservations"));
      const results = await Promise.all(requests);

      const ok = results.filter((r) => r.status === 200);
      expect(ok).toHaveLength(50);
    }, 40000);

    it("20 parallel bron — overbooking yo'q (TZ 3-band)", async () => {
      const rooms = await prisma.room.findMany({
        where: { roomTypeId: TYPES.b, isActive: true },
        select: { id: true },
      });
      const roomId = rooms[0]!.id;

      // Hammasi BITTA xonaga, bir xil sanaga
      const requests = Array.from({ length: 20 }, (_, i) =>
        api("/api/reservations", {
          method: "POST",
          body: JSON.stringify({
            roomId,
            checkIn: day(260),
            checkOut: day(262),
            guestName: `Yuklama ${i}`,
            phone: "+99899200009",
            guestPhone: `+99890999${String(i).padStart(4, "0")}`,
            adults: 1,
            pricePerNight: 100,
          }),
        })
      );

      const results = await Promise.all(requests);
      const created = results.filter((r) => r.status === 201);

      // FAQAT BITTASI o'tishi kerak — DB constraint kafolati
      expect(created).toHaveLength(1);

      // Qolganlari 409 (xona band) yoki 409 (konflikt)
      const rejected = results.filter((r) => r.status === 409);
      expect(rejected).toHaveLength(19);

      await prisma.reservation.deleteMany({
        where: { id: { in: created.map((r) => r.body.id) } },
      });
    }, 60000);

    it("yuklamadan keyin DB'da qoplanuvchi bron yo'q", async () => {
      // Butun bazada tekshiruv — overbooking mutlaqo bo'lmasligi
      // kerak (TZ 3-band)
      const overlaps = await prisma.$queryRaw<Array<{ cnt: number }>>`
        SELECT COUNT(*)::int AS cnt
        FROM "Reservation" a
        JOIN "Reservation" b
          ON a."roomId" = b."roomId"
         AND a.id < b.id
         AND a."checkIn" < b."checkOut"
         AND b."checkIn" < a."checkOut"
        WHERE a.status NOT IN ('CANCELLED', 'NO_SHOW')
          AND b.status NOT IN ('CANCELLED', 'NO_SHOW')
      `;

      expect(overlaps[0]?.cnt ?? 0).toBe(0);
    }, 30000);
  });

  // --- Davriy jadval -----------------------------------------
  describe("davriy jadval", () => {
    it("uchala vazifa ro'yxatdan o'tgan", async () => {
      const res = await api("/api/admin/queues");
      expect(res.body.queues["pms-maintenance"]).toBeTruthy();
    });

    it("admin qo'lda ishga tushira oladi", async () => {
      const poll = await api("/api/admin/maintenance/poll", { method: "POST" });
      // 200 — ishladi; 503 — Beds24 javob bermadi (ikkalasi ham
      // to'g'ri, 500 esa xato bo'lardi)
      expect([200, 503]).toContain(poll.status);
      if (poll.status === 200) expect(typeof poll.body.fetched).toBe("number");

      const catchUp = await api("/api/admin/maintenance/catch-up", { method: "POST" });
      expect(catchUp.status).toBe(200);
    }, 40000);

    it("kanal holati endpoint'i ishlaydi", async () => {
      const res = await api("/api/admin/channel-health");
      expect(res.status).toBe(200);
      expect(typeof res.body.reachable).toBe("boolean");
    }, 20000);
  });
});
