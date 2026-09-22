/**
 * FAZA 2A — API integratsiya testlari
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md):
 *   "barcha amallar API orqali ishlaydi, javob formati frontend
 *    kutgan shaklda"
 *
 * Ishga tushirish:  npm test
 * Shart: server ishlab turishi kerak (npm run dev)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { day, realRooms, someRooms, someType, tariffFor, typeOf } from "./testUtils.js";

const BASE = process.env.PMS_URL ?? "http://127.0.0.1:3000";

/**
 * Test ishlatadigan xonalar — bazadan olinadi.
 *
 * Ilgari "107", "111", "112" qattiq yozilgan edi; loyiha 12
 * xonadan 18 xonaga o'tganda bu testlar 404 qaytarardi.
 */
let R: string[] = [];

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = res.status === 204 ? null : ((await res.json()) as any);
  return { status: res.status, body };
};

describe("FAZA 2A — ichki REST API", () => {
  beforeAll(async () => {
    const { status } = await api("/health");
    if (status !== 200) throw new Error("Server ishlamayapti — `npm run dev` ishga tushiring");

    R = await someRooms(8);
    await Promise.all(R.map((id) => tariffFor(id)));
  });

  // --- Format (02-fayl §3) ----------------------------------
  describe("javob formati — Shaxmatka moslik jadvali", () => {
    it("rooms: id = xona raqami, type kichik harf", async () => {
      const { body } = await api("/api/rooms");

      // Xona SONI tekshirilmaydi: u seed ma'lumotiga bog'liq va
      // o'zgarishi mumkin. Tekshiriladigan narsa — javob SHAKLI,
      // chunki Shaxmatka aynan shu shaklni kutadi.
      expect(body.length).toBeGreaterThan(0);

      const first = body[0];
      expect(first.number).toBe(first.id);        // Q2: id = raqam
      expect(typeof first.type).toBe("string");
      expect(first.type).toMatch(/^[a-z0-9_]+$/); // kichik harf
      expect(typeof first.floor).toBe("number");
      expect(first.status).toMatch(/^[a-z_]+$/);  // "occupied", "available"
    });

    it("rooms: har xona turi mavjud turlar ro'yxatidan", async () => {
      const { body } = await api("/api/rooms");
      const { body: types } = await api("/api/rooms/types");

      const known = new Set(types.map((t: any) => t.id));

      // Har xonaning turi haqiqatan mavjud bo'lishi kerak —
      // aks holda Shaxmatka `ROOM_TYPES[type].label` da yiqiladi
      for (const room of body) {
        expect(known.has(room.type), `${room.id}: noma'lum tur ${room.type}`).toBe(true);
      }
    });

    it("reservations: guest flatten, Decimal → number, sana string", async () => {
      const { body } = await api("/api/reservations");
      expect(body.length).toBeGreaterThan(0);

      const r = body[0];
      expect(typeof r.guestName).toBe("string");       // flatten
      expect(typeof r.phone).toBe("string");           // flatten
      expect(r.guest).toBeUndefined();                 // ichma-ich obyekt YO'Q
      expect(typeof r.pricePerNight).toBe("number");   // Decimal emas
      expect(r.checkIn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.checkOut).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof r.createdAt).toBe("number");       // epoch ms
      expect(Array.isArray(r.charges)).toBe(true);
      expect(Array.isArray(r.payments)).toBe(true);
    });

    it("reservations: source va status kichik harfda", async () => {
      const { body } = await api("/api/reservations");
      for (const r of body) {
        expect(r.source).toMatch(/^[a-z_]+$/);
        expect(r.status).toMatch(/^[a-z_]+$/);
      }
    });

    it("payments: amount number, date 'YYYY-MM-DD'", async () => {
      const { body } = await api("/api/reservations");
      const withPayment = body.find((r: any) => r.payments.length > 0);
      expect(withPayment).toBeDefined();

      const p = withPayment.payments[0];
      expect(typeof p.amount).toBe("number");
      expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof p.method).toBe("string");
    });
  });

  // --- TZ 14-band: to'lov hisobi ----------------------------
  describe("TZ 14-band — to'lov hisobi", () => {
    it("totalPrice = pricePerNight × nights + charges", async () => {
      const { body } = await api("/api/reservations");
      for (const r of body) {
        const nights = Math.max(
          1,
          Math.round(
            (new Date(r.checkOut).getTime() - new Date(r.checkIn).getTime()) / 86_400_000
          )
        );
        const chargesTotal = r.charges.reduce((s: number, c: any) => s + c.amount, 0);
        expect(r.totalPrice).toBeCloseTo(r.pricePerNight * nights + chargesTotal, 2);
      }
    });

    it("remainingAmount = max(total - paid, 0)", async () => {
      const { body } = await api("/api/reservations");
      for (const r of body) {
        const paid = r.payments.reduce((s: number, p: any) => s + p.amount, 0);
        expect(r.paidAmount).toBeCloseTo(paid, 2);
        expect(r.remainingAmount).toBeCloseTo(Math.max(r.totalPrice - paid, 0), 2);
      }
    });
  });

  // --- TZ 2-band: sakkiz amal -------------------------------
  describe("TZ 2-band — bron amallari", () => {
    let id: string;

    it("1. bron yaratish", async () => {
      // Narx va to'lov BAZADAN kelgan tarifdan hisoblanadi:
      // qattiq yozilgan "35" USD davridan qolgan edi
      const price = await tariffFor(R[5]);
      const nights = 3;
      const prepay = Math.round(price / 2);

      const { status, body } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: R[5],
          guestName: "Vitest Mehmon",
          phone: "+998900000001",
          checkIn: day(40),
          checkOut: day(43),
          adults: 2,
          source: "direct",
          pricePerNight: price,
          initialPayment: prepay,
        }),
      });
      expect(status).toBe(201);
      expect(body.status).toBe("confirmed");

      // TZ 14-band formulasi: narx x kecha
      expect(body.totalPrice).toBe(price * nights);
      expect(body.paidAmount).toBe(prepay);
      expect(body.remainingAmount).toBe(price * nights - prepay);
      id = body.id;
    });

    it("2. bronni o'zgartirish (mehmon soni, narx)", async () => {
      // Tarifdan YUQORI narx — chegirma sababi talab qilinmaydi
      // (SAVOLLAR.md S4)
      const newPrice = (await tariffFor(R[5])) + 50_000;

      const { body } = await api(`/api/reservations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ adults: 3, pricePerNight: newPrice }),
      });
      expect(body.adults).toBe(3);
      expect(body.pricePerNight).toBe(newPrice);
      expect(body.totalPrice).toBe(newPrice * 3);
    });

    it("3. sana o'zgartirish", async () => {
      const { body } = await api(`/api/reservations/${id}/change-dates`, {
        method: "POST",
        body: JSON.stringify({ checkIn: day(40), checkOut: day(45) }),
      });
      expect(body.checkOut).toBe(day(45));

      // 5 kecha: jami narx kechalar soniga ko'payadi
      expect(body.totalPrice).toBe(body.pricePerNight * 5);
    });

    it("4. xona almashtirish (tur o'zgaradi)", async () => {
      const { body } = await api(`/api/reservations/${id}/change-room`, {
        method: "POST",
        body: JSON.stringify({ roomId: R[1] }),   // double — bugun bo'sh
      });
      expect(body.roomId).toBe(R[1]);
      expect(body.syncStatus).toBe("pending");     // Beds24'ga yuborilishi kerak
    });

    it("5. to'lov qo'shish", async () => {
      // Qarzning bir qismini to'laymiz: to'liq summa qarzdan
      // oshib ketsa backend rad etadi (SAVOLLAR.md S1)
      const { body: before } = await api(`/api/reservations/${id}`);
      const amount = Math.round(before.remainingAmount / 2);

      const { status, body } = await api(`/api/reservations/${id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount, method: "Karta" }),
      });
      expect(status).toBe(201);
      expect(body.paidAmount).toBe(before.paidAmount + amount);
      expect(body.payments).toHaveLength(before.payments.length + 1);
    });

    it("6. xarajat qo'shish", async () => {
      const { body: before } = await api(`/api/reservations/${id}`);
      const extra = 20_000;

      const { body } = await api(`/api/reservations/${id}/charges`, {
        method: "POST",
        body: JSON.stringify({ label: "Minibar", amount: extra }),
      });

      // Qo'shimcha xizmat jami summaga ham, qarzga ham qo'shiladi
      expect(body.totalPrice).toBe(before.totalPrice + extra);
      expect(body.remainingAmount).toBe(before.remainingAmount + extra);
    });

    it("7. check-in — status va vaqt yoziladi", async () => {
      const { body } = await api(`/api/reservations/${id}/check-in`, { method: "POST" });
      expect(body.status).toBe("checked_in");
      expect(body.checkedInAt).toBeTruthy();
    });

    it("8. check-out — status va vaqt yoziladi", async () => {
      const { body } = await api(`/api/reservations/${id}/check-out`, { method: "POST" });
      expect(body.status).toBe("checked_out");
      expect(body.checkedOutAt).toBeTruthy();
    });

    it("chiqib ketgan bronni bekor qilib bo'lmaydi", async () => {
      // Yuqoridagi 8-test check-out qildi. CHECKED_OUT — yakuniy
      // holat, undan chiqib bo'lmaydi (SAVOLLAR.md S3).
      //
      // Ilgari bu test bekor qilishni kutardi va o'tardi, chunki
      // status mashinasi yo'q edi: chiqib ketgan mehmonning broni
      // bekor qilinib, hisobotdan yo'qolishi mumkin edi.
      const { status, body } = await api(`/api/reservations/${id}/cancel`, {
        method: "POST",
      });
      expect(status).toBe(400);
      expect(body.error).toContain("mehmon chiqqan");
    });

    it("bekor qilish — tasdiqlangan bron bo'shaydi", async () => {
      const { body: fresh } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: R[2],
          guestName: "Bekor Qilinadigan",
          phone: "+998900000001",
          checkIn: day(60),
          checkOut: day(62),
          pricePerNight: await tariffFor(R[2]),
        }),
      });

      const { body } = await api(`/api/reservations/${fresh.id}/cancel`, {
        method: "POST",
      });
      expect(body.status).toBe("cancelled");
    });
  });

  // --- Room.status — JORIY holat, sanaga bog'liq emas -------
  describe("Room.status — joriy jismoniy holat", () => {
    it("kelajakdagi bron xona holatini o'zgartirmaydi", async () => {
      const { body: before } = await api("/api/rooms");
      const was = before.find((r: any) => r.id === R[3]).status;

      const { body: r } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: R[3],
          guestName: "Kelajak mehmoni",
          phone: "+998900000002",
          checkIn: day(120),
          checkOut: day(123),
          pricePerNight: await tariffFor(R[3]),
        }),
      });

      const { body: after } = await api("/api/rooms");
      expect(after.find((x: any) => x.id === R[3]).status).toBe(was);

      await api(`/api/reservations/${r.id}/cancel`, { method: "POST" });
    });

    it("bugungi check-in → OCCUPIED, check-out → DIRTY", async () => {
      const { body: r } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: R[4],
          guestName: "Bugungi mehmon",
          phone: "+998900000003",
          checkIn: day(0),
          checkOut: day(2),
          pricePerNight: await tariffFor(R[4]),
        }),
      });

      await api(`/api/reservations/${r.id}/check-in`, { method: "POST" });
      const { body: a } = await api("/api/rooms");
      expect(a.find((x: any) => x.id === R[4]).status).toBe("occupied");

      await api(`/api/reservations/${r.id}/check-out`, { method: "POST" });
      const { body: b } = await api("/api/rooms");
      expect(b.find((x: any) => x.id === R[4]).status).toBe("dirty");

      await api(`/api/reservations/${r.id}/cancel`, { method: "POST" });
    });
  });

  // --- TZ 3-band: overbooking -------------------------------
  describe("TZ 3-band — overbooking himoyasi", () => {
    let firstId: string;

    it("birinchi bron o'tadi", async () => {
      const { status, body } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: R[6],
          guestName: "Birinchi",
          phone: "+998900000004",
          checkIn: day(60),
          checkOut: day(63),
          pricePerNight: await tariffFor(R[6]),
        }),
      });
      expect(status).toBe(201);
      firstId = body.id;
    });

    it("qoplanuvchi bron 409 bilan rad etiladi", async () => {
      const { status, body } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: R[6],
          guestName: "Ikkinchi",
          phone: "+998900000005",
          checkIn: day(61),      // kesishadi
          checkOut: day(65),
          pricePerNight: await tariffFor(R[6]),
        }),
      });
      expect(status).toBe(409);
      expect(body.code).toBe("ROOM_UNAVAILABLE");
    });

    it("chegara '[)': checkOut kuni yangi bron kiradi", async () => {
      const { status } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: R[6],
          guestName: "Uchinchi",
          phone: "+998900000006",
          checkIn: day(63),      // birinchisi shu kuni chiqadi
          checkOut: day(66),
          pricePerNight: await tariffFor(R[6]),
        }),
      });
      expect(status).toBe(201);
    });

    it("bekor qilingan bron xonani bo'shatadi", async () => {
      await api(`/api/reservations/${firstId}/cancel`, { method: "POST" });
      const { status } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: R[6],
          guestName: "To'rtinchi",
          phone: "+998900000007",
          checkIn: day(60),
          checkOut: day(62),
          pricePerNight: await tariffFor(R[6]),
        }),
      });
      expect(status).toBe(201);
    });
  });

  // --- Validatsiya ------------------------------------------
  describe("validatsiya", () => {
    it("checkOut <= checkIn bo'lsa 400", async () => {
      const { status } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: R[0],
          guestName: "X",
          phone: "+998900000008",
          checkIn: day(10),
          checkOut: day(10),
          pricePerNight: await tariffFor(R[0]),
        }),
      });
      expect(status).toBe(400);
    });

    it("noto'g'ri sana formati 400", async () => {
      const { status } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: R[0],
          guestName: "X",
          phone: "+998900000009",
          checkIn: "12.09.2026",
          checkOut: day(12),
          pricePerNight: await tariffFor(R[0]),
        }),
      });
      expect(status).toBe(400);
    });

    it("mavjud bo'lmagan xona 404", async () => {
      const { status } = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: "999",
          guestName: "X",
          phone: "+998900000010",
          checkIn: day(10),
          checkOut: day(12),
          pricePerNight: await tariffFor("999"),
        }),
      });
      expect(status).toBe(404);
    });
  });

  // --- Bo'sh xonalar ----------------------------------------
  describe("bo'sh xonalarni qidirish", () => {
    it("band xona ro'yxatda yo'q", async () => {
      const { body } = await api(`/api/rooms/available?from=${day(80)}&to=${day(83)}`);
      // Xona soni seed ma'lumotiga bog'liq — faqat "hammasi bo'sh"
      // ekanini tekshiramiz
      expect(body.length).toBe((await realRooms()).length);

      await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: R[2],
          guestName: "Band qiluvchi",
          phone: "+998900000011",
          checkIn: day(80),
          checkOut: day(83),
          pricePerNight: await tariffFor(R[2]),
        }),
      });

      const { body: after } = await api(`/api/rooms/available?from=${day(80)}&to=${day(83)}`);

      // Bitta xona band bo'ldi — ro'yxat bittaga qisqaradi
      expect(after.length).toBe(body.length - 1);
      expect(after.find((r: any) => r.id === R[2])).toBeUndefined();
    });
  });

  // --- Narxlar (07 §8) --------------------------------------
  describe("narxlar — Q8 (qo'lda belgilanadi)", () => {
    it("RatePlan o'qiladi", async () => {
      const { body } = await api(`/api/rate-plans?from=${day(0)}&to=${day(2)}`);
      expect(body.length).toBeGreaterThan(0);
      expect(typeof body[0].price).toBe("number");
      expect(body[0].source).toBe("pms");
    });

    it("narx belgilanadi va sync kutadi", async () => {
      // Tur ID'lari BAZADAN: "standard"/"deluxe" eski 12 xonali
      // tuzilishdan qolgan nomlar edi
      const typeA = await someType(0);
      const typeB = await someType(1);
      const priceA = 450_000;
      const priceB = 650_000;

      const { body } = await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({
          from: day(100),
          to: day(102),
          prices: { [typeA]: priceA, [typeB]: priceB },
        }),
      });
      expect(body.updated).toBe(6);          // 3 kun × 2 tur
      expect(body.syncStatus).toBe("pending");

      const { body: check } = await api(`/api/rate-plans?from=${day(100)}&to=${day(100)}`);
      const std = check.find((p: any) => p.roomTypeId === typeA);
      expect(std.price).toBe(priceA);
      expect(std.syncStatus).toBe("pending");
    });
  });
});
