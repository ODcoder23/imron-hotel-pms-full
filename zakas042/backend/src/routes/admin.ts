/**
 * Admin endpoint'lari — mapping, ulanish holati, sync loglari
 *
 * Manba: 06-XONA-MAPPING.md §3, §7
 *
 * ISH CHEGARASI: mavjud Admin Panel kodiga kirish yo'q, shuning
 * uchun bu endpoint'lar backend ichidagi alohida sahifalar bilan
 * ishlaydi (`/admin/*`). Keyinroq mavjud Admin Panelga ko'chirish
 * mumkin — API o'zgarmaydi.
 *
 * TZ 18-band: faqat ADMIN roli kirishi kerak. JWT FAZA 12 da
 * qo'shiladi — hozircha ochiq (dev).
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, ValidationError, NotFoundError } from "../lib/errors.js";
import { toNumber, toDateKey } from "../lib/serialize.js";
import * as mapping from "../services/mapping.js";
import {
  listSettings, setSetting, SETTING_KEYS, getRatesSoT, getAvailabilitySoT,
  getMealPrice, getFreeCancelHours, getCancelFeeNights,
  getOtaCommissionPercent, getAuditRetentionDays, BUSINESS_DEFAULTS,
} from "../services/settings.js";
import {
  addExpense, deleteExpense, listExpenses, expenseSummary, CATEGORY_LABEL,
} from "../services/expenses.js";
import {
  createTask, listTasks, listCleaners, reassignTask, cancelTask,
  dirtyWithoutTask, todayPlan, arrivalsReadiness, lateTasks, cleanerStats,
  approveTask, rejectTask,
} from "../services/cleaning.js";

/** Bir hafta oldin — farosh statistikasi oralig'i */
function weekAgo(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Ertaga — oraliq oxiri (bugun ham kirsin) */
function tomorrow(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}
import { Prisma, type CleaningStatus } from "@prisma/client";
import { config } from "../lib/config.js";
import { kitchenOverview } from "../services/kitchen.js";
import { sendDailyKitchenReport } from "../bot/kitchen-bot.js";
import {
  listBotAccess,
  createBotAccess,
  updateBotAccess,
  deleteBotAccess,
} from "../services/botAccess.js";

/**
 * Zod natijasini tekshiradi yoki tushunarli xato tashlaydi.
 *
 * NEGA: `schema.parse()` to'g'ridan-to'g'ri chaqirilsa
 * `ZodError` chiqadi va u global ishlovchida ushlanadi, lekin
 * xabar shakli boshqacha bo'ladi. Bu yordamchi hamma joyda
 * bir xil xabar beradi.
 */
function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ValidationError(
      r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }
  return r.data;
}
import { requireAuth, requirePermission, type AuthedRequest } from "../lib/authMiddleware.js";
import { audit, listAudit } from "../services/auditLog.js";
import {
  runPollNow, runDriftCheckNow, runCatchUpNow, runExpireNow,
} from "../queues/scheduler.js";
import { checkChannelHealth } from "../services/reconciliation.js";
import { listDeadLetters, requeueDeadLetter, clearDeadLetters } from "../queues/deadLetter.js";
import { cleanQueueHistory } from "../queues/index.js";
import { getChannel } from "../services/channel/registry.js";
import { getRoomTypesCached, invalidateRoomTypes } from "../services/channel/propertyCache.js";
import { getConnectionStatus } from "../services/beds24/auth.js";
import { getCreditState } from "../services/beds24/client.js";
import * as webhookSvc from "../services/webhook.js";
import { getFullReport } from "../services/report.js";
import { fromDateKey } from "../lib/serialize.js";

export const adminRouter = Router();

// ============================================================
//  Mapping (TZ 5-band)
// ============================================================

/** GET /api/admin/mapping — joriy bog'lanishlar */
adminRouter.get("/mapping", asyncHandler(async (_req, res) => {
  const list = await mapping.listMappings();
  res.json(list.map((m) => ({
    id: m.id,
    roomTypeId: m.roomTypeId,
    roomTypeLabel: m.roomType?.label,
    roomId: m.roomId,
    roomNumber: m.room?.number,
    externalRoomTypeId: m.externalRoomTypeId,
    externalUnitId: m.externalUnitId,
    createdAt: m.createdAt.toISOString(),
  })));
}));

/** GET /api/admin/mapping/health — to'liqlik tekshiruvi (06-fayl §7) */
adminRouter.get("/mapping/health", asyncHandler(async (_req, res) => {
  res.json(await mapping.getMappingHealth());
}));

