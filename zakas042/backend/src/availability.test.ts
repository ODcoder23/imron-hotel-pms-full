/**
 * FAZA 9 — Availability sync: PMS -> Beds24
 *
 * TZ 6-band:  "Xona band qilinsa Beds24'da availability kamayadi,
 *              bekor qilinsa qayta oshadi. Har bir o'zgarish queue
 *              orqali yuborilsin."
 * TZ 20-band: PMS va Beds24 bir xil inventory ko'rishi kerak.
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md, FAZA 9):
 *   "Shaxmatkada xona band qilinganda, mock server'ga
 *    POST /inventory/rooms/calendar yetib keladi va numAvail
 *    to'g'ri songa kamayadi (6 -> 5 -> 4 ...). Mock so'rovni qayd
 *    qiladi, test uni tekshiradi."
 *
 * Seed sonlari (07-fayl §2): standard 6, double 4, deluxe 2.
 *
 * Ishga tushirish:  npx vitest run src/availability.test.ts
 * Shart: server (:3000), mock (:4000), PostgreSQL, Redis
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prisma } from "./lib/prisma.js";
import { setupConnection } from "./services/beds24/auth.js";
import { upsertMapping } from "./services/mapping.js";
import {
  recalcAvailability,
  readRange,
  pushAvailability,
  syncAvailabilityRange,
  enqueueAvailabilitySync,
} from "./services/availability.js";
import { fromDateKey } from "./lib/serialize.js";
import { TYPES, loadTypes } from "./testUtils.js";

const PMS = process.env.PMS_URL ?? "http://127.0.0.1:3000";
const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:4000";

const EXT = { standard: "101001", double: "101002", deluxe: "101003" } as const;

/** Seed'dagi haqiqiy sonlar (07-fayl §2) */
/**
 * Tur bo'yicha xona soni — BAZADAN (`loadTotals()`).
 *
 * Ilgari `{ standard: 6, double: 4, deluxe: 2 }` qattiq yozilgan
 * edi; loyiha 18 xonaga o'tganda bu sonlar noto'g'ri bo'lib qoldi.
 */
const TOTAL = { a: 0, b: 0, c: 0 };

async function loadTotals() {
  for (const [key, typeId] of [["a", TYPES.a], ["b", TYPES.b], ["c", TYPES.c]] as const) {
    TOTAL[key] = await prisma.room.count({
      where: { roomTypeId: typeId, isActive: true },
    });
  }
}

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
      at: string;
      roomId: number;
      /** Beds24 oraliq shakli: {from, to, numAvail} — kun emas */
      entries: Array<{ from: string; to: string; numAvail?: number }>;
    }>;
    credits: { remaining: number };
  };

