/**
 * PMS'ga webhook yuborish
 *
 * Manba: 04-WEBHOOK-HANDLER.md
 *
 * Beds24 bron yaratilganda/o'zgarganda PMS endpoint'iga POST qiladi.
 * Bu fayl aynan shuni taqlid qiladi — shuning uchun webhook handler,
 * duplicate dedup va echo loop himoyasi real sinovdan o'tadi.
 */

import { state, type Booking } from "./state.js";

const PMS_WEBHOOK_URL =
  process.env.PMS_WEBHOOK_URL ?? "http://localhost:3000/api/webhooks/beds24";
const WEBHOOK_TOKEN = process.env.PMS_WEBHOOK_TOKEN ?? "dev-webhook-token";

export type WebhookEvent =
  | "booking.new"
  | "booking.modified"
  | "booking.cancelled"
  | "payment.updated";

/**
 * Webhook yuboradi. Xato bo'lsa jim qoladi — Beds24 ham shunday
 * qiladi (PMS javob bermasa qayta urinadi, lekin bizga xato bermaydi).
 */
export async function sendWebhook(
  event: WebhookEvent,
  booking: Booking,
  opts: { delayMs?: number } = {}
): Promise<void> {
  const fire = async () => {
    const payload = {
      event,
      timestamp: new Date().toISOString(),
      propertyId: 12345,
      booking,
    };

    try {
      const url = `${PMS_WEBHOOK_URL}/${WEBHOOK_TOKEN}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      state.webhooksSent.push({
        at: new Date().toISOString(),
        event,
        bookingId: booking.id,
      });
      console.log(`[webhook] ${event} #${booking.id} -> ${res.status}`);
    } catch (e) {
      console.log(`[webhook] ${event} #${booking.id} -> XATO: ${String(e).slice(0, 60)}`);
    }
  };

  if (opts.delayMs) {
    setTimeout(() => void fire(), opts.delayMs);
  } else {
    await fire();
  }
}

/**
 * Bir xil webhook'ni ikki marta yuboradi — duplicate dedup sinovi
 * (TZ 9-band, 04-fayl §3).
 */
export async function sendDuplicateWebhook(
  event: WebhookEvent,
  booking: Booking
): Promise<void> {
  await sendWebhook(event, booking);
  await sendWebhook(event, booking);
}

/**
 * Narx o'zgarishi webhook'i — TZ 7-band teskari yo'nalish.
 *
 * Beds24 narxni o'zi yoki boshqa kanal orqali o'zgartirganda
 * shunday event yuboradi. PMS `SOURCE_OF_TRUTH_RATES` ga qarab
 * qabul qiladi yoki rad etadi (07-fayl §7).
 */
export async function sendRateWebhook(
  roomId: number,
  rates: Array<{ date: string; price: number; minStay?: number }>
): Promise<void> {
  const payload = {
    event: "rate.changed",
    timestamp: new Date().toISOString(),
    propertyId: 12345,
    roomId,
    rates,
  };

  try {
    const url = `${PMS_WEBHOOK_URL}/${WEBHOOK_TOKEN}`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.webhooksSent.push({
      at: new Date().toISOString(),
      event: "rate.changed" as never,
      bookingId: 0,
    });
  } catch (e) {
    console.warn(`[webhook] rate.changed yuborilmadi: ${String(e).slice(0, 80)}`);
  }
}