/** GET /api/admin/mapping/external — Beds24'dagi turlar (tanlash uchun) */
adminRouter.get("/mapping/external", asyncHandler(async (req, res) => {
  const status = await getConnectionStatus();
  if (!status.isConnected) {
    res.json({ connected: false, properties: [] });
    return;
  }

  try {
    // `?refresh=true` keshni chetlab o'tadi (admin "Yangilash")
    const force = req.query.refresh === "true";
    if (force) invalidateRoomTypes();
    const properties = await getRoomTypesCached(undefined, { force });
    res.json({ connected: true, properties });
  } catch (e) {
    res.json({
      connected: true,
      properties: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}));

/** PUT /api/admin/mapping — bog'lash */
const upsertSchema = z.object({
  roomTypeId: z.string().min(1).optional(),
  roomId: z.string().min(1).optional(),
  externalRoomTypeId: z.string().min(1),
  externalUnitId: z.string().min(1).optional(),
});

adminRouter.put("/mapping", requireAuth, requirePermission("mapping.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }
  // Oldingi holat — audit `before` uchun
  const before = parsed.data.roomTypeId
    ? await mapping.findRoomTypeMapping(parsed.data.roomTypeId)
    : null;

  const result = await mapping.upsertMapping(parsed.data);

  await audit({
    userId: req.user?.id,
    action: before ? "mapping.updated" : "mapping.created",
    entityType: "ChannelMapping",
    entityId: result.id,
    before: before ? { externalRoomTypeId: before.externalRoomTypeId } : undefined,
    after: { ...parsed.data },
    ipAddress: req.ip,
  });

  res.json({ ok: true, id: result.id });
}));

/** DELETE /api/admin/mapping/:id — bog'lanishni olib tashlash */
adminRouter.delete("/mapping/:id", requireAuth, requirePermission("mapping.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const force = req.query.force === "true";
  await mapping.deleteMapping(req.params.id, { force });

  await audit({
    userId: req.user?.id,
    action: "mapping.deleted",
    entityType: "ChannelMapping",
    entityId: req.params.id,
    after: { force },
    ipAddress: req.ip,
  });

  res.json({ ok: true });
}));

// ============================================================
//  Beds24 ulanishi
// ============================================================

/**
 * GET /api/admin/connection
 * TZ 13-band: token'ning o'zi HECH QACHON qaytarilmaydi —
 * faqat "ulangan/ulanmagan" holati.
 */
adminRouter.get("/connection", asyncHandler(async (_req, res) => {
  const status = await getConnectionStatus();
  const credits = getCreditState();

  res.json({
    ...status,
    credits: {
      remaining: credits.remaining,
      resetsIn: credits.resetsIn,
      isLow: credits.isLow,
    },
  });
}));

/** POST /api/admin/connection/ping — ulanishni tekshirish */
adminRouter.post("/connection/ping", requireAuth, requirePermission("channel.connect"), asyncHandler(async (_req, res) => {
  res.json(await getChannel().ping());
}));

// ============================================================
//  SyncLog (TZ 16-band)
// ============================================================

adminRouter.get("/sync-log", requireAuth, requirePermission("synclog.read"), asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const status = req.query.status as string | undefined;

  const logs = await prisma.syncLog.findMany({
    where: status ? { status: status.toUpperCase() as never } : {},
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  res.json(logs.map((l) => ({
    id: l.id,
    action: l.action,
    direction: l.direction.toLowerCase(),
    status: l.status.toLowerCase(),
    reservationId: l.reservationId,
    roomId: l.roomId,
    attempt: l.attempt,
    errorMessage: l.errorMessage,
    durationMs: l.durationMs,
    createdAt: l.createdAt.toISOString(),
  })));
}));

/** GET /api/admin/webhook-events — kelgan webhook'lar (04-fayl) */
adminRouter.get("/webhook-events", asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const status = req.query.status as string | undefined;

  const events = await prisma.webhookEvent.findMany({
    where: status ? { status: status.toUpperCase() as never } : {},
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  res.json(events.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    externalId: e.externalId,
    status: e.status.toLowerCase(),
    attempts: e.attempts,
    errorMessage: e.errorMessage,
    processedAt: e.processedAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
  })));
}));

/** POST /api/admin/webhook-events/:id/reprocess — qo'lda qayta ishlash (04-fayl §7) */
adminRouter.post("/webhook-events/:id/reprocess", requireAuth, requirePermission("mapping.write"), asyncHandler(async (req: AuthedRequest, res) => {
  await audit({
    userId: req.user?.id,
    action: "webhook.reprocessed",
    entityType: "WebhookEvent",
    entityId: req.params.id,
    ipAddress: req.ip,
  });

  const result = await webhookSvc.reprocessWebhook(req.params.id);
  if (!result) throw new NotFoundError("Webhook event");
  res.json({ ok: true, status: result.status.toLowerCase() });
}));

/** GET /api/admin/webhook-events/stats */
adminRouter.get("/webhook-events/stats", asyncHandler(async (_req, res) => {
  res.json(await webhookSvc.getWebhookStats());
}));

// ============================================================
//  Narxlar (07-fayl §8 — Q8: admin qo'lda belgilaydi)
// ============================================================

adminRouter.get("/rates", asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) throw new ValidationError("from va to kerak");

  const plans = await prisma.ratePlan.findMany({
    where: {
      date: {
        gte: new Date(`${from}T00:00:00Z`),
        lte: new Date(`${to}T00:00:00Z`),
      },
    },
    orderBy: [{ date: "asc" }, { roomTypeId: "asc" }],
  });

  res.json(plans.map((p) => ({
    roomTypeId: p.roomTypeId,
    date: toDateKey(p.date),
    price: toNumber(p.price),
    minStay: p.minStay,
    source: p.source,
    syncStatus: p.syncError ? "error" : p.syncedAt ? "synced" : "pending",
    syncError: p.syncError,
  })));
}));

// ============================================================
//  Umumiy holat — /admin bosh sahifasi uchun
// ============================================================

adminRouter.get("/status", asyncHandler(async (_req, res) => {
  const [health, connection, roomCount, resCount, failedSync, pendingWebhooks] =
    await Promise.all([
      mapping.getMappingHealth(),
      getConnectionStatus(),
      prisma.room.count({ where: { isActive: true } }),
      prisma.reservation.count({
        where: { status: { in: ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN"] } },
      }),
      prisma.syncLog.count({ where: { status: "FAILED" } }),
      prisma.webhookEvent.count({
        where: { status: { in: ["RECEIVED", "QUEUED", "FAILED", "NEEDS_MANUAL_ACTION"] } },
      }),
    ]);

  const credits = getCreditState();

  res.json({
    phase: "5",
    mapping: {
      isComplete: health.isComplete,
      unmappedRoomCount: health.unmappedRoomCount,
      orphanCount: health.orphanMappings.length,
    },
    beds24: {
      connected: connection.isConnected,
      propertyId: connection.propertyId,
      creditsRemaining: credits.remaining,
      creditsLow: credits.isLow,
    },
    counts: {
      rooms: roomCount,
      activeReservations: resCount,
      failedSyncs: failedSync,
      pendingWebhooks,
    },
  });
}));

// ============================================================
//  Sozlamalar — source of truth (TZ 7-band, 07-fayl §7)
// ============================================================

/** GET /api/admin/settings — joriy sozlamalar */
adminRouter.get("/settings", asyncHandler(async (_req, res) => {
  res.json(await listSettings());
}));

/**
 * PUT /api/admin/settings — source of truth o'zgartirish
 *
 * Bu qaror narx halqasining oldini oladi: bir vaqtda faqat bitta
 * tomon g'olib (07-fayl §7). O'zgarish AuditLog'ga yoziladi
 * (FAZA 12 da `updatedBy` haqiqiy foydalanuvchi bo'ladi).
 */
const settingsSchema = z.object({
  ratesSoT: z.enum(["pms", "beds24"]).optional(),
  availabilitySoT: z.enum(["pms", "beds24"]).optional(),
});

adminRouter.put("/settings", requireAuth, requirePermission("settings.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }

  const { ratesSoT, availabilitySoT } = parsed.data;

  // Source-of-truth almashtirilishi — eng muhim audit hodisasi
  // (10-fayl §4): narx qaysi tomondan boshqarilishini o'zgartiradi
  if (ratesSoT) {
    const before = await getRatesSoT();
    if (before !== ratesSoT) {
      await setSetting(SETTING_KEYS.ratesSoT, ratesSoT, req.user?.id);
      await audit({
        userId: req.user?.id,
        action: "settings.changed",
        entityType: "Settings",
        entityId: SETTING_KEYS.ratesSoT,
        before: { value: before },
        after: { value: ratesSoT },
        ipAddress: req.ip,
      });
    }
  }

  if (availabilitySoT) {
    const before = await getAvailabilitySoT();
    if (before !== availabilitySoT) {
      await setSetting(SETTING_KEYS.availabilitySoT, availabilitySoT, req.user?.id);
      await audit({
        userId: req.user?.id,
        action: "settings.changed",
        entityType: "Settings",
        entityId: SETTING_KEYS.availabilitySoT,
        before: { value: before },
        after: { value: availabilitySoT },
        ipAddress: req.ip,
      });
    }
  }

  res.json(await listSettings());
}));

/**
 * GET /api/admin/audit-log — kim nima qildi (TZ 18-band, 10-fayl §4)
 *
 * `synclog.read` huquqi: MANAGER ham ko'radi. Audit — nazorat
 * vositasi, uni yashirish nazoratni yo'qotadi.
 */
// --- GET /api/admin/report?from=&to= ------------------------
//
// Umumiy hisobot — FAQAT FOUNDER. Bu yerda maosh, foyda va
// xarajat bor: ADMIN texnik ishlarni qiladi, biznes raqamlari
// unga kerak emas (`PERMISSIONS["report.read"] = ["FOUNDER"]`).
adminRouter.get(
  "/report",
  requireAuth,
  requirePermission("report.read"),
  asyncHandler(async (req, res) => {
    const fromStr = String(req.query.from ?? "");
    const toStr = String(req.query.to ?? "");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
      throw new ValidationError("from va to: YYYY-MM-DD shaklida bo'lishi kerak");
    }

    const from = fromDateKey(fromStr);
    const to = fromDateKey(toStr);
    if (to < from) throw new ValidationError("'to' sanasi 'from' dan oldin bo'lishi mumkin emas");

    // Juda uzun oraliq sekin bo'ladi — bir yil yetarli
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
    if (days > 366) throw new ValidationError("Oraliq 366 kundan oshmasligi kerak");

    res.json(await getFullReport(from, to));
  })
);

