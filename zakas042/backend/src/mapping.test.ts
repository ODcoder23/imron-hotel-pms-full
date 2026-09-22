/**
 * FAZA 5 — Xona mapping testlari
 *
 * TZ 5-band: "Eng muhim qism... Noto'g'ri xona turiga bron
 * tushmasligi kerak."
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md):
 *   "uchala room type ham Beds24'dagi turga bog'langan;
 *    mapping/health -> isComplete: true"
 *
 * Ishga tushirish:  npx vitest run src/mapping.test.ts
 * Shart: server (:3000), mock (:4000), PostgreSQL
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prisma } from "./lib/prisma.js";
import { setupConnection } from "./services/beds24/auth.js";
import * as mapping from "./services/mapping.js";
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

/** Uchala turni bog'laydi — ko'p testda kerak */
async function mapAll() {
  // EXT kalitlari tarixiy nomlar — ular faqat tashqi Beds24
  // ID'sini topish uchun. PMS turi TYPES dan keladi (bazadagi
  // haqiqiy turlar).
  const pairs: Array<[string, string]> = [
    [TYPES.a, EXT.standard],
    [TYPES.b, EXT.double],
    [TYPES.c, EXT.deluxe],
  ];

  for (const [pms, ext] of pairs) {
    await mapping.upsertMapping({ roomTypeId: pms, externalRoomTypeId: ext });
  }
}

/** Barcha mapping'ni tozalaydi */
async function clearMappings() {
  await prisma.channelMapping.deleteMany();
}

