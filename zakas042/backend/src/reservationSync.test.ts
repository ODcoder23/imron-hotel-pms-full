/**
 * FAZA 10 — Reservation sync: PMS -> Beds24
 *
 * TZ 2-band: Shaxmatkadagi SAKKIZ amal Beds24 bilan sinxronlanadi.
 * TZ 8-band: oltita status qo'llab-quvvatlanadi.
 * Mijoz qarorlari: Q6 (xona almashsa Beds24'da ham), Q7 (check-in/out).
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md, FAZA 10):
 *   "Sakkiz amalning har biri mock server'ga yetib keladi va to'g'ri
 *    payload bilan; echo loop testida cheksiz halqa yuzaga kelmaydi."
 *
 * Mock POST /bookings dan keyin webhook QAYTARADI — ya'ni echo loop
 * bu yerda haqiqiy sharoitda sinaladi, sun'iy emas.
 *
 * Ishga tushirish:  npx vitest run src/reservationSync.test.ts
 * Shart: server (:3000), mock (:4000), PostgreSQL, Redis
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prisma } from "./lib/prisma.js";
import { setupConnection } from "./services/beds24/auth.js";
import { upsertMapping } from "./services/mapping.js";
import {
  pushReservation,
  splitName,
  nights,
  resyncFailed,
} from "./services/reservationSync.js";
import { toBeds24Status, toPmsStatus, roundTripsCleanly } from "./services/beds24/statusMap.js";
import type { ReservationStatus } from "@prisma/client";
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
    bookings: Array<Record<string, any>>;
    webhooksSent: Array<Record<string, any>>;
  };

/** Beds24 tomondagi bronni id bo'yicha topadi */
async function mockBooking(externalId: string | null | undefined) {
  if (!externalId) return null;
  const { bookings } = await mockState();
  return bookings.find((b) => String(b.id) === String(externalId)) ?? null;
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

async function findRoom(roomTypeId: string, skip = 0) {
  const rooms = await prisma.room.findMany({
    where: { roomTypeId, isActive: true },
    orderBy: { number: "asc" },
    take: skip + 1,
  });
  const room = rooms[skip];
  if (!room) throw new Error(`${roomTypeId} turida ${skip + 1}-xona yo'q`);
  return room;
}

/**
 * Test broni yaratadi va Beds24'ga yetib borishini kutadi.
 *
 * MUHIM: bron yaratilishi bilan WORKER ham uni yuboradi (FAZA 10
 * trigger'i). Shuning uchun bu yerda qo'lda `pushReservation`
 * CHAQIRILMAYDI — aks holda ikkalasi parallel ishlab, Beds24'da
 * ikkinchi booking paydo bo'lishi mumkin. Worker tugashini kutamiz.
 */
async function createSynced(over: Record<string, unknown> = {}) {
  const room = await findRoom(TYPES.a);
  const created = await api("/api/reservations", {
    method: "POST",
    body: JSON.stringify({
      roomId: room.id,
      checkIn: "2030-03-01",
      checkOut: "2030-03-04",
      guestName: "Sync Testi",
      phone: "+99895600001",
      guestPhone: "+998900000050",
      adults: 2,
      pricePerNight: 100,
      ...over,
    }),
  });
  if (created.status !== 201) throw new Error(`bron yaratilmadi: ${JSON.stringify(created.body)}`);

  const id = created.body.id as string;
  const externalId = await waitForSync(id);
  return { id, externalId, room };
}

/** Worker bronni Beds24'ga yuborgunicha kutadi */
async function waitForSync(id: string, timeoutMs = 12000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const fresh = await prisma.reservation.findUniqueOrThrow({ where: { id } });
    if (fresh.externalReservationId) return fresh.externalReservationId;
    if (Date.now() >= deadline) {
      // Worker ishlamayapti (Redis yo'q?) — qo'lda yuboramiz
      const outcome = await pushReservation(id);
      if (outcome.status !== "sent") {
        throw new Error(`yuborilmadi: ${JSON.stringify(outcome)}`);
      }
      const after = await prisma.reservation.findUniqueOrThrow({ where: { id } });
      if (!after.externalReservationId) throw new Error("externalReservationId yozilmadi");
      return after.externalReservationId;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Amaldan keyin worker yangilashini kutadi — `check` rost bo'lguncha */
/**
 * Shart bajarilishini kutadi.
 *
 * MUHIM: worker job'ni `UnrecoverableError` bilan tashlagan bo'lishi
 * mumkin — masalan oldingi test fayli mapping'ni o'chirib qoldirgan
 * va job mapping tiklanishidan OLDIN ishga tushgan. Bunday job
 * o'lik xatga tushadi va hech qachon qayta urinmaydi.
 *
 * Shuning uchun kutish davomida vaqti-vaqti bilan qo'lda turtki
 * beramiz: `pushReservation` idempotent (12-fayl §2), ya'ni ortiqcha
 * chaqiruv zarar qilmaydi — DB'dagi joriy holat yuboriladi.
 */
async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 12000,
  nudge?: () => Promise<unknown>
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let ticks = 0;

  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;

    // Har ~2 soniyada bir marta
    if (nudge && ++ticks % 10 === 0) {
      await nudge().catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("FAZA 10 — reservation sync PMS -> Beds24 (TZ 2, 8-band)", () => {
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

    // Test oraliqlari 2030 yilda — boshqa testlarga tegmaydi
    const from = new Date("2030-01-01T00:00:00Z");
    await prisma.payment.deleteMany({ where: { reservation: { checkIn: { gte: from } } } });
    await prisma.reservation.deleteMany({ where: { checkIn: { gte: from } } });
    await prisma.availability.deleteMany({ where: { date: { gte: from } } });

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

  // --- Status mapping (TZ 8-band, 08-fayl §2) ------------------
  describe("status mapping — markaziy fayl", () => {
    it("oltita PMS statusi Beds24 qiymatiga map qilinadi", () => {
      expect(toBeds24Status("PENDING_PAYMENT")).toEqual({ status: "request" });
      expect(toBeds24Status("CONFIRMED")).toEqual({ status: "confirmed" });
      expect(toBeds24Status("CHECKED_IN")).toEqual({ status: "confirmed", subStatus: "arrived" });
      expect(toBeds24Status("CHECKED_OUT")).toEqual({ status: "confirmed", subStatus: "departed" });
      expect(toBeds24Status("CANCELLED")).toEqual({ status: "cancelled" });
      expect(toBeds24Status("NO_SHOW")).toEqual({ status: "black" });
    });

    it("PMS -> Beds24 -> PMS aylanishi statusni buzmaydi", () => {
      // Aks holda bron yuborilgandan keyin webhook qaytganda status
      // o'zgarib ketadi va cheksiz o'zgarish halqasi boshlanadi
      const all: ReservationStatus[] = [
        "PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN",
        "CHECKED_OUT", "CANCELLED", "NO_SHOW",
      ];
      for (const s of all) {
        expect(roundTripsCleanly(s), `${s} aylanishda buzildi`).toBe(true);
      }
    });

    it("check-in/check-out subStatus orqali beriladi (Q7)", () => {
      // Beds24'da alohida status yo'q — ikkalasi ham confirmed
      expect(toBeds24Status("CHECKED_IN").status).toBe("confirmed");
      expect(toBeds24Status("CHECKED_OUT").status).toBe("confirmed");
      expect(toBeds24Status("CHECKED_IN").subStatus).not.toBe(
        toBeds24Status("CHECKED_OUT").subStatus
      );
    });

    it("noma'lum Beds24 statusi CONFIRMED ga tushadi (TZ 17-band)", () => {
      const ext = {
        externalId: "1", externalRoomTypeId: "1", status: "nimadir_yangi",
        checkIn: "2030-01-01", checkOut: "2030-01-02", adults: 1, children: 0,
        price: 0, currency: "USD", guest: { fullName: "x" },
        modifiedAt: new Date().toISOString(),
      };
      // Bronni yo'qotgandan ko'ra tasdiqlangan deb qabul qilish yaxshi
      expect(toPmsStatus(ext)).toBe("CONFIRMED");
    });
  });

  // --- Yordamchi funksiyalar ---------------------------------
  describe("payload yordamchilari", () => {
    it("ism first/last ga ajratiladi", () => {
      expect(splitName("Aziz Karimov")).toEqual({ first: "Aziz", last: "Karimov" });
      expect(splitName("Aziz Karim Ogli")).toEqual({ first: "Aziz", last: "Karim Ogli" });
    });

    it("bir so'zli ismda familiya bo'sh qolmaydi", () => {
      // Beds24 bo'sh lastName'ni rad etadi
      const r = splitName("Aziz");
      expect(r.first).toBe("Aziz");
      expect(r.last.length).toBeGreaterThan(0);
    });

    it("kechalar '[)' qoidasi bo'yicha sanaladi", () => {
      expect(nights(new Date("2030-03-01"), new Date("2030-03-04"))).toBe(3);
      expect(nights(new Date("2030-03-01"), new Date("2030-03-02"))).toBe(1);
    });
  });

  // --- FAZA 10 ASOSIY MEZONI: sakkiz amal --------------------
  describe("FAZA 10 mezoni — sakkiz amal mock'ga yetib keladi", () => {
    it("1. Yangi bron yaratish -> Beds24'da booking paydo bo'ladi", async () => {
      const { id, externalId } = await createSynced();

      expect(externalId).toBeTruthy();

      const booking = await mockBooking(externalId);
      expect(booking).toBeTruthy();
      expect(booking!.arrival).toBe("2030-03-01");
      expect(booking!.departure).toBe("2030-03-04");
      expect(booking!.numAdult).toBe(2);
      expect(booking!.price).toBe(300);          // 100 x 3 kecha
      expect(booking!.firstName).toBe("Sync");
      expect(booking!.lastName).toBe("Testi");
      expect(booking!.referer).toBe("PMS");      // echo belgisi

      const fresh = await prisma.reservation.findUniqueOrThrow({ where: { id } });
      expect(fresh.syncStatus).toBe("SYNCED");
      expect(fresh.lastSyncedAt).toBeTruthy();
    }, 25000);

    it("2. Bronni o'zgartirish -> mehmon soni va narx yangilanadi", async () => {
      const { id, externalId } = await createSynced();

      await api(`/api/reservations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ adults: 3, pricePerNight: 150 }),
      });

      // Worker o'zi yuboradi (TZ 2-band: "queue orqali")
      const ok = await waitFor(
        async () => {
          const b = await mockBooking(externalId);
          return b?.numAdult === 3;
        },
        12000,
        () => pushReservation(id)
      );
      expect(ok, "numAdult Beds24'ga yetmadi").toBe(true);

      const booking = await mockBooking(externalId);
      expect(booking!.price).toBe(450);          // 150 x 3 kecha
    }, 25000);

    it("3. Xonani almashtirish -> Beds24'da ham ko'rinadi (Q6)", async () => {
      const { id, externalId } = await createSynced();
      const deluxe = await findRoom(TYPES.c);

      const res = await api(`/api/reservations/${id}/change-room`, {
        method: "POST",
        body: JSON.stringify({ roomId: deluxe.id }),
      });
      expect(res.status).toBe(200);

      const ok = await waitFor(
        async () => {
          const b = await mockBooking(externalId);
          return String(b?.roomId) === EXT.deluxe;
        },
        12000,
        () => pushReservation(id)
      );
      // Tur o'zgardi -> Beds24'dagi roomId ham o'zgarishi kerak
      expect(ok, "roomId Beds24'da yangilanmadi").toBe(true);
    }, 25000);

    it("4. Sanani o'zgartirish -> arrival/departure yangilanadi", async () => {
      const { id, externalId } = await createSynced();

      await api(`/api/reservations/${id}/change-dates`, {
        method: "POST",
        body: JSON.stringify({ checkIn: "2030-03-10", checkOut: "2030-03-15" }),
      });

      const ok = await waitFor(
        async () => {
          const b = await mockBooking(externalId);
          return b?.arrival === "2030-03-10";
        },
        12000,
        () => pushReservation(id)
      );
      expect(ok, "sanalar Beds24'ga yetmadi").toBe(true);

      const booking = await mockBooking(externalId);
      expect(booking!.departure).toBe("2030-03-15");
      expect(booking!.price).toBe(500);          // 100 x 5 kecha
    }, 25000);

    it("5. Mehmon soni -> numAdult/numChild", async () => {
      const { id, externalId } = await createSynced();

      await api(`/api/reservations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ adults: 1, children: 2 }),
      });

      const ok = await waitFor(
        async () => {
          const b = await mockBooking(externalId);
          return b?.numAdult === 1 && b?.numChild === 2;
        },
        12000,
        () => pushReservation(id)
      );
      expect(ok, "mehmon soni Beds24'ga yetmadi").toBe(true);
    }, 25000);

    it("6. Narxni o'zgartirish -> price", async () => {
      const { id, externalId } = await createSynced();

      await api(`/api/reservations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ pricePerNight: 250 }),
      });

      const ok = await waitFor(
        async () => {
          const b = await mockBooking(externalId);
          return b?.price === 750;               // 250 x 3 kecha
        },
        12000,
        () => pushReservation(id)
      );
      expect(ok, "narx Beds24'ga yetmadi").toBe(true);
    }, 25000);

    it("7. Bekor qilish -> status cancelled", async () => {
      const { id, externalId } = await createSynced();

      await api(`/api/reservations/${id}/cancel`, { method: "POST" });

      const ok = await waitFor(
        async () => {
          const b = await mockBooking(externalId);
          return b?.status === "cancelled";
        },
        12000,
        () => pushReservation(id)
      );
      expect(ok, "bekor qilish Beds24'ga yetmadi").toBe(true);
    }, 25000);

    it("8. Check-in -> subStatus arrived, check-out -> departed (Q7)", async () => {
      const { id, externalId } = await createSynced();

      await api(`/api/reservations/${id}/check-in`, { method: "POST" });

      let ok = await waitFor(
        async () => {
          const b = await mockBooking(externalId);
          return b?.subStatus === "arrived";
        },
        12000,
        () => pushReservation(id)
      );
      expect(ok, "check-in Beds24'ga yetmadi").toBe(true);
      expect((await mockBooking(externalId))!.status).toBe("confirmed");

      await api(`/api/reservations/${id}/check-out`, { method: "POST" });

      ok = await waitFor(
        async () => {
          const b = await mockBooking(externalId);
          return b?.subStatus === "departed";
        },
        12000,
        () => pushReservation(id)
      );
      expect(ok, "check-out Beds24'ga yetmadi").toBe(true);
      expect((await mockBooking(externalId))!.status).toBe("confirmed");
    }, 25000);

    it("no-show -> status black (08-fayl §2)", async () => {
      const { id, externalId } = await createSynced();

      await api(`/api/reservations/${id}/no-show`, { method: "POST" });

      const ok = await waitFor(
        async () => {
          const b = await mockBooking(externalId);
          return b?.status === "black";
        },
        12000,
        () => pushReservation(id)
      );
      expect(ok, "no-show Beds24'ga yetmadi").toBe(true);
    }, 25000);
  });

  // --- Echo loop (12-fayl §3) --------------------------------
  describe("echo loop himoyasi", () => {
    it("yuborilgan bron referer=PMS belgisi bilan ketadi", async () => {
      const { externalId } = await createSynced();
      const booking = await mockBooking(externalId);
      expect(booking!.referer).toBe("PMS");
    });

    it("mock qaytargan webhook yangi bron YARATMAYDI", async () => {
      const before = await prisma.reservation.count();

      const { id } = await createSynced();

      // Mock POST /bookings dan keyin webhook qaytaradi (150ms).
      // Echo himoyasi ishlamasa PMS ikkinchi bron yaratadi.
      await new Promise((r) => setTimeout(r, 2500));

      const after = await prisma.reservation.count();
      expect(after).toBe(before + 1);        // faqat bittasi — o'zimiznikisi

      // Bron o'zi joyida turibdi
      const still = await prisma.reservation.findUnique({ where: { id } });
      expect(still).toBeTruthy();
    }, 15000);

    it("echo webhook 'skipped' deb belgilanadi, ishlanmaydi", async () => {
      await createSynced();
      await new Promise((r) => setTimeout(r, 2500));

      const events = await prisma.webhookEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
      });

      // Echo kelgan bo'lsa u SKIPPED/IGNORED bo'lishi kerak.
      // Hech qanday event xato bermasligi ham muhim.
      expect(events.every((e) => e.status !== "FAILED")).toBe(true);

      // Eng muhimi: OTA broni yaratilmagan (biznikini echo deb
      // qabul qilib ikkinchi nusxa chiqmagan)
      const otaCount = await prisma.reservation.count({
        where: { externalReservationId: { not: null }, source: { not: "DIRECT" } },
      });
      expect(otaCount).toBe(0);
    }, 15000);

    it("o'zgartirish -> echo -> qayta o'zgartirish halqasi yo'q", async () => {
      const { id, externalId } = await createSynced();

      await api(`/api/reservations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ adults: 3 }),
      });
      await pushReservation(id);

      // Halqa bo'lsa mock'da bron soni yoki webhook soni o'sib ketadi
      await new Promise((r) => setTimeout(r, 2500));

      const { bookings, webhooksSent } = await mockState();
      expect(bookings).toHaveLength(1);
      // Ikki push -> ko'pi bilan ikki webhook. Halqada o'nlab bo'lardi.
      expect(webhooksSent.length).toBeLessThanOrEqual(4);

      const booking = await mockBooking(externalId);
      expect(booking!.numAdult).toBe(3);
    }, 15000);
  });

  // --- Idempotentlik (12-fayl §2) ----------------------------
  describe("idempotentlik", () => {
    it("ikki marta yuborish bitta booking yaratadi", async () => {
      const { id, externalId } = await createSynced();

      // Qo'shimcha ikki push — worker allaqachon bir marta yuborgan
      await pushReservation(id);
      await pushReservation(id);

      const { bookings } = await mockState();
      // Uchala yuborish ham bitta booking'ni yangiladi
      expect(bookings).toHaveLength(1);
      expect(String(bookings[0]!.id)).toBe(String(externalId));
    }, 25000);

    it("PARALLEL ikki push bitta booking yaratadi (poyga himoyasi)", async () => {
      // REGRESSIYA HIMOYASI: advisory lock bo'lmasa ikkala chaqiruv
      // ham `externalReservationId` bo'sh deb ko'radi va Beds24'da
      // IKKITA booking yaratadi — mehmon ikki marta band qilingan
      // bo'lib chiqadi, bu esa real overbooking.
      const room = await findRoom(TYPES.c);
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2030-04-10",
          checkOut: "2030-04-12",
          guestName: "Poyga Testi",
          phone: "+99895600002",
          guestPhone: "+998900000060",
          adults: 1,
          pricePerNight: 200,
        }),
      });
      expect(created.status).toBe(201);

      // Worker ham shu bronni yuborishi mumkin — hammasi birga
      const results = await Promise.all([
        pushReservation(created.body.id),
        pushReservation(created.body.id),
        pushReservation(created.body.id),
      ]);

      expect(results.every((r) => r.status === "sent")).toBe(true);

      // ASOSIY TEKSHIRUV: nechta push bo'lishidan qat'i nazar,
      // Beds24 tomonda shu mehmon uchun FAQAT BITTA booking.
      //
      // `created` bayrog'ini sanamaymiz: worker ham shu bronni
      // yuborgan bo'lishi mumkin va yaratish undan oldin bo'lib
      // ketadi. Muhimi — dublikat yo'qligi.
      const { bookings } = await mockState();
      const forThisGuest = bookings.filter((b) => b.firstName === "Poyga");
      expect(forThisGuest).toHaveLength(1);

      const fresh = await prisma.reservation.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(fresh.externalReservationId).toBeTruthy();
      // PMS'dagi id Beds24'dagi yagona booking bilan bir xil
      expect(String(forThisGuest[0]!.id)).toBe(String(fresh.externalReservationId));
    }, 20000);

    it("worker DB'dagi JORIY holatni yuboradi, eski nusxani emas", async () => {
      const { id, externalId } = await createSynced();

      // Job navbatda turganini simulyatsiya qilamiz: bron yana o'zgardi
      await api(`/api/reservations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ adults: 4 }),
      });
      await api(`/api/reservations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ adults: 1 }),
      });

      // Endi yuboramiz — oxirgi holat ketishi kerak
      await pushReservation(id);

      const ok = await waitFor(async () => {
        const b = await mockBooking(externalId);
        return b?.numAdult === 1;
      });
      expect(ok, "oxirgi holat yuborilmadi").toBe(true);
    }, 25000);
  });

  // --- Mapping yo'q (06-fayl §3) -----------------------------
  describe("mapping yo'q bo'lsa", () => {
    it("yuborilmaydi, syncStatus NOT_APPLICABLE bo'ladi", async () => {
      await prisma.channelMapping.deleteMany();

      const room = await findRoom(TYPES.a);
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2030-05-01",
          checkOut: "2030-05-03",
          guestName: "Mapping Yoq",
          phone: "+99895600003",
          guestPhone: "+998900000051",
          adults: 1,
          pricePerNight: 100,
        }),
      });
      expect(created.status).toBe(201);       // PMS'da bron ISHLAYDI

      const outcome = await pushReservation(created.body.id);
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.retryable).toBe(false);   // qayta urinish foydasiz
        expect(outcome.error).toContain("mapping topilmadi");
      }

      const fresh = await prisma.reservation.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(fresh.syncStatus).toBe("NOT_APPLICABLE");
      expect(fresh.externalReservationId).toBeNull();

      const { bookings } = await mockState();
      expect(bookings).toHaveLength(0);        // taxminiy mapping ishlatilmadi
    });

    it("mapping tuzatilgach resyncFailed qayta yuboradi", async () => {
      await prisma.channelMapping.deleteMany();

      const room = await findRoom(TYPES.a);
      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2030-06-01",
          checkOut: "2030-06-03",
          guestName: "Resync Testi",
          phone: "+99895600004",
          guestPhone: "+998900000052",
          adults: 1,
          pricePerNight: 100,
        }),
      });
      await pushReservation(created.body.id);

      // Admin mapping'ni bog'ladi
      await mapAll();

      const result = await resyncFailed();
      expect(result.sent).toBeGreaterThanOrEqual(1);

      const fresh = await prisma.reservation.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(fresh.syncStatus).toBe("SYNCED");
      expect(fresh.externalReservationId).toBeTruthy();
    });
  });

  // --- SyncLog (TZ 16-band) ----------------------------------
  describe("SyncLog", () => {
    it("yuborish SUCCESS sifatida yoziladi, reservationId bilan", async () => {
      const { id } = await createSynced();

      const log = await prisma.syncLog.findFirst({
        where: { action: "push_reservation", status: "SUCCESS", reservationId: id },
        orderBy: { createdAt: "desc" },
      });
      expect(log).toBeTruthy();
      expect(log!.direction).toBe("PMS_TO_CHANNEL");
    });

    it("log'da token/parol saqlanmaydi (TZ 18-band)", async () => {
      await createSynced();

      const logs = await prisma.syncLog.findMany({ take: 10 });
      const text = JSON.stringify(logs).toLowerCase();
      expect(text).not.toContain("mock-access-token");
      expect(text).not.toContain("refreshtoken");
    });
  });

  // --- Navbat orqali (TZ 2-band: "queue orqali") -------------
  describe("navbat orqali avtomatik yuborish", () => {
    it("bron yaratilganda worker o'zi Beds24'ga yuboradi", async () => {
      const room = await findRoom(TYPES.b);

      const created = await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2030-07-01",
          checkOut: "2030-07-03",
          guestName: "Navbat Broni",
          phone: "+99895600005",
          guestPhone: "+998900000053",
          adults: 2,
          pricePerNight: 120,
        }),
      });
      expect(created.status).toBe(201);

      // Worker bajarishini kutamiz — qo'lda pushReservation yo'q
      let fresh = await prisma.reservation.findUniqueOrThrow({ where: { id: created.body.id } });
      for (let i = 0; i < 40 && !fresh.externalReservationId; i++) {
        await new Promise((r) => setTimeout(r, 250));
        fresh = await prisma.reservation.findUniqueOrThrow({ where: { id: created.body.id } });
      }

      expect(fresh.externalReservationId).toBeTruthy();
      expect(fresh.syncStatus).toBe("SYNCED");

      const booking = await mockBooking(fresh.externalReservationId);
      expect(booking!.numAdult).toBe(2);
      expect(booking!.price).toBe(240);
    }, 20000);
  });
});