adminRouter.get(
  "/audit-log",
  requireAuth,
  requirePermission("synclog.read"),
  asyncHandler(async (req, res) => {
    res.json(await listAudit({
      limit: req.query.limit ? Number(req.query.limit) : 50,
      action: req.query.action,
      entityType: req.query.entityType,
    }));
  })
);

// ============================================================
//  Davriy vazifalar — qo'lda ishga tushirish (FAZA 14)
// ============================================================
//
// Jadval o'z vaqtida baribir ishlaydi. Bu endpoint'lar admin
// nosozlikni kutmasdan tekshirishi uchun va dasturchi topshirishda
// zanjirni sinab ko'rishi uchun.

/**
 * POST /api/admin/maintenance/poll — Beds24'dan o'zgarishlarni tortish
 *
 * TZ 10-band: webhook ishlamasa ham bronlar tushadi (04-fayl §8).
 */
adminRouter.post(
  "/maintenance/poll",
  requireAuth,
  requirePermission("channel.connect"),
  asyncHandler(async (_req, res) => {
    try {
      res.json(await runPollNow());
    } catch (e) {
      // Beds24 javob bermasa 500 emas, TUSHUNARLI javob beramiz:
      // admin "server buzildi" deb o'ylamasligi kerak, bu kanal
      // holati (TZ 17-band).
      res.status(503).json({
        error: "Beds24 javob bermadi. Keyinroq urinib ko'ring.",
        code: "CHANNEL_UNAVAILABLE",
        detail: String(e).slice(0, 200),
      });
    }
  })
);

/**
 * POST /api/admin/maintenance/drift — PMS va Beds24 farqini tekshirish
 *
 * TZ 20-band: barcha tizimlar bir xil inventory (07-fayl §6).
 */
adminRouter.post(
  "/maintenance/drift",
  requireAuth,
  requirePermission("channel.connect"),
  asyncHandler(async (req, res) => {
    const days = req.query.days ? Number(req.query.days) : 30;
    try {
      res.json(await runDriftCheckNow(Math.min(Math.max(days, 1), 90)));
    } catch (e) {
      res.status(503).json({
        error: "Beds24 javob bermadi. Keyinroq urinib ko'ring.",
        code: "CHANNEL_UNAVAILABLE",
        detail: String(e).slice(0, 200),
      });
    }
  })
);

/**
 * POST /api/admin/maintenance/catch-up — qolib ketganlarni yuborish
 *
 * TZ 17-band: "Beds24 qayta ishlaganda avtomatik yuborilsin."
 */
adminRouter.post(
  "/maintenance/catch-up",
  requireAuth,
  requirePermission("channel.connect"),
  asyncHandler(async (_req, res) => {
    res.json(await runCatchUpNow());
  })
);

/** POST /api/admin/maintenance/expire-unpaid — to'lanmagan bronlar */
adminRouter.post(
  "/maintenance/expire-unpaid",
  requireAuth,
  requirePermission("reservation.cancel"),
  asyncHandler(async (_req, res) => {
    res.json(await runExpireNow());
  })
);

/**
 * GET /api/admin/channel-health — Beds24 javob beryaptimi
 *
 * TZ 17, 19-band: kanal o'chgan bo'lsa admin darhol ko'radi va
 * "nega OTA'da yangilanmayapti" degan savol tug'ilmaydi.
 */
adminRouter.get(
  "/channel-health",
  requireAuth,
  requirePermission("synclog.read"),
  asyncHandler(async (_req, res) => {
    res.json(await checkChannelHealth());
  })
);

// ============================================================
//  O'lik xat navbati — TZ 11-band (beds24-retry)
// ============================================================
//
// 5 urinishdan keyin ham bo'lmagan job'lar. Admin sababni
// tuzatgach (mapping bog'lash, Beds24 qaytishi) qayta yuboradi.

/** GET /api/admin/dead-letters — yiqilgan job'lar ro'yxati */
adminRouter.get(
  "/dead-letters",
  requireAuth,
  requirePermission("synclog.read"),
  asyncHandler(async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    res.json(await listDeadLetters(limit));
  })
);

/** POST /api/admin/dead-letters/requeue — qayta yuborish */
const requeueSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});