describe("FAZA 5 — xona mapping (TZ 5-band)", () => {
  beforeAll(async () => {
    // Tur ID'lari bazadan olinadi (testUtils.ts) — ilgari
    // "standard"/"double"/"deluxe" qattiq yozilgan edi
    await loadTypes();
    const res = await fetch(`${MOCK}/authentication/setup`, { headers: { code: "mock-invite-code" } });
    if (!res.ok) throw new Error("Mock server ishlamayapti");
    await setupConnection("mock-invite-code", "12345");
  });

  beforeEach(async () => {
    const conn = await prisma.channelConnection.findFirst({
      where: { channel: { code: "beds24" }, isActive: true },
    });
    if (!conn) await setupConnection("mock-invite-code", "12345");
    await clearMappings();
  });

  /**
   * Mapping'ni TIKLAB ketamiz.
   *
   * Bu fayl mapping YO'QLIGINI sinaydi, shuning uchun `beforeEach`
   * uni o'chiradi. Lekin fayl tugagach mapping o'chirilgan holda
   * qolsa — keyingi test fayllarining sync worker'lari "mapping
   * topilmadi" bilan yiqiladi va ular worker'ni kutib 20 soniya
   * o'tirib qoladi.
   *
   * Server worker'lari testlar orasida ham ishlab turadi, ya'ni
   * holat fayllar orasida oqib o'tadi.
   */
  afterAll(async () => {
    await mapAll();
  });

  // --- FAZA 5 mezoni ---------------------------------------
  describe("tayyorlik mezoni", () => {
    it("mapping yo'q -> isComplete=false, 12 xona bog'lanmagan", async () => {
      const h = await mapping.getMappingHealth();
      expect(h.isComplete).toBe(false);
      expect(h.unmappedRoomCount).toBe(12);
      expect(h.roomTypes.every((r) => !r.mapped)).toBe(true);
      for (const r of h.roomTypes) {
        expect(r.warning).toContain("OTA'da ko'rinmaydi");
      }
    });

    it("uchala tur bog'langach -> isComplete=true", async () => {
      await mapAll();
      const h = await mapping.getMappingHealth();

      expect(h.isComplete).toBe(true);
      expect(h.unmappedRoomCount).toBe(0);
      expect(h.orphanMappings).toHaveLength(0);
      expect(h.roomTypes).toHaveLength(3);
      expect(h.roomTypes.every((r) => r.mapped)).toBe(true);
    });

    it("xona sonlari mos keladi (6/4/2)", async () => {
      await mapAll();
      const h = await mapping.getMappingHealth();

      const byId = Object.fromEntries(h.roomTypes.map((r) => [r.id, r]));
      expect(byId.standard.rooms).toBe(6);
      expect(byId.standard.externalQty).toBe(6);
      expect(byId.double.rooms).toBe(4);
      expect(byId.double.externalQty).toBe(4);
      expect(byId.deluxe.rooms).toBe(2);
      expect(byId.deluxe.externalQty).toBe(2);

      // Sonlar mos kelsa ogohlantirish bo'lmaydi
      expect(h.roomTypes.every((r) => !r.warning)).toBe(true);
    });
  });

  // --- Validatsiya (06-fayl §6) ----------------------------
  describe("validatsiya qoidalari", () => {
    it("bitta Beds24 turi faqat bitta PMS turiga", async () => {
      await mapping.upsertMapping({ roomTypeId: TYPES.a, externalRoomTypeId: EXT.standard });

      await expect(
        mapping.upsertMapping({ roomTypeId: TYPES.b, externalRoomTypeId: EXT.standard })
      ).rejects.toThrow(/allaqachon/);
    });

    it("bir xil turni qayta bog'lash — yangilanadi, xato emas", async () => {
      await mapping.upsertMapping({ roomTypeId: TYPES.a, externalRoomTypeId: EXT.standard });
      await mapping.upsertMapping({ roomTypeId: TYPES.a, externalRoomTypeId: EXT.double });

      const found = await mapping.findRoomTypeMapping(TYPES.a);
      expect(found?.externalRoomTypeId).toBe(EXT.double);

      const all = await mapping.listMappings();
      expect(all).toHaveLength(1);     // ikkita yozuv yaratilmadi
    });

    it("mavjud bo'lmagan PMS turi -> xato", async () => {
      await expect(
        mapping.upsertMapping({ roomTypeId: "suite", externalRoomTypeId: EXT.standard })
      ).rejects.toThrow(/topilmadi/);
    });

    it("roomTypeId va roomId ikkalasi ham yo'q -> xato", async () => {
      await expect(
        mapping.upsertMapping({ externalRoomTypeId: EXT.standard })
      ).rejects.toThrow(/kerak/);
    });
  });

  // --- O'chirish (06-fayl §6) ------------------------------
  describe("o'chirish", () => {
    it("faol bron bo'lsa ogohlantiradi", async () => {
      await mapping.upsertMapping({ roomTypeId: TYPES.a, externalRoomTypeId: EXT.standard });
      const m = await mapping.findRoomTypeMapping(TYPES.a);

      // Seed'da standard turida faol bron bor
      await expect(mapping.deleteMapping(m!.id)).rejects.toThrow(/faol bron/);
    });

    it("force bilan o'chiriladi", async () => {
      await mapping.upsertMapping({ roomTypeId: TYPES.a, externalRoomTypeId: EXT.standard });
      const m = await mapping.findRoomTypeMapping(TYPES.a);

      await mapping.deleteMapping(m!.id, { force: true });
      expect(await mapping.findRoomTypeMapping(TYPES.a)).toBeNull();
    });

    it("soft delete — yozuv qoladi, isActive=false", async () => {
      await mapping.upsertMapping({ roomTypeId: TYPES.c, externalRoomTypeId: EXT.deluxe });
      const m = await mapping.findRoomTypeMapping(TYPES.c);

      await mapping.deleteMapping(m!.id, { force: true });

      const raw = await prisma.channelMapping.findUnique({ where: { id: m!.id } });
      expect(raw).not.toBeNull();          // yozuv o'chirilmadi
      expect(raw!.isActive).toBe(false);   // faqat belgilandi
    });
  });

  // --- Tashqi id bo'yicha topish (webhook uchun, 06-fayl §5) ---
  describe("findByExternal — webhook uchun", () => {
    it("room type darajasida topadi", async () => {
      await mapAll();
      const found = await mapping.findByExternal(EXT.deluxe);
      expect(found?.roomTypeId).toBe(TYPES.c);
    });

    it("mapping yo'q -> null (bron yaratilmaydi)", async () => {
      await mapAll();
      const found = await mapping.findByExternal("99999");
      expect(found).toBeNull();
    });

    it("unit mapping ustuvor", async () => {
      await mapAll();
      // 101-xonaga unit darajasida mapping
      await mapping.upsertMapping({
        roomId: "101",
        externalRoomTypeId: EXT.standard,
        externalUnitId: "unit-A",
      });

      const byUnit = await mapping.findByExternal(EXT.standard, "unit-A");
      expect(byUnit?.roomId).toBe("101");

      // Unit berilmasa — room type darajasi
      const byType = await mapping.findByExternal(EXT.standard);
      expect(byType?.roomTypeId).toBe(TYPES.a);
      expect(byType?.roomId).toBeNull();
    });
  });

  // --- Orphan aniqlash (06-fayl §7) ------------------------
  describe("orphan mapping", () => {
    it("Beds24'da yo'q turga bog'lanish -> orphan", async () => {
      await mapping.upsertMapping({ roomTypeId: TYPES.a, externalRoomTypeId: "99999" });

      const h = await mapping.getMappingHealth();
      expect(h.orphanMappings).toHaveLength(1);
      expect(h.orphanMappings[0].externalRoomTypeId).toBe("99999");
      expect(h.isComplete).toBe(false);     // orphan bo'lsa to'liq emas
    });

    it("bog'lanmagan Beds24 turlari ko'rsatiladi", async () => {
      await mapping.upsertMapping({ roomTypeId: TYPES.a, externalRoomTypeId: EXT.standard });

      const h = await mapping.getMappingHealth();
      const unusedIds = h.unusedExternal.map((e) => e.id);
      expect(unusedIds).toContain(EXT.double);
      expect(unusedIds).toContain(EXT.deluxe);
      expect(unusedIds).not.toContain(EXT.standard);
    });
  });

  // --- Audit log (TZ 18-band) ------------------------------
  describe("audit log", () => {
    it("mapping o'zgarishi yoziladi", async () => {
      await prisma.auditLog.deleteMany();

      await mapping.upsertMapping({ roomTypeId: TYPES.a, externalRoomTypeId: EXT.standard });
      await mapping.upsertMapping({ roomTypeId: TYPES.a, externalRoomTypeId: EXT.double });

      const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
      expect(logs).toHaveLength(2);
      expect(logs[0].action).toBe("mapping.created");
      expect(logs[1].action).toBe("mapping.updated");
      expect(logs[1].before).toMatchObject({ externalRoomTypeId: EXT.standard });
      expect(logs[1].after).toMatchObject({ externalRoomTypeId: EXT.double });
    });
  });

  // --- HTTP API --------------------------------------------
  describe("HTTP endpoint'lari", () => {
    it("GET /api/admin/mapping/health", async () => {
      await mapAll();
      const { status, body } = await api("/api/admin/mapping/health");
      expect(status).toBe(200);
      expect(body.isComplete).toBe(true);
      expect(body.channelConnected).toBe(true);
    });

    it("GET /api/admin/mapping/external — Beds24 turlari", async () => {
      const { body } = await api("/api/admin/mapping/external");
      expect(body.connected).toBe(true);
      const types = body.properties.flatMap((p: any) => p.roomTypes);
      expect(types).toHaveLength(3);
    });

    it("PUT /api/admin/mapping", async () => {
      const { status, body } = await api("/api/admin/mapping", {
        method: "PUT",
        body: JSON.stringify({ roomTypeId: TYPES.a, externalRoomTypeId: EXT.standard }),
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it("PUT konflikt -> 409 MAPPING_CONFLICT", async () => {
      await mapping.upsertMapping({ roomTypeId: TYPES.a, externalRoomTypeId: EXT.standard });

      const { status, body } = await api("/api/admin/mapping", {
        method: "PUT",
        body: JSON.stringify({ roomTypeId: TYPES.b, externalRoomTypeId: EXT.standard }),
      });
      expect(status).toBe(409);
      expect(body.code).toBe("MAPPING_CONFLICT");
    });

    it("PUT noto'g'ri payload -> 400", async () => {
      const { status } = await api("/api/admin/mapping", {
        method: "PUT",
        body: JSON.stringify({ roomTypeId: TYPES.a }),
      });
      expect(status).toBe(400);
    });

    it("DELETE faol bron bilan -> 409", async () => {
      await mapping.upsertMapping({ roomTypeId: TYPES.a, externalRoomTypeId: EXT.standard });
      const m = await mapping.findRoomTypeMapping(TYPES.a);

      const { status, body } = await api(`/api/admin/mapping/${m!.id}`, { method: "DELETE" });
      expect(status).toBe(409);
      expect(body.code).toBe("MAPPING_HAS_ACTIVE_RESERVATIONS");
    });

    it("DELETE ?force=true -> o'chadi", async () => {
      await mapping.upsertMapping({ roomTypeId: TYPES.a, externalRoomTypeId: EXT.standard });
      const m = await mapping.findRoomTypeMapping(TYPES.a);

      const { status } = await api(`/api/admin/mapping/${m!.id}?force=true`, { method: "DELETE" });
      expect(status).toBe(200);
      expect(await mapping.findRoomTypeMapping(TYPES.a)).toBeNull();
    });

    it("GET /api/admin/connection — token OSHKOR QILINMAYDI (TZ 13-band)", async () => {
      const { body } = await api("/api/admin/connection");
      expect(body.isConnected).toBe(true);
      expect(body.propertyId).toBe("12345");

      const json = JSON.stringify(body);
      expect(json).not.toContain("mock-access-");
      expect(json).not.toContain("mock-refresh-");
      expect(json).not.toMatch(/accessToken|refreshToken/);
    });

    it("GET /api/admin/status — umumiy holat", async () => {
      await mapAll();
      const { body } = await api("/api/admin/status");
      expect(body.mapping.isComplete).toBe(true);
      expect(body.beds24.connected).toBe(true);
      expect(body.counts.rooms).toBe(12);
    });

    it("admin sahifasi ochiladi", async () => {
      const res = await fetch(`${PMS}/admin/mapping.html`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Xona mapping");
    });
  });
});
