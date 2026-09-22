/**
 * FAZA 11 — Narxlar va to'lov
 *
 * TZ 7-band:  narx ikki yo'nalishda sinxronlanadi, source of truth
 *             qaroriga bo'ysunadi.
 * TZ 14-band: to'lov hisob-kitobi — "To'liq to'langan / Qarz bor".
 * Mijoz qarori Q8: avtomatik o'suvchi narx mexanizmi YO'Q.
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md, FAZA 11):
 *   "Narx ikki yo'nalishda ham to'g'ri ishlaydi, loop yo'q;
 *    Beds24'dan kelgan to'lov Shaxmatkadagi 'To'liq to'langan /
 *    Qarz bor' belgisini to'g'ri ko'rsatadi."
 *
 * Ishga tushirish:  npx vitest run src/rates.test.ts
 * Shart: server (:3000), mock (:4000), PostgreSQL, Redis
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prisma } from "./lib/prisma.js";
import { setupConnection } from "./services/beds24/auth.js";
import { upsertMapping } from "./services/mapping.js";
import { readRates, pushRates, applyExternalRate, syncRatesRange } from "./services/rates.js";
import { getRatesSoT, setSetting, SETTING_KEYS } from "./services/settings.js";
import { fromDateKey } from "./lib/serialize.js";
import { TYPES, loadTypes } from "./testUtils.js";

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

const mockControl = async (path: string, body?: unknown) => {
  const res = await fetch(`${MOCK}/control/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json() as any;
};

const mockState = async () =>
  (await fetch(`${MOCK}/control/state`).then((r) => r.json())) as {
    calendarPushes: Array<{
      roomId: number;
      entries: Array<{ from: string; to: string; price1?: number; numAvail?: number }>;
    }>;
  };

/** Mock qabul qilgan narxlar — oraliqlar kunlarga yoyiladi */
async function pushedPrices(externalRoomTypeId: string): Promise<Map<string, number>> {
  const { calendarPushes } = await mockState();
  const out = new Map<string, number>();
  for (const push of calendarPushes) {
    if (push.roomId !== Number(externalRoomTypeId)) continue;
    for (const e of push.entries) {
      if (typeof e.price1 !== "number") continue;
      const end = new Date(e.to + "T00:00:00Z").getTime();
      for (let t = new Date(e.from + "T00:00:00Z").getTime(); t <= end; t += 86_400_000) {
        out.set(new Date(t).toISOString().slice(0, 10), e.price1);
      }
    }
  }
  return out;
}

/**
 * PMS turlarini Beds24 tashqi ID'lariga bog'laydi.
 *
 * EXT kalitlari ("standard", "double", "deluxe") tarixiy nomlar —
 * ular faqat tashqi ID'ni topish uchun, PMS tur ID'si emas.
 * PMS tomoni TYPES dan keladi (bazadagi haqiqiy turlar).
 */
async function mapAll() {
  const pairs: Array<[string, string]> = [
    [TYPES.a, EXT.standard],
    [TYPES.b, EXT.double],
    [TYPES.c, EXT.deluxe],
  ];

  for (const [pms, external] of pairs) {
    await upsertMapping({ roomTypeId: pms, externalRoomTypeId: external });
  }
}

const D = (k: string) => fromDateKey(k);

