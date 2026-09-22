/**
 * FAZA 0.5 — mock Beds24 server testlari
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md):
 *   "mock server ishga tushadi, GET /properties javob beradi,
 *    webhook yuboradi; BEDS24_BASE_URL almashtirilganda kod
 *    o'zgarmaydi"
 *
 * Ishga tushirish:  npx vitest run mock.test.ts
 * Shart: mock server ishlab turishi kerak (npm run dev)
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";

/**
 * Mock server manzili.
 *
 * `:4000` qattiq yozilgan edi va mock boshqa portda ishlaganda
 * (tunnel orqali `:4100`) barcha 28 test `ECONNREFUSED` bilan
 * skip bo'lardi — sabab kodda deb o'ylash oson edi. Backend
 * testlari 2026-09-17 da `PMS_URL`/`MOCK_URL` ga o'tkazilgan,
 * bu fayl qolib ketgan.
 *
 * `127.0.0.1`, `localhost` EMAS: Node 18+ da `localhost` avval
 * IPv6 (`::1`) ga hal bo'ladi, SSH tunnel esa IPv4 da tinglaydi.
 * Natijada `connect ECONNREFUSED ::1:4100` chiqadi va tunnel
 * ochiq bo'lsa ham testlar yiqiladi.
 */
const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:4000";
let token = "";

const call = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${MOCK}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { token } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};

