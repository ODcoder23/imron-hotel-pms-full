/**
 * Webhook qabul qilish — TZ 10-band
 *
 * Manba: 04-WEBHOOK-HANDLER.md §2, §3, §9
 *
 * TZ 10-band ketma-ketligi: validate -> eventni saqlash ->
 * duplicate tekshirish -> queuega yuborish -> database update ->
 * Shaxmatkani update qilish.
 *
 * FAZA 6 — birinchi to'rt qadam (HTTP so'rov ichida, tez).
 * FAZA 7 — worker (asinxron: Reservation yaratish, WebSocket).
 *
 * NEGA 200 DARHOL QAYTARILADI (04-fayl §2): Beds24 javobni kutadi
 * va kechiksa qayta yuboradi. Og'ir ishni HTTP so'rov ichida
 * bajarish — takroriy webhook va timeout sababi.
 */

import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { config } from "../lib/config.js";
import { sanitizeForJson } from "../lib/sanitize.js";
import { getChannel } from "./channel/registry.js";
import { webhookQueue } from "../queues/index.js";

export type WebhookIntake = {
  status: "accepted" | "duplicate" | "invalid";
  webhookEventId: string | null;
  eventType: string;
  externalId: string | null;
  detail?: string;
};

/**
 * Vaqtga bog'liq maydonlar — hash'ga KIRMAYDI.
 *
 * Takroriy webhook'da bu qiymatlar har safar o'zgaradi, lekin bron
 * mazmuni bir xil. Ularni hisobga olsak dedup umuman ishlamaydi
 * (aynan shu xato FAZA 6 testida topildi).
 */
const VOLATILE_KEYS = new Set([
  "timestamp", "modifiedtime", "modifiedat", "sentat", "receivedat",
  "deliveryid", "webhookid", "requestid", "nonce",
]);

/** Kalitlarni tartiblab, vaqt maydonlarini tashlab, barqaror JSON */
function stableStringify(value: unknown, depth = 0): string {
  if (depth > 12) return '"[MAX_DEPTH]"';
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v, depth + 1)).join(",") + "]";
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k]) => !VOLATILE_KEYS.has(k.toLowerCase().replace(/[-_]/g, "")))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v, depth + 1));

  return "{" + entries.join(",") + "}";
}

/**
 * SHA-256 — bir xil MAZMUNni aniqlash uchun (04-fayl §3).
 *
 * Nima uchun oddiy `JSON.stringify` yaramaydi:
 *   1. Kalitlar tartibi o'zgarsa hash ham o'zgaradi
 *   2. `timestamp` har safar boshqacha bo'ladi
 * Ikkalasi ham dedup'ni buzadi.
 */
export function computePayloadHash(payload: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

// ============================================================
//  1. VALIDATE (04-fayl §9)
// ============================================================

export type ValidationContext = {
  urlToken?: string;
  signature?: string;
  rawBody?: string;
  clientIp?: string;
};

export type ValidationResult = { ok: true } | { ok: false; reason: string; status: number };

/**
 * Webhook haqiqatan Beds24'dan kelganini tekshiradi.
 *
 * IKKI REJIM (04-fayl §9) — `.env` da `WEBHOOK_AUTH_MODE`:
 *   signature — HMAC-SHA256 (Beds24 secret bersa)
 *   ip_token  — maxfiy URL token + IP whitelist (bermasa)
 *
 * Beds24 signature beradimi — FAZA 15 da dasturchi aniqlaydi.
 * Kod ikkala holatni ham qo'llab-quvvatlaydi, faqat sozlama o'zgaradi.
 */
export function validateWebhook(ctx: ValidationContext): ValidationResult {
  const mode = config.webhook.authMode;

  if (mode === "signature") {
    const secret = config.webhook.signatureSecret;
    if (!secret) {
      return { ok: false, reason: "WEBHOOK_SIGNATURE_SECRET sozlanmagan", status: 500 };
    }
    if (!ctx.signature) {
      return { ok: false, reason: "Signature header yo'q", status: 401 };
    }
    if (!ctx.rawBody) {
      return { ok: false, reason: "Raw body o'qilmadi", status: 400 };
    }

    const expected = crypto.createHmac("sha256", secret).update(ctx.rawBody).digest("hex");
    const given = ctx.signature.replace(/^sha256=/, "");

    // timingSafeEqual — uzunlik bir xil bo'lishi shart
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(given, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: "Signature mos kelmadi", status: 401 };
    }
    return { ok: true };
  }

  // ip_token rejimi
  const expectedToken = config.webhook.urlToken;
  if (!expectedToken) {
    return { ok: false, reason: "WEBHOOK_URL_TOKEN sozlanmagan", status: 500 };
  }
  if (ctx.urlToken !== expectedToken) {
    return { ok: false, reason: "URL token noto'g'ri", status: 401 };
  }

  // IP whitelist — ro'yxat bo'sh bo'lsa tekshirilmaydi
  const allowed = config.webhook.allowedIps;
  if (allowed.length > 0 && ctx.clientIp) {
    const ip = ctx.clientIp.replace(/^::ffff:/, "");
    const isAllowed = allowed.some((a) => ip === a.trim() || ip.startsWith(a.trim()));
    if (!isAllowed) {
      return { ok: false, reason: `IP ruxsat etilmagan: ${ip}`, status: 403 };
    }
  }

  return { ok: true };
}

/** Payload sxemasi — majburiy maydonlar bormi */
export function validatePayloadShape(payload: unknown): ValidationResult {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "Payload obyekt emas", status: 400 };
  }
  const p = payload as Record<string, unknown>;
  if (!p.event && !p.booking) {
    return { ok: false, reason: "`event` yoki `booking` maydoni yo'q", status: 400 };
  }
  return { ok: true };
}

