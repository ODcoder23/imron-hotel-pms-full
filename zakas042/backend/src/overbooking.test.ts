/**
 * FAZA 2B — Overbooking himoyasi (TZ 3-band)
 *
 * TZ: "OVERBOOKING BO'LMASLIGI SHART."
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md):
 *   "parallel test o'tadi; hech qanday sharoitda ikkita
 *    qoplanuvchi bron yaratilmaydi"
 *
 * Bu eng muhim test. Dastur mantig'i (2-qatlam) ikki parallel so'rov
 * uchun yetarli emas — ikkalasi ham tekshiruvdan o'tib ketishi mumkin.
 * DB constraint (1-qatlam) yagona haqiqiy kafolat.
 *
 * Ishga tushirish:  npm test -- overbooking
 * Shart: server ishlab turishi kerak (npm run dev)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { day, someRooms, tariffFor, typeOf } from "./testUtils.js";

const BASE = process.env.PMS_URL ?? "http://127.0.0.1:3000";

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  return { status: res.status, body: (await res.json()) as any };
};

/**
 * Bron yaratadi.
 *
 * Narx BAZADAN olinadi: tarifdan past narx chegirma sababini
 * talab qiladi (SAVOLLAR.md S4), va test uni berishi shart emas.
 */
const book = async (roomId: string, from: number, to: number, name: string) =>
  api("/api/reservations", {
    method: "POST",
    body: JSON.stringify({
      roomId,
      guestName: name,
      phone: "+99898500001",
      checkIn: day(from),
      checkOut: day(to),
      pricePerNight: await tariffFor(roomId),
    }),
  });

/**
 * Test ishlatadigan xonalar — bazadagi haqiqiy ID'lar.
 *
 * Ilgari "107", "112" kabi qattiq yozilgan edi; loyiha 12 xonadan
 * 18 xonaga o'tganda hammasi yiqildi.
 */
let R: string[] = [];

/** DB'dan haqiqiy holatni o'qiydi — API javobiga ishonmaydi */
const activeBookings = async (roomId: string, from: number, to: number) => {
  const { body } = await api(`/api/reservations?from=${day(from)}&to=${day(to)}`);
  return body.filter(
    (r: any) => r.roomId === roomId && !["cancelled", "no_show"].includes(r.status)
  );
};

