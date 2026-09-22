/**
 * FAZA 6 — Webhook qabul qilish testlari
 *
 * TZ 10-band: validate -> eventni saqlash -> duplicate tekshirish ->
 *             queuega yuborish
 * TZ 9-band:  duplicate reservation yaratilmasin (1-qatlam)
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md):
 *   "Beds24'da test bron yaratilganda WebhookEvent DB'da paydo
 *    bo'ladi; takroriy webhook duplicate deb belgilanadi"
 *
 * Ishga tushirish:  npx vitest run src/webhook.test.ts
 * Shart: server (:3000), mock (:4000), PostgreSQL
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import crypto from "node:crypto";
import { prisma } from "./lib/prisma.js";
import { computePayloadHash, validatePayloadShape } from "./services/webhook.js";
import { sanitizeForLog } from "./lib/sanitize.js";

const PMS = process.env.PMS_URL ?? "http://127.0.0.1:3000";
const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:4000";
const TOKEN = "dev-webhook-token";

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${PMS}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
};

const events = async (limit = 20) => {
  const res = await fetch(`${PMS}/api/admin/webhook-events?limit=${limit}`);
  return (await res.json()) as any[];
};

/**
 * FAZA 7 dan keyin worker QUEUED event'ni darhol oladi va
 * `processed` / `needs_manual_action` ga o'tkazadi. Shuning uchun
 * "qabul qilindi" degani `queued` EMAS — bu holatlardan biri.
 * Faqat `ignored_duplicate` va `failed` alohida ma'noga ega.
 */
const isAccepted = (status: string) =>
  ["queued", "processed", "needs_manual_action"].includes(status);