/** `check` rost bo'lguncha kutadi */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 12000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("FAZA 11 — narxlar va to'lov (TZ 7, 14-band)", () => {
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

    // Test oraliqlari 2031 yilda
    await prisma.ratePlan.deleteMany({ where: { date: { gte: D("2031-01-01") } } });

    // Har test standart SoT dan boshlaydi
    await setSetting(SETTING_KEYS.ratesSoT, "pms");

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

  afterAll(async () => {
    await setSetting(SETTING_KEYS.ratesSoT, "pms");
  });

  // --- Narx belgilash (Q8: qo'lda) ---------------------------
  describe("narx belgilash — admin qo'lda (Q8)", () => {
    it("PUT /api/rate-plans oraliqdagi har kunga narx yozadi", async () => {
      const res = await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({
          from: "2031-03-01",
          to: "2031-03-03",
          prices: { [TYPES.a]: 45 },
        }),
      });
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(3);       // 01, 02, 03

      const days = await readRates(TYPES.a, D("2031-03-01"), D("2031-03-03"));
      expect(days).toHaveLength(3);
      expect(days.every((d) => d.price === 45)).toBe(true);
      expect(days.every((d) => d.source === "pms")).toBe(true);
    });

    it("narx o'zgarganda syncedAt tozalanadi — qayta yuboriladi", async () => {
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-03-10", to: "2031-03-11", prices: { [TYPES.c]: 80 } }),
      });
      await pushRates(TYPES.c, D("2031-03-10"), D("2031-03-11"));

      let days = await readRates(TYPES.c, D("2031-03-10"), D("2031-03-11"));
      expect(days.every((d) => d.syncedAt !== null)).toBe(true);

      // Narx o'zgardi -> qayta yuborilishi kerak
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-03-10", to: "2031-03-11", prices: { [TYPES.c]: 95 } }),
      });

      days = await readRates(TYPES.c, D("2031-03-10"), D("2031-03-11"));
      expect(days.every((d) => d.syncedAt === null)).toBe(true);
      expect(days.every((d) => d.price === 95)).toBe(true);
    });

    it("GET narx bilan birga sync holatini qaytaradi (07-fayl §8)", async () => {
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-03-20", to: "2031-03-20", prices: { [TYPES.b]: 60 } }),
      });

      const res = await api("/api/rate-plans?from=2031-03-20&to=2031-03-20");
      const row = res.body.find((r: any) => r.roomTypeId === TYPES.b);
      expect(row).toBeTruthy();
      expect(row.price).toBe(60);
      // ● yuborildi / ○ kutmoqda / ⚠ xato
      expect(["pending", "synced", "error"]).toContain(row.syncStatus);
    });
  });

  // --- PMS -> Beds24 (TZ 7-band) -----------------------------
  describe("PMS -> Beds24", () => {
    it("narx mock server'ga price1 sifatida yetib keladi", async () => {
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-04-01", to: "2031-04-03", prices: { [TYPES.a]: 55 } }),
      });

      const result = await pushRates(TYPES.a, D("2031-04-01"), D("2031-04-03"));
      expect(result.status).toBe("sent");

      const prices = await pushedPrices(EXT.standard);
      expect(prices.get("2031-04-01")).toBe(55);
      expect(prices.get("2031-04-02")).toBe(55);
      expect(prices.get("2031-04-03")).toBe(55);
    });

    it("yuborilgandan keyin syncedAt yoziladi", async () => {
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-04-10", to: "2031-04-11", prices: { [TYPES.c]: 120 } }),
      });

      let days = await readRates(TYPES.c, D("2031-04-10"), D("2031-04-11"));
      expect(days.every((d) => d.syncedAt === null)).toBe(true);

      await pushRates(TYPES.c, D("2031-04-10"), D("2031-04-11"));

      days = await readRates(TYPES.c, D("2031-04-10"), D("2031-04-11"));
      expect(days.every((d) => d.syncedAt !== null)).toBe(true);
      expect(days.every((d) => d.syncError === null)).toBe(true);
    });

    it("o'zgarmagan narx ikkinchi marta yuborilmaydi (kredit tejash)", async () => {
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-04-20", to: "2031-04-22", prices: { [TYPES.b]: 70 } }),
      });

      const first = await pushRates(TYPES.b, D("2031-04-20"), D("2031-04-22"));
      expect(first.status).toBe("sent");

      const second = await pushRates(TYPES.b, D("2031-04-20"), D("2031-04-22"));
      expect(second.status).toBe("skipped");
    });

    it("mapping yo'q bo'lsa yuborilmaydi va xato belgilanadi", async () => {
      await prisma.channelMapping.deleteMany();

      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-05-01", to: "2031-05-02", prices: { [TYPES.a]: 50 } }),
      });

      const result = await pushRates(TYPES.a, D("2031-05-01"), D("2031-05-02"));
      expect(result.status).toBe("failed");

      const days = await readRates(TYPES.a, D("2031-05-01"), D("2031-05-02"));
      expect(days.every((d) => d.syncError?.includes("mapping"))).toBe(true);

      // Taxminiy mapping ishlatilmadi
      const prices = await pushedPrices(EXT.standard);
      expect(prices.size).toBe(0);
    });

    it("navbat orqali avtomatik yuboriladi", async () => {
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-06-01", to: "2031-06-02", prices: { [TYPES.c]: 200 } }),
      });

      // Worker o'zi bajaradi (3s debounce)
      const ok = await waitFor(async () => {
        const prices = await pushedPrices(EXT.deluxe);
        return prices.get("2031-06-01") === 200;
      });
      expect(ok, "narx Beds24'ga yetmadi").toBe(true);
    }, 20000);
  });

  // --- Beds24 -> PMS (TZ 7-band teskari) ---------------------
  describe("Beds24 -> PMS", () => {
    it("SoT=beds24 bo'lsa kelgan narx qabul qilinadi", async () => {
      await setSetting(SETTING_KEYS.ratesSoT, "beds24");
      expect(await getRatesSoT()).toBe("beds24");

      const outcome = await applyExternalRate({
        externalRoomTypeId: EXT.standard,
        date: "2031-07-01",
        price: 88,
      });

      expect(outcome.status).toBe("applied");

      const days = await readRates(TYPES.a, D("2031-07-01"), D("2031-07-01"));
      expect(days[0]!.price).toBe(88);
      expect(days[0]!.source).toBe("beds24");
      // Beds24'dan kelgan narx allaqachon sinxron — qayta
      // yuborilmaydi (halqa himoyasi)
      expect(days[0]!.syncedAt).not.toBeNull();
    });

    it("SoT=pms bo'lsa kelgan narx RAD ETILADI", async () => {
      await setSetting(SETTING_KEYS.ratesSoT, "pms");

      const outcome = await applyExternalRate({
        externalRoomTypeId: EXT.standard,
        date: "2031-07-10",
        price: 999,
      });

      expect(outcome.status).toBe("skipped");
      if (outcome.status === "skipped") {
        expect(outcome.reason).toContain("pms is source of truth");
      }

      const days = await readRates(TYPES.a, D("2031-07-10"), D("2031-07-10"));
      expect(days).toHaveLength(0);       // yozilmadi

      const log = await prisma.syncLog.findFirst({
        where: { action: "rate_changed", status: "SKIPPED" },
        orderBy: { createdAt: "desc" },
      });
      expect(log).toBeTruthy();
    });

    it("bir xil narx qayta yozilmaydi (loop himoyasi 3-qatlam)", async () => {
      await setSetting(SETTING_KEYS.ratesSoT, "beds24");

      await applyExternalRate({
        externalRoomTypeId: EXT.deluxe,
        date: "2031-07-20",
        price: 150,
      });

      const before = await readRates(TYPES.c, D("2031-07-20"), D("2031-07-20"));

      const second = await applyExternalRate({
        externalRoomTypeId: EXT.deluxe,
        date: "2031-07-20",
        price: 150,
      });

      expect(second.status).toBe("skipped");
      if (second.status === "skipped") {
        expect(second.reason).toContain("o'zgarmagan");
      }

      const after = await readRates(TYPES.c, D("2031-07-20"), D("2031-07-20"));
      expect(after[0]!.syncedAt?.getTime()).toBe(before[0]!.syncedAt?.getTime());
    });

    it("mapping yo'q bo'lsa kelgan narx yozilmaydi", async () => {
      await setSetting(SETTING_KEYS.ratesSoT, "beds24");
      await prisma.channelMapping.deleteMany();

      const outcome = await applyExternalRate({
        externalRoomTypeId: "999999",
        date: "2031-07-25",
        price: 60,
      });

      expect(outcome.status).toBe("skipped");
    });

    it("webhook orqali kelgan narx qo'llanadi (to'liq zanjir)", async () => {
      await setSetting(SETTING_KEYS.ratesSoT, "beds24");

      await mockControl("simulate-rate-change", {
        roomId: Number(EXT.double),
        rates: [
          { date: "2031-08-01", price: 77 },
          { date: "2031-08-02", price: 77 },
        ],
      });

      const ok = await waitFor(async () => {
        const days = await readRates(TYPES.b, D("2031-08-01"), D("2031-08-02"));
        return days.length === 2 && days.every((d) => d.price === 77);
      });
      expect(ok, "webhook narxi qo'llanmadi").toBe(true);

      const days = await readRates(TYPES.b, D("2031-08-01"), D("2031-08-02"));
      expect(days.every((d) => d.source === "beds24")).toBe(true);
    }, 20000);
  });

  // --- LOOP HIMOYASI — FAZA 11 asosiy mezoni -----------------
  describe("FAZA 11 mezoni — halqa yo'q", () => {
    it("SoT=pms: Beds24 narx yuborsa PMS javob QAYTARMAYDI", async () => {
      // Bu asosiy halqa xavfi: Beds24 yuboradi -> PMS rad etib
      // o'zinikini yuboradi -> Beds24 yana yuboradi -> cheksiz
      await setSetting(SETTING_KEYS.ratesSoT, "pms");

      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-09-01", to: "2031-09-02", prices: { [TYPES.a]: 40 } }),
      });
      await pushRates(TYPES.a, D("2031-09-01"), D("2031-09-02"));
      await mockControl("reset");
      await mapAll();

      // Beds24 boshqa narx yubordi
      await mockControl("simulate-rate-change", {
        roomId: Number(EXT.standard),
        rates: [{ date: "2031-09-01", price: 999 }],
      });
      await new Promise((r) => setTimeout(r, 3000));

      // PMS narxi o'zgarmadi
      const days = await readRates(TYPES.a, D("2031-09-01"), D("2031-09-01"));
      expect(days[0]!.price).toBe(40);

      // VA eng muhimi: PMS javoban hech narsa yubormadi
      const prices = await pushedPrices(EXT.standard);
      expect(prices.size).toBe(0);
    }, 20000);

    it("SoT=beds24: PMS narxi yuborilmaydi", async () => {
      await setSetting(SETTING_KEYS.ratesSoT, "beds24");

      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-09-10", to: "2031-09-11", prices: { [TYPES.c]: 300 } }),
      });

      const result = await pushRates(TYPES.c, D("2031-09-10"), D("2031-09-11"));
      expect(result.status).toBe("skipped");
      if (result.status === "skipped") {
        expect(result.reason).toContain("source of truth");
      }

      const prices = await pushedPrices(EXT.deluxe);
      expect(prices.size).toBe(0);
    });

    it("SoT almashtirilganda yo'nalish ham almashadi", async () => {
      // pms -> yuboriladi
      await setSetting(SETTING_KEYS.ratesSoT, "pms");
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-10-01", to: "2031-10-01", prices: { [TYPES.b]: 65 } }),
      });
      expect((await pushRates(TYPES.b, D("2031-10-01"), D("2031-10-01"))).status).toBe("sent");

      // beds24 -> yuborilmaydi
      await setSetting(SETTING_KEYS.ratesSoT, "beds24");
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({ from: "2031-10-02", to: "2031-10-02", prices: { [TYPES.b]: 66 } }),
      });
      expect((await pushRates(TYPES.b, D("2031-10-02"), D("2031-10-02"))).status).toBe("skipped");
    });
  });

  // --- Sozlamalar endpoint'i ---------------------------------
  describe("sozlamalar", () => {
    it("GET /api/admin/settings joriy SoT ni qaytaradi", async () => {
      const res = await api("/api/admin/settings");
      expect(res.status).toBe(200);
      expect(["pms", "beds24"]).toContain(res.body.ratesSoT);
    });

    it("PUT bilan o'zgartiriladi va darhol kuchga kiradi", async () => {
      await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ ratesSoT: "beds24" }),
      });
      expect(await getRatesSoT()).toBe("beds24");

      await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ ratesSoT: "pms" }),
      });
      expect(await getRatesSoT()).toBe("pms");
    });

    it("noto'g'ri qiymat rad etiladi", async () => {
      const res = await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ ratesSoT: "nimadir" }),
      });
      expect(res.status).toBe(400);
    });
  });

  // --- Bir necha tur birga -----------------------------------
  describe("syncRatesRange", () => {
    it("uchala turni birga yuboradi", async () => {
      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({
          from: "2031-11-01",
          to: "2031-11-02",
          prices: { [TYPES.a]: 40, [TYPES.b]: 55, [TYPES.c]: 90 },
        }),
      });

      const result = await syncRatesRange(
        [TYPES.a, TYPES.b, TYPES.c],
        "2031-11-01",
        "2031-11-02"
      );
      expect(result.sent).toBe(3);
      expect(result.failed).toBe(0);

      expect((await pushedPrices(EXT.standard)).get("2031-11-01")).toBe(40);
      expect((await pushedPrices(EXT.double)).get("2031-11-01")).toBe(55);
      expect((await pushedPrices(EXT.deluxe)).get("2031-11-01")).toBe(90);
    });

    it("bir tur yiqilsa qolganlari yuboriladi (TZ 17-band)", async () => {
      await prisma.channelMapping.deleteMany({ where: { roomTypeId: TYPES.a } });

      await api("/api/rate-plans", {
        method: "PUT",
        body: JSON.stringify({
          from: "2031-11-10",
          to: "2031-11-10",
          prices: { [TYPES.a]: 40, [TYPES.c]: 90 },
        }),
      });

      const result = await syncRatesRange([TYPES.a, TYPES.c], "2031-11-10", "2031-11-10");
      expect(result.failed).toBe(1);
      expect(result.sent).toBe(1);
      expect((await pushedPrices(EXT.deluxe)).get("2031-11-10")).toBe(90);
    });
  });

  // --- To'lov (TZ 14-band) -----------------------------------
  describe("to'lov hisob-kitobi (TZ 14-band)", () => {
    const findRoom = async () => {
      const room = await prisma.room.findFirst({
        where: { roomTypeId: TYPES.a, isActive: true },
        orderBy: { number: "asc" },
      });
      if (!room) throw new Error("xona yo'q");
      return room;
    };

    it("to'lovsiz bron: paidAmount 0, qarz to'liq", async () => {
      const room = await findRoom();
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2031-12-01",
          checkOut: "2031-12-03",
          guestName: "Qarz Testi",
          phone: "+99892700001",
          guestPhone: "+998900000070",
          adults: 1,
          pricePerNight: 100,
        }),
      });
      expect(created.status).toBe(201);

      expect(created.body.totalPrice).toBe(200);
      expect(created.body.paidAmount).toBe(0);
      expect(created.body.remainingAmount).toBe(200);   // "Qarz bor"

      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    });

    it("qisman to'lov: qarz kamayadi", async () => {
      const room = await findRoom();
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2031-12-10",
          checkOut: "2031-12-12",
          guestName: "Qisman Testi",
          phone: "+99892700002",
          guestPhone: "+998900000071",
          adults: 1,
          pricePerNight: 100,
        }),
      });

      const paid = await api(`/api/reservations/${created.body.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: 120, method: "cash" }),
      });

      expect(paid.body.paidAmount).toBe(120);
      expect(paid.body.remainingAmount).toBe(80);

      await prisma.payment.deleteMany({ where: { reservationId: created.body.id } });
      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    });

    it("to'liq to'lov: qarz 0 — 'To'liq to'langan'", async () => {
      const room = await findRoom();
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2031-12-20",
          checkOut: "2031-12-22",
          guestName: "Toliq Testi",
          phone: "+99892700003",
          guestPhone: "+998900000072",
          adults: 1,
          pricePerNight: 100,
        }),
      });

      const paid = await api(`/api/reservations/${created.body.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: 200, method: "card" }),
      });

      expect(paid.body.paidAmount).toBe(200);
      expect(paid.body.remainingAmount).toBe(0);

      await prisma.payment.deleteMany({ where: { reservationId: created.body.id } });
      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    });

    it("xarajat qo'shilsa qarz oshadi (TZ 14-band)", async () => {
      const room = await findRoom();
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2031-12-25",
          checkOut: "2031-12-26",
          guestName: "Xarajat Testi",
          phone: "+99892700004",
          guestPhone: "+998900000073",
          adults: 1,
          pricePerNight: 100,
        }),
      });

      const withCharge = await api(`/api/reservations/${created.body.id}/charges`, {
        method: "POST",
        body: JSON.stringify({ label: "Minibar", amount: 25 }),
      });

      expect(withCharge.body.totalPrice).toBe(125);
      expect(withCharge.body.remainingAmount).toBe(125);

      await prisma.charge.deleteMany({ where: { reservationId: created.body.id } });
      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    });

    it("to'lov qaytarilsa qarz qayta oshadi", async () => {
      const room = await findRoom();
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2031-12-28",
          checkOut: "2031-12-29",
          guestName: "Qaytarish Testi",
          phone: "+99892700005",
          guestPhone: "+998900000074",
          adults: 1,
          pricePerNight: 100,
        }),
      });

      const paid = await api(`/api/reservations/${created.body.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: 100, method: "cash" }),
      });
      expect(paid.body.remainingAmount).toBe(0);

      const paymentId = paid.body.payments[0].id;
      const reversed = await api(
        `/api/reservations/${created.body.id}/payments/${paymentId}/reverse`,
        { method: "POST" }
      );

      expect(reversed.body.paidAmount).toBe(0);
      expect(reversed.body.remainingAmount).toBe(100);

      await prisma.payment.deleteMany({ where: { reservationId: created.body.id } });
      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    });
  });
});