describe("FAZA 0.5 — mock Beds24 server", () => {
  beforeAll(async () => {
    const res = await fetch(`${MOCK}/authentication/setup`, {
      headers: { code: "mock-invite-code" },
    });
    if (!res.ok) throw new Error("Mock server ishlamayapti — `npm run dev`");
    token = ((await res.json()) as any).token;
  });

  beforeEach(async () => {
    await fetch(`${MOCK}/control/reset`, { method: "POST" });
  });

  // --- Auth oqimi (03-fayl §1) ------------------------------
  describe("autentifikatsiya", () => {
    it("invite code -> refreshToken + token", async () => {
      const res = await fetch(`${MOCK}/authentication/setup`, {
        headers: { code: "mock-invite-code" },
      });
      const b = (await res.json()) as any;
      expect(res.status).toBe(200);
      expect(b.token).toMatch(/^mock-access-/);
      expect(b.refreshToken).toMatch(/^mock-refresh-/);
      expect(b.expiresIn).toBe(86400);      // 24 soat
    });

    it("noto'g'ri invite code -> 403", async () => {
      const res = await fetch(`${MOCK}/authentication/setup`, {
        headers: { code: "yolg'on-kod" },
      });
      expect(res.status).toBe(403);
    });

    it("refreshToken -> yangi access token", async () => {
      const setup = await fetch(`${MOCK}/authentication/setup`, {
        headers: { code: "mock-invite-code" },
      });
      const { refreshToken } = (await setup.json()) as any;

      const res = await fetch(`${MOCK}/authentication/token`, { headers: { refreshToken } });
      const b = (await res.json()) as any;
      expect(res.status).toBe(200);
      expect(b.token).toMatch(/^mock-access-/);
    });

    it("tokensiz so'rov -> 401", async () => {
      const res = await fetch(`${MOCK}/properties`);
      expect(res.status).toBe(401);
    });
  });

  // --- Rate limit (03-fayl §3) ------------------------------
  describe("rate limit — kredit tizimi", () => {
    it("har javobda uch header keladi", async () => {
      const { headers } = await call("/properties");
      expect(headers.get("x-request-cost")).toBeTruthy();
      expect(headers.get("x-five-min-limit-remaining")).toBeTruthy();
      expect(headers.get("x-five-min-limit-resets-in")).toBeTruthy();
    });

    it("kredit so'rovdan keyin kamayadi", async () => {
      const a = await call("/properties");
      const before = Number(a.headers.get("x-five-min-limit-remaining"));
      const b = await call("/properties");
      const after = Number(b.headers.get("x-five-min-limit-remaining"));
      expect(after).toBeLessThan(before);
    });

    it("kredit tugasa 429 + resetsIn", async () => {
      await fetch(`${MOCK}/control/drain-credits`, { method: "POST" });
      const { status, body } = await call("/properties");
      expect(status).toBe(429);
      expect(body.resetsIn).toBeGreaterThan(0);
    });

    it("scenario=429 bilan majburan rate limit", async () => {
      const { status } = await call("/properties?scenario=429");
      expect(status).toBe(429);
    });
  });

  // --- Properties (06-fayl §3 mapping ekrani manbai) --------
  describe("GET /properties", () => {
    // 2026-09-17: 3 tur / 12 xona -> 9 tur / 18 xona.
    // PMS 2026-09-16 da 18 xonaga o'tgan edi, mock qoldirilgan
    // va 6 tarifni umuman bog'lab bo'lmasdi.
    it("9 room type qaytaradi, jami 18 xona", async () => {
      const { status, body } = await call("/properties");
      expect(status).toBe(200);

      const types = body.data[0].roomTypes;
      expect(types).toHaveLength(9);

      const total = types.reduce((n: number, t: any) => n + t.qty, 0);
      expect(total).toBe(18);
    });

    it("qty PMS'dagi xona soniga mos", async () => {
      const { body } = await call("/properties");
      const byName = Object.fromEntries(
        body.data[0].roomTypes.map((t: any) => [t.name, t.qty])
      );

      // `prisma/seed.ts` dagi taqsimot bilan bir xil
      expect(byName["Standart 3 kishilik"]).toBe(1);
      expect(byName["Komfort 3 kishilik"]).toBe(3);
      expect(byName["Oilaviy yarim lyuks"]).toBe(2);
      expect(byName["Komfort 4 kishilik"]).toBe(2);
      expect(byName["Premium 4 kishilik"]).toBe(4);
      expect(byName["Delyuks 4 kishilik"]).toBe(3);
      expect(byName["Oilaviy Delyuks"]).toBe(1);
      expect(byName["Oilaviy lyuks balkonli 201"]).toBe(1);
      expect(byName["Oilaviy lyuks balkonli 301"]).toBe(1);
    });

    it("room type id'lari mapping uchun barqaror", async () => {
      const { body } = await call("/properties");
      const ids = body.data[0].roomTypes.map((t: any) => t.id);
      expect(ids).toEqual([
        101001, 101002, 101003, 101004, 101005,
        101006, 101007, 101008, 101009,
      ]);
    });
  });

  // --- Bookings (12-fayl §3) --------------------------------
  describe("/bookings", () => {
    it("POST yangi bron -> [{new: {...}}]", async () => {
      const { status, body } = await call("/bookings", {
        method: "POST",
        body: JSON.stringify([{
          roomId: 101001,
          status: "confirmed",
          arrival: "2026-12-01",
          departure: "2026-12-04",
          numAdult: 2,
          price: 105,
          firstName: "Test",
          lastName: "Mehmon",
          referer: "PMS",
        }]),
      });

      expect(status).toBe(200);
      expect(body[0].new).toBeDefined();
      expect(body[0].new.id).toBeGreaterThan(70000000);
      expect(body[0].new.referer).toBe("PMS");     // echo loop belgisi
    });

    it("POST id bilan -> [{modified: {...}}]", async () => {
      const created = await call("/bookings", {
        method: "POST",
        body: JSON.stringify([{
          roomId: 101001, arrival: "2026-12-10", departure: "2026-12-12",
          numAdult: 1, price: 70, firstName: "A", lastName: "B",
        }]),
      });
      const id = created.body[0].new.id;

      const { body } = await call("/bookings", {
        method: "POST",
        body: JSON.stringify([{ id, status: "cancelled" }]),
      });
      expect(body[0].modified.status).toBe("cancelled");
    });

    it("mavjud bo'lmagan id -> errors", async () => {
      const { body } = await call("/bookings", {
        method: "POST",
        body: JSON.stringify([{ id: 99999999, status: "cancelled" }]),
      });
      expect(body[0].errors).toBeDefined();
    });

    it("roomId yo'q -> errors", async () => {
      const { body } = await call("/bookings", {
        method: "POST",
        body: JSON.stringify([{ arrival: "2026-12-01", departure: "2026-12-03" }]),
      });
      expect(body[0].errors[0].field).toBe("roomId");
    });

    it("GET modifiedFrom filtri (polling fallback, 04-fayl §8)", async () => {
      await call("/bookings", {
        method: "POST",
        body: JSON.stringify([{
          roomId: 101001, arrival: "2026-12-20", departure: "2026-12-22",
          numAdult: 1, price: 70, firstName: "C", lastName: "D",
        }]),
      });

      const all = await call("/bookings");
      expect(all.body.count).toBeGreaterThan(0);

      const future = new Date(Date.now() + 60_000).toISOString();
      const none = await call(`/bookings?modifiedFrom=${future}`);
      expect(none.body.count).toBe(0);
    });
  });

  // --- Calendar (07-fayl §4) -------------------------------
  describe("/inventory/rooms/calendar", () => {
    it("POST availability -> oraliq kunlarga yoyiladi", async () => {
      const { status, body } = await call("/inventory/rooms/calendar", {
        method: "POST",
        body: JSON.stringify([{
          roomId: 101001,
          calendar: [{ from: "2027-01-01", to: "2027-01-05", numAvail: 4, price1: 35 }],
        }]),
      });
      expect(status).toBe(200);
      expect(body[0].modified).toBe(5);     // 5 kun
    });

    it("GET yuborilgan qiymatni qaytaradi", async () => {
      await call("/inventory/rooms/calendar", {
        method: "POST",
        body: JSON.stringify([{
          roomId: 101002,
          calendar: [{ from: "2027-02-01", to: "2027-02-03", numAvail: 2, price1: 42 }],
        }]),
      });

      const { body } = await call(
        "/inventory/rooms/calendar?roomId=101002&startDate=2027-02-01&endDate=2027-02-03"
      );
      const cal = body.data[0].calendar;
      expect(cal).toHaveLength(3);
      expect(cal[0].numAvail).toBe(2);
      expect(cal[0].price1).toBe(42);
    });

    it("qayta yuborilgan qiymat ustiga yoziladi", async () => {
      const push = (numAvail: number) =>
        call("/inventory/rooms/calendar", {
          method: "POST",
          body: JSON.stringify([{
            roomId: 101003,
            calendar: [{ from: "2027-03-01", to: "2027-03-01", numAvail }],
          }]),
        });

      await push(2);
      await push(1);

      const { body } = await call(
        "/inventory/rooms/calendar?roomId=101003&startDate=2027-03-01&endDate=2027-03-01"
      );
      expect(body.data[0].calendar[0].numAvail).toBe(1);
    });

    it("push'lar qayd qilinadi (test tekshiruvi uchun)", async () => {
      await call("/inventory/rooms/calendar", {
        method: "POST",
        body: JSON.stringify([{
          roomId: 101001,
          calendar: [{ from: "2027-04-01", to: "2027-04-02", numAvail: 6 }],
        }]),
      });

      const state = await fetch(`${MOCK}/control/state`).then((r) => r.json() as any);
      expect(state.calendarPushes).toHaveLength(1);
      expect(state.calendarPushes[0].roomId).toBe(101001);
    });
  });

  // --- Xato scenario'lari -----------------------------------
  describe("xato holatlari", () => {
    it("scenario=500", async () => {
      expect((await call("/properties?scenario=500")).status).toBe(500);
    });

    it("scenario=502 (HTML javob — JSON parse xatosi)", async () => {
      const { status, body } = await call("/properties?scenario=502");
      expect(status).toBe(502);
      expect(typeof body).toBe("string");
    });

    it("scenario=malformed (buzilgan JSON)", async () => {
      const { body } = await call("/properties?scenario=malformed");
      expect(typeof body).toBe("string");     // parse bo'lmadi
    });

    it("scenario=empty (bo'sh javob)", async () => {
      const { body } = await call("/properties?scenario=empty");
      expect(body).toBeNull();
    });
  });

  // --- Webhook (04-fayl) -----------------------------------
  describe("webhook yuborish", () => {
    it("OTA bron -> webhook yuboriladi", async () => {
      await fetch(`${MOCK}/control/simulate-ota-booking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arrival: "2027-05-01", departure: "2027-05-03" }),
      });

      const state = await fetch(`${MOCK}/control/state`).then((r) => r.json() as any);
      expect(state.webhooksSent).toHaveLength(1);
      expect(state.webhooksSent[0].event).toBe("booking.new");
    });

    it("duplicate=true -> bir xil webhook ikki marta (TZ 9-band)", async () => {
      await fetch(`${MOCK}/control/simulate-ota-booking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arrival: "2027-05-10", departure: "2027-05-12", duplicate: true }),
      });

      const state = await fetch(`${MOCK}/control/state`).then((r) => r.json() as any);
      expect(state.webhooksSent).toHaveLength(2);
      expect(state.webhooksSent[0].bookingId).toBe(state.webhooksSent[1].bookingId);
    });

    it("bekor qilish -> booking.cancelled", async () => {
      const created = await fetch(`${MOCK}/control/simulate-ota-booking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arrival: "2027-06-01", departure: "2027-06-03" }),
      }).then((r) => r.json() as any);

      await fetch(`${MOCK}/control/simulate-cancellation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: created.booking.id }),
      });

      const state = await fetch(`${MOCK}/control/state`).then((r) => r.json() as any);
      const events = state.webhooksSent.map((w: any) => w.event);
      expect(events).toContain("booking.cancelled");
    });

    it("to'lov -> payment.updated (TZ 14-band)", async () => {
      const created = await fetch(`${MOCK}/control/simulate-ota-booking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arrival: "2027-07-01", departure: "2027-07-03" }),
      }).then((r) => r.json() as any);

      const paid = await fetch(`${MOCK}/control/simulate-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: created.booking.id, amount: 150 }),
      }).then((r) => r.json() as any);

      expect(paid.booking.invoiceItems[0].amount).toBe(150);

      const state = await fetch(`${MOCK}/control/state`).then((r) => r.json() as any);
      expect(state.webhooksSent.map((w: any) => w.event)).toContain("payment.updated");
    });
  });
});
