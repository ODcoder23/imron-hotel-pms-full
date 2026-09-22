/**
 * Event yuborish yordamchilari — TZ 15-band
 *
 * Manba: 09-REALTIME-WEBSOCKET.md §1, §3
 *
 * TARTIB MUHIM (09-fayl §1): event faqat DB transaction
 * muvaffaqiyatli tugagandan KEYIN yuboriladi. Aks holda frontend
 * DB'da yo'q ma'lumotni ko'rsatib qo'yishi mumkin.
 *
 * Payload shakli Shaxmatkaning mavjud massiv elementlari bilan
 * aynan bir xil — `serializeReservation` natijasi to'g'ridan-to'g'ri
 * uzatiladi.
 */

import { prisma } from "../lib/prisma.js";
import { serializeReservation, serializeRoom, toDateKey } from "../lib/serialize.js";
import { sendBookingAlert } from "../bot/index.js";
import { reservationInclude } from "../services/reservations.js";
import { broadcast } from "./server.js";
import { now } from "./events.js";

/**
 * Bron event'i. Xona holati ham qo'shiladi — frontend ikkalasini
 * bir vaqtda yangilashi uchun (09-fayl §3).
 */
export async function notifyReservation(
  type: "reservation.created" | "reservation.updated" | "reservation.cancelled",
  reservationId: string
): Promise<void> {
  try {
    const res = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: reservationInclude,
    });
    if (!res) return;

    const room = await prisma.room.findUnique({ where: { id: res.roomId } });

    const payload = serializeReservation(res);

    broadcast({
      type,
      timestamp: now(),
      reservation: payload as never,
      room: room ? (serializeRoom(room) as never) : undefined,
    });

    // Founder'ga Telegram xabari — faqat YANGI bron uchun.
    // O'zgarish va bekor qilish uchun yuborilmaydi: aks holda
    // har check-in'da xabar kelib, foydasiz shovqin bo'lardi.
    //
    // `void` — Telegram sekin javob bersa ham bron yaratilishi
    // kutib qolmaydi (TZ 17, 19-band).
    if (type === "reservation.created") {
      const nights = Math.max(
        1,
        Math.round((res.checkOut.getTime() - res.checkIn.getTime()) / 86_400_000)
      );
      void sendBookingAlert({
        guestName: String(payload.guestName ?? ""),
        roomId: res.roomId,
        checkIn: String(payload.checkIn ?? ""),
        checkOut: String(payload.checkOut ?? ""),
        nights,
        total: Number(payload.totalPrice ?? 0),
        source: String(payload.source ?? ""),
        status: String(payload.status ?? ""),
        phone: String(payload.phone ?? "") || undefined,
      }).catch(() => { /* bot xatosi bronni to'xtatmaydi */ });
    }
  } catch (e) {
    // Real-time — yordamchi funksiya. Xato bo'lsa asosiy amal
    // baribir bajarilgan (TZ 17-band printsipi).
    console.warn(`[ws] ${type} yuborilmadi: ${String(e).slice(0, 100)}`);
  }
}

/** To'lov o'zgardi — PayPill yangilanishi uchun (TZ 14-band) */
export async function notifyPayment(reservationId: string): Promise<void> {
  try {
    const res = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: reservationInclude,
    });
    if (!res) return;

    broadcast({
      type: "payment.updated",
      timestamp: now(),
      reservation: serializeReservation(res) as never,
    });
  } catch (e) {
    console.warn(`[ws] payment.updated yuborilmadi: ${String(e).slice(0, 100)}`);
  }
}

/** Xona holati qo'lda o'zgartirildi */
export async function notifyRoomStatus(roomId: string): Promise<void> {
  try {
    const room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room) return;

    broadcast({
      type: "room.status.changed",
      timestamp: now(),
      room: serializeRoom(room) as never,
    });
  } catch (e) {
    console.warn(`[ws] room.status.changed yuborilmadi: ${String(e).slice(0, 100)}`);
  }
}

/**
 * Availability o'zgardi.
 *
 * Shaxmatka buni ishlatmaydi (u bronlardan o'zi hisoblaydi), lekin
 * Website va Admin panel uchun kerak — TZ 15-band talab qiladi.
 */
export function notifyAvailability(roomTypeIds: string[], from: Date, to: Date): void {
  broadcast({
    type: "availability.changed",
    timestamp: now(),
    roomTypeIds,
    from: toDateKey(from) ?? "",
    to: toDateKey(to) ?? "",
  });
}

// --- Admin ogohlantirishlari (09-fayl §2) -------------------

/** Beds24'ga yuborilmadi — admin ko'rishi kerak (TZ 11, 17-band) */
export function notifySyncFailed(action: string, error: string, reservationId?: string): void {
  broadcast({
    type: "sync.failed",
    timestamp: now(),
    action,
    reservationId,
    error: error.slice(0, 300),
  });
}

/** Mapping yo'q / bo'sh xona yo'q — qo'lda hal qilish kerak (TZ 5-band) */
export function notifyWebhookNeedsAttention(webhookEventId: string, reason: string): void {
  broadcast({
    type: "webhook.needs_attention",
    timestamp: now(),
    webhookEventId,
    reason: reason.slice(0, 300),
  });
}

/** Narx sync holati o'zgardi — Narxlar paneli uchun (07-fayl §8, D16) */
export function notifyRateSync(
  roomTypeId: string,
  date: string,
  syncStatus: "pending" | "synced" | "error"
): void {
  broadcast({
    type: "rate.sync.updated",
    timestamp: now(),
    roomTypeId,
    date,
    syncStatus,
  });
}
