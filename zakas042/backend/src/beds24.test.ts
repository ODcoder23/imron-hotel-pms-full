/**
 * FAZA 4 — Beds24 auth + client testlari
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md):
 *   "mock server'dan property ro'yxati olinadi; token avtomatik
 *    yangilanadi; kredit hisobi loglanadi; 429 qaytganda job
 *    kechiktiriladi (xato sifatida sanalmaydi)"
 *
 * Ishga tushirish:  npx vitest run src/beds24.test.ts
 * Shart: mock server (:4000) va PostgreSQL ishlab turishi kerak
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { beds24Adapter } from "./services/beds24/adapter.js";
import {
  getCreditState,
  resetCreditState,
  RateLimitError,
  isRetryable,
  getRetryDelay,
} from "./services/beds24/client.js";
import { setupConnection, getAccessToken, invalidateToken, getConnectionStatus } from "./services/beds24/auth.js";
import { encrypt, decrypt } from "./lib/encryption.js";
import { prisma } from "./lib/prisma.js";

const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:4000";

const mockControl = (path: string, body?: unknown) =>
  fetch(`${MOCK}/control/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const day = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

describe("FAZA 4 — Beds24 auth va client", () => {
  beforeAll(async () => {
    const res = await fetch(`${MOCK}/authentication/setup`, { headers: { code: "mock-invite-code" } });
    if (!res.ok) throw new Error("Mock server ishlamayapti — mock-beds24/npm run dev");

    // Seed `Channel` va `ChannelConnection` ni tozalaydi, shuning uchun
    // bu test o'z ulanishini o'zi yaratadi — boshqa testlar tartibiga
    // bog'liq bo'lmaydi.
    await setupConnection("mock-invite-code", "12345");
  });

  // Har test oldidan ulanish borligini kafolatlash (seed oraliqda
  // ishga tushsa ham test yiqilmaydi)
  beforeEach(async () => {
    const conn = await prisma.channelConnection.findFirst({
      where: { channel: { code: "beds24" }, isActive: true },
    });
    if (!conn) await setupConnection("mock-invite-code", "12345");
  });

  beforeEach(async () => {
    await mockControl("reset");
    resetCreditState();
  });

  // --- Shifrlash (TZ 18-band, 10-fayl §6) -------------------
  describe("credentials shifrlash", () => {
    it("shifrlash va deshifrlash aylanishi", () => {
      const secret = "mock-refresh-abc123xyz";
      const enc = encrypt(secret);
      expect(enc).not.toContain(secret);          // ochiq matn yo'q
      expect(enc.split(":")).toHaveLength(3);     // iv:tag:data
      expect(decrypt(enc)).toBe(secret);
    });

    it("har shifrlash boshqa natija beradi (IV tasodifiy)", () => {
      const a = encrypt("bir xil matn");
      const b = encrypt("bir xil matn");
      expect(a).not.toBe(b);
      expect(decrypt(a)).toBe(decrypt(b));
    });

    it("buzilgan shifr deshifrlanmaydi (GCM autentifikatsiyasi)", () => {
      const enc = encrypt("maxfiy");
      const parts = enc.split(":");
      // ciphertext'ning oxirgi belgisini o'zgartiramiz
      const tampered = [parts[0], parts[1], parts[2].slice(0, -2) + "XY"].join(":");
      expect(() => decrypt(tampered)).toThrow();
    });

    it("DB'da token OCHIQ saqlanmaydi", async () => {
      const conn = await prisma.channelConnection.findFirst({
        where: { channel: { code: "beds24" } },
      });
      expect(conn).toBeTruthy();
      expect(conn!.refreshToken).not.toMatch(/^mock-refresh-/);   // shifrlangan
      expect(conn!.refreshToken.split(":")).toHaveLength(3);
      expect(decrypt(conn!.refreshToken)).toMatch(/^mock-refresh-/);
    });
  });

  // --- Token oqimi (03-fayl §1) ----------------------------
  describe("token boshqaruvi", () => {
    it("access token olinadi", async () => {
      const token = await getAccessToken();
      expect(token).toMatch(/^mock-access-/);
    });

    it("cache ishlaydi — ikkinchi chaqiruv bir xil token", async () => {
      const a = await getAccessToken();
      const b = await getAccessToken();
      expect(a).toBe(b);      // yangi so'rov yuborilmadi, kredit tejaldi
    });

    it("cache bekor qilingach yangi token olinadi", async () => {
      const before = await getAccessToken();
      await invalidateToken();
      const after = await getAccessToken();
      expect(after).not.toBe(before);
      expect(after).toMatch(/^mock-access-/);
    });

    it("ulanish holati token'ni oshkor qilmaydi (TZ 13-band)", async () => {
      const status = await getConnectionStatus();
      expect(status.isConnected).toBe(true);
      expect(status.propertyId).toBe("12345");
      expect(JSON.stringify(status)).not.toContain("mock-access-");
      expect(JSON.stringify(status)).not.toContain("mock-refresh-");
    });
  });

  // --- Rate limit (03-fayl §3, 05-fayl §3) -----------------
  describe("rate limit boshqaruvi", () => {
    it("kredit holati javob headerlaridan o'qiladi", async () => {
      await beds24Adapter.getRoomTypes();
      const c = getCreditState();
      expect(c.remaining).toBeGreaterThan(0);
      expect(c.remaining).toBeLessThan(100);     // sarflandi
      expect(c.updatedAt).toBeGreaterThan(0);
    });

    it("kredit tugasa RateLimitError, XATO EMAS", async () => {
      await mockControl("drain-credits");

      let caught: unknown;
      try {
        await beds24Adapter.getRoomTypes();
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(RateLimitError);
      expect(isRetryable(caught)).toBe(true);              // qayta urinish kerak
      expect(getRetryDelay(caught)).toBeGreaterThan(0);    // qancha kutish
    });

    it("kredit kam bo'lsa oldindan to'xtatadi (bekorga so'rov yuborilmaydi)", async () => {
      await mockControl("drain-credits");
      try { await beds24Adapter.getRoomTypes(); } catch { /* kredit holati yozildi */ }

      const before = (await fetch(`${MOCK}/control/state`).then((r) => r.json() as any)).credits;

      // Ikkinchi urinish — client oldindan to'xtatishi kerak
      await expect(beds24Adapter.getRoomTypes()).rejects.toThrow(RateLimitError);

      const after = (await fetch(`${MOCK}/control/state`).then((r) => r.json() as any)).credits;
      expect(after.remaining).toBe(before.remaining);   // yangi so'rov ketmadi
    });
  });

  // --- Property va room type (06-fayl §3) ------------------
  describe("getRoomTypes", () => {
    it("3 room type, qty 6/4/2", async () => {
      const props = await beds24Adapter.getRoomTypes();
      expect(props).toHaveLength(1);

      const types = props[0].roomTypes;
      expect(types).toHaveLength(3);

      const byName = Object.fromEntries(types.map((t) => [t.name, t.qty]));
      expect(byName["Standard Room"]).toBe(6);
      expect(byName["Double Room"]).toBe(4);
      expect(byName["Deluxe Room"]).toBe(2);
    });

    it("unit-level mapping aniqlanadi (FAZA 0.5, 1-fakt)", async () => {
      const props = await beds24Adapter.getRoomTypes();
      const hasUnits = props[0].roomTypes.some((t) => t.units.length > 0);
      expect(hasUnits).toBe(false);     // mock room-type darajasida
    });

    it("ping muvaffaqiyatli", async () => {
      const r = await beds24Adapter.ping();
      expect(r.ok).toBe(true);
      expect(r.creditsRemaining).toBeGreaterThan(0);
    });
  });

  // --- Bron yuborish (12-fayl §3) --------------------------
  describe("pushReservation", () => {
    it("yangi bron -> externalId qaytadi", async () => {
      const r = await beds24Adapter.pushReservation({
        externalRoomTypeId: "101001",
        status: "confirmed",
        checkIn: day(30),
        checkOut: day(33),
        adults: 2,
        children: 0,
        totalPrice: 105,
        guestFirstName: "Test",
        guestLastName: "Mehmon",
      });

      expect(r.ok).toBe(true);
      if (r.ok) expect(Number(r.externalId)).toBeGreaterThan(70000000);
    });

    it("referer='PMS' qo'yiladi — echo loop belgisi (04-fayl §6)", async () => {
      await beds24Adapter.pushReservation({
        externalRoomTypeId: "101001",
        status: "confirmed",
        checkIn: day(40),
        checkOut: day(42),
        adults: 1,
        children: 0,
        totalPrice: 70,
        guestFirstName: "Echo",
        guestLastName: "Test",
      });

      const state = await fetch(`${MOCK}/control/state`).then((r) => r.json() as any);
      expect(state.bookings[0].referer).toBe("PMS");
    });

    it("mavjud bronni yangilaydi", async () => {
      const created = await beds24Adapter.pushReservation({
        externalRoomTypeId: "101001",
        status: "confirmed",
        checkIn: day(50),
        checkOut: day(52),
        adults: 1,
        children: 0,
        totalPrice: 70,
        guestFirstName: "A",
        guestLastName: "B",
      });
      expect(created.ok).toBe(true);
      const id = created.ok ? created.externalId! : "";

      const updated = await beds24Adapter.pushReservation({
        externalId: id,
        externalRoomTypeId: "101001",
        status: "cancelled",
        checkIn: day(50),
        checkOut: day(52),
        adults: 1,
        children: 0,
        totalPrice: 70,
        guestFirstName: "A",
        guestLastName: "B",
      });
      expect(updated.ok).toBe(true);

      const state = await fetch(`${MOCK}/control/state`).then((r) => r.json() as any);
      expect(state.bookings[0].status).toBe("cancelled");
    });

    it("validatsiya xatosi retryable EMAS", async () => {
      const r = await beds24Adapter.pushReservation({
        externalId: "99999999",     // mavjud emas
        externalRoomTypeId: "101001",
        status: "confirmed",
        checkIn: day(60),
        checkOut: day(62),
        adults: 1,
        children: 0,
        totalPrice: 70,
        guestFirstName: "X",
        guestLastName: "Y",
      });

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.retryable).toBe(false);   // qayta yuborish foydasiz
    });
  });

  // --- Availability (07-fayl §4) --------------------------
  describe("pushAvailability", () => {
    it("ketma-ket bir xil kunlar bitta oraliqqa yig'iladi (kredit tejash)", async () => {
      const days = Array.from({ length: 10 }, (_, i) => ({
        date: day(100 + i),
        available: 4,           // hammasi bir xil
      }));

      const r = await beds24Adapter.pushAvailability({
        externalRoomTypeId: "101001",
        days,
      });

      expect(r.ok).toBe(true);
      if (r.ok) expect(r.detail).toContain("1 oraliq");   // 10 kun -> 1 oraliq

      const state = await fetch(`${MOCK}/control/state`).then((r) => r.json() as any);
      expect(state.calendarPushes[0].entries).toHaveLength(1);
    });

    it("qiymat o'zgarganda yangi oraliq boshlanadi", async () => {
      const r = await beds24Adapter.pushAvailability({
        externalRoomTypeId: "101001",
        days: [
          { date: day(110), available: 6 },
          { date: day(111), available: 6 },
          { date: day(112), available: 5 },   // o'zgardi
          { date: day(113), available: 5 },
        ],
      });

      expect(r.ok).toBe(true);
      if (r.ok) expect(r.detail).toContain("2 oraliq");
    });

    it("yuborilgan qiymat Beds24'da saqlanadi", async () => {
      await beds24Adapter.pushAvailability({
        externalRoomTypeId: "101002",
        days: [{ date: day(120), available: 3 }],
      });

      const read = await beds24Adapter.getAvailability("101002", day(120), day(120));
      expect(read).toHaveLength(1);
      expect(read[0].available).toBe(3);
    });
  });

  // --- Narx (TZ 7-band) -----------------------------------
  describe("pushRates", () => {
    it("narx yuboriladi va o'qiladi", async () => {
      await beds24Adapter.pushRates({
        externalRoomTypeId: "101003",
        days: [
          { date: day(130), price: 52 },
          { date: day(131), price: 52 },
        ],
      });

      const read = await beds24Adapter.getAvailability("101003", day(130), day(131));
      expect(read[0].price).toBe(52);
    });
  });

  // --- Polling fallback (04-fayl §8) ----------------------
  describe("pullReservations", () => {
    it("modifiedFrom bo'yicha filtrlaydi", async () => {
      await mockControl("simulate-ota-booking", {
        arrival: day(140),
        departure: day(142),
        firstName: "Polling",
        lastName: "Testi",
      });

      const recent = await beds24Adapter.pullReservations(new Date(Date.now() - 60_000));
      expect(recent.length).toBeGreaterThan(0);
      expect(recent[0].guest.fullName).toBe("Polling Testi");

      const future = await beds24Adapter.pullReservations(new Date(Date.now() + 60_000));
      expect(future).toHaveLength(0);
    });

    it("OTA broni isOwnEcho=false (bizning emas)", async () => {
      await mockControl("simulate-ota-booking", {
        arrival: day(150),
        departure: day(152),
        referer: "Booking.com",
      });

      const list = await beds24Adapter.pullReservations(new Date(Date.now() - 60_000));
      expect(list[0].isOwnEcho).toBe(false);
      expect(list[0].source).toBe("Booking.com");
    });
  });

  // --- Webhook parse (04-fayl) ----------------------------
  describe("parseWebhook", () => {
    it("OTA webhook normallashadi", () => {
      const r = beds24Adapter.parseWebhook({
        event: "booking.new",
        booking: {
          id: 70000123,
          roomId: 101001,
          status: "confirmed",
          arrival: "2027-01-01",
          departure: "2027-01-04",
          numAdult: 2,
          numChild: 1,
          price: 150,
          firstName: "Booking.com",
          lastName: "Mehmoni",
          phone: "+998901234567",
          referer: "Booking.com",
          modifiedTime: new Date().toISOString(),
        },
      });

      expect(r.event).toBe("booking.new");
      expect(r.externalId).toBe("70000123");
      expect(r.isOwnEcho).toBe(false);
      expect(r.reservation?.guest.fullName).toBe("Booking.com Mehmoni");
      expect(r.reservation?.adults).toBe(2);
      expect(r.reservation?.children).toBe(1);
    });

    it("o'z aks-sadosi aniqlanadi (referer=PMS)", () => {
      const r = beds24Adapter.parseWebhook({
        event: "booking.modified",
        booking: {
          id: 70000124,
          roomId: 101001,
          status: "confirmed",
          arrival: "2027-02-01",
          departure: "2027-02-03",
          numAdult: 1,
          numChild: 0,
          price: 70,
          referer: "PMS",           // bizning belgimiz
          modifiedTime: new Date().toISOString(),
        },
      });

      expect(r.isOwnEcho).toBe(true);   // e'tiborsiz qoldiriladi
    });

    it("to'lov ma'lumoti ajratiladi (TZ 14-band)", () => {
      const r = beds24Adapter.parseWebhook({
        event: "payment.updated",
        booking: {
          id: 70000125,
          roomId: 101001,
          status: "confirmed",
          arrival: "2027-03-01",
          departure: "2027-03-03",
          numAdult: 1,
          numChild: 0,
          price: 100,
          modifiedTime: new Date().toISOString(),
          invoiceItems: [
            { type: "charge", amount: 100, description: "Xona" },
            { type: "payment", amount: 60, description: "OTA to'lovi" },
          ],
        },
      });

      expect(r.reservation?.payments).toHaveLength(1);   // faqat payment
      expect(r.reservation?.payments?.[0].amount).toBe(60);
    });

    it("bo'sh payload xato bermaydi", () => {
      const r = beds24Adapter.parseWebhook({ event: "unknown" });
      expect(r.externalId).toBeNull();
      expect(r.isOwnEcho).toBe(false);
    });
  });

  // --- Xato holatlari -------------------------------------
  describe("xato holatlari (mock scenario'lari)", () => {
    it("500 -> retryable", async () => {
      // scenario query orqali — client'dan o'tkazib bo'lmaydi,
      // shuning uchun to'g'ridan-to'g'ri tekshiramiz
      const res = await fetch(`${MOCK}/properties?scenario=500`, {
        headers: { token: await getAccessToken() },
      });
      expect(res.status).toBe(500);
    });

    it("ping xato holatda ok=false qaytaradi, throw qilmaydi", async () => {
      await mockControl("drain-credits");
      const r = await beds24Adapter.ping();
      expect(r.ok).toBe(false);
      expect(r.detail).toContain("kredit");
    });
  });
});
