/**
 * FAZA 8 — Real-time (WebSocket) testlari
 *
 * TZ 4-band:  "Admin sahifani refresh qilmasdan ham yangi bronni
 *              ko'rishi uchun WebSocket/real-time update ishlatilsin."
 * TZ 15-band: oltita event turi talab qilinadi.
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md, FAZA 8):
 *   "Beds24'da test bron yaratilsa, Shaxmatka ochiq turgan
 *    brauzerda sahifani yangilamasdan paydo bo'ladi."
 *
 * Test brauzer o'rnida haqiqiy WebSocket klient sifatida ulanadi:
 * agar klient event'ni olsa, brauzer ham oladi — bir xil protokol,
 * bir xil payload.
 *
 * Ishga tushirish:  npx vitest run src/realtime.test.ts
 * Shart: server (:3000), mock (:4000), PostgreSQL
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { prisma } from "./lib/prisma.js";
import { setupConnection } from "./services/beds24/auth.js";
import * as mapping from "./services/mapping.js";
import { PMS_EVENTS, ADMIN_EVENTS } from "./realtime/events.js";

const PMS = process.env.PMS_URL ?? "http://127.0.0.1:3000";

/**
 * WebSocket manzili PMS dan olinadi.
 *
 * Ilgari `ws://localhost:3000/ws` qattiq yozilgan edi va
 * `PMS_URL` ni umuman e'tiborga olmasdi: backend boshqa portda
 * bo'lsa (bizda 3200) barcha realtime testlari ulana olmasdi.
 * `localhost` ham muammo — Node 18+ uni IPv6 ga hal qiladi
 * (vitest.setup.ts izohiga qarang).
 */
const WS_URL = PMS.replace(/^http/, "ws") + "/ws";
const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:4000";
const TOKEN = "dev-webhook-token";

/**
 * WebSocket uchun JWT token (TZ 18-band, 09-fayl §4).
 *
 * `AUTH_REQUIRED=true` bo'lganda ulanish token talab qiladi.
 * Dev'da (`false`) bo'sh qoladi va ulanish ochiq bo'ladi —
 * ikkala rejimda ham testlar ishlashi kerak.
 */
let wsToken = "";

