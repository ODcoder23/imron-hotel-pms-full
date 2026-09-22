/**
 * Narx endpoint'lari — Narxlar paneli uchun (07-fayl §8)
 * Q8: avtomatik o'suvchi mexanizm yo'q, admin qo'lda belgilaydi.
 */

import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, ValidationError } from "../lib/errors.js";
import { toNumber, toDateKey, fromDateKey } from "../lib/serialize.js";
import { onRatesChanged, pushRates } from "../services/rates.js";
import { requireAuth, requirePermission, type AuthedRequest } from "../lib/authMiddleware.js";
import { audit } from "../services/auditLog.js";

export const ratesRouter = Router();

// --- GET /api/rate-plans?from=&to= --------------------------
ratesRouter.get("/", requireAuth, requirePermission("reservation.read"), asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) throw new ValidationError("from va to parametrlari kerak");

  const plans = await prisma.ratePlan.findMany({
    where: { date: { gte: fromDateKey(from), lte: fromDateKey(to) } },
    orderBy: [{ date: "asc" }, { roomTypeId: "asc" }],
  });

  res.json(plans.map((p) => ({
    roomTypeId: p.roomTypeId,
    date: toDateKey(p.date),
    price: toNumber(p.price),
    minStay: p.minStay,
    source: p.source,
    // 07-fayl §8: ● yuborildi / ○ kutmoqda / ⚠ xato
    syncStatus: p.syncError ? "error" : p.syncedAt ? "synced" : "pending",
    syncError: p.syncError,
  })));
}));

// --- PUT /api/rate-plans — narx belgilash -------------------
const putSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  prices: z.record(z.string(), z.number().min(0)),
});

ratesRouter.put("/", requireAuth, requirePermission("rate.write"), asyncHandler(async (req: AuthedRequest, res) => {
  const { from, to, prices } = putSchema.parse(req.body);
  const start = fromDateKey(from);
  const end = fromDateKey(to);
  if (end < start) throw new ValidationError("'to' sanasi 'from' dan keyin bo'lishi kerak");

  let count = 0;
  for (const [roomTypeId, price] of Object.entries(prices)) {
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = new Date(d);
      await prisma.ratePlan.upsert({
        where: { roomTypeId_date: { roomTypeId, date } },
        create: { roomTypeId, date, price: new Prisma.Decimal(price), source: "pms" },
        update: { price: new Prisma.Decimal(price), source: "pms", syncedAt: null },
      });
      count++;
    }
  }

  // Beds24'ga fonda yuboriladi — admin kutmaydi (07-fayl §8).
  // Panel holatni `rate.sync.updated` event'i orqali ko'radi.
  await onRatesChanged(Object.keys(prices), start, end);

  // Narx o'zgarishi OTA'gacha boradi — kim qilganini bilish kerak
  await audit({
    userId: req.user?.id,
    action: "rate.changed",
    entityType: "RatePlan",
    entityId: `${from}..${to}`,
    after: { prices, from, to },
    ipAddress: req.ip,
  });

  res.json({ updated: count, syncStatus: "pending" });
}));

// --- POST /api/rate-plans/resync — xatoni qayta yuborish ----
// 07-fayl §8: panel'dagi [↻] tugmasi
const resyncSchema = z.object({
  roomTypeIds: z.array(z.string().min(1)).min(1),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

ratesRouter.post("/resync", requireAuth, requirePermission("rate.write"), asyncHandler(async (req, res) => {
  const { roomTypeIds, from, to } = resyncSchema.parse(req.body);
  const start = fromDateKey(from);
  const end = fromDateKey(to);

  // Xato belgisini tozalaymiz — aks holda qayta urinish ham
  // "xato" bo'lib ko'rinaveradi
  await prisma.ratePlan.updateMany({
    where: { roomTypeId: { in: roomTypeIds }, date: { gte: start, lte: end } },
    data: { syncedAt: null, syncError: null },
  });

  const outcomes = [];
  for (const id of roomTypeIds) {
    outcomes.push(await pushRates(id, start, end));
  }

  res.json({
    outcomes,
    sent: outcomes.filter((o) => o.status === "sent").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
  });
}));
