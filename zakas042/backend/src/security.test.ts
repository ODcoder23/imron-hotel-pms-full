/**
 * FAZA 12 — Xavfsizlik va audit
 *
 * TZ 16-band: SyncLog. TZ 18-band: to'qqiz xavfsizlik talabi.
 *
 * Mezon (11-BOSQICHLAR-ROADMAP.md, FAZA 12):
 *   "10-fayl §1 jadvalidagi 9 ta talab ham 'bajarildi'."
 *
 * Cheklist (10-fayl §9) shu test bilan avtomatlashtiriladi —
 * qo'lda tekshirish o'rniga har yurishda qayta sinaladi.
 *
 * Ishga tushirish:  npx vitest run src/security.test.ts
 * Shart: server (:3000), PostgreSQL
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./lib/prisma.js";
import {
  PERMISSIONS, can, hashPassword, verifyPassword,
  signToken, verifyToken, login, createUser,
} from "./services/auth.js";
import { audit, listAudit, AUDIT_ACTIONS } from "./services/auditLog.js";
import { sanitizeForLog } from "./lib/sanitize.js";
import { encrypt, decrypt } from "./lib/encryption.js";
import type { UserRole } from "@prisma/client";

const PMS = process.env.PMS_URL ?? "http://127.0.0.1:3000";
const BACKEND_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${PMS}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, raw: text };
};

/** Test uchun yaratilgan foydalanuvchilar — tozalash uchun */
const created: string[] = [];

/**
 * ADMIN token — auth yoqilgan bo'lsa kerak bo'ladi.
 *
 * Testlar ikkala rejimda ham ishlashi kerak: dev'da
 * `AUTH_REQUIRED=false`, production tekshiruvida `true`.
 */
let adminAuth: Record<string, string> = {};

async function loadAdminToken(): Promise<void> {
  const health = await api("/health");
  if (health.body?.security?.auth !== true) return;

  const res = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@imron.local", password: "admin12345" }),
  });
  if (res.body?.token) adminAuth = { Authorization: `Bearer ${res.body.token}` };
}