async function loadWsToken(): Promise<void> {
  const health = await fetch(`${PMS}/health`).then((r) => r.json() as any);
  if (health?.security?.auth !== true) return;

  const res = await fetch(`${PMS}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@imron.local", password: "admin12345" }),
  });
  const body = (await res.json()) as { token?: string };
  wsToken = body.token ?? "";
}

/** Token bilan WebSocket manzili */
const wsUrl = (): string =>
  wsToken ? `${WS_URL}?token=${encodeURIComponent(wsToken)}` : WS_URL;

/**
 * WebSocket klienti — brauzer o'rnida.
 *
 * Event'lar navbatga yig'iladi, `waitFor` kutib oladi. Polling
 * emas: `resolve` xabar kelganda darhol chaqiriladi.
 */
class TestClient {
  private ws: WebSocket;
  private received: any[] = [];
  private waiters: { match: (m: any) => boolean; resolve: (m: any) => void }[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      if (raw.toString() === "pong") return;
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.received.push(msg);

      // Kutayotganlarni tekshiramiz
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i]!.match(msg)) {
          this.waiters.splice(i, 1)[0]!.resolve(msg);
        }
      }
    });
  }

  static async connect(): Promise<TestClient> {
    const ws = new WebSocket(wsUrl());
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new TestClient(ws);
  }

  /** Shartga mos event kutadi. Allaqachon kelgan bo'lsa darhol qaytaradi. */
  waitFor(match: (m: any) => boolean, timeoutMs = 6000): Promise<any> {
    const already = this.received.find(match);
    if (already) return Promise.resolve(already);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const types = this.received.map((m) => m.type).join(", ") || "hech narsa";
        reject(new Error(`Event kelmadi (${timeoutMs}ms). Kelganlari: ${types}`));
      }, timeoutMs);

      this.waiters.push({
        match,
        resolve: (m) => { clearTimeout(timer); resolve(m); },
      });
    });
  }

  ofType(type: string) {
    return this.received.filter((m) => m.type === type);
  }

  clear() { this.received = []; this.waiters = []; }

  close() { this.ws.removeAllListeners(); this.ws.close(); }
}

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

const mockControl = (path: string, body?: unknown) =>
  fetch(`${MOCK}/control/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const webhookPayload = (bookingId: number, over: Record<string, unknown> = {}) => ({
  event: "booking.new",
  timestamp: new Date().toISOString(),
  propertyId: 12345,
  booking: {
    id: bookingId,
    roomId: 101001,
    status: "confirmed",
    arrival: "2027-08-10",
    departure: "2027-08-13",
    numAdult: 2,
    numChild: 0,
    price: 240,
    firstName: "Realtime",
    lastName: "Test",
    modifiedTime: new Date().toISOString(),
    ...over,
  },
});

/**
 * Beds24 room type -> PMS room type bog'lanishi.
 *
 * Mapping bo'lmasa webhook `needs_manual_action` ga tushadi va
 * bron yaratilmaydi (TZ 5-band) — event ham chiqmaydi. Shuning
 * uchun real-time testi mapping bilan boshlanadi.
 */
const EXT = { standard: "101001", double: "101002", deluxe: "101003" } as const;

async function mapAll() {
  for (const [pms, ext] of Object.entries(EXT)) {
    await mapping.upsertMapping({ roomTypeId: pms, externalRoomTypeId: ext });
  }
}

let client: TestClient;

describe("FAZA 8 — real-time WebSocket (TZ 4, 15-band)", () => {
  beforeAll(async () => {
    const res = await fetch(`${PMS}/health`);
    if (!res.ok) throw new Error("Server ishlamayapti");
    const health = (await res.json()) as any;
    if (!health.realtime) throw new Error("/health'da realtime yo'q — server yangilanmagan");
    await loadWsToken();

    const mockRes = await fetch(`${MOCK}/authentication/setup`, { headers: { code: "mock-invite-code" } });
    if (!mockRes.ok) throw new Error("Mock server ishlamayapti");
  });

  beforeEach(async () => {
    await prisma.webhookEvent.deleteMany();
    await prisma.payment.deleteMany({
      where: { reservation: { externalReservationId: { not: null } } },
    });
    await prisma.reservation.deleteMany({ where: { externalReservationId: { not: null } } });
    await mockControl("reset");

    // Ulanish + mapping — webhook bron yaratishi uchun shart
    const conn = await prisma.channelConnection.findFirst({
      where: { channel: { code: "beds24" }, isActive: true },
    });
    if (!conn) await setupConnection("mock-invite-code", "12345");
    await mapAll();

    client = await TestClient.connect();
  });

  afterEach(() => { client?.close(); });

  // --- Event ro'yxati: TZ 15-band ------------------------------
  describe("event turlari (TZ 15-band)", () => {
    it("TZ talab qilgan oltita event aniqlangan", () => {
      expect(PMS_EVENTS).toEqual([
        "reservation.created",
        "reservation.updated",
        "reservation.cancelled",
        "room.status.changed",
        "availability.changed",
        "payment.updated",
      ]);
    });

    it("admin event'lari alohida — Shaxmatka ularni ko'rsatmaydi", () => {
      expect(ADMIN_EVENTS).toContain("sync.failed");
      expect(ADMIN_EVENTS).toContain("webhook.needs_attention");
      // Aralashmasligi kerak
      for (const e of ADMIN_EVENTS) expect(PMS_EVENTS).not.toContain(e as never);
    });
  });

  // --- Ulanish -------------------------------------------------
  describe("ulanish", () => {
    it("ulanganda 'connected' xabari keladi", async () => {
      const msg = await client.waitFor((m) => m.type === "connected");
      expect(msg.serverStartedAt).toBeTruthy();
    });

    it("serverStartedAt barqaror — restart bo'lmasa o'zgarmaydi", async () => {
      const a = await client.waitFor((m) => m.type === "connected");
      const second = await TestClient.connect();
      try {
        const b = await second.waitFor((m) => m.type === "connected");
        expect(b.serverStartedAt).toBe(a.serverStartedAt);
      } finally {
        second.close();
      }
    });

    it("/health real-time statistikasini ko'rsatadi", async () => {
      const health = (await (await fetch(`${PMS}/health`)).json()) as any;
      expect(health.realtime.clients).toBeGreaterThanOrEqual(1);
      expect(typeof health.realtime.redisPubSub).toBe("boolean");
    });

    it("ping -> pong", async () => {
      const ws = new WebSocket(wsUrl());
      await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
      const pong = await new Promise<string>((resolve) => {
        ws.on("message", (raw) => {
          const s = raw.toString();
          if (s === "pong") resolve(s);
        });
        ws.send("ping");
      });
      expect(pong).toBe("pong");
      ws.close();
    });
  });

  // --- Autentifikatsiya (TZ 18-band, 09-fayl §4) --------------
  describe("ulanish autentifikatsiyasi", () => {
    /** Ulanish natijasini aniqlaydi: qabul qilindimi yoki yopildimi */
    const probe = (url: string): Promise<{ accepted: boolean; code?: number }> =>
      new Promise((resolve) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => { ws.close(); resolve({ accepted: false }); }, 5000);

        ws.on("message", () => {
          clearTimeout(timer); ws.close();
          resolve({ accepted: true });
        });
        ws.on("close", (code) => {
          clearTimeout(timer);
          resolve({ accepted: false, code });
        });
        ws.on("error", () => {
          clearTimeout(timer);
          resolve({ accepted: false });
        });
      });

    it("to'g'ri token bilan ulanish qabul qilinadi", async () => {
      const r = await probe(wsUrl());
      expect(r.accepted, "to'g'ri token rad etildi").toBe(true);
    }, 15000);

    it("AUTH_REQUIRED=true bo'lsa tokensiz ulanish rad etiladi", async () => {
      // Dev rejimida (`false`) ulanish ochiq — test o'zini
      // o'tkazib yuboradi
      if (!wsToken) return;

      const r = await probe(WS_URL);
      expect(r.accepted, "tokensiz ulanish qabul qilindi").toBe(false);
      // 1008 = Policy Violation
      expect(r.code).toBe(1008);
    }, 15000);

    it("buzilgan token rad etiladi", async () => {
      if (!wsToken) return;

      const r = await probe(`${WS_URL}?token=buzilgan.token.qiymati`);
      expect(r.accepted).toBe(false);
      expect(r.code).toBe(1008);
    }, 15000);
  });

  // --- ASOSIY MEZON: Beds24 broni refresh'siz ko'rinadi --------
  describe("FAZA 8 mezoni — Beds24 broni sahifani yangilamasdan keladi", () => {
    it("webhook kelganda reservation.created event'i yuboriladi", async () => {
      const body = webhookPayload(70009001);

      const res = await post(`/api/webhooks/beds24/${TOKEN}`, body);
      expect(res.status).toBe(200);

      // Brauzer hech narsa so'ramadi — event o'zi keldi
      const evt = await client.waitFor((m) => m.type === "reservation.created");

      expect(evt.reservation).toBeTruthy();
      expect(evt.reservation.externalReservationId).toBe("70009001");
      expect(evt.reservation.guestName).toContain("Realtime");
    });

    it("event payload'i Shaxmatka kutgan shaklda — konvertatsiya kerak emas", async () => {
      await post(`/api/webhooks/beds24/${TOKEN}`, webhookPayload(70009002));
      const evt = await client.waitFor((m) => m.type === "reservation.created");

      const r = evt.reservation;
      // Massiv elementi bilan aynan bir xil shakl (09-fayl §3)
      expect(typeof r.id).toBe("string");
      expect(typeof r.roomId).toBe("string");
      expect(typeof r.guestName).toBe("string");     // flatten qilingan
      expect(typeof r.totalPrice).toBe("number");    // Decimal EMAS
      expect(typeof r.paidAmount).toBe("number");
      expect(r.checkIn).toMatch(/^\d{4}-\d{2}-\d{2}$/);   // Date EMAS
      expect(r.checkOut).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.status).toBe(String(r.status).toLowerCase());   // enum kichik harf

      // API javobi bilan solishtiramiz — ikkisi bir xil bo'lishi kerak
      const fromApi = (await (await fetch(`${PMS}/api/reservations/${r.id}`)).json()) as any;
      expect(r.checkIn).toBe(fromApi.checkIn);
      expect(r.totalPrice).toBe(fromApi.totalPrice);
      expect(r.guestName).toBe(fromApi.guestName);
    });

    it("event bilan birga xona holati ham keladi", async () => {
      await post(`/api/webhooks/beds24/${TOKEN}`, webhookPayload(70009003));
      const evt = await client.waitFor((m) => m.type === "reservation.created");

      expect(evt.room).toBeTruthy();
      expect(evt.room.id).toBe(evt.reservation.roomId);
      expect(typeof evt.room.status).toBe("string");
    });

    it("bir necha brauzer ochiq bo'lsa — hammasi oladi", async () => {
      const b = await TestClient.connect();
      const c = await TestClient.connect();
      try {
        await post(`/api/webhooks/beds24/${TOKEN}`, webhookPayload(70009004));

        const [e1, e2, e3] = await Promise.all([
          client.waitFor((m) => m.type === "reservation.created"),
          b.waitFor((m) => m.type === "reservation.created"),
          c.waitFor((m) => m.type === "reservation.created"),
        ]);
        expect(e1.reservation.id).toBe(e2.reservation.id);
        expect(e2.reservation.id).toBe(e3.reservation.id);
      } finally {
        b.close();
        c.close();
      }
    });
  });

  // --- PMS ichidagi amallar ------------------------------------
  describe("PMS amallari ham event yuboradi", () => {
    const findRoom = async () => {
      const rooms = (await (await fetch(`${PMS}/api/rooms`)).json()) as any[];
      return rooms[0];
    };

    it("PMS'da bron yaratilsa reservation.created keladi", async () => {
      const room = await findRoom();
      const res = await post("/api/reservations", {
        roomId: room.id,
        checkIn: "2027-09-05",
        checkOut: "2027-09-07",
        guestName: "Ichki Mehmon",
        guestPhone: "+998900000001",
        adults: 1,
        pricePerNight: 100,
      });
      expect(res.status).toBe(201);

      const evt = await client.waitFor(
        (m) => m.type === "reservation.created" && m.reservation.id === res.body.id
      );
      expect(evt.reservation.guestName).toBe("Ichki Mehmon");

      await prisma.reservation.delete({ where: { id: res.body.id } }).catch(() => {});
    });

    it("to'lov qo'shilsa payment.updated keladi (TZ 14-band)", async () => {
      const room = await findRoom();
      const created = await post("/api/reservations", {
        roomId: room.id,
        checkIn: "2027-09-20",
        checkOut: "2027-09-22",
        guestName: "Tolov Testi",
        guestPhone: "+998900000002",
        adults: 1,
        pricePerNight: 150,
      });
      const id = created.body.id;
      client.clear();

      await post(`/api/reservations/${id}/payments`, { amount: 100, method: "cash" });

      const evt = await client.waitFor(
        (m) => m.type === "payment.updated" && m.reservation.id === id
      );
      expect(evt.reservation.paidAmount).toBe(100);

      await prisma.payment.deleteMany({ where: { reservationId: id } });
      await prisma.reservation.delete({ where: { id } }).catch(() => {});
    });

    it("bron bekor qilinsa reservation.cancelled keladi", async () => {
      const room = await findRoom();
      const created = await post("/api/reservations", {
        roomId: room.id,
        checkIn: "2027-10-01",
        checkOut: "2027-10-03",
        guestName: "Bekor Testi",
        guestPhone: "+998900000003",
        adults: 1,
        pricePerNight: 75,
      });
      const id = created.body.id;
      client.clear();

      await post(`/api/reservations/${id}/cancel`, {});

      const evt = await client.waitFor(
        (m) => m.type === "reservation.cancelled" && m.reservation.id === id
      );
      // TZ 2-band: bron o'chirilmaydi, statusi o'zgaradi — tarix saqlanadi
      expect(evt.reservation.status).toBe("cancelled");

      await prisma.reservation.delete({ where: { id } }).catch(() => {});
    });
  });

  // --- Ishonchlilik (09-fayl §5, TZ 17-band) -------------------
  describe("ishonchlilik", () => {
    it("WebSocket yo'q bo'lsa ham webhook qabul qilinadi", async () => {
      client.close();     // brauzer yopildi

      const res = await post(`/api/webhooks/beds24/${TOKEN}`, webhookPayload(70009010));
      expect(res.status).toBe(200);

      // Webhook navbat orqali qayta ishlanadi (TZ 11-band) —
      // javob darhol keladi, bron esa bir necha yuz ms keyin.
      // WebSocket yopiq bo'lsa ham natija DB'ga yoziladi.
      let saved = null;
      for (let i = 0; i < 25 && !saved; i++) {
        await new Promise((r) => setTimeout(r, 200));
        saved = await prisma.reservation.findFirst({
          where: { externalReservationId: "70009010" },
        });
      }
      expect(saved).toBeTruthy();

      client = await TestClient.connect();   // afterEach uchun
    });

    it("takroriy webhook ikkinchi event yubormaydi (TZ 9-band)", async () => {
      const body = webhookPayload(70009011);

      await post(`/api/webhooks/beds24/${TOKEN}`, body);
      await client.waitFor((m) => m.type === "reservation.created");

      const before = client.ofType("reservation.created").length;
      const second = await post(`/api/webhooks/beds24/${TOKEN}`, body);
      expect(second.body.duplicate).toBe(true);

      // Dedup ishlagan — yangi event chiqmaydi
      await new Promise((r) => setTimeout(r, 800));
      expect(client.ofType("reservation.created").length).toBe(before);
    });

    it("klient uzilsa server yiqilmaydi", async () => {
      const temp = await TestClient.connect();
      temp.close();
      await new Promise((r) => setTimeout(r, 300));

      // Server hali ham ishlayapti va event yuboradi
      await post(`/api/webhooks/beds24/${TOKEN}`, webhookPayload(70009012));
      const evt = await client.waitFor((m) => m.type === "reservation.created");
      expect(evt.reservation.externalReservationId).toBe("70009012");
    });
  });
});
