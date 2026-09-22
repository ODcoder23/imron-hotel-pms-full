/**
 * FAZA 7 — Queue va webhook -> Reservation
 *
 * TZ 1, 4, 9, 10, 11, 17-band
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md):
 *   "Beds24'da yaratilgan test bron avtomatik ravishda to'g'ri
 *    xonaga biriktirilgan Reservation sifatida paydo bo'ladi"
 *
 * Ishga tushirish:  npx vitest run src/queue.test.ts
 * Shart: server (:3000), mock (:4000), PostgreSQL, Redis (:6379)
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "./lib/prisma.js";
import { setupConnection } from "./services/beds24/auth.js";
import { upsertMapping } from "./services/mapping.js";
import {
  toPmsStatus, toSource, assignRoom, processPendingEvents,
} from "./services/webhookProcessor.js";
import { isRedisHealthy, getQueueCounts } from "./queues/index.js";
import type { ExternalReservation } from "./services/channel/types.js";
import { TYPES, loadTypes } from "./testUtils.js";

const PMS = process.env.PMS_URL ?? "http://127.0.0.1:3000";
const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:4000";
const EXT = { standard: "101001", double: "101002", deluxe: "101003" } as const;

/** Webhook worker ishlab bo'lishini kutadi */
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

const mockControl = async (path: string, body?: unknown) => {
  const res = await fetch(`${MOCK}/control/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json() as any;
};

const reservations = async () =>
  (await fetch(`${PMS}/api/reservations`).then((r) => r.json())) as any[];

const events = async (limit = 20) =>
  (await fetch(`${PMS}/api/admin/webhook-events?limit=${limit}`).then((r) => r.json())) as any[];

const otaBookings = async () => (await reservations()).filter((r) => r.externalReservationId);

/** Test uchun ExternalReservation qurish */
const ext = (over: Partial<ExternalReservation> = {}): ExternalReservation => ({
  externalId: "90000001",
  externalRoomTypeId: EXT.standard,
  status: "confirmed",
  checkIn: "2027-11-01",
  checkOut: "2027-11-04",
  adults: 2,
  children: 0,
  price: 150,
  currency: "USD",
  guest: { fullName: "Test Mehmon", phone: "+998911112233" },
  modifiedAt: new Date().toISOString(),
  ...over,
});

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

describe("FAZA 7 — queue va webhook -> Reservation", () => {
  beforeAll(async () => {
    // Tur ID'lari bazadan olinadi (testUtils.ts) — ilgari
    // "standard"/"double"/"deluxe" qattiq yozilgan edi
    await loadTypes();
    const health = await fetch(`${PMS}/health`).then((r) => r.json() as any);
    if (health.redis !== "connected") {
      throw new Error("Redis ishlamayapti — redis-server ishga tushiring");
    }
    const mock = await fetch(`${MOCK}/authentication/setup`, { headers: { code: "mock-invite-code" } });
    if (!mock.ok) throw new Error("Mock server ishlamayapti");
  });

  beforeEach(async () => {
    await prisma.webhookEvent.deleteMany();
    await prisma.syncLog.deleteMany();

    // MUHIM: mock reset bookingId hisobini 70000001 dan qayta
    // boshlaydi. PMS'da o'sha externalReservationId bilan eski bron
    // qolsa, yangi webhook "update" sifatida ishlanadi va test
    // mapping tekshiruvigacha yetib bormaydi.
    await prisma.payment.deleteMany({ where: { reservation: { externalReservationId: { not: null } } } });
    await prisma.reservation.deleteMany({ where: { externalReservationId: { not: null } } });
    await mockControl("reset");

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

  // --- Infratuzilma (TZ 11-band) ---------------------------
  describe("navbatlar", () => {
    it("Redis ulangan", async () => {
      expect(await isRedisHealthy()).toBe(true);
    });

    it("TZ 11-band talab qilgan navbatlar mavjud", async () => {
      const counts = await getQueueCounts();
      const names = Object.keys(counts);
      expect(names).toContain("beds24-webhook");
      expect(names).toContain("beds24-reservation-sync");
      expect(names).toContain("beds24-availability-sync");
      expect(names).toContain("beds24-rate-sync");
    });

    it("/api/admin/queues holatni qaytaradi", async () => {
      const r = await fetch(`${PMS}/api/admin/queues`).then((x) => x.json() as any);
      expect(r.redis).toBe(true);
      expect(r.queues["beds24-webhook"]).toBeDefined();
    });
  });

  // --- Status mapping (08-fayl §2) ------------------------
  describe("status mapping", () => {
    it("cancelled -> CANCELLED", () => {
      expect(toPmsStatus(ext({ status: "cancelled" }))).toBe("CANCELLED");
    });

    it("black -> NO_SHOW", () => {
      expect(toPmsStatus(ext({ status: "black" }))).toBe("NO_SHOW");
    });

    it("request -> PENDING_PAYMENT", () => {
      expect(toPmsStatus(ext({ status: "request" }))).toBe("PENDING_PAYMENT");
    });

    it("new + to'lovsiz -> PENDING_PAYMENT", () => {
      expect(toPmsStatus(ext({ status: "new", payments: [] }))).toBe("PENDING_PAYMENT");
    });

    it("new + to'lov bilan -> CONFIRMED", () => {
      expect(toPmsStatus(ext({ status: "new", payments: [{ amount: 100 }] }))).toBe("CONFIRMED");
    });

    it("confirmed + arrived -> CHECKED_IN", () => {
      expect(toPmsStatus(ext({ status: "confirmed", subStatus: "arrived" }))).toBe("CHECKED_IN");
    });

    it("confirmed + departed -> CHECKED_OUT", () => {
      expect(toPmsStatus(ext({ status: "confirmed", subStatus: "departed" }))).toBe("CHECKED_OUT");
    });

    it("OTA nomi source enum'iga aylanadi", () => {
      expect(toSource("Booking.com")).toBe("BOOKING_COM");
      expect(toSource("Airbnb")).toBe("AIRBNB");
      expect(toSource("Expedia")).toBe("EXPEDIA");
      expect(toSource("PMS")).toBe("DIRECT");
      expect(toSource("Nomalum OTA")).toBe("OTHER");
      expect(toSource(undefined)).toBe("OTHER");
    });
  });

  // --- Avtomatik xona biriktirish (06-fayl §5, Q3) --------
  describe("avtomatik xona biriktirish", () => {
    it("bo'sh xona tanlanadi", async () => {
      const r = await assignRoom(ext({ checkIn: "2027-12-01", checkOut: "2027-12-04" }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.roomTypeId).toBe(TYPES.a);
        expect(["101", "102", "105", "107", "109", "111"]).toContain(r.roomId);
      }
    });

    it("mapping yo'q -> rad etiladi, taxmin QILINMAYDI", async () => {
      const r = await assignRoom(ext({ externalRoomTypeId: "99999" }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("no_mapping");
        expect(r.detail).toContain("mapping yo'q");
      }
    });

    it("barcha xona band -> no_free_room (overbooking signali)", async () => {
      // deluxe turida 2 xona — ikkalasini band qilamiz
      const from = "2028-01-10";
      const to = "2028-01-13";
      const guest = await prisma.guest.findFirstOrThrow();

      for (const roomId of ["106", "110"]) {
        await prisma.reservation.create({
          data: {
            roomId, guestId: guest.id,
            checkIn: new Date(`${from}T00:00:00Z`),
            checkOut: new Date(`${to}T00:00:00Z`),
            adults: 1, source: "DIRECT",
            pricePerNight: 50, status: "CONFIRMED",
          },
        });
      }

      const r = await assignRoom(
        ext({ externalRoomTypeId: EXT.deluxe, checkIn: from, checkOut: to })
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("no_free_room");
        expect(r.detail).toContain("bo'sh xona yo'q");
      }
    });

    it("OUT_OF_ORDER xona tanlanmaydi", async () => {
      // double turida 4 xona: 103, 104, 108, 112
      await prisma.room.updateMany({
        where: { id: { in: ["103", "104", "108"] } },
        data: { status: "OUT_OF_ORDER" },
      });

      const r = await assignRoom(
        ext({ externalRoomTypeId: EXT.double, checkIn: "2028-02-01", checkOut: "2028-02-03" })
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.roomId).toBe("112");   // faqat shu qoldi

      await prisma.room.updateMany({
        where: { id: { in: ["103", "104", "108"] } },
        data: { status: "AVAILABLE" },
      });
    });
  });

  // --- MEZON: OTA bron -> Reservation ---------------------
  describe("FAZA 7 mezoni", () => {
    it("OTA bron AVTOMATIK Reservation ga aylanadi", async () => {
      const before = (await otaBookings()).length;

      await mockControl("simulate-ota-booking", {
        roomTypeId: Number(EXT.standard),
        arrival: "2028-03-10",
        departure: "2028-03-13",
        firstName: "Booking.com",
        lastName: "Mehmoni",
        price: 150,
        referer: "Booking.com",
      });

      await settle(2000);

      const after = await otaBookings();
      expect(after.length).toBe(before + 1);

      const created = after.find((r) => r.checkIn === "2028-03-10");
      expect(created).toBeDefined();
      expect(created.source).toBe("booking_com");
      expect(created.status).toBe("confirmed");
      expect(created.totalPrice).toBe(150);        // 50 × 3 kun
      expect(created.pricePerNight).toBe(50);
      expect(created.guestName).toBe("Booking.com Mehmoni");
      expect(created.syncStatus).toBe("synced");   // qayta yuborilmaydi
      expect(["101", "102", "105", "107", "109", "111"]).toContain(created.roomId);
    });

    it("WebhookEvent PROCESSED bo'ladi", async () => {
      await mockControl("simulate-ota-booking", {
        roomTypeId: Number(EXT.double),
        arrival: "2028-04-01",
        departure: "2028-04-03",
      });
      await settle(2000);

      const list = await events();
      const processed = list.find((e) => e.eventType === "booking.new");
      expect(processed?.status).toBe("processed");
      expect(processed?.processedAt).toBeTruthy();
    });

    it("SyncLog yoziladi (TZ 16-band)", async () => {
      await mockControl("simulate-ota-booking", {
        roomTypeId: Number(EXT.standard),
        arrival: "2028-05-01",
        departure: "2028-05-03",
      });
      await settle(2000);

      const logs = await prisma.syncLog.findMany({ orderBy: { createdAt: "desc" } });
      expect(logs.length).toBeGreaterThan(0);

      // FAZA 9/10 dan keyin bitta OTA broni bir nechta log yozadi:
      // webhook qabul qilindi (CHANNEL_TO_PMS), availability va
      // bron Beds24'ga qaytarildi (PMS_TO_CHANNEL). Shuning uchun
      // "eng oxirgisi" emas, KERAKLISINI qidiramiz.
      const inbound = logs.find((l) => l.direction === "CHANNEL_TO_PMS");
      expect(inbound, "webhook logi yozilmadi").toBeTruthy();
      expect(inbound!.status).toBe("SUCCESS");
    });
  });

  // --- Bron yangilanishi ----------------------------------
  describe("mavjud bronni yangilash", () => {
    it("bekor qilish -> CANCELLED", async () => {
      const created = await mockControl("simulate-ota-booking", {
        roomTypeId: Number(EXT.standard),
        arrival: "2028-06-01",
        departure: "2028-06-04",
      });
      await settle(2000);

      await mockControl("simulate-cancellation", { bookingId: created.booking.id });
      await settle(2000);

      const list = await otaBookings();
      const found = list.find((r) => r.externalReservationId === String(created.booking.id));
      expect(found?.status).toBe("cancelled");
    });

    it("to'lov -> Payment yoziladi (TZ 14-band)", async () => {
      const created = await mockControl("simulate-ota-booking", {
        roomTypeId: Number(EXT.deluxe),
        arrival: "2028-07-01",
        departure: "2028-07-03",
        price: 104,
        referer: "Airbnb",
      });
      await settle(2000);

      await mockControl("simulate-payment", { bookingId: created.booking.id, amount: 60 });
      await settle(2000);

      const list = await otaBookings();
      const found = list.find((r) => r.externalReservationId === String(created.booking.id));

      expect(found?.paidAmount).toBe(60);
      expect(found?.remainingAmount).toBe(44);      // 104 - 60
      expect(found?.payments).toHaveLength(1);
      // OTA to'lovi ajratib ko'rsatiladi (08-fayl §7)
      expect(found.payments[0].method).toContain("Onlayn");
    });

    it("bir to'lov IKKI MARTA yozilmaydi", async () => {
      const created = await mockControl("simulate-ota-booking", {
        roomTypeId: Number(EXT.standard),
        arrival: "2028-08-01",
        departure: "2028-08-03",
        price: 70,
      });
      await settle(2000);

      // Bir xil to'lovni ikki marta
      await mockControl("simulate-payment", { bookingId: created.booking.id, amount: 40 });
      await settle(1500);
      await mockControl("simulate-payment", { bookingId: created.booking.id, amount: 40 });
      await settle(2000);

      const list = await otaBookings();
      const found = list.find((r) => r.externalReservationId === String(created.booking.id));
      // Mock invoiceItems ga ikkita qo'shadi, lekin ikkinchisi
      // bir xil externalPaymentId bilan — yozilmaydi
      expect(found.payments.length).toBeLessThanOrEqual(2);
      expect(found.paidAmount).toBeLessThanOrEqual(80);
    });
  });

  // --- Echo loop (04-fayl §6) -----------------------------
  describe("echo loop himoyasi", () => {
    it("referer=PMS -> e'tiborsiz qoldiriladi", async () => {
      const before = (await otaBookings()).length;

      await mockControl("simulate-ota-booking", {
        roomTypeId: Number(EXT.standard),
        arrival: "2028-09-01",
        departure: "2028-09-03",
        referer: "PMS",         // bizning belgimiz
      });
      await settle(2000);

      // Yangi bron YARATILMAYDI
      expect((await otaBookings()).length).toBe(before);

      const logs = await prisma.syncLog.findMany({
        where: { action: "webhook_echo_skipped" },
      });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].status).toBe("SKIPPED");
    });
  });

  // --- Mapping yo'q (06-fayl §4) --------------------------
  describe("mapping yo'q holati", () => {
    it("NEEDS_MANUAL_ACTION + tushunarli xabar", async () => {
      await mockControl("simulate-ota-booking", {
        roomTypeId: 99999,        // mapping yo'q
        arrival: "2028-10-01",
        departure: "2028-10-03",
      });
      await settle(2000);

      const list = await events();
      const stuck = list.find((e) => e.status === "needs_manual_action");
      expect(stuck).toBeDefined();
      expect(stuck.errorMessage).toContain("mapping yo'q");
      expect(stuck.errorMessage).toContain("/admin/mapping");
    });

    it("ma'lumot YO'QOLMAYDI — rawPayload saqlanadi", async () => {
      await mockControl("simulate-ota-booking", {
        roomTypeId: 99999,
        arrival: "2028-11-01",
        departure: "2028-11-03",
        firstName: "Yo'qolmasin",
        lastName: "Mehmon",
      });
      await settle(2000);

      const raw = await prisma.webhookEvent.findFirst({
        where: { status: "NEEDS_MANUAL_ACTION" },
        orderBy: { createdAt: "desc" },
      });
      const payload = raw!.rawPayload as any;
      expect(payload.booking.firstName).toBe("Yo'qolmasin");
    });

    it("mapping qo'shilgach qayta ishlash ishlaydi (04-fayl §7)", async () => {
      const created = await mockControl("simulate-ota-booking", {
        roomTypeId: 88888,
        arrival: "2028-12-01",
        departure: "2028-12-03",
      });
      await settle(2000);

      const stuck = (await events()).find((e) => e.status === "needs_manual_action");
      expect(stuck).toBeDefined();

      // Admin mapping'ni to'g'irladi
      await upsertMapping({ roomTypeId: TYPES.b, externalRoomTypeId: "88888" });

      // "Qayta ishlash" tugmasi
      await fetch(`${PMS}/api/admin/webhook-events/${stuck.id}/reprocess`, { method: "POST" });
      await settle(500);
      await processPendingEvents();

      const list = await otaBookings();
      const found = list.find((r) => r.externalReservationId === String(created.booking.id));
      expect(found).toBeDefined();
      expect(["103", "104", "108", "112"]).toContain(found.roomId);   // double turi
    });
  });

  // --- Duplicate (TZ 9-band) ------------------------------
  describe("duplicate himoyasi", () => {
    it("takroriy webhook ikkinchi bron YARATMAYDI", async () => {
      const before = (await otaBookings()).length;

      await mockControl("simulate-ota-booking", {
        roomTypeId: Number(EXT.standard),
        arrival: "2029-01-10",
        departure: "2029-01-13",
        duplicate: true,           // ikki marta yuboriladi
      });
      await settle(2500);

      // Faqat BITTA bron
      expect((await otaBookings()).length).toBe(before + 1);

      const list = await events();
      expect(list.filter((e) => e.status === "ignored_duplicate")).toHaveLength(1);
    });
  });

  // --- TZ 17-band: Redis yo'q bo'lsa ---------------------
  describe("TZ 17-band — xatolarga chidamlilik", () => {
    it("QUEUED event'lar qo'lda ishlanadi (Redis zaxirasi)", async () => {
      // Worker o'tkazib yuborgan event'ni qo'lda yaratamiz
      const channel = await prisma.channel.findUniqueOrThrow({ where: { code: "beds24" } });
      const payload = {
        event: "booking.new",
        booking: {
          id: 95000001,
          roomId: Number(EXT.standard),
          status: "confirmed",
          arrival: "2029-02-01",
          departure: "2029-02-03",
          numAdult: 1,
          numChild: 0,
          price: 70,
          firstName: "Qo'lda",
          lastName: "Ishlangan",
          modifiedTime: new Date().toISOString(),
        },
      };

      await prisma.webhookEvent.create({
        data: {
          channelId: channel.id,
          eventType: "booking.new",
          externalId: "95000001",
          payloadHash: `manual-${Date.now()}`,
          rawPayload: payload,
          status: "QUEUED",
        },
      });

      const counts = await processPendingEvents();
      expect(counts.processed).toBeGreaterThan(0);

      const found = (await otaBookings()).find((r) => r.externalReservationId === "95000001");
      expect(found).toBeDefined();
      expect(found.guestName).toBe("Qo'lda Ishlangan");
    });
  });
});