adminRouter.post(
  "/dead-letters/requeue",
  requireAuth,
  requirePermission("channel.connect"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = requeueSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("ids massivi kerak");

    const result = await requeueDeadLetter(parsed.data.ids);

    await audit({
      userId: req.user?.id,
      action: "webhook.reprocessed",
      entityType: "DeadLetter",
      entityId: parsed.data.ids.join(","),
      after: result,
      ipAddress: req.ip,
    });

    res.json(result);
  })
);

/** DELETE /api/admin/dead-letters — tozalash */
adminRouter.delete(
  "/dead-letters",
  requireAuth,
  requirePermission("channel.connect"),
  asyncHandler(async (_req, res) => {
    res.json({ removed: await clearDeadLetters() });
  })
);

/** DELETE /api/admin/queues/clean — barcha navbatlardagi eski xato/tugagan job'larni tozalash */
adminRouter.delete(
  "/queues/clean",
  requireAuth,
  requirePermission("channel.connect"),
  asyncHandler(async (_req, res) => {
    res.json({ cleaned: await cleanQueueHistory() });
  })
);

// ============================================================
//  XARAJATLAR — SAVOLLAR.md S14
//
//  NEGA `report.read` HUQUQI: xarajat daromad va foydani
//  ko'rsatadi, bu esa faqat egasi ko'radigan ma'lumot.
// ============================================================

/** GET /api/admin/expenses?from=&to= */
adminRouter.get(
  "/expenses",
  requireAuth,
  requirePermission("report.read"),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) throw new ValidationError("from va to parametrlari kerak");

    const fromDate = fromDateKey(from);
    const toEx = fromDateKey(to);
    toEx.setUTCDate(toEx.getUTCDate() + 1);   // `to` kuni ham kirsin

    const [rows, summary] = await Promise.all([
      listExpenses(fromDate, toEx),
      expenseSummary(fromDate, toEx),
    ]);

    res.json({
      summary,
      items: rows.map((r) => ({
        id: r.id,
        date: toDateKey(r.date),
        category: r.category,
        label: CATEGORY_LABEL[r.category],
        amount: Number(r.amount),
        note: r.note ?? "",
        isAuto: r.isAuto,
        enteredBy: r.user?.fullName ?? null,
      })),
    });
  })
);

/** POST /api/admin/expenses — qo'lda xarajat kiritish */
const expenseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Sana 'YYYY-MM-DD' shaklida"),
  category: z.enum([
    "UTILITIES", "FOOD", "MAINTENANCE", "TAX",
    "MARKETING", "COMMISSION", "SALARY", "OTHER",
  ]),
  amount: z.number().positive("Summa musbat bo'lishi kerak").max(1_000_000_000),
  note: z.string().max(500).optional(),
});

adminRouter.post(
  "/expenses",
  requireAuth,
  requirePermission("report.read"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = expenseSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      );
    }

    const row = await addExpense({ ...parsed.data, userId: req.user?.id });

    await audit({
      userId: req.user?.id,
      action: "expense.created",
      entityType: "Expense",
      entityId: row.id,
      after: { category: row.category, amount: Number(row.amount) },
      ipAddress: req.ip,
    });

    res.status(201).json({ id: row.id });
  })
);

/** DELETE /api/admin/expenses/:id */
adminRouter.delete(
  "/expenses/:id",
  requireAuth,
  requirePermission("report.read"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const row = await deleteExpense(req.params.id);

    await audit({
      userId: req.user?.id,
      action: "expense.deleted",
      entityType: "Expense",
      entityId: req.params.id,
      before: { category: row.category, amount: Number(row.amount) },
      ipAddress: req.ip,
    });

    res.json({ ok: true });
  })
);

// ============================================================
//  BIZNES SOZLAMALARI — nonushta, bekor qilish, komissiya
// ============================================================

/**
 * GET /api/admin/business-settings
 *
 * Joriy qiymatlar + boshlang'ich qiymatlar. Panel "qaytadan
 * standartga" tugmasi uchun ikkalasini ham ko'rsatadi.
 */
adminRouter.get(
  "/business-settings",
  requireAuth,
  requirePermission("settings.write"),
  asyncHandler(async (_req, res) => {
    const [mealPrice, freeCancelHours, cancelFeeNights, otaCommissionPercent, auditRetentionDays] =
      await Promise.all([
        getMealPrice(),
        getFreeCancelHours(),
        getCancelFeeNights(),
        getOtaCommissionPercent(),
        getAuditRetentionDays(),
      ]);

    res.json({
      current: {
        mealPrice, freeCancelHours, cancelFeeNights,
        otaCommissionPercent, auditRetentionDays,
      },
      defaults: BUSINESS_DEFAULTS,
    });
  })
);

/** PUT /api/admin/business-settings */
const businessSchema = z.object({
  /** Nonushta — kishi boshiga (S10) */
  mealPrice: z.number().min(0).max(10_000_000).optional(),
  /** Bepul bekor qilish oynasi, soat (S11) */
  freeCancelHours: z.number().int().min(0).max(720).optional(),
  /** Jarima necha kecha narxi (S11) */
  cancelFeeNights: z.number().min(0).max(30).optional(),
  /** OTA komissiyasi, foiz (S14) */
  otaCommissionPercent: z.number().min(0).max(100).optional(),
  /** Audit saqlash muddati, kun (S16). 30 kundan kam bo'lmasin */
  auditRetentionDays: z.number().int().min(30).max(3650).optional(),
});

adminRouter.put(
  "/business-settings",
  requireAuth,
  requirePermission("settings.write"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = businessSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      );
    }

    const KEYS = {
      mealPrice: SETTING_KEYS.mealPrice,
      freeCancelHours: SETTING_KEYS.freeCancelHours,
      cancelFeeNights: SETTING_KEYS.cancelFeeNights,
      otaCommissionPercent: SETTING_KEYS.otaCommissionPercent,
      auditRetentionDays: SETTING_KEYS.auditRetentionDays,
    } as const;

    const changed: Record<string, number> = {};

    for (const [field, key] of Object.entries(KEYS)) {
      const value = parsed.data[field as keyof typeof KEYS];
      if (value === undefined) continue;

      await setSetting(key, String(value), req.user?.id);
      changed[field] = value;
    }

    // Pul bilan bog'liq sozlama — jurnalda qolsin
    if (Object.keys(changed).length > 0) {
      await audit({
        userId: req.user?.id,
        action: "settings.changed",
        entityType: "BusinessSettings",
        after: changed,
        ipAddress: req.ip,
      });
    }

    res.json({ ok: true, changed });
  })
);