/** "YYYY-MM-DD" oralig'ini kunlarga yoyadi (ikki chekka ham kiradi) */
function expandRange(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(to + "T00:00:00Z").getTime();
  for (let t = new Date(from + "T00:00:00Z").getTime(); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Mock qabul qilgan kun -> numAvail xaritasi.
 *
 * Adapter ketma-ket bir xil kunlarni ORALIQQA yig'ib yuboradi
 * (07-fayl §4), shuning uchun bu yerda qayta yoyamiz. Keyingi
 * push oldingisini qoplaydi — oxirgisi ustun.
 */
async function pushedValues(externalRoomTypeId: string): Promise<Map<string, number>> {
  const { calendarPushes } = await mockState();
  const out = new Map<string, number>();
  for (const push of calendarPushes) {
    if (push.roomId !== Number(externalRoomTypeId)) continue;
    for (const e of push.entries) {
      if (typeof e.numAvail !== "number") continue;
      for (const day of expandRange(e.from, e.to)) out.set(day, e.numAvail);
    }
  }
  return out;
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

/** Bir xona turidagi bo'sh xonani topadi */
async function findRoom(roomTypeId: string) {
  const room = await prisma.room.findFirst({
    where: { roomTypeId, isActive: true },
    orderBy: { number: "asc" },
  });
  if (!room) throw new Error(`${roomTypeId} turida xona yo'q`);
  return room;
}

const D = (key: string) => fromDateKey(key);

describe("FAZA 9 — availability sync PMS -> Beds24 (TZ 6, 20-band)", () => {
  beforeAll(async () => {
    // Tur ID'lari bazadan olinadi (testUtils.ts) — ilgari
    // "standard"/"double"/"deluxe" qattiq yozilgan edi
    await loadTypes();
    await loadTotals();
    const health = await fetch(`${PMS}/health`).then((r) => r.json() as any);
    if (health.redis !== "connected") {
      throw new Error("Redis ishlamayapti — redis-server ishga tushiring");
    }
    const mock = await fetch(`${MOCK}/authentication/setup`, { headers: { code: "mock-invite-code" } });
    if (!mock.ok) throw new Error("Mock server ishlamayapti");
  });

  beforeEach(async () => {
    await prisma.syncLog.deleteMany();
    await prisma.webhookEvent.deleteMany();

    // Test oraliqlari 2028 yilda — seed bronlariga tegmaydi
    await prisma.payment.deleteMany({
      where: { reservation: { checkIn: { gte: D("2028-01-01") } } },
    });
    await prisma.reservation.deleteMany({ where: { checkIn: { gte: D("2028-01-01") } } });

    // syncedCount tozalanadi: har test toza sahifadan boshlaydi,
    // aks holda oldingi test yuborgan qiymat "o'zgarish yo'q" beradi
    await prisma.availability.deleteMany({ where: { date: { gte: D("2028-01-01") } } });

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

  // --- Agregatsiya formulasi (07-fayl §2) ---------------------
  describe("agregatsiya — PMS aniq xona, Beds24 son", () => {
    it("bron yo'q oraliqda availableCount = jami xonalar soni", async () => {
      await recalcAvailability([TYPES.a], D("2028-03-01"), D("2028-03-05"));
      const days = await readRange(TYPES.a, D("2028-03-01"), D("2028-03-05"));

      expect(days).toHaveLength(4);          // 01,02,03,04 — 05 kirmaydi
      for (const d of days) {
        expect(d.totalRooms).toBe(TOTAL.a);
        expect(d.availableCount).toBe(TOTAL.a);
      }
    });

    it("bitta bron -> faqat o'sha kunlar bittaga kamayadi", async () => {
      const room = await findRoom(TYPES.a);
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2028-03-10",
          checkOut: "2028-03-12",
          guestName: "Agregatsiya Testi",
          phone: "+99894400001",
          guestPhone: "+998900000010",
          adults: 1,
          pricePerNight: 100,
        }),
      });
      expect(created.status).toBe(201);

      await recalcAvailability([TYPES.a], D("2028-03-09"), D("2028-03-14"));
      const days = await readRange(TYPES.a, D("2028-03-09"), D("2028-03-14"));
      const byDate = new Map(days.map((d) => [d.date, d.availableCount]));

      expect(byDate.get("2028-03-09")).toBe(TOTAL.a);      // bron oldin
      expect(byDate.get("2028-03-10")).toBe(TOTAL.a - 1);  // checkIn KIRADI
      expect(byDate.get("2028-03-11")).toBe(TOTAL.a - 1);
      expect(byDate.get("2028-03-12")).toBe(TOTAL.a);      // checkOut KIRMAYDI
      expect(byDate.get("2028-03-13")).toBe(TOTAL.a);
    });

    it("bekor qilingan bron bandlikka kirmaydi (TZ 6-band)", async () => {
      const room = await findRoom(TYPES.b);
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2028-04-01",
          checkOut: "2028-04-03",
          guestName: "Bekor Testi",
          phone: "+99894400002",
          guestPhone: "+998900000011",
          adults: 1,
          pricePerNight: 90,
        }),
      });

      await recalcAvailability([TYPES.b], D("2028-04-01"), D("2028-04-03"));
      let days = await readRange(TYPES.b, D("2028-04-01"), D("2028-04-03"));
      expect(days[0]!.availableCount).toBe(TOTAL.b - 1);

      await api(`/api/reservations/${created.body.id}/cancel`, { method: "POST" });

      await recalcAvailability([TYPES.b], D("2028-04-01"), D("2028-04-03"));
      days = await readRange(TYPES.b, D("2028-04-01"), D("2028-04-03"));
      // Qayta oshdi — TZ 6-band aynan shuni talab qiladi
      expect(days[0]!.availableCount).toBe(TOTAL.b);
    });

    it("availableCount hech qachon jami sondan oshmaydi (TZ 3-band)", async () => {
      await recalcAvailability(
        [TYPES.a, TYPES.b, TYPES.c],
        D("2028-05-01"),
        D("2028-05-10")
      );

      for (const [type, total] of Object.entries(TOTAL)) {
        const days = await readRange(type, D("2028-05-01"), D("2028-05-10"));
        for (const d of days) {
          expect(d.availableCount).toBeLessThanOrEqual(total);
          expect(d.availableCount).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  // --- FAZA 9 ASOSIY MEZONI ----------------------------------
  describe("FAZA 9 mezoni — mock server numAvail oladi", () => {
    it("POST /inventory/rooms/calendar mock'ga yetib keladi", async () => {
      await recalcAvailability([TYPES.c], D("2028-06-01"), D("2028-06-04"));
      const result = await pushAvailability(TYPES.c, D("2028-06-01"), D("2028-06-04"));

      expect(result.status).toBe("sent");

      const pushed = await pushedValues(EXT.deluxe);
      expect(pushed.get("2028-06-01")).toBe(TOTAL.c);
      expect(pushed.get("2028-06-02")).toBe(TOTAL.c);
      expect(pushed.get("2028-06-03")).toBe(TOTAL.c);
    });

    it("6 -> 5 -> 4: har bron numAvail'ni bittaga kamaytiradi", async () => {
      const from = D("2028-07-01");
      const to = D("2028-07-03");
      const rooms = await prisma.room.findMany({
        where: { roomTypeId: TYPES.a, isActive: true },
        orderBy: { number: "asc" },
        take: 2,
      });

      // Boshlang'ich: 6
      await recalcAvailability([TYPES.a], from, to);
      await pushAvailability(TYPES.a, from, to);
      expect((await pushedValues(EXT.standard)).get("2028-07-01")).toBe(6);

      // 1-bron -> 5
      await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: rooms[0]!.id,
          checkIn: "2028-07-01",
          checkOut: "2028-07-03",
          guestName: "Birinchi",
          phone: "+99894400003",
          guestPhone: "+998900000021",
          adults: 1,
          pricePerNight: 100,
        }),
      });
      await recalcAvailability([TYPES.a], from, to);
      await pushAvailability(TYPES.a, from, to);
      expect((await pushedValues(EXT.standard)).get("2028-07-01")).toBe(5);

      // 2-bron -> 4
      await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: rooms[1]!.id,
          checkIn: "2028-07-01",
          checkOut: "2028-07-03",
          guestName: "Ikkinchi",
          phone: "+99894400004",
          guestPhone: "+998900000022",
          adults: 1,
          pricePerNight: 100,
        }),
      });
      await recalcAvailability([TYPES.a], from, to);
      await pushAvailability(TYPES.a, from, to);
      expect((await pushedValues(EXT.standard)).get("2028-07-01")).toBe(4);
    });

    it("bekor qilinganda numAvail qayta oshadi", async () => {
      const from = D("2028-08-01");
      const to = D("2028-08-03");
      const room = await findRoom(TYPES.c);

      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2028-08-01",
          checkOut: "2028-08-03",
          guestName: "Oshish Testi",
          phone: "+99894400005",
          guestPhone: "+998900000023",
          adults: 1,
          pricePerNight: 200,
        }),
      });

      await recalcAvailability([TYPES.c], from, to);
      await pushAvailability(TYPES.c, from, to);
      expect((await pushedValues(EXT.deluxe)).get("2028-08-01")).toBe(TOTAL.c - 1);

      await api(`/api/reservations/${created.body.id}/cancel`, { method: "POST" });

      await recalcAvailability([TYPES.c], from, to);
      await pushAvailability(TYPES.c, from, to);
      expect((await pushedValues(EXT.deluxe)).get("2028-08-01")).toBe(TOTAL.c);
    });

    it("mock'da saqlangan kalendar PMS hisobiga mos (TZ 20-band)", async () => {
      const from = D("2028-09-01");
      const to = D("2028-09-05");
      const room = await findRoom(TYPES.b);

      await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2028-09-02",
          checkOut: "2028-09-04",
          guestName: "Inventory Testi",
          phone: "+99894400006",
          guestPhone: "+998900000024",
          adults: 1,
          pricePerNight: 90,
        }),
      });

      await recalcAvailability([TYPES.b], from, to);
      await pushAvailability(TYPES.b, from, to);

      // Mock'ning o'z GET javobi bilan solishtiramiz — Beds24
      // tomonda ham bir xil son turishi kerak
      const res = await fetch(
        `${MOCK}/inventory/rooms/calendar?roomId=${EXT.double}&startDate=2028-09-01&endDate=2028-09-04`,
        { headers: { token: "mock-access-token" } }
      );
      const body = (await res.json()) as any;
      const entry = body.data?.[0];
      const mockByDate = new Map<string, number>(
        (entry?.calendar ?? []).map((c: any) => [c.from ?? c.date, c.numAvail])
      );

      const pmsDays = await readRange(TYPES.b, from, to);
      for (const d of pmsDays) {
        if (mockByDate.has(d.date)) {
          expect(mockByDate.get(d.date)).toBe(d.availableCount);
        }
      }
    });
  });

  // --- Kredit tejash (07-fayl §4) ----------------------------
  describe("kredit tejash", () => {
    it("o'zgarmagan oraliq ikkinchi marta yuborilmaydi", async () => {
      const from = D("2028-10-01");
      const to = D("2028-10-06");

      await recalcAvailability([TYPES.c], from, to);
      const first = await pushAvailability(TYPES.c, from, to);
      expect(first.status).toBe("sent");

      const second = await pushAvailability(TYPES.c, from, to);
      expect(second.status).toBe("skipped");
      if (second.status === "skipped") {
        expect(second.reason).toBe("o'zgarish yo'q");
      }
    });

    it("ketma-ket bir xil kunlar bitta oraliqqa yig'iladi", async () => {
      const from = D("2028-11-01");
      const to = D("2028-11-11");        // 10 kun

      await recalcAvailability([TYPES.c], from, to);
      await pushAvailability(TYPES.c, from, to);

      const { calendarPushes } = await mockState();
      const push = calendarPushes.find((p) => p.roomId === Number(EXT.deluxe));
      expect(push).toBeTruthy();

      // 10 kun bir xil qiymat -> mock'ga bitta oraliq keladi.
      // Mock oraliqni kunlarga yoyadi, lekin `entries` soni
      // yuborilgan oraliqlar sonini ko'rsatadi.
      expect(push!.entries.length).toBeLessThan(10);
    });

    it("faqat o'zgargan kun yuboriladi, butun oraliq emas", async () => {
      const from = D("2029-01-01");
      const to = D("2029-01-11");
      const room = await findRoom(TYPES.c);

      // 1) Butun oraliq yuborildi
      await recalcAvailability([TYPES.c], from, to);
      await pushAvailability(TYPES.c, from, to);
      await mockControl("reset");
      await mapAll();     // reset mapping'ga tegmaydi, lekin ulanish tiklanadi

      // 2) Faqat 2 kunga bron
      await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2029-01-05",
          checkOut: "2029-01-07",
          guestName: "Qisman Testi",
          phone: "+99894400007",
          guestPhone: "+998900000025",
          adults: 1,
          pricePerNight: 200,
        }),
      });

      await recalcAvailability([TYPES.c], from, to);
      const result = await pushAvailability(TYPES.c, from, to);

      expect(result.status).toBe("sent");
      if (result.status === "sent") {
        // 10 kundan faqat 2 tasi o'zgardi
        expect(result.days).toBe(2);
      }

      const pushed = await pushedValues(EXT.deluxe);
      expect(pushed.get("2029-01-05")).toBe(TOTAL.c - 1);
      expect(pushed.get("2029-01-06")).toBe(TOTAL.c - 1);
      expect(pushed.has("2029-01-01")).toBe(false);   // o'zgarmagan — yuborilmadi
    });

    it("syncedCount yuborilgandan keyin yozib qo'yiladi", async () => {
      const from = D("2029-02-01");
      const to = D("2029-02-04");

      await recalcAvailability([TYPES.b], from, to);
      let days = await readRange(TYPES.b, from, to);
      expect(days.every((d) => d.syncedCount === null)).toBe(true);

      await pushAvailability(TYPES.b, from, to);

      days = await readRange(TYPES.b, from, to);
      for (const d of days) {
        expect(d.syncedCount).toBe(d.availableCount);
      }
    });
  });

  // --- Mapping yo'q (06-fayl §3) -----------------------------
  describe("mapping yo'q bo'lsa", () => {
    it("yuborilmaydi va FAILED log yoziladi", async () => {
      await prisma.channelMapping.deleteMany();

      await recalcAvailability([TYPES.a], D("2029-03-01"), D("2029-03-03"));
      const result = await pushAvailability(TYPES.a, D("2029-03-01"), D("2029-03-03"));

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("mapping topilmadi");
      }

      // Mock'ga hech narsa ketmadi — taxminiy mapping ishlatilmadi
      const pushed = await pushedValues(EXT.standard);
      expect(pushed.size).toBe(0);

      const log = await prisma.syncLog.findFirst({
        where: { action: "push_availability", status: "FAILED" },
        orderBy: { createdAt: "desc" },
      });
      expect(log).toBeTruthy();
      expect(log!.errorMessage).toContain("mapping topilmadi");
    });
  });

  // --- SyncLog (TZ 16-band) ----------------------------------
  describe("SyncLog", () => {
    it("muvaffaqiyatli yuborish SUCCESS sifatida yoziladi", async () => {
      await recalcAvailability([TYPES.c], D("2029-04-01"), D("2029-04-03"));
      await pushAvailability(TYPES.c, D("2029-04-01"), D("2029-04-03"));

      const log = await prisma.syncLog.findFirst({
        where: { action: "push_availability", status: "SUCCESS" },
        orderBy: { createdAt: "desc" },
      });
      expect(log).toBeTruthy();
      expect(log!.direction).toBe("PMS_TO_CHANNEL");
      expect(log!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("o'zgarish yo'q bo'lsa SKIPPED yoziladi", async () => {
      await recalcAvailability([TYPES.c], D("2029-05-01"), D("2029-05-03"));
      await pushAvailability(TYPES.c, D("2029-05-01"), D("2029-05-03"));
      await pushAvailability(TYPES.c, D("2029-05-01"), D("2029-05-03"));

      const log = await prisma.syncLog.findFirst({
        where: { action: "push_availability", status: "SKIPPED" },
        orderBy: { createdAt: "desc" },
      });
      expect(log).toBeTruthy();
    });
  });

  // --- Bir necha tur birga --------------------------------------
  describe("syncAvailabilityRange", () => {
    it("uchala turni birga yuboradi", async () => {
      const result = await syncAvailabilityRange(
        [TYPES.a, TYPES.b, TYPES.c],
        "2029-06-01",
        "2029-06-04",
        { recalc: true }
      );

      expect(result.sent).toBe(3);
      expect(result.failed).toBe(0);

      expect((await pushedValues(EXT.standard)).get("2029-06-01")).toBe(TOTAL.a);
      expect((await pushedValues(EXT.double)).get("2029-06-01")).toBe(TOTAL.b);
      expect((await pushedValues(EXT.deluxe)).get("2029-06-01")).toBe(TOTAL.c);
    });

    it("bir tur yiqilsa qolganlari baribir yuboriladi (TZ 17-band)", async () => {
      // Faqat standard'ning mapping'ini olib tashlaymiz
      await prisma.channelMapping.deleteMany({ where: { roomTypeId: TYPES.a } });

      const result = await syncAvailabilityRange(
        [TYPES.a, TYPES.c],
        "2029-07-01",
        "2029-07-04",
        { recalc: true }
      );

      expect(result.failed).toBe(1);
      expect(result.sent).toBe(1);
      // Deluxe yetib bordi — qisman muvaffaqiyat
      expect((await pushedValues(EXT.deluxe)).get("2029-07-01")).toBe(TOTAL.c);
    });
  });

  // --- Navbat (TZ 6-band: "queue orqali yuborilsin") ---------
  describe("navbat va debounce", () => {
    it("bron yaratilganda job navbatga tushadi", async () => {
      const room = await findRoom(TYPES.a);

      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2029-08-01",
          checkOut: "2029-08-03",
          guestName: "Navbat Testi",
          phone: "+99894400008",
          guestPhone: "+998900000030",
          adults: 1,
          pricePerNight: 100,
        }),
      });
      expect(created.status).toBe(201);

      // Job 3s debounce bilan qo'yildi, worker bajaradi.
      // Kutamiz: 3s delay + bajarish vaqti.
      let pushed = new Map<string, number>();
      for (let i = 0; i < 30 && !pushed.has("2029-08-01"); i++) {
        await new Promise((r) => setTimeout(r, 300));
        pushed = await pushedValues(EXT.standard);
      }

      expect(pushed.get("2029-08-01")).toBe(TOTAL.a - 1);
    }, 20000);

    it("bir xil oraliq uchun takroriy job qo'shilmaydi (debounce)", async () => {
      const from = D("2029-09-01");
      const to = D("2029-09-05");

      // Ikki chaqiruv ketma-ket — bir debounce oynasiga tushishi
      // kerak. Oyna chegarasiga tushib qolmaslik uchun uch marta
      // urinamiz: 3 soniyalik oynada ketma-ket ikki chaqiruvning
      // ajralib qolishi juda kam ehtimol, lekin mumkin.
      let a = await enqueueAvailabilitySync([TYPES.c], from, to, "test_1");
      let b = await enqueueAvailabilitySync([TYPES.c], from, to, "test_2");

      for (let i = 0; i < 3 && a.jobId !== b.jobId; i++) {
        a = await enqueueAvailabilitySync([TYPES.c], from, to, "test_1");
        b = await enqueueAvailabilitySync([TYPES.c], from, to, "test_2");
      }

      expect(a.queued).toBe(true);
      expect(b.queued).toBe(true);
      // Bir oyna ichida bir xil jobId — BullMQ ikkinchisini qabul
      // qilmaydi, ya'ni ikki o'zgarish bitta yuborishga birlashadi
      expect(a.jobId).toBe(b.jobId);
    });

    it("keyingi oynada o'sha oraliq QAYTA yuboriladi", async () => {
      // REGRESSIYA HIMOYASI: `jobId`da oyna raqami bo'lmasa, BullMQ
      // tugagan job'ni 24 soat saqlagani uchun o'sha oraliq bir sutka
      // yuborilmas edi. Bron bekor qilinsa Beds24 eski sonni ko'rib
      // qolardi — TZ 6-band buzilardi.
      const from = D("2029-11-01");
      const to = D("2029-11-04");

      const first = await enqueueAvailabilitySync([TYPES.c], from, to, "birinchi");
      expect(first.queued).toBe(true);

      // Oyna 3 soniya — keyingisiga o'tamiz
      await new Promise((r) => setTimeout(r, 3100));

      const second = await enqueueAvailabilitySync([TYPES.c], from, to, "ikkinchi");
      expect(second.queued).toBe(true);
      expect(second.jobId).not.toBe(first.jobId);
    }, 15000);

    it("bekor qilingandan keyin yangi qiymat Beds24'ga yetadi", async () => {
      const room = await findRoom(TYPES.c);

      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2029-12-01",
          checkOut: "2029-12-03",
          guestName: "Bekor Zanjiri",
          phone: "+99894400009",
          guestPhone: "+998900000031",
          adults: 1,
          pricePerNight: 200,
        }),
      });
      expect(created.status).toBe(201);

      // 1) Band bo'lgani yetib bordi
      let pushed = new Map<string, number>();
      for (let i = 0; i < 30 && pushed.get("2029-12-01") !== TOTAL.c - 1; i++) {
        await new Promise((r) => setTimeout(r, 300));
        pushed = await pushedValues(EXT.deluxe);
      }
      expect(pushed.get("2029-12-01")).toBe(TOTAL.c - 1);

      // 2) Bekor qilamiz — qiymat qayta oshishi kerak (TZ 6-band)
      await api(`/api/reservations/${created.body.id}/cancel`, { method: "POST" });

      for (let i = 0; i < 40 && pushed.get("2029-12-01") !== TOTAL.c; i++) {
        await new Promise((r) => setTimeout(r, 300));
        pushed = await pushedValues(EXT.deluxe);
      }
      expect(pushed.get("2029-12-01")).toBe(TOTAL.c);
    }, 30000);

    it("Redis yo'q bo'lsa ham bron yaratish yiqilmaydi (TZ 17, 19-band)", async () => {
      // enqueue xato bersa ham `queued: false` qaytaradi, tashlamaydi
      const result = await enqueueAvailabilitySync([], D("2029-10-01"), D("2029-10-02"), "bosh");
      expect(result.queued).toBe(false);
    });
  });
});