// ============================================================
//  2-4. SAQLASH, DEDUP, QUEUE
// ============================================================

/**
 * Webhook'ni qabul qiladi va navbatga qo'yadi.
 *
 * MUHIM: validatsiyadan o'tmagan so'rov ham saqlanadi
 * (`status = FAILED`) — hujum urinishlarini ko'rish uchun
 * (04-fayl §9).
 */
export async function intakeWebhook(
  payload: unknown,
  validation: ValidationResult
): Promise<WebhookIntake> {
  const channel = await prisma.channel.upsert({
    where: { code: "beds24" },
    create: { code: "beds24", name: "Beds24", isActive: true },
    update: {},
  });

  // Adapter payload'ni normallashtiradi — event nomi va id ajratiladi
  let eventType = "unknown";
  let externalId: string | null = null;
  try {
    const parsed = getChannel().parseWebhook(payload);
    eventType = parsed.event;
    externalId = parsed.externalId;
  } catch {
    // Parse bo'lmasa ham saqlaymiz — ma'lumot yo'qolmaydi
  }

  const payloadHash = computePayloadHash(payload);
  const rawPayload = sanitizeForJson(payload);

  // --- Validatsiyadan o'tmadi: saqlanadi, lekin navbatga tushmaydi ---
  if (!validation.ok) {
    const event = await prisma.webhookEvent.create({
      data: {
        channelId: channel.id,
        eventType,
        externalId,
        payloadHash,
        rawPayload,
        status: "FAILED",
        errorMessage: `Validatsiya: ${validation.reason}`,
      },
    });
    return {
      status: "invalid",
      webhookEventId: event.id,
      eventType,
      externalId,
      detail: validation.reason,
    };
  }

  // --- 3. DUPLICATE TEKSHIRISH (TZ 9-band, 1-qatlam) ---
  //
  // unique(channelId, eventType, externalId, payloadHash)
  //
  // DIQQAT: constraint ichida `createdAt` BO'LMASLIGI shart.
  // `createdAt = now()` har safar boshqacha bo'lgani uchun, u
  // constraint tarkibida bo'lsa dedup umuman ishlamaydi.
  // `payloadHash` esa mazmun bir xilligini aniqlaydi: bir xil
  // bookingId uchun TURLI mazmunli webhook normal holat (bron
  // yangilandi), bir xil mazmun esa duplicate.
  const existing = await prisma.webhookEvent.findFirst({
    where: { channelId: channel.id, eventType, externalId, payloadHash },
  });

  if (existing) {
    const dup = await prisma.webhookEvent.create({
      data: {
        channelId: channel.id,
        eventType,
        externalId,
        // Hash'ni o'zgartiramiz — unique constraint buzilmasin,
        // lekin asl hash `rawPayload._duplicateOf` da qoladi
        payloadHash: `${payloadHash}:dup:${Date.now()}`,
        rawPayload: { ...(rawPayload as object), _duplicateOf: existing.id },
        status: "IGNORED_DUPLICATE",
        processedAt: new Date(),
      },
    });
    return {
      status: "duplicate",
      webhookEventId: dup.id,
      eventType,
      externalId,
      detail: `Avvalgi event: ${existing.id}`,
    };
  }

  // --- 2. SAQLASH + 4. QUEUEGA YUBORISH (04-fayl §2) ---
  const event = await prisma.webhookEvent.create({
    data: {
      channelId: channel.id,
      eventType,
      externalId,
      payloadHash,
      rawPayload,
      status: "QUEUED",
    },
  });

  // Navbatga qo'yish. Redis ishlamasa ham event DB'da QUEUED
  // holatida qoladi — `processPendingEvents()` keyinroq oladi,
  // ma'lumot YO'QOLMAYDI (TZ 17-band).
  try {
    await webhookQueue.add(
      "process",
      { webhookEventId: event.id },
      { jobId: event.id }      // idempotent: bir event bir marta
    );
  } catch (e) {
    console.warn(
      `[webhook] navbatga qo'yilmadi (${String(e).slice(0, 80)}) — ` +
      `event ${event.id} QUEUED holatida qoldi`
    );
  }

  return { status: "accepted", webhookEventId: event.id, eventType, externalId };
}

// ============================================================
//  Qo'lda qayta ishlash (04-fayl §7)
// ============================================================

/**
 * `NEEDS_MANUAL_ACTION` yoki `FAILED` event'ni qayta navbatga qo'yadi.
 * Admin mapping'ni to'g'irlagandan keyin ishlatiladi.
 */
export async function reprocessWebhook(id: string, userId?: string) {
  const event = await prisma.webhookEvent.findUnique({ where: { id } });
  if (!event) return null;

  const updated = await prisma.webhookEvent.update({
    where: { id },
    data: { status: "QUEUED", errorMessage: null, attempts: { increment: 1 } },
  });

  await prisma.auditLog.create({
    data: {
      userId: userId ?? null,
      action: "webhook.reprocessed",
      entityType: "WebhookEvent",
      entityId: id,
      before: { status: event.status, errorMessage: event.errorMessage },
      after: { status: "QUEUED" },
    },
  });

  return updated;
}

/** Statistika — admin sahifasi uchun */
export async function getWebhookStats() {
  const grouped = await prisma.webhookEvent.groupBy({
    by: ["status"],
    _count: true,
  });

  const byStatus: Record<string, number> = {};
  for (const g of grouped) byStatus[g.status.toLowerCase()] = g._count;

  const recent = await prisma.webhookEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { createdAt: true },
  });

  return {
    byStatus,
    total: grouped.reduce((s, g) => s + g._count, 0),
    lastReceivedAt: recent[0]?.createdAt.toISOString() ?? null,
  };
}
