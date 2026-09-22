/**
 * Audit log — TZ 18-band (8-talab)
 *
 * Manba: 10-SECURITY-VA-SYNCLOG.md §4
 *
 * FARQ (10-fayl §4):
 *   `AuditLog` — KIM qildi (odam harakati)
 *   `SyncLog`  — NIMA yuborildi (tizim harakati)
 * Ikkalasi alohida jadval, aralashtirilmaydi.
 *
 * `before`/`after` `sanitizeForLog()` dan o'tadi: sozlama qiymatida
 * token bo'lib qolishi mumkin (masalan kelajakda `WEBHOOK_TOKEN`
 * sozlama sifatida qo'shilsa).
 */

import { prisma } from "../lib/prisma.js";
import { getAuditRetentionDays } from "./settings.js";
import { sanitizeForLog } from "../lib/sanitize.js";

/**
 * Qayd qilinadigan amallar (10-fayl §4).
 *
 * Ro'yxat yopiq: yangi amal qo'shish uchun shu yerga yozish kerak,
 * shunda "qaysi amallar kuzatiladi" savoliga bitta javob bo'ladi.
 */
export const AUDIT_ACTIONS = [
  "mapping.created",
  "mapping.updated",
  "mapping.deleted",
  "settings.changed",
  "channel.connected",
  "channel.disconnected",
  "webhook.reprocessed",
  "reservation.cancelled",
  "reservation.no_show",
  // Pul harakati — naqd yo'qolsa javobgar ko'rinsin (SAVOLLAR.md S13)
  "payment.received",
  "payment.refunded",
  "payment.reversed",
  // Xarajatlar (SAVOLLAR.md S14) — foyda hisobiga ta'sir qiladi
  "expense.created",
  "expense.deleted",
  // Bot ruxsatlari (TOZALIK-BOT.md §7) — kim moliyani ko'ra oladi
  "bot.access_granted",
  "bot.access_changed",
  "bot.access_revoked",
  "rate.changed",
  "room.blocked",
  "room.unblocked",
  "floor.blocked",
  "floor.unblocked",
  "user.created",
  "user.role_changed",
  "user.login",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditInput = {
  userId?: string | null;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string;
};

/**
 * Audit yozuvi yaratadi.
 *
 * XATO TASHLAMAYDI: audit yozilmagani uchun asosiy amal
 * bekor qilinmasligi kerak (TZ 17-band). Xato konsolga tushadi.
 *
 * `userId` "dev" bo'lsa (auth o'chirilgan rejim) null yoziladi —
 * DB'da bunday foydalanuvchi yo'q, foreign key yiqilardi.
 */
export async function audit(input: AuditInput): Promise<void> {
  try {
    const userId = input.userId && input.userId !== "dev" ? input.userId : null;

    // Foydalanuvchi o'chirilgan bo'lishi mumkin — FK xatosidan qochamiz
    const exists = userId
      ? await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
      : null;

    await prisma.auditLog.create({
      data: {
        userId: exists ? userId : null,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        before: input.before ? (sanitizeForLog(input.before) as never) : undefined,
        after: input.after ? (sanitizeForLog(input.after) as never) : undefined,
        ipAddress: input.ipAddress ?? null,
      },
    });
  } catch (e) {
    console.warn(`[audit] yozilmadi (${input.action}): ${String(e).slice(0, 120)}`);
  }
}

/** Admin panel uchun — oxirgi yozuvlar */
export async function listAudit(opts: {
  limit?: number;
  action?: string;
  entityType?: string;
} = {}) {
  const rows = await prisma.auditLog.findMany({
    where: {
      ...(opts.action ? { action: opts.action } : {}),
      ...(opts.entityType ? { entityType: opts.entityType } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 50, 200),
    include: { user: { select: { email: true, fullName: true, role: true } } },
  });

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    before: r.before,
    after: r.after,
    ipAddress: r.ipAddress,
    createdAt: r.createdAt.toISOString(),
    // Foydalanuvchi o'chirilgan bo'lsa ham yozuv qoladi
    user: r.user ? { email: r.user.email, fullName: r.user.fullName, role: r.user.role } : null,
  }));
}

// ============================================================
//  Tozalash — SAVOLLAR.md S16
// ============================================================

/**
 * Eski audit yozuvlarini o'chiradi.
 *
 * QOIDA (2026-09-17 kelishuvi): jurnal `AUDIT_RETENTION_DAYS` kun
 * saqlanadi (boshlang'ich 365). Bronlar, mehmonlar va to'lovlar
 * O'CHIRILMAYDI — ular kichik va moliyaviy tarix uchun kerak.
 *
 * NEGA AYNAN JURNAL: u eng tez o'sadigan jadval — har amal uchun
 * bitta yozuv. Bir yildan eski yozuv amalda hech qachon o'qilmaydi,
 * lekin zaxira nusxasini va so'rovlarni sekinlashtiradi.
 *
 * Haftada bir marta ishlaydi (`scheduler.ts`).
 */
export async function pruneAuditLog(): Promise<{
  deleted: number;
  olderThanDays: number;
}> {
  const days = await getAuditRetentionDays();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const result = await prisma.auditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  return { deleted: result.count, olderThanDays: days };
}