// ============================================================
//  TOZALASH — TOZALIK-BOT.md
//
//  `room.block` huquqi: xona holati bilan ishlaydigan amal.
//  MANAGER ham topshiriq yubora oladi.
// ============================================================

/** GET /api/admin/cleaning — topshiriqlar ro'yxati */
adminRouter.get(
  "/cleaning",
  requireAuth,
  requirePermission("room.block"),
  asyncHandler(async (req, res) => {
    const status = req.query.status as CleaningStatus | undefined;

    /**
     * Nazorat uchun hamma ma'lumot bir so'rovda
     * (TOZALIK-TAHLIL.md).
     *
     * NEGA BIRGA: panel ochilganda oltita alohida so'rov
     * yuborsa, tunnel orqali har biri ~700ms oladi. Bitta
     * so'rovda hammasi parallel bajariladi.
     */
    const [tasks, cleaners, dirty, plan, arrivals, late, stats, rooms] =
      await Promise.all([
        listTasks(status),
        listCleaners(),
        dirtyWithoutTask(),
        todayPlan(),
        arrivalsReadiness(),
        lateTasks(),
        cleanerStats(weekAgo(), tomorrow()),
        // Xona ro'yxati — panelda tanlash uchun (qo'lda yozish
        // o'rniga ochiluvchi ro'yxat)
        prisma.room.findMany({
          where: { isActive: true },
          select: {
            id: true,
            floor: true,
            status: true,
            roomType: { select: { label: true } },
          },
          orderBy: { sortOrder: "asc" },
        }),
      ]);

    res.json({
      // --- Diqqat talab qiladi (TOZALIK-TAHLIL.md §1, §2) ---
      alerts: {
        dirtyWithoutTask: dirty,
        late: late.map((l) => ({
          ...l,
          // Panel qaysi topshiriq ekanini ko'rsatishi uchun
          reason: tasks.find((t) => t.id === l.id)?.reason ?? "",
          employeeName: (() => {
            const t = tasks.find((x) => x.id === l.id);
            return t?.claimedByName ?? t?.employee?.fullName ?? null;
          })(),
        })),
      },

      // --- Bugungi holat (§4) ---
      today: plan,

      // --- Kelayotgan mehmonlar va xona tayyorligi (§5) ---
      arrivals,

      // --- Farosh natijalari (§3) ---
      stats,

      // Tanlash ro'yxatlari — panel qo'lda yozishni talab
      // qilmasin
      rooms: rooms.map((r) => ({
        id: r.id,
        label: r.roomType?.label ?? "",
        floor: r.floor,
        status: r.status,
      })),

      cleaners: cleaners.map((c) => ({
        id: c.id,
        fullName: c.fullName,
        // Telegram bog'lanmagan bo'lsa panelda ogohlantirish
        hasTelegram: Boolean(c.telegramId),
      })),
      tasks: tasks.map((t) => ({
        id: t.id,
        roomId: t.roomId,
        roomType: t.room.roomType?.label ?? "",
        floor: t.room.floor,
        status: t.status,
        reason: t.reason,
        isAuto: t.isAuto,
        employeeId: t.employeeId,
        /**
         * Kim bajardi.
         *
         * Guruh mantig'ida (2026-09-17) `employee` bo'sh bo'ladi —
         * kim olgani `claimedByName` da (Telegram ismi). Panel
         * ikkalasini ham ko'rsata olishi uchun ikkalasi ham
         * qaytariladi, `workerName` esa tayyor qiymat.
         */
        employeeName: t.employee?.fullName ?? null,
        claimedByName: t.claimedByName,
        workerName: t.claimedByName ?? t.employee?.fullName ?? null,
        photoUrl: t.photoUrl ?? null,
        /** Guruhga xabar yuborilganmi */
        sentToGroup: Boolean(t.chatId),
        createdAt: t.createdAt.toISOString(),
        acceptedAt: t.acceptedAt?.toISOString() ?? null,
        finishedAt: t.finishedAt?.toISOString() ?? null,
        doneAt: t.doneAt?.toISOString() ?? null,
      })),
    });
  })
);

/** POST /api/admin/cleaning — qo'lda topshiriq yuborish */
const cleaningSchema = z.object({
  roomId: z.string().min(1).max(50),
  reason: z.string().min(3, "Sabab yozilishi kerak").max(300),
  /** Berilmasa navbat bo'yicha tanlanadi */
  employeeId: z.string().min(1).optional(),
});

adminRouter.post(
  "/cleaning",
  requireAuth,
  requirePermission("room.block"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = cleaningSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      );
    }

    const { task, created } = await createTask({
      ...parsed.data,
      isAuto: false,
      createdById: req.user?.id,
    });

    /**
     * Ogohlantirish OLIB TASHLANDI (2026-09-17).
     *
     * Ilgari ikki xil xabar chiqardi: "Telegram bog'langan
     * farosh topilmadi" (guruh mantig'ida hech qachon
     * biriktirilmaydi, shuning uchun har doim chiqardi) va
     * "ish vaqti tugagan" (endi bot 24 soat ishlaydi).
     *
     * Ikkalasi ham admin'ni behuda chalg'itardi. Xabar guruhga
     * darhol ketadi; yuborilmasa bot log'iga yoziladi va
     * davriy vazifa qayta uriniadi.
     */
    res.status(created ? 201 : 200).json({
      id: task.id,
      created,
      employeeName: task.employee?.fullName ?? null,
      sentToGroup: true,
      warning: null,
    });
  })
);

/** POST /api/admin/cleaning/:id/reassign — boshqa faroshga */
adminRouter.post(
  "/cleaning/:id/reassign",
  requireAuth,
  requirePermission("room.block"),
  asyncHandler(async (req, res) => {
    const { employeeId } = parseOrThrow(
      z.object({ employeeId: z.string().min(1) }),
      req.body
    );

    const task = await reassignTask(req.params.id, employeeId);
    res.json({ id: task.id, employeeName: task.employee?.fullName ?? null });
  })
);

/**
 * POST /api/admin/cleaning/:id/approve — tozalashni tasdiqlash
 *
 * FAQAT SHU YERDA xona sotishga ochiladi (2026-09-17 qarori).
 * Farosh "tozaladim" degani yetarli emas.
 */
adminRouter.post(
  "/cleaning/:id/approve",
  requireAuth,
  requirePermission("room.block"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const task = await approveTask(req.params.id, req.user?.id);
    res.json({ id: task.id, roomId: task.roomId });
  })
);