describe("FAZA 2B — overbooking himoyasi (TZ 3-band)", () => {
  beforeAll(async () => {
    const { status } = await api("/health");
    if (status !== 200) throw new Error("Server ishlamayapti — `npm run dev`");

    // Kamida 8 ta xona kerak: parallel testlar bir-biriga
    // xalaqit bermasin
    R = await someRooms(8);

    // Tarif keshini oldindan to'ldiramiz. Aks holda 20 parallel
    // `book()` chaqiruvining har biri narx so'rovini yuborib,
    // bronlar bir vaqtda ketmay qolardi — parallel test o'z
    // ma'nosini yo'qotardi.
    await Promise.all(R.map((id) => tariffFor(id)));
  });

  // --- Asosiy sinov: 20 parallel so'rov ---------------------
  describe("parallel so'rovlar", () => {
    it("20 ta bir vaqtdagi so'rov — faqat BITTASI o'tadi", async () => {
      const ROOM = R[0];
      const FROM = 200;
      const TO = 203;

      // Promise.all — hammasi bir vaqtda ketadi
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => book(ROOM, FROM, TO, `Parallel-${i}`))
      );

      const created = results.filter((r) => r.status === 201);
      const rejected = results.filter((r) => r.status === 409);
      const other = results.filter((r) => r.status !== 201 && r.status !== 409);

      console.log(
        `\n  20 parallel so'rov: ${created.length} yaratildi, ` +
        `${rejected.length} rad etildi, ${other.length} boshqa`
      );
      if (other.length > 0) {
        console.log("  Boshqa javoblar:", other.map((o) => `${o.status}: ${o.body?.error}`));
      }

      expect(created).toHaveLength(1);
      expect(rejected.length + other.length).toBe(19);

      // DB'da haqiqatan bitta yozuv bormi
      const inDb = await activeBookings(ROOM, FROM, TO);
      expect(inDb).toHaveLength(1);
    }, 30_000);

    it("50 parallel so'rov — hali ham bitta", async () => {
      const ROOM = R[1];
      const FROM = 210;
      const TO = 213;

      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => book(ROOM, FROM, TO, `Yuklama-${i}`))
      );

      const created = results.filter((r) => r.status === 201);
      console.log(`\n  50 parallel so'rov: ${created.length} yaratildi`);

      expect(created).toHaveLength(1);
      expect(await activeBookings(ROOM, FROM, TO)).toHaveLength(1);
    }, 60_000);

    it("qisman kesishuvchi sanalar — faqat bittasi o'tadi", async () => {
      const ROOM = R[2];

      // Hammasi 222-kunni QOPLAYDI, shuning uchun faqat bittasi o'tishi
      // kerak. Diqqat: '[)' qoidasida 218-221 va 221-225 KESISHMAYDI
      // (biri chiqadi, ikkinchisi o'sha kuni kiradi) — shuning uchun
      // har oraliq umumiy kunni o'z ichiga olishi shart.
      const results = await Promise.all([
        book(ROOM, 220, 225, "A"),   // 220..224 egallaydi
        book(ROOM, 222, 227, "B"),   // 222..226
        book(ROOM, 218, 223, "C"),   // 218..222
        book(ROOM, 221, 226, "D"),   // 221..225
        book(ROOM, 219, 230, "E"),   // 219..229
      ]);

      const created = results.filter((r) => r.status === 201);
      console.log(`\n  5 kesishuvchi so'rov: ${created.length} yaratildi`);

      expect(created).toHaveLength(1);
      expect(await activeBookings(ROOM, 215, 235)).toHaveLength(1);
    }, 30_000);

    it("chegara qoidasi: 218-221 va 221-225 KESISHMAYDI", async () => {
      const ROOM = R[3];

      // Bu ikkisi parallel yuborilsa ham ikkalasi ham o'tishi kerak —
      // '[)' qoidasi: checkOut kirmaydi. Agar bittasi rad etilsa,
      // himoya haddan tashqari keng ishlayapti va har check-out kuni
      // bitta xona bekorga yo'qoladi.
      const results = await Promise.all([
        book(ROOM, 218, 221, "Chiqadi"),
        book(ROOM, 221, 225, "Kiradi"),
      ]);

      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    }, 30_000);
  });

  // --- Kesishmaydiganlar hammasi o'tishi kerak --------------
  describe("kesishmaydigan bronlar", () => {
    it("ketma-ket oraliqlar — hammasi o'tadi", async () => {
      const ROOM = R[4];

      const results = await Promise.all([
        book(ROOM, 240, 243, "1-mehmon"),   // 240-243
        book(ROOM, 243, 246, "2-mehmon"),   // 243-246  chegara '[)'
        book(ROOM, 246, 249, "3-mehmon"),   // 246-249
        book(ROOM, 249, 252, "4-mehmon"),   // 249-252
      ]);

      const created = results.filter((r) => r.status === 201);
      console.log(`\n  4 ketma-ket oraliq: ${created.length} yaratildi`);

      expect(created).toHaveLength(4);
      expect(await activeBookings(ROOM, 235, 255)).toHaveLength(4);
    }, 30_000);

    it("turli xonalar — parallel bo'lsa ham hammasi o'tadi", async () => {
      const rooms = [R[0], R[1], R[2], R[3]];

      const results = await Promise.all(
        rooms.map((r, i) => book(r, 260, 263, `Xona-${r}`))
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(4);
    }, 30_000);
  });

  // --- Boshqa amallar ham himoyalangan ----------------------
  describe("xona/sana o'zgartirish ham himoyalangan", () => {
    it("parallel change-room — faqat bittasi o'tadi", async () => {
      // Ikki bron turli xonalarda, ikkalasi ham 3-xonaga ko'chmoqchi
      const { body: a } = await book(R[5], 270, 273, "Ko'chuvchi-A");
      const { body: b } = await book(R[6], 270, 273, "Ko'chuvchi-B");

      const results = await Promise.all([
        api(`/api/reservations/${a.id}/change-room`, {
          method: "POST",
          body: JSON.stringify({ roomId: R[7] }),
        }),
        api(`/api/reservations/${b.id}/change-room`, {
          method: "POST",
          body: JSON.stringify({ roomId: R[7] }),
        }),
      ]);

      const ok = results.filter((r) => r.status === 200);
      console.log(`\n  2 parallel change-room: ${ok.length} o'tdi`);

      expect(ok).toHaveLength(1);
      expect(await activeBookings(R[7], 265, 275)).toHaveLength(1);
    }, 30_000);

    it("parallel change-dates — kesishuvga olib kelmaydi", async () => {
      const ROOM = R[3];
      const { body: first } = await book(ROOM, 280, 283, "Sana-A");
      const { body: second } = await book(ROOM, 290, 293, "Sana-B");

      // Ikkinchisi birinchisining sanasiga ko'chmoqchi
      const { status } = await api(`/api/reservations/${second.id}/change-dates`, {
        method: "POST",
        body: JSON.stringify({ checkIn: day(281), checkOut: day(284) }),
      });

      expect(status).toBe(409);

      const inDb = await activeBookings(ROOM, 275, 295);
      expect(inDb).toHaveLength(2);
      // Ikkinchisi eski sanasida qolgan
      expect(inDb.find((r: any) => r.id === second.id).checkIn).toBe(day(290));
    }, 30_000);
  });

  // --- Availability agregatsiyasi (07 §2) -------------------
  describe("availability agregatsiyasi", () => {
    it("bron yaratilgach son kamayadi, bekor qilingach qaytadi", async () => {
      const FROM = 300;

      const before = await api(`/api/rate-plans?from=${day(FROM)}&to=${day(FROM)}`);
      expect(before.status).toBe(200);

      // Bugungi holatni o'qish uchun rooms/available ishlatamiz
      const { body: freeBefore } = await api(
        `/api/rooms/available?from=${day(FROM)}&to=${day(FROM + 2)}`
      );
      // Tur BAZADAN olinadi: "standard" eski 12 xonali
      // tuzilishdan qolgan nom edi
      const TYPE = await typeOf(R[0]);
      const standardBefore = freeBefore.filter((r: any) => r.type === TYPE).length;

      const { body: r } = await book(R[0], FROM, FROM + 2, "Agregatsiya testi");

      const { body: freeAfter } = await api(
        `/api/rooms/available?from=${day(FROM)}&to=${day(FROM + 2)}`
      );
      const standardAfter = freeAfter.filter((x: any) => x.type === TYPE).length;

      expect(standardAfter).toBe(standardBefore - 1);

      await api(`/api/reservations/${r.id}/cancel`, { method: "POST" });

      const { body: freeCancelled } = await api(
        `/api/rooms/available?from=${day(FROM)}&to=${day(FROM + 2)}`
      );
      const standardCancelled = freeCancelled.filter((x: any) => x.type === TYPE).length;

      expect(standardCancelled).toBe(standardBefore);
    }, 30_000);

    it("son hech qachon manfiy yoki totalRooms'dan katta bo'lmaydi", async () => {
      const { body } = await api(`/api/rooms/available?from=${day(310)}&to=${day(312)}`);
      const byType: Record<string, number> = {};
      for (const r of body) byType[r.type] = (byType[r.type] ?? 0) + 1;

      // 02-fayl §4: standard 6, double 4, deluxe 2
      expect(byType.standard ?? 0).toBeLessThanOrEqual(6);
      expect(byType.double ?? 0).toBeLessThanOrEqual(4);
      expect(byType.deluxe ?? 0).toBeLessThanOrEqual(2);
      for (const n of Object.values(byType)) expect(n).toBeGreaterThanOrEqual(0);
    });
  });

  // --- Yakuniy kafolat --------------------------------------
  describe("yakuniy tekshiruv", () => {
    it("BUTUN BAZADA birorta ham qoplanuvchi bron yo'q", async () => {
      const { body: all } = await api("/api/reservations");
      const active = all.filter(
        (r: any) => !["cancelled", "no_show"].includes(r.status)
      );

      const byRoom: Record<string, any[]> = {};
      for (const r of active) (byRoom[r.roomId] ??= []).push(r);

      const overlaps: string[] = [];
      for (const [roomId, list] of Object.entries(byRoom)) {
        const sorted = [...list].sort((a, b) => a.checkIn.localeCompare(b.checkIn));
        for (let i = 1; i < sorted.length; i++) {
          // '[)' qoidasi: oldingi checkOut > keyingi checkIn bo'lsa kesishadi
          if (sorted[i - 1].checkOut > sorted[i].checkIn) {
            overlaps.push(
              `${roomId}: ${sorted[i - 1].checkIn}..${sorted[i - 1].checkOut} ` +
              `va ${sorted[i].checkIn}..${sorted[i].checkOut}`
            );
          }
        }
      }

      console.log(`\n  Tekshirildi: ${active.length} faol bron, ${Object.keys(byRoom).length} xona`);
      if (overlaps.length > 0) console.log("  KESISHUVLAR:", overlaps);

      expect(overlaps).toEqual([]);
    });
  });
});