describe("FAZA 12 — xavfsizlik va audit (TZ 16, 18-band)", () => {
  beforeAll(async () => {
    const health = await fetch(`${PMS}/health`).then((r) => r.json() as any);
    if (!health.security) throw new Error("/health'da security yo'q — server yangilanmagan");
    await loadAdminToken();
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
  });

  afterAll(async () => {
    if (created.length > 0) {
      await prisma.auditLog.deleteMany({ where: { userId: { in: created } } });
      await prisma.user.deleteMany({ where: { id: { in: created } } });
    }
  });

  // --- 1. Credentials faqat backendda (TZ 18-band, 1-talab) ---
  describe("1. API credentials backendda qoladi", () => {
    it("ChannelConnection javobida token maydonlari YO'Q", async () => {
      const res = await api("/api/admin/connection", { headers: adminAuth });
      expect(res.status).toBe(200);

      const text = JSON.stringify(res.body).toLowerCase();
      expect(text).not.toContain("refreshtoken");
      expect(text).not.toContain("accesstoken");
      // Haqiqiy token qiymati ham tushmasin
      expect(text).not.toContain("mock-access-token");
      expect(text).not.toContain("mock-refresh-token");
    });

    it("token'lar DB'da shifrlangan holda turadi", async () => {
      const conn = await prisma.channelConnection.findFirst({
        where: { channel: { code: "beds24" } },
      });

      if (!conn?.refreshToken) return;    // ulanish yo'q — o'tkazamiz

      // Shifrlangan format: base64(iv):base64(tag):base64(data)
      expect(conn.refreshToken.split(":")).toHaveLength(3);
      expect(conn.refreshToken).not.toContain("mock-refresh-token");

      // Va ochib bo'ladi
      expect(decrypt(conn.refreshToken)).toBeTruthy();
    });

    it("shifrlash aylanishi buzilmaydi", () => {
      const secret = "mock-refresh-token-12345";
      const enc = encrypt(secret);
      expect(enc).not.toContain(secret);
      expect(decrypt(enc)).toBe(secret);
    });
  });

  // --- 2. .env himoyasi (TZ 18-band, 2-talab) ----------------
  describe("2. .env va secret'lar", () => {
    it(".env .gitignore da", () => {
      const root = path.resolve(BACKEND_DIR, "..");
      const candidates = [
        path.join(root, ".gitignore"),
        path.join(BACKEND_DIR, ".gitignore"),
      ].filter((p) => fs.existsSync(p));

      expect(candidates.length).toBeGreaterThan(0);
      const all = candidates.map((p) => fs.readFileSync(p, "utf8")).join("\n");
      expect(all).toMatch(/(^|\n)\.env/);
    });

    it("ENCRYPTION_KEY va JWT_SECRET sozlangan", () => {
      expect(process.env.ENCRYPTION_KEY ?? "").not.toBe("");
      expect(process.env.JWT_SECRET ?? "").not.toBe("");
    });
  });

  // --- 3. JWT (TZ 18-band, 3-talab) --------------------------
  describe("3. JWT autentifikatsiya", () => {
    it("to'g'ri parol bilan token beriladi", async () => {
      const res = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@imron.local", password: "admin12345" }),
      });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
      expect(res.body.user.role).toBe("ADMIN");
    });

    it("noto'g'ri parol 401 beradi", async () => {
      const res = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@imron.local", password: "notogri" }),
      });
      expect(res.status).toBe(401);
    });

    it("mavjud bo'lmagan email BIR XIL xabar beradi", async () => {
      // Aks holda hujumchi qaysi email'lar borligini aniqlaydi
      const a = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "yoq@imron.local", password: "notogri" }),
      });
      const b = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@imron.local", password: "notogri" }),
      });

      expect(a.status).toBe(b.status);
      expect(a.body.error).toBe(b.body.error);
    });

    it("javobda passwordHash YO'Q", async () => {
      const res = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@imron.local", password: "admin12345" }),
      });
      expect(res.raw.toLowerCase()).not.toContain("passwordhash");
      expect(res.raw).not.toContain("$2a$");
      expect(res.raw).not.toContain("$2b$");
    });

    it("token o'qiladi va tekshiriladi", () => {
      const token = signToken({ sub: "u1", role: "MANAGER", email: "m@x.uz" });
      const payload = verifyToken(token);
      expect(payload?.sub).toBe("u1");
      expect(payload?.role).toBe("MANAGER");
    });

    it("buzilgan token rad etiladi", () => {
      const token = signToken({ sub: "u1", role: "ADMIN", email: "a@x.uz" });
      expect(verifyToken(token + "x")).toBeNull();
      expect(verifyToken("umuman-token-emas")).toBeNull();
    });

    it("muddati o'tgan token rad etiladi", async () => {
      const token = signToken({ sub: "u1", role: "ADMIN", email: "a@x.uz" }, "1ms");
      await new Promise((r) => setTimeout(r, 50));
      expect(verifyToken(token)).toBeNull();
    });

    it("parol hash'lanadi va tekshiriladi", async () => {
      const hash = await hashPassword("parol12345");
      expect(hash).not.toBe("parol12345");
      expect(hash.startsWith("$2")).toBe(true);
      expect(await verifyPassword("parol12345", hash)).toBe(true);
      expect(await verifyPassword("boshqa", hash)).toBe(false);
    });

    it("seed'dagi placeholder parol hech qachon mos kelmaydi", async () => {
      // Eski seed "PLACEHOLDER_FAZA_2A" yozardi — bcrypt formatida
      // emas, shuning uchun `verifyPassword` uni rad etishi kerak
      expect(await verifyPassword("PLACEHOLDER_FAZA_2A", "PLACEHOLDER_FAZA_2A")).toBe(false);
      expect(await verifyPassword("", "")).toBe(false);
    });
  });

  // --- 4. RBAC (TZ 18-band, 4-talab) -------------------------
  describe("4. RBAC — to'rt rol (10-fayl §3)", () => {
    it("FOUNDER hamma huquqqa ega", () => {
      // Egasi — yagona rol, unda hech narsa yopiq emas
      for (const p of Object.keys(PERMISSIONS)) {
        expect(can("FOUNDER", p as never), `FOUNDER uchun ${p} yopiq`).toBe(true);
      }
    });

    it("ADMIN texnik ishlarni qiladi, biznes raqamlarini ko'rmaydi", () => {
      // 2026-09-16: FOUNDER roli qo'shilganda ikki huquq ADMIN'dan
      // olindi. Ilgari "ADMIN hamma huquqqa ega" edi.
      expect(can("ADMIN", "report.read")).toBe(false);   // daromad, foyda
      expect(can("ADMIN", "user.manage")).toBe(false);   // adminlarni nazorat

      // Qolgan hammasi ochiq
      for (const p of Object.keys(PERMISSIONS)) {
        if (p === "report.read" || p === "user.manage") continue;
        expect(can("ADMIN", p as never), `ADMIN uchun ${p} yopiq`).toBe(true);
      }
    });

    it("umumiy hisobot faqat egasiga ko'rinadi", () => {
      expect(can("FOUNDER", "report.read")).toBe(true);
      expect(can("ADMIN", "report.read")).toBe(false);
      expect(can("MANAGER", "report.read")).toBe(false);
      expect(can("STAFF", "report.read")).toBe(false);
    });

    it("foydalanuvchi boshqaruvi faqat egasida", () => {
      expect(can("FOUNDER", "user.manage")).toBe(true);
      expect(can("ADMIN", "user.manage")).toBe(false);
      expect(can("MANAGER", "user.manage")).toBe(false);
      expect(can("STAFF", "user.manage")).toBe(false);
    });

    it("MANAGER Beds24 sozlamalariga KIROLMAYDI", () => {
      expect(can("MANAGER", "channel.connect")).toBe(false);
      expect(can("MANAGER", "mapping.write")).toBe(false);
      expect(can("MANAGER", "settings.write")).toBe(false);
      expect(can("MANAGER", "user.manage")).toBe(false);
    });

    it("MANAGER bron va narx bilan ishlaydi", () => {
      expect(can("MANAGER", "reservation.write")).toBe(true);
      expect(can("MANAGER", "reservation.cancel")).toBe(true);
      expect(can("MANAGER", "rate.write")).toBe(true);
      expect(can("MANAGER", "synclog.read")).toBe(true);
    });

    it("STAFF faqat check-in/to'lov/o'qish", () => {
      expect(can("STAFF", "checkin.write")).toBe(true);
      expect(can("STAFF", "payment.write")).toBe(true);
      expect(can("STAFF", "reservation.read")).toBe(true);

      // Narxga va bekor qilishga tegmaydi
      expect(can("STAFF", "rate.write")).toBe(false);
      expect(can("STAFF", "reservation.cancel")).toBe(false);
      expect(can("STAFF", "settings.write")).toBe(false);
    });

    it("har huquqda kamida bitta rol bor", () => {
      // Bo'sh ro'yxat = hech kim qila olmaydi, bu xato
      for (const [perm, roles] of Object.entries(PERMISSIONS)) {
        expect(roles.length, `${perm} uchun rol yo'q`).toBeGreaterThan(0);
      }
    });

    it("FOUNDER har huquqda bor — qulflanib qolmaslik uchun", () => {
      // 2026-09-16 dan beri bu rolni FOUNDER bajaradi: ADMIN'dan
      // `report.read` va `user.manage` olib tashlandi, shuning
      // uchun "hamma narsani qila oladigan" yagona rol — egasi.
      //
      // Bittasi bo'lmasa tizim qulflanadi: hech kim o'sha amalni
      // bajara olmaydi va bazaga qo'lda kirmasdan tuzatib bo'lmaydi.
      for (const [perm, roles] of Object.entries(PERMISSIONS)) {
        expect(roles as readonly UserRole[], `${perm} da FOUNDER yo'q`).toContain("FOUNDER");
      }
    });

    it("/api/auth/me foydalanuvchi huquqlarini qaytaradi", async () => {
      const res = await api("/api/auth/me", { headers: adminAuth });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.permissions)).toBe(true);
      expect(res.body.permissions.length).toBeGreaterThan(0);
    });
  });

  // --- 8. Audit log (TZ 18-band, 8-talab) --------------------
  describe("8. Audit log — kim nima qildi (10-fayl §4)", () => {
    it("yozuv yaratiladi va o'qiladi", async () => {
      await audit({
        action: "settings.changed",
        entityType: "Settings",
        entityId: "TEST_KEY",
        before: { value: "a" },
        after: { value: "b" },
        ipAddress: "127.0.0.1",
      });

      const rows = await listAudit({ action: "settings.changed" });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.entityId).toBe("TEST_KEY");
      expect((rows[0]!.after as any).value).toBe("b");
    });

    it("before/after sanitizatsiyadan o'tadi (TZ 18-band, 9-talab)", async () => {
      await audit({
        action: "channel.connected",
        entityType: "ChannelConnection",
        entityId: "test",
        after: { refreshToken: "juda-maxfiy-token", propertyId: "12345" },
      });

      const rows = await listAudit({ action: "channel.connected" });
      const text = JSON.stringify(rows[0]!.after);
      expect(text).not.toContain("juda-maxfiy-token");
      expect(text).toContain("12345");     // maxfiy bo'lmagan qism qoladi
    });

    it("noto'g'ri userId audit'ni yiqitmaydi", async () => {
      // Foydalanuvchi o'chirilgan bo'lishi mumkin — FK xatosi
      // asosiy amalni to'xtatmasligi kerak (TZ 17-band)
      await expect(
        audit({ userId: "yoq-bunday-user", action: "user.login" })
      ).resolves.toBeUndefined();
    });

    it("source-of-truth almashtirilishi qayd etiladi", async () => {
      const before = await api("/api/admin/settings", { headers: adminAuth });
      const current = before.body.ratesSoT;
      const other = current === "pms" ? "beds24" : "pms";

      await api("/api/admin/settings", {
        method: "PUT",
        headers: adminAuth,
        body: JSON.stringify({ ratesSoT: other }),
      });

      const rows = await listAudit({ action: "settings.changed" });
      const entry = rows.find((r) => r.entityId === "SOURCE_OF_TRUTH_RATES");
      expect(entry, "SoT o'zgarishi audit'ga tushmadi").toBeTruthy();
      expect((entry!.before as any).value).toBe(current);
      expect((entry!.after as any).value).toBe(other);

      // Qaytaramiz
      await api("/api/admin/settings", {
        method: "PUT",
        headers: adminAuth,
        body: JSON.stringify({ ratesSoT: current }),
      });
    });

    it("bron bekor qilinishi qayd etiladi", async () => {
      // Tur nomi qattiq yozilmaydi: "standard" 12 xonali eski
      // tuzilishdan qolgan edi va bu test topa olmay yiqilardi
      const room = await prisma.room.findFirstOrThrow({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
      });

      // Narx tarifdan olinadi — pastroq narx chegirma sababini
      // talab qiladi (SAVOLLAR.md S4)
      const plan = await prisma.ratePlan.findFirst({
        where: { roomTypeId: room.roomTypeId },
        orderBy: { price: "desc" },
        select: { price: true },
      });

      const created = await api("/api/reservations", {
        method: "POST",
        headers: adminAuth,
        body: JSON.stringify({
          roomId: room.id,
          checkIn: "2032-03-01",
          checkOut: "2032-03-02",
          guestName: "Audit Testi",
          phone: "+99890700001",
          guestPhone: "+998900000080",
          adults: 1,
          pricePerNight: plan ? Number(plan.price) : 100,
        }),
      });
      expect(created.status).toBe(201);

      await api(`/api/reservations/${created.body.id}/cancel`, { method: "POST", headers: adminAuth });

      const rows = await listAudit({ action: "reservation.cancelled" });
      const entry = rows.find((r) => r.entityId === created.body.id);
      expect(entry, "bekor qilish audit'ga tushmadi").toBeTruthy();

      await prisma.reservation.delete({ where: { id: created.body.id } }).catch(() => {});
    });

    it("GET /api/admin/audit-log ro'yxatni qaytaradi", async () => {
      await audit({ action: "user.login", entityType: "User", entityId: "x" });

      const res = await api("/api/admin/audit-log?limit=5", { headers: adminAuth });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("amallar ro'yxati yopiq — yangi amal qo'shish ongli qaror", () => {
      // 10-fayl §4 dagi hamma amal ro'yxatda bo'lishi kerak
      for (const a of [
        "mapping.created", "settings.changed", "channel.connected",
        "webhook.reprocessed", "reservation.cancelled", "reservation.no_show",
        "user.created", "user.role_changed",
      ]) {
        expect(AUDIT_ACTIONS as readonly string[]).toContain(a);
      }
    });
  });

  // --- 9. Sensitive data log qilinmasin (9-talab) ------------
  describe("9. Maxfiy ma'lumot log'ga tushmaydi", () => {
    it("sanitizeForLog token va parolni yashiradi", () => {
      const out = sanitizeForLog({
        refreshToken: "maxfiy1",
        accessToken: "maxfiy2",
        password: "maxfiy3",
        apiKey: "maxfiy4",
        guestName: "Aziz",
        nested: { authToken: "maxfiy5", price: 100 },
      });

      const text = JSON.stringify(out);
      for (const secret of ["maxfiy1", "maxfiy2", "maxfiy3", "maxfiy4", "maxfiy5"]) {
        expect(text, `${secret} yashirilmadi`).not.toContain(secret);
      }
      // Oddiy ma'lumot qoladi
      expect(text).toContain("Aziz");
      expect(text).toContain("100");
    });

    it("SyncLog'da 'token' qidiruvi maxfiy qiymat topmaydi (10-fayl §9)", async () => {
      const logs = await prisma.syncLog.findMany({ take: 200 });
      const text = JSON.stringify(logs).toLowerCase();

      expect(text).not.toContain("mock-access-token");
      expect(text).not.toContain("mock-refresh-token");
      expect(text).not.toContain("mock-invite-code");
    });

    it("WebhookEvent rawPayload'ida token yo'q", async () => {
      const events = await prisma.webhookEvent.findMany({ take: 100 });
      const text = JSON.stringify(events).toLowerCase();
      expect(text).not.toContain("mock-access-token");
      expect(text).not.toContain("dev-only-secret");
    });

    it("AuditLog'da ham token yo'q", async () => {
      const rows = await prisma.auditLog.findMany({ take: 200 });
      const text = JSON.stringify(rows).toLowerCase();
      expect(text).not.toContain("mock-refresh-token");
      expect(text).not.toContain("$2a$");     // parol hash ham emas
    });
  });

  // --- Foydalanuvchi boshqaruvi ------------------------------
  describe("foydalanuvchi boshqaruvi", () => {
    it("yaratilgan foydalanuvchi parol hash'isiz qaytadi", async () => {
      const user = await createUser({
        email: `test-${Date.now()}@imron.local`,
        password: "parol12345",
        fullName: "Test Foydalanuvchi",
        role: "STAFF",
      });
      created.push(user.id);

      expect(JSON.stringify(user).toLowerCase()).not.toContain("passwordhash");
      expect(user.role).toBe("STAFF");
    });

    it("yaratilgan parol bilan kirish mumkin", async () => {
      const email = `login-${Date.now()}@imron.local`;
      const user = await createUser({
        email, password: "parol12345", fullName: "Login Testi", role: "MANAGER",
      });
      created.push(user.id);

      const result = await login(email, "parol12345");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.user.role).toBe("MANAGER");
    });

    it("o'chirilgan foydalanuvchi kira olmaydi", async () => {
      const email = `disabled-${Date.now()}@imron.local`;
      const user = await createUser({
        email, password: "parol12345", fullName: "O'chirilgan", role: "STAFF",
      });
      created.push(user.id);

      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

      const result = await login(email, "parol12345");
      expect(result.ok).toBe(false);
    });

    it("oxirgi ADMIN rolini o'zgartirib bo'lmaydi", async () => {
      const admins = await prisma.user.findMany({ where: { role: "ADMIN", isActive: true } });
      if (admins.length !== 1) return;     // bir nechta admin bor — test ma'nosiz

      const res = await api(`/api/auth/users/${admins[0]!.id}`, {
        method: "PATCH",
        headers: adminAuth,
        body: JSON.stringify({ role: "STAFF" }),
      });
      expect(res.status).toBe(400);

      const still = await prisma.user.findUniqueOrThrow({ where: { id: admins[0]!.id } });
      expect(still.role).toBe("ADMIN");
    });
  });

  // --- RBAC HAQIQIY HTTP orqali ------------------------------
  //
  // Yuqoridagi RBAC testlari `can()` funksiyasini tekshiradi.
  // Bu blok esa endpoint'lar HAQIQATAN himoyalanganini sinaydi:
  // funksiya to'g'ri bo'lib, route'ga ulanmagan bo'lishi mumkin.
  //
  // Faqat `AUTH_REQUIRED=true` bo'lganda ishlaydi. Dev muhitida
  // auth o'chirilgan, shuning uchun test o'zini o'tkazib yuboradi.
  describe("RBAC endpoint'larda (AUTH_REQUIRED=true bo'lganda)", () => {
    let authOn = false;
    const tokens: Record<string, string> = {};

    beforeAll(async () => {
      const health = await api("/health");
      authOn = health.body?.security?.auth === true;
      if (!authOn) return;

      for (const [role, email] of Object.entries({
        admin: "admin@imron.local",
        manager: "manager@imron.local",
        staff: "staff@imron.local",
      })) {
        const res = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password: "admin12345" }),
        });
        if (res.body?.token) tokens[role] = res.body.token;
      }
    });

    const withRole = (role: string) => ({
      headers: { Authorization: `Bearer ${tokens[role]}` },
    });

    it("tokensiz so'rov 401 beradi", async () => {
      if (!authOn) return;

      // MUHIM: setupFiles global `fetch` ni o'rab, PMS so'rovlariga
      // avtomatik ADMIN token qo'shadi (vitest.setup.ts izohiga
      // qarang). Bu yerda esa aynan TOKENSIZ holatni sinaymiz,
      // shuning uchun bo'sh `Authorization` yuboramiz — o'ram
      // sarlavha bor deb hisoblab tegmaydi.
      const res = await fetch(`${PMS}/api/rooms`, {
        headers: { Authorization: "" },
      });
      expect(res.status).toBe(401);

      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("UNAUTHORIZED");
    });

    it("STAFF xonalarni ko'radi", async () => {
      if (!authOn) return;
      const res = await api("/api/rooms", withRole("staff"));
      expect(res.status).toBe(200);
    });

    it("STAFF narx belgilay OLMAYDI (403)", async () => {
      if (!authOn) return;
      const res = await api("/api/rate-plans", {
        method: "PUT",
        ...withRole("staff"),
        body: JSON.stringify({ from: "2032-01-01", to: "2032-01-01", prices: { standard: 50 } }),
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    });

    it("MANAGER narx belgilaydi", async () => {
      if (!authOn) return;
      const res = await api("/api/rate-plans", {
        method: "PUT",
        ...withRole("manager"),
        body: JSON.stringify({ from: "2032-01-02", to: "2032-01-02", prices: { standard: 50 } }),
      });
      expect(res.status).toBe(200);
    });

    it("MANAGER sozlamalarga tegolmaydi (403)", async () => {
      if (!authOn) return;
      const res = await api("/api/admin/settings", {
        method: "PUT",
        ...withRole("manager"),
        body: JSON.stringify({ ratesSoT: "beds24" }),
      });
      expect(res.status).toBe(403);
    });

    it("ADMIN sozlamalarni o'zgartiradi", async () => {
      if (!authOn) return;
      const before = await api("/api/admin/settings", withRole("admin"));
      const current = before.body.ratesSoT;

      const res = await api("/api/admin/settings", {
        method: "PUT",
        ...withRole("admin"),
        body: JSON.stringify({ ratesSoT: current }),
      });
      expect(res.status).toBe(200);
    });

    it("buzilgan token 401 beradi", async () => {
      if (!authOn) return;
      const res = await api("/api/rooms", {
        headers: { Authorization: "Bearer buzilgan.token.qiymati" },
      });
      expect(res.status).toBe(401);
    });
  });

  // --- 6. Rate limiting (TZ 18-band, 6-talab) ----------------
  //
  // Faqat `RATE_LIMIT_DISABLED=false` bo'lganda ishlaydi. Dev va
  // odatdagi test yurishlarida cheklov o'chirilgan, chunki testlar
  // o'nlab so'rov yuboradi va cheklovga urilib qolishi mumkin —
  // bu tekshirilayotgan xatti-harakat emas.
  describe("6. Rate limiting (RATE_LIMIT_DISABLED=false bo'lganda)", () => {
    let limitOn = false;

    beforeAll(async () => {
      const health = await api("/health");
      limitOn = health.body?.security?.rateLimit === true;
    });

    it("login 5 urinishdan keyin 429 beradi (brute-force himoyasi)", async () => {
      if (!limitOn) return;

      const codes: number[] = [];
      for (let i = 0; i < 8; i++) {
        const res = await fetch(`${PMS}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "" },
          body: JSON.stringify({ email: "brute@imron.local", password: "notogri" }),
        });
        codes.push(res.status);
      }

      // Boshida 401 (parol noto'g'ri), keyin 429 (cheklov)
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
      expect(codes[0]).toBe(401);
    }, 30000);

    it("cheklov sarlavhalari qaytariladi", async () => {
      if (!limitOn) return;

      const res = await fetch(`${PMS}/api/rooms`, { headers: { Authorization: "" } });
      // `standardHeaders: true` — RFC qoidasiga mos sarlavhalar
      const hasLimitHeader =
        res.headers.has("ratelimit-limit") || res.headers.has("ratelimit");
      expect(hasLimitHeader).toBe(true);
    });
  });

  // --- Cheklist (10-fayl §9) ---------------------------------
  describe("xavfsizlik cheklisti — FAZA 12 mezoni", () => {
    it("/health xavfsizlik holatini ko'rsatadi", async () => {
      const res = await api("/health");
      expect(res.body.security).toBeTruthy();
      expect(typeof res.body.security.auth).toBe("boolean");
      expect(typeof res.body.security.rateLimit).toBe("boolean");
    });

    it("hech bir API javobida token qolmagan", async () => {
      // Bir nechta endpoint'ni birdan tekshiramiz
      const paths = [
        "/api/rooms",
        "/api/reservations",
        "/api/admin/connection",
        "/api/admin/mapping",
        "/api/admin/status",
      ];

      // Auth yoqilgan bo'lsa token bilan so'raymiz
      for (const p of paths) {
        const res = await api(p, { headers: adminAuth });
        const text = res.raw.toLowerCase();
        expect(text, `${p} da refreshToken bor`).not.toContain("refreshtoken");
        expect(text, `${p} da accessToken bor`).not.toContain("accesstoken");
        expect(text, `${p} da passwordHash bor`).not.toContain("passwordhash");
      }
    });
  });
});