/** POST /api/admin/cleaning/:id/reject — qayta tozalash */
adminRouter.post(
  "/cleaning/:id/reject",
  requireAuth,
  requirePermission("room.block"),
  asyncHandler(async (req, res) => {
    const { note } = parseOrThrow(
      z.object({ note: z.string().max(300).optional() }),
      req.body
    );

    const task = await rejectTask(req.params.id, note ?? "");
    res.json({ id: task.id });
  })
);

/** DELETE /api/admin/cleaning/:id — bekor qilish */
adminRouter.delete(
  "/cleaning/:id",
  requireAuth,
  requirePermission("room.block"),
  asyncHandler(async (req, res) => {
    await cancelTask(req.params.id);
    res.json({ ok: true });
  })
);

// ============================================================
//  BOT RUXSATLARI — faqat FOUNDER (TOZALIK-BOT.md §7)
// ============================================================

/** GET /api/admin/bot-access */
adminRouter.get(
  "/bot-access",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const botType = req.query.botType as string | undefined;
    const [rows, employees] = await Promise.all([
      listBotAccess(botType),
      prisma.employee.findMany({
        where: { isActive: true },
        select: { id: true, fullName: true, position: true, telegramId: true },
        orderBy: { fullName: "asc" },
      }),
    ]);

    res.json({
      // `.env` dagi ro'yxat — o'chirib bo'lmaydi, zaxira yo'l
      envIds: config.telegram.founderIds,
      access: rows,
      // Xodimlar: kimda Telegram bog'langanini ko'rsatish uchun
      employees,
    });
  })
);

/** POST /api/admin/bot-access */
const botAccessInputSchema = z.object({
  botType: z.enum(["FOUNDER", "KITCHEN"]).default("FOUNDER"),
  telegramId: z.string().regex(/^(\d{5,15})?$/, "Telegram ID faqat raqam").optional().nullable(),
  username: z.string().max(100).optional().nullable(),
  label: z.string().min(1, "Ism yoki izoh kerak").max(100),
  level: z.enum(["FULL", "LIMITED"]).default("FULL"),
});

adminRouter.post(
  "/bot-access",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = parseOrThrow(botAccessInputSchema, req.body);

    const row = await createBotAccess({
      botType: data.botType,
      telegramId: data.telegramId,
      username: data.username,
      label: data.label,
      level: data.level,
      createdById: req.user?.id,
    });

    await audit({
      userId: req.user?.id,
      action: "bot.access_granted",
      entityType: "BotAccess",
      entityId: row.id,
      after: {
        botType: row.botType,
        telegramId: row.telegramId,
        username: row.username,
        label: row.label,
        level: row.level,
      },
      ipAddress: req.ip,
    });

    res.status(201).json(row);
  })
);

/** PATCH /api/admin/bot-access/:id */
adminRouter.patch(
  "/bot-access/:id",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const updateSchema = z.object({
      botType: z.enum(["FOUNDER", "KITCHEN"]).optional(),
      telegramId: z.string().regex(/^(\d{5,15})?$/, "Telegram ID faqat raqam").optional().nullable(),
      username: z.string().max(100).optional().nullable(),
      label: z.string().min(1).max(100).optional(),
      level: z.enum(["FULL", "LIMITED"]).optional(),
      isActive: z.boolean().optional(),
    });

    const data = parseOrThrow(updateSchema, req.body);
    const row = await updateBotAccess(req.params.id, data);

    await audit({
      userId: req.user?.id,
      action: "bot.access_changed",
      entityType: "BotAccess",
      entityId: row.id,
      after: data,
      ipAddress: req.ip,
    });

    res.json(row);
  })
);

/** DELETE /api/admin/bot-access/:id */
adminRouter.delete(
  "/bot-access/:id",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (req: AuthedRequest, res) => {
    await deleteBotAccess(req.params.id);

    await audit({
      userId: req.user?.id,
      action: "bot.access_revoked",
      entityType: "BotAccess",
      entityId: req.params.id,
      ipAddress: req.ip,
    });

    res.json({ ok: true });
  })
);

/** PATCH /api/admin/employees/:id/telegram — xodimni bog'lash */
adminRouter.patch(
  "/employees/:id/telegram",
  requireAuth,
  requirePermission("employee.write"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { telegramId } = parseOrThrow(
      z.object({
        // Bo'sh satr — bog'lanishni uzish
        telegramId: z.string().regex(/^(\d{5,15})?$/, "Telegram ID faqat raqam"),
      }),
      req.body
    );

    const value = telegramId || null;

    if (value) {
      const taken = await prisma.employee.findUnique({
        where: { telegramId: value },
        select: { id: true, fullName: true },
      });
      if (taken && taken.id !== req.params.id) {
        throw new ValidationError(`Bu Telegram ID ${taken.fullName} ga biriktirilgan`);
      }
    }

    await prisma.employee.update({
      where: { id: req.params.id },
      data: { telegramId: value },
    });

    res.json({ ok: true });
  })
);

// ============================================================
//  XODIMLAR — kadrlar hisobi (BOT-RUXSAT.md)
//
//  `employee.read` / `employee.write` huquqi: FOUNDER va ADMIN.
//  Maosh ma'lumoti bor, shuning uchun menejer ko'rmaydi.
// ============================================================

/**
 * Mavjud lavozimlar.
 *
 * NEGA RO'YXAT: erkin matn bo'lsa bir lavozim turli nomlar
 * bilan yozilib ketardi ("Farrosh", "farrosh", "Tozalovchi") va
 * tozalash tizimi farroshni topa olmasdi.
 *
 * `FARROSH` maxsus: faqat shu lavozimdagilar tozalash
 * topshiriqlarini oladi (`services/cleaning.ts`).
 */
const POSITIONS = [
  "Farrosh",
  "Qabulxona xodimi",
  "Menejer",
  "Bosh administrator",
  "Oshpaz",
  "Oshpaz yordamchisi",
  "Xavfsizlik",
  "Texnik xodim",
  "Boshqa",
] as const;

/** GET /api/admin/employees */
adminRouter.get(
  "/employees",
  requireAuth,
  requirePermission("employee.read"),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.employee.findMany({
      orderBy: [{ isActive: "desc" }, { fullName: "asc" }],
    });

    res.json({
      positions: POSITIONS,
      employees: rows.map((e) => ({
        id: e.id,
        fullName: e.fullName,
        position: e.position,
        phone: e.phone ?? "",
        passport: e.passport ?? "",
        photoUrl: e.photoUrl ?? "",
        salary: e.salary ? Number(e.salary) : 0,
        hiredAt: toDateKey(e.hiredAt),
        isActive: e.isActive,
        telegramId: e.telegramId ?? "",
        notes: e.notes ?? "",
      })),
    });
  })
);

