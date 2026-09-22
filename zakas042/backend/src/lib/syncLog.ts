/**
 * SyncLog yozish — TZ 16-band
 *
 * Manba: 10-SECURITY-VA-SYNCLOG.md §3
 *
 * TZ 16-band aynan sakkiz maydonni talab qiladi:
 *   timestamp, direction, action, reservation_id, request,
 *   response, status, error_message
 *
 * `createdAt` = TZ'dagi `timestamp`.
 *
 * NEGA ALOHIDA FAYL: log yozish ikki yo'nalishda ham kerak —
 * webhook (CHANNEL_TO_PMS) va availability/rate sync (PMS_TO_CHANNEL).
 * Avval `webhookProcessor` ichida private funksiya edi; FAZA 9 dan
 * boshlab ikkinchi chaqiruvchi paydo bo'ldi, shuning uchun ajratildi.
 *
 * MUHIM: log yozish asosiy amalni yiqitmasligi kerak (TZ 17-band).
 * Xato bo'lsa konsolga tushadi, exception tashlanmaydi.
 */

import { prisma } from "./prisma.js";
import { sanitizeForLog } from "./sanitize.js";

export type SyncLogStatus = "SUCCESS" | "FAILED" | "SKIPPED";
export type SyncLogDirection = "PMS_TO_CHANNEL" | "CHANNEL_TO_PMS";

export type SyncLogInput = {
  action: string;
  direction: SyncLogDirection;
  status: SyncLogStatus;
  reservationId?: string | null;
  roomId?: string | null;
  request?: unknown;
  response?: unknown;
  errorMessage?: string;
  attempt?: number;
  durationMs?: number;
};

/**
 * Beds24 kanalining id'si.
 *
 * KESHLANMAYDI. Avval keshlangan edi, lekin DB qayta seed qilinganda
 * (testlar, migratsiya, reset) `Channel` qatori o'chib qayta
 * yaratiladi va id o'zgaradi. Eski id bilan yozishga urinish foreign
 * key xatosiga tushadi, u esa jim yutiladi — natijada SyncLog
 * yozilmay qoladi va TZ 16-band buziladi (sabab ko'rinmaydi).
 *
 * Bitta indeksli so'rov har log uchun arzon; sinxronizatsiya
 * chaqiruvlari baribir tashqi API kutadi.
 */
async function getChannelId(): Promise<string | null> {
  const channel = await prisma.channel.findUnique({ where: { code: "beds24" } });
  return channel?.id ?? null;
}

/**
 * SyncLog yozuvi yaratadi.
 *
 * `request` va `response` `sanitizeForLog` dan o'tadi — token,
 * parol, apiKey kabi maydonlar logga tushmaydi (TZ 18-band).
 */
export async function logSync(input: SyncLogInput): Promise<void> {
  try {
    const channelId = await getChannelId();
    if (!channelId) return;

    await prisma.syncLog.create({
      data: {
        channelId,
        action: input.action,
        direction: input.direction,
        status: input.status,
        reservationId: input.reservationId ?? null,
        roomId: input.roomId ?? null,
        request: input.request ? (sanitizeForLog(input.request) as never) : undefined,
        response: input.response ? (sanitizeForLog(input.response) as never) : undefined,
        errorMessage: input.errorMessage ? input.errorMessage.slice(0, 500) : null,
        attempt: input.attempt ?? 1,
        durationMs: input.durationMs ?? null,
      },
    });
  } catch (e) {
    // Log yozilmasa asosiy amal baribir bajarilgan (TZ 17-band)
    console.warn(`[synclog] yozilmadi: ${String(e).slice(0, 120)}`);
  }
}

/** PMS -> Beds24 yo'nalishi uchun qisqartma */
export const logPush = (
  action: string,
  status: SyncLogStatus,
  extra: Omit<SyncLogInput, "action" | "direction" | "status"> = {}
) => logSync({ action, direction: "PMS_TO_CHANNEL", status, ...extra });
