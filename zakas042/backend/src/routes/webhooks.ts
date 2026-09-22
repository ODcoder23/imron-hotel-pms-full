/**
 * Webhook endpoint — TZ 10-band
 *
 * POST /api/webhooks/beds24            (signature rejimi)
 * POST /api/webhooks/beds24/:token     (ip_token rejimi)
 *
 * Manba: 04-WEBHOOK-HANDLER.md
 *
 * MUHIM: 200 DARHOL qaytariladi. Beds24 javobni kutadi va kechiksa
 * qayta yuboradi — og'ir ishni HTTP so'rov ichida bajarish takroriy
 * webhook va timeout sababi (04-fayl §2).
 *
 * Shuning uchun bu yerda faqat: validate -> saqlash -> dedup ->
 * navbatga qo'yish. Reservation yaratish worker'da (FAZA 7).
 */

import { Router, type Request } from "express";
import { asyncHandler } from "../lib/errors.js";
import * as webhook from "../services/webhook.js";

export const webhooksRouter = Router();

/** Client IP — Nginx orqasida X-Forwarded-For bo'ladi */
function clientIp(req: Request): string {
  const fwd = req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.ip ?? req.socket.remoteAddress ?? "";
}

/** Beds24 signature header'i — aniq nomi FAZA 15 da tasdiqlanadi */
function signatureHeader(req: Request): string | undefined {
  return (
    req.header("x-beds24-signature") ??
    req.header("x-signature") ??
    req.header("x-hub-signature-256") ??
    undefined
  );
}

const handler = asyncHandler(async (req, res) => {
  const validation = webhook.validateWebhook({
    urlToken: req.params.token,
    signature: signatureHeader(req),
    rawBody: (req as Request & { rawBody?: string }).rawBody,
    clientIp: clientIp(req),
  });

  // Sxema tekshiruvi — validatsiya o'tgan bo'lsa ham payload buzilgan bo'lishi mumkin
  const shape = validation.ok ? webhook.validatePayloadShape(req.body) : validation;

  const result = await webhook.intakeWebhook(req.body, shape);

  // Validatsiyadan o'tmagan so'rovga xato kodi qaytariladi,
  // lekin payload DB'da saqlangan (hujumni ko'rish uchun)
  if (result.status === "invalid") {
    const status = shape.ok ? 400 : shape.status;
    console.warn(`[webhook] rad etildi (${status}): ${result.detail}`);
    res.status(status).json({ error: result.detail, eventId: result.webhookEventId });
    return;
  }

  if (result.status === "duplicate") {
    console.log(`[webhook] duplicate: ${result.eventType} #${result.externalId}`);
    // 200 — Beds24 qayta yubormasligi uchun
    res.status(200).json({ ok: true, duplicate: true, eventId: result.webhookEventId });
    return;
  }

  console.log(`[webhook] qabul qilindi: ${result.eventType} #${result.externalId}`);
  res.status(200).json({ ok: true, eventId: result.webhookEventId });
});

// ip_token rejimi — token URL'da
webhooksRouter.post("/beds24/:token", handler);

// signature rejimi — token yo'q
webhooksRouter.post("/beds24", handler);