const employeeSchema = z.object({
  fullName: z.string().min(2, "Ism kerak").max(200),
  position: z.string().min(2).max(100),
  phone: z.string().max(30).optional(),
  passport: z.string().max(50).optional(),
  /**
   * Rasm — `data:` URL yoki havola.
   *
   * 2 MB chegara: `data:` URL bazada matn sifatida saqlanadi,
   * kattasi so'rovlarni sekinlashtiradi.
   */
  photoUrl: z.string().max(2_000_000).optional(),
  salary: z.number().min(0).max(1_000_000_000).optional(),
  hiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Sana 'YYYY-MM-DD'"),
  /**
   * Telegram ID — faqat farosh uchun kerak.
   *
   * Bo'sh satr bog'lanishni uzadi. Raqam bo'lmasa rad etiladi:
   * username ("@ali") bilan xabar yuborib bo'lmaydi, Telegram
   * API faqat ID qabul qiladi.
   */
  telegramId: z.string().regex(/^(\d{5,15})?$/, "Telegram ID faqat raqam").optional(),
  notes: z.string().max(500).optional(),
});

/** Telegram ID band emasligini tekshiradi */
async function assertTelegramFree(tgId: string, exceptId?: string): Promise<void> {
  if (!tgId) return;

  const [employee, access] = await Promise.all([
    prisma.employee.findUnique({
      where: { telegramId: tgId },
      select: { id: true, fullName: true },
    }),
    prisma.botAccess.findFirst({
      where: { telegramId: tgId },
      select: { label: true },
    }),
  ]);

  if (employee && employee.id !== exceptId) {
    throw new ValidationError(`Bu Telegram ID ${employee.fullName} ga biriktirilgan`);
  }

  // Ogohlantirish emas, xato emas: bir odam ham egasi, ham
  // xodim bo'lishi mumkin (kichik mehmonxonada bo'ladi).
  // Faqat bilib turish uchun log.
  if (access) {
    console.log(`[employee] ${tgId} bot ruxsatida ham bor: ${access.label}`);
  }
}

/** POST /api/admin/employees */
adminRouter.post(
  "/employees",
  requireAuth,
  requirePermission("employee.write"),
  asyncHandler(async (req, res) => {
    const d = parseOrThrow(employeeSchema, req.body);
    const tgId = d.telegramId ?? "";

    await assertTelegramFree(tgId);

    const row = await prisma.employee.create({
      data: {
        fullName: d.fullName.trim(),
        position: d.position.trim(),
        phone: d.phone?.trim() || null,
        passport: d.passport?.trim() || null,
        photoUrl: d.photoUrl?.trim() || null,
        salary: d.salary ? new Prisma.Decimal(d.salary) : null,
        hiredAt: fromDateKey(d.hiredAt),
        telegramId: tgId || null,
        notes: d.notes?.trim() || null,
      },
    });

    res.status(201).json({ id: row.id });
  })
);

/** PATCH /api/admin/employees/:id */
adminRouter.patch(
  "/employees/:id",
  requireAuth,
  requirePermission("employee.write"),
  asyncHandler(async (req, res) => {
    const d = parseOrThrow(employeeSchema.partial(), req.body);

    if (d.telegramId !== undefined) {
      await assertTelegramFree(d.telegramId, req.params.id);
    }

    await prisma.employee.update({
      where: { id: req.params.id },
      data: {
        ...(d.fullName ? { fullName: d.fullName.trim() } : {}),
        ...(d.position ? { position: d.position.trim() } : {}),
        ...(d.phone !== undefined ? { phone: d.phone.trim() || null } : {}),
        ...(d.passport !== undefined ? { passport: d.passport.trim() || null } : {}),
        ...(d.photoUrl !== undefined ? { photoUrl: d.photoUrl.trim() || null } : {}),
        ...(d.salary !== undefined ? { salary: new Prisma.Decimal(d.salary) } : {}),
        ...(d.hiredAt ? { hiredAt: fromDateKey(d.hiredAt) } : {}),
        ...(d.telegramId !== undefined ? { telegramId: d.telegramId || null } : {}),
        ...(d.notes !== undefined ? { notes: d.notes.trim() || null } : {}),
      },
    });

    res.json({ ok: true });
  })
);

/**
 * DELETE /api/admin/employees/:id — ishdan bo'shatish
 *
 * Yozuv O'CHIRILMAYDI, `isActive = false` bo'ladi: tozalash
 * tarixida "kim bajargan" ko'rinib tursin.
 */
adminRouter.delete(
  "/employees/:id",
  requireAuth,
  requirePermission("employee.write"),
  asyncHandler(async (req, res) => {
    const emp = await prisma.employee.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true },
    });

    await prisma.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id: req.params.id },
        data: { isActive: false, firedAt: new Date(), telegramId: null },
      });
      if (emp?.userId) {
        await tx.user.update({
          where: { id: emp.userId },
          data: { isActive: false },
        });
      }
    });

    res.json({ ok: true });
  })
);

// ============================================================
//  SAYT BOSHQARUVI — xona turlari (2026-09-17)
//
//  Sayt mehmonga TUR sotadi, aniq xona emas. Shuning uchun
//  rasm va tavsif `RoomType` da saqlanadi.
//
//  `settings.write` huquqi: FOUNDER va ADMIN. Menejer saytni
//  o'zgartira olmaydi.
// ============================================================

/** GET /api/admin/website/rooms */
adminRouter.get(
  "/website/rooms",
  requireAuth,
  requirePermission("settings.write"),
  asyncHandler(async (_req, res) => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const [types, plans] = await Promise.all([
      prisma.roomType.findMany({
        orderBy: { sortOrder: "asc" },
        include: { _count: { select: { rooms: true } } },
      }),
      prisma.ratePlan.findMany({
        where: { date: { gte: today } },
        orderBy: { date: "asc" },
        select: { roomTypeId: true, price: true },
      }),
    ]);

    const priceOf = new Map<string, number>();
    for (const p of plans) {
      if (!priceOf.has(p.roomTypeId)) priceOf.set(p.roomTypeId, Number(p.price));
    }

    res.json({
      rooms: types.map((t) => ({
        id: t.id,
        label: t.label,
        description: t.description ?? "",
        imageUrl: t.imageUrl ?? "",
        gallery: Array.isArray(t.gallery) ? t.gallery : [],
        amenities: Array.isArray(t.amenities) ? t.amenities : [],
        showOnSite: t.showOnSite,
        maxAdults: t.maxAdults,
        sortOrder: t.sortOrder,
        roomCount: t._count.rooms,
        pricePerNight: priceOf.get(t.id) ?? 0,
      })),
    });
  })
);