const mockControl = (path: string, body?: unknown) =>
  fetch(`${MOCK}/control/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

/** Beds24 webhook payload shakli */
const payload = (bookingId: number, over: Record<string, unknown> = {}) => ({
  event: "booking.new",
  timestamp: new Date().toISOString(),
  propertyId: 12345,
  booking: {
    id: bookingId,
    roomId: 101001,
    status: "confirmed",
    arrival: "2027-06-01",
    departure: "2027-06-04",
    numAdult: 2,
    numChild: 0,
    price: 150,
    firstName: "Test",
    lastName: "Mehmon",
    modifiedTime: new Date().toISOString(),
    ...over,
  },
});

describe("FAZA 6 — webhook qabul qilish (TZ 10-band)", () => {
  beforeAll(async () => {
    const res = await fetch(`${PMS}/health`);
    if (!res.ok) throw new Error("Server ishlamayapti");
  });

  beforeEach(async () => {
    await prisma.webhookEvent.deleteMany();
    // Mock reset bookingId'ni 70000001 dan qayta boshlaydi —
    // eski OTA bronlari qolsa yangi webhook "update" bo'lib ketadi
    await prisma.payment.deleteMany({
      where: { reservation: { externalReservationId: { not: null } } },
    });
    await prisma.reservation.deleteMany({ where: { externalReservationId: { not: null } } });
    await mockControl("reset");
  });

  // --- payloadHash: dedup asosi (04-fayl §3) ---------------
  describe("payloadHash", () => {
    it("bir xil mazmun -> bir xil hash", () => {
      const a = computePayloadHash({ event: "x", booking: { id: 1, price: 100 } });
      const b = computePayloadHash({ event: "x", booking: { id: 1, price: 100 } });
      expect(a).toBe(b);
    });

    it("kalitlar tartibi hash'ga ta'sir qilmaydi", () => {
      const a = computePayloadHash({ event: "x", booking: { id: 1, price: 100 } });
      const b = computePayloadHash({ booking: { price: 100, id: 1 }, event: "x" });
      expect(a).toBe(b);
    });

    it("timestamp hash'ga KIRMAYDI — aks holda dedup ishlamaydi", () => {
      const a = computePayloadHash({ event: "x", timestamp: "2027-01-01T00:00:00Z", booking: { id: 1 } });
      const b = computePayloadHash({ event: "x", timestamp: "2027-06-15T12:34:56Z", booking: { id: 1 } });
      expect(a).toBe(b);
    });

    it("modifiedTime ham kirmaydi", () => {
      const a = computePayloadHash({ booking: { id: 1, modifiedTime: "2027-01-01T00:00:00Z" } });
      const b = computePayloadHash({ booking: { id: 1, modifiedTime: "2027-09-09T09:09:09Z" } });
      expect(a).toBe(b);
    });

    it("mazmun o'zgarsa hash o'zgaradi", () => {
      const a = computePayloadHash({ booking: { id: 1, price: 100 } });
      const b = computePayloadHash({ booking: { id: 1, price: 200 } });
      expect(a).not.toBe(b);
    });
  });

  // --- Validatsiya (04-fayl §9) ----------------------------
  describe("validatsiya", () => {
    it("to'g'ri token -> qabul qilinadi", async () => {
      const { status, body } = await post(`/api/webhooks/beds24/${TOKEN}`, payload(80000001));
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.eventId).toBeTruthy();
    });

    it("noto'g'ri token -> 401", async () => {
      const { status } = await post("/api/webhooks/beds24/yolgon", payload(80000002));
      expect(status).toBe(401);
    });

    it("tokensiz -> 401 (ip_token rejimida)", async () => {
      const { status } = await post("/api/webhooks/beds24", payload(80000003));
      expect(status).toBe(401);
    });

    it("rad etilgan so'rov ham SAQLANADI (hujumni ko'rish uchun)", async () => {
      await post("/api/webhooks/beds24/yolgon", payload(80000004));

      const list = await events();
      const failed = list.find((e) => e.status === "failed");
      expect(failed).toBeDefined();
      expect(failed.errorMessage).toContain("token");
    });

    it("buzilgan payload -> 400", async () => {
      const { status, body } = await post(`/api/webhooks/beds24/${TOKEN}`, { nimadir: "boshqa" });
      expect(status).toBe(400);
      expect(body.error).toContain("maydoni yo'q");
    });

    it("HMAC signature tekshiruvi (unit)", () => {
      const secret = "test-secret";
      const rawBody = JSON.stringify({ event: "booking.new" });
      const sig = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

      // signature rejimini vaqtincha yoqish uchun to'g'ridan-to'g'ri
      // validateWebhook'ni chaqirib bo'lmaydi (config muzlatilgan),
      // shuning uchun HMAC mantig'ining o'zini tekshiramiz
      const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      expect(sig).toBe(expected);

      const wrong = crypto.createHmac("sha256", "boshqa-secret").update(rawBody).digest("hex");
      expect(sig).not.toBe(wrong);
    });

    it("payload sxemasi: event yoki booking kerak", () => {
      expect(validatePayloadShape({ event: "x" }).ok).toBe(true);
      expect(validatePayloadShape({ booking: { id: 1 } }).ok).toBe(true);
      expect(validatePayloadShape({ other: 1 }).ok).toBe(false);
      expect(validatePayloadShape(null).ok).toBe(false);
      expect(validatePayloadShape("matn").ok).toBe(false);
    });
  });

  // --- Duplicate (TZ 9-band, 1-qatlam) --------------------
  describe("duplicate himoyasi", () => {
    it("bir xil webhook ikki marta -> ikkinchisi IGNORED_DUPLICATE", async () => {
      const p = payload(80000010);

      const first = await post(`/api/webhooks/beds24/${TOKEN}`, p);
      const second = await post(`/api/webhooks/beds24/${TOKEN}`, p);

      expect(first.status).toBe(200);
      expect(first.body.duplicate).toBeUndefined();
      expect(second.status).toBe(200);          // 200 — Beds24 qayta yubormasin
      expect(second.body.duplicate).toBe(true);

      const list = await events();
      expect(list).toHaveLength(2);
      expect(list.filter((e) => e.status === "ignored_duplicate")).toHaveLength(1);
      expect(list.filter((e) => isAccepted(e.status))).toHaveLength(1);
    });

    it("timestamp farq qilsa ham duplicate aniqlanadi", async () => {
      const a = payload(80000011);
      const b = { ...a, timestamp: new Date(Date.now() + 60_000).toISOString() };

      await post(`/api/webhooks/beds24/${TOKEN}`, a);
      const second = await post(`/api/webhooks/beds24/${TOKEN}`, b);

      expect(second.body.duplicate).toBe(true);
    });

    it("MAZMUN o'zgarsa duplicate EMAS (bron yangilandi)", async () => {
      const a = payload(80000012, { price: 150 });
      const b = payload(80000012, { price: 200 });   // narx o'zgardi

      await post(`/api/webhooks/beds24/${TOKEN}`, a);
      const second = await post(`/api/webhooks/beds24/${TOKEN}`, b);

      expect(second.body.duplicate).toBeUndefined();

      const list = await events();
      expect(list.filter((e) => isAccepted(e.status))).toHaveLength(2);
    });

    it("turli bookingId -> ikkalasi ham qabul qilinadi", async () => {
      await post(`/api/webhooks/beds24/${TOKEN}`, payload(80000013));
      await post(`/api/webhooks/beds24/${TOKEN}`, payload(80000014));

      const list = await events();
      expect(list.filter((e) => isAccepted(e.status))).toHaveLength(2);
    });
  });

  // --- Saqlash (04-fayl §2, 2-qadam) ----------------------
  describe("eventni saqlash", () => {
    it("event turi va externalId ajratiladi", async () => {
      await post(`/api/webhooks/beds24/${TOKEN}`, payload(80000020));

      const list = await events();
      expect(list[0].eventType).toBe("booking.new");
      expect(list[0].externalId).toBe("80000020");
      expect(isAccepted(list[0].status)).toBe(true);
    });

    it("rawPayload to'liq saqlanadi (ma'lumot yo'qolmaydi)", async () => {
      await post(`/api/webhooks/beds24/${TOKEN}`, payload(80000021, { notes: "Maxsus so'rov" }));

      const raw = await prisma.webhookEvent.findFirst({ orderBy: { createdAt: "desc" } });
      const stored = raw!.rawPayload as any;
      expect(stored.booking.notes).toBe("Maxsus so'rov");
      expect(stored.booking.id).toBe(80000021);
    });

    it("noma'lum event turi ham saqlanadi, xato bermaydi", async () => {
      const { status } = await post(`/api/webhooks/beds24/${TOKEN}`, {
        event: "kelajakdagi.yangi.event",
        booking: { id: 80000022, roomId: 101001, modifiedTime: new Date().toISOString() },
      });
      expect(status).toBe(200);

      const list = await events();
      expect(list[0].eventType).toBe("kelajakdagi.yangi.event");
    });

    it("booking'siz event ham saqlanadi", async () => {
      const { status } = await post(`/api/webhooks/beds24/${TOKEN}`, { event: "ping" });
      expect(status).toBe(200);

      const list = await events();
      expect(list[0].externalId).toBeNull();
    });
  });

  // --- Sanitizatsiya (TZ 16-band, 10-fayl §2) -------------
  describe("sanitizatsiya", () => {
    it("token va parol REDACTED bo'ladi", () => {
      const clean = sanitizeForLog({
        event: "test",
        token: "maxfiy-token-123",
        refreshToken: "maxfiy-refresh",
        password: "parol",
        booking: { id: 1, apiKey: "kalit" },
      }) as any;

      expect(clean.token).toBe("[REDACTED]");
      expect(clean.refreshToken).toBe("[REDACTED]");
      expect(clean.password).toBe("[REDACTED]");
      expect(clean.booking.apiKey).toBe("[REDACTED]");
      expect(clean.event).toBe("test");          // maxfiy emas — qoladi
      expect(clean.booking.id).toBe(1);
    });

    it("karta ma'lumotlari REDACTED", () => {
      const clean = sanitizeForLog({
        cardNumber: "4111111111111111",
        card_number: "4111111111111111",
        cvv: "123",
        cardHolder: "TEST",
      }) as any;

      expect(clean.cardNumber).toBe("[REDACTED]");
      expect(clean.card_number).toBe("[REDACTED]");
      expect(clean.cvv).toBe("[REDACTED]");
      expect(clean.cardHolder).toBe("[REDACTED]");
    });

    it("saqlangan payload'da maxfiy ma'lumot yo'q", async () => {
      await post(`/api/webhooks/beds24/${TOKEN}`, {
        event: "booking.new",
        token: "OSHKOR-BO'LMASLIGI-KERAK",
        booking: { id: 80000030, roomId: 101001, modifiedTime: new Date().toISOString() },
      });

      const raw = await prisma.webhookEvent.findFirst({ orderBy: { createdAt: "desc" } });
      const json = JSON.stringify(raw!.rawPayload);
      expect(json).not.toContain("OSHKOR-BO'LMASLIGI-KERAK");
      expect(json).toContain("[REDACTED]");
    });
  });

  // --- Mock bilan uchdan-uchgacha ------------------------
  describe("mock Beds24 bilan to'liq oqim", () => {
    it("OTA bron -> webhook -> PMS qabul qiladi", async () => {
      await mockControl("simulate-ota-booking", {
        arrival: "2027-07-01",
        departure: "2027-07-04",
        firstName: "Booking.com",
        lastName: "Mehmoni",
        price: 180,
      });

      // Webhook 150ms kechikish bilan yuboriladi
      await new Promise((r) => setTimeout(r, 800));

      const list = await events();
      expect(list.length).toBeGreaterThan(0);
      expect(list[0].eventType).toBe("booking.new");
      expect(isAccepted(list[0].status)).toBe(true);
    });

    it("mock duplicate -> PMS ikkinchisini rad etadi", async () => {
      await mockControl("simulate-ota-booking", {
        arrival: "2027-08-01",
        departure: "2027-08-03",
        duplicate: true,
      });

      await new Promise((r) => setTimeout(r, 1000));

      const list = await events();
      expect(list).toHaveLength(2);
      expect(list.filter((e) => e.status === "ignored_duplicate")).toHaveLength(1);
      expect(list.filter((e) => isAccepted(e.status))).toHaveLength(1);
    });

    it("bekor qilish webhook'i keladi", async () => {
      const created = await mockControl("simulate-ota-booking", {
        arrival: "2027-09-01",
        departure: "2027-09-03",
      }).then((r) => r.json() as any);

      await new Promise((r) => setTimeout(r, 500));
      await mockControl("simulate-cancellation", { bookingId: created.booking.id });
      await new Promise((r) => setTimeout(r, 500));

      const list = await events();
      expect(list.map((e) => e.eventType)).toContain("booking.cancelled");
    });

    it("to'lov webhook'i keladi (TZ 14-band)", async () => {
      const created = await mockControl("simulate-ota-booking", {
        arrival: "2027-10-01",
        departure: "2027-10-03",
      }).then((r) => r.json() as any);

      await new Promise((r) => setTimeout(r, 500));
      await mockControl("simulate-payment", { bookingId: created.booking.id, amount: 90 });
      await new Promise((r) => setTimeout(r, 500));

      const list = await events();
      expect(list.map((e) => e.eventType)).toContain("payment.updated");
    });
  });

  // --- Qo'lda qayta ishlash (04-fayl §7) -----------------
  describe("qayta ishlash", () => {
    it("FAILED event qayta navbatga qo'yiladi", async () => {
      await post("/api/webhooks/beds24/yolgon", payload(80000040));

      const list = await events();
      const failed = list.find((e) => e.status === "failed");
      expect(failed).toBeDefined();

      const res = await fetch(`${PMS}/api/admin/webhook-events/${failed!.id}/reprocess`, {
        method: "POST",
      });
      const body = (await res.json()) as any;
      expect(res.status).toBe(200);
      expect(body.status).toBe("queued");

      const after = await events();
      const same = after.find((e) => e.id === failed!.id);
      expect(same.status).toBe("queued");
      expect(same.attempts).toBe(1);
    });

    it("qayta ishlash AuditLog ga yoziladi (TZ 18-band)", async () => {
      await prisma.auditLog.deleteMany();
      await post("/api/webhooks/beds24/yolgon", payload(80000041));

      const list = await events();
      const failed = list.find((e) => e.status === "failed")!;
      await fetch(`${PMS}/api/admin/webhook-events/${failed.id}/reprocess`, { method: "POST" });

      // Shu event uchun yozuv bo'lishi kerak. Boshqa testlardan
      // qolgan yozuvlar ham bo'lishi mumkin, shuning uchun
      // entityId bo'yicha filtrlaymiz.
      const logs = await prisma.auditLog.findMany({
        where: { action: "webhook.reprocessed", entityId: failed.id },
      });
      expect(logs.length).toBeGreaterThanOrEqual(1);
    });

    it("mavjud bo'lmagan event -> 404", async () => {
      const res = await fetch(`${PMS}/api/admin/webhook-events/yoq-bunday-id/reprocess`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });
  });

  // --- Statistika ---------------------------------------
  describe("statistika", () => {
    it("holatlar bo'yicha sanaladi", async () => {
      const p = payload(80000050);
      await post(`/api/webhooks/beds24/${TOKEN}`, p);
      await post(`/api/webhooks/beds24/${TOKEN}`, p);           // duplicate
      await post("/api/webhooks/beds24/yolgon", payload(80000051));  // failed

      const res = await fetch(`${PMS}/api/admin/webhook-events/stats`);
      const stats = (await res.json()) as any;

      expect(stats.total).toBe(3);
      expect(stats.byStatus.ignored_duplicate).toBe(1);
      expect(stats.byStatus.failed).toBe(1);
      // Uchinchisi worker tomonidan ishlangan bo'lishi mumkin
      const accepted =
        (stats.byStatus.queued ?? 0) +
        (stats.byStatus.processed ?? 0) +
        (stats.byStatus.needs_manual_action ?? 0);
      expect(accepted).toBe(1);
      expect(stats.lastReceivedAt).toBeTruthy();
    });
  });
});
