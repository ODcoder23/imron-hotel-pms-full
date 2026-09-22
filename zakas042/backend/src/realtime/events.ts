/**
 * Real-time event turlari — TZ 15-band
 *
 * Manba: 09-REALTIME-WEBSOCKET.md §2, §3
 *
 * TZ aynan oltitasini talab qiladi:
 *   reservation.created, reservation.updated, reservation.cancelled,
 *   room.status.changed, availability.changed, payment.updated
 *
 * Payload shakli Shaxmatkaning mavjud massiv elementlari bilan
 * AYNAN bir xil (09-fayl §3) — shuning uchun frontendda oddiy
 * "qo'sh yoki yangila" mantig'i yetarli, yangi komponent kerak emas.
 */

export const PMS_EVENTS = [
  "reservation.created",
  "reservation.updated",
  "reservation.cancelled",
  "room.status.changed",
  "availability.changed",
  "payment.updated",
] as const;

/** Admin panel ogohlantirishlari — Shaxmatka e'tiborsiz qoldiradi */
export const ADMIN_EVENTS = [
  "sync.failed",
  "webhook.needs_attention",
  "rate.sync.updated",
] as const;

export type PmsEvent = (typeof PMS_EVENTS)[number];
export type AdminEvent = (typeof ADMIN_EVENTS)[number];
export type EventType = PmsEvent | AdminEvent;

/** Serializatsiya qilingan bron (serializeReservation natijasi) */
export type SerializedReservation = Record<string, unknown> & { id: string; roomId: string };
export type SerializedRoom = Record<string, unknown> & { id: string; status: string };

export type RealtimeMessage =
  | {
      type: "reservation.created" | "reservation.updated" | "reservation.cancelled";
      timestamp: string;
      reservation: SerializedReservation;
      room?: SerializedRoom;
    }
  | {
      type: "payment.updated";
      timestamp: string;
      reservation: SerializedReservation;
    }
  | {
      type: "room.status.changed";
      timestamp: string;
      room: SerializedRoom;
    }
  | {
      type: "availability.changed";
      timestamp: string;
      roomTypeIds: string[];
      from: string;
      to: string;
    }
  | {
      type: "sync.failed";
      timestamp: string;
      action: string;
      reservationId?: string;
      error: string;
    }
  | {
      type: "webhook.needs_attention";
      timestamp: string;
      webhookEventId: string;
      reason: string;
    }
  | {
      type: "rate.sync.updated";
      timestamp: string;
      roomTypeId: string;
      date: string;
      syncStatus: "pending" | "synced" | "error";
    }
  | {
      type: "connected";
      timestamp: string;
      /** Frontend uzilishdan keyin farqni bilishi uchun */
      serverStartedAt: string;
    };

export const now = (): string => new Date().toISOString();