/**
 * PATCH /api/admin/website/rooms/:id
 *
 * Narx bu yerda O'ZGARTIRILMAYDI — u `RatePlan` da, sana
 * bo'yicha. Narx uchun "Narxlar" bo'limi bor (TZ 7-band).
 */
const websiteRoomSchema = z.object({
  label: z.string().min(2).max(120).optional(),
  description: z.string().max(2000).optional(),
  /** `data:` URL yoki havola. 2 MB chegara — bazada matn */
  imageUrl: z.string().max(2_000_000).optional(),
  gallery: z.array(z.string().max(2_000_000)).max(8).optional(),
  amenities: z.array(z.string().max(60)).max(20).optional(),
  showOnSite: z.boolean().optional(),
  maxAdults: z.number().int().min(1).max(20).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

adminRouter.patch(
  "/website/rooms/:id",
  requireAuth,
  requirePermission("settings.write"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const d = parseOrThrow(websiteRoomSchema, req.body);

    const before = await prisma.roomType.findUnique({
      where: { id: req.params.id },
      select: { label: true, showOnSite: true },
    });
    if (!before) throw new NotFoundError("Xona turi");

    await prisma.roomType.update({
      where: { id: req.params.id },
      data: {
        ...(d.label ? { label: d.label.trim() } : {}),
        ...(d.description !== undefined
          ? { description: d.description.trim() || null }
          : {}),
        ...(d.imageUrl !== undefined ? { imageUrl: d.imageUrl.trim() || null } : {}),
        ...(d.gallery !== undefined ? { gallery: d.gallery } : {}),
        ...(d.amenities !== undefined ? { amenities: d.amenities } : {}),
        ...(d.showOnSite !== undefined ? { showOnSite: d.showOnSite } : {}),
        ...(d.maxAdults !== undefined ? { maxAdults: d.maxAdults } : {}),
        ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
      },
    });

    // Saytdagi o'zgarish — mehmon ko'radigan narsa
    await audit({
      userId: req.user?.id,
      action: "settings.changed",
      entityType: "RoomType",
      entityId: req.params.id,
      before: { label: before.label, showOnSite: before.showOnSite },
      after: {
        label: d.label,
        showOnSite: d.showOnSite,
        imageChanged: d.imageUrl !== undefined,
      },
      ipAddress: req.ip,
    });

    res.json({ ok: true });
  })
);

// ============================================================
//  OSHXONA — ovqat hisobi (BOTLAR-REJA.md)
//
//  `reservation.read` huquqi: oshpaz ham ko'rishi mumkin.
//  Mehmon ismi bor, lekin pul ma'lumoti yo'q.
// ============================================================

/** GET /api/admin/kitchen */
adminRouter.get(
  "/kitchen",
  requireAuth,
  requirePermission("reservation.read"),
  asyncHandler(async (_req, res) => {
    res.json(await kitchenOverview());
  })
);

/** POST /api/admin/kitchen/send-telegram */
adminRouter.post(
  "/kitchen/send-telegram",
  requireAuth,
  requirePermission("reservation.read"),
  asyncHandler(async (req, res) => {
    const offset = req.body?.offset === 1 ? 1 : 0;
    const result = await sendDailyKitchenReport(offset);
    res.json({ ok: true, sent: result.sent });
  })
);

// ============================================================
//  MAPPING — ovqat belgisi (BOTLAR-REJA.md)
// ============================================================

/**
 * PATCH /api/admin/mappings/:id/meal
 *
 * Beds24 tarifi ovqat bilan keladimi. Ular standart maydon
 * bermaydi, shuning uchun qo'lda belgilanadi.
 */
adminRouter.patch(
  "/mappings/:id/meal",
  requireAuth,
  requirePermission("mapping.write"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { includesMeal } = parseOrThrow(
      z.object({ includesMeal: z.boolean() }),
      req.body
    );

    const row = await prisma.channelMapping.update({
      where: { id: req.params.id },
      data: { includesMeal },
      select: { id: true, externalRoomTypeId: true, includesMeal: true },
    });

    await audit({
      userId: req.user?.id,
      action: "mapping.updated",
      entityType: "ChannelMapping",
      entityId: row.id,
      after: { includesMeal },
      ipAddress: req.ip,
    });

    res.json(row);
  })
);

// ============================================================
//  BOT ACCESS MANAGEMENT (Founder & Kitchen bots)
// ============================================================

/** GET /api/admin/bot-access */
adminRouter.get(
  "/bot-access",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (req, res) => {
    const botType = typeof req.query.botType === "string" ? req.query.botType : undefined;
    res.json(await listBotAccess(botType));
  })
);

/** POST /api/admin/bot-access */
adminRouter.post(
  "/bot-access",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const input = parseOrThrow(
      z.object({
        botType: z.enum(["FOUNDER", "KITCHEN"]).optional(),
        telegramId: z.union([z.string(), z.number()]).nullish(),
        username: z.string().nullish(),
        label: z.string().min(1),
        level: z.enum(["FULL", "LIMITED"]).optional(),
      }),
      req.body
    );

    const record = await createBotAccess({
      ...input,
      createdById: req.user?.id,
    });

    res.status(201).json(record);
  })
);

/** PATCH /api/admin/bot-access/:id */
adminRouter.patch(
  "/bot-access/:id",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const input = parseOrThrow(
      z.object({
        botType: z.enum(["FOUNDER", "KITCHEN"]).optional(),
        telegramId: z.union([z.string(), z.number()]).nullish(),
        username: z.string().nullish(),
        label: z.string().min(1).optional(),
        level: z.enum(["FULL", "LIMITED"]).optional(),
        isActive: z.boolean().optional(),
      }),
      req.body
    );

    const record = await updateBotAccess(req.params.id, input);
    res.json(record);
  })
);

/** DELETE /api/admin/bot-access/:id */
adminRouter.delete(
  "/bot-access/:id",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (req: AuthedRequest, res) => {
    await deleteBotAccess(req.params.id);
    res.json({ ok: true });
  })
);


