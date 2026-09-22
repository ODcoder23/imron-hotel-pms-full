/**
 * Beds24Adapter — ChannelAdapter implementatsiyasi
 *
 * Manba: 01-ARXITEKTURA-VA-QOIDALAR.md §4, 03-fayl §2
 *
 * Bu fayl Beds24'ning o'z formatini bizning umumiy shaklga tarjima
 * qiladi. Biznes-mantiq qatlami faqat `ChannelAdapter` ni biladi,
 * Beds24 tafsilotlarini ko'rmaydi.
 */

import type {
  ChannelAdapter,
  ExternalProperty,
  ExternalReservation,
  ExternalRoomType,
  AvailabilityPush,
  RatesPush,
  SyncResult,
  WebhookResult,
} from "../channel/types.js";
import { beds24Request, getCreditState, RateLimitError, Beds24ApiError } from "./client.js";
import { Beds24AuthError } from "./auth.js";

// --- Beds24 javob shakllari ---------------------------------

type Beds24Booking = {
  id: number;
  roomId: number;
  unitId?: number;
  status: string;
  subStatus?: string;
  arrival: string;
  departure: string;
  numAdult: number;
  numChild: number;
  price: number;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  country?: string;
  address?: string;
  notes?: string;
  referer?: string;
  modifiedTime: string;
  invoiceItems?: Array<{ type: string; amount: number; description?: string }>;
};

type Beds24Property = {
  id: number;
  name: string;
  currency?: string;
  roomTypes: Array<{
    id: number;
    name: string;
    qty: number;
    maxPeople?: number;
    units?: Array<{ id: number; name: string }>;
  }>;
};

/** Bizning yuborgan bronimiz belgisi — echo loop himoyasi (04-fayl §6) */
const OWN_REFERER = "PMS";

function toExternalReservation(b: Beds24Booking): ExternalReservation {
  const fullName = [b.firstName, b.lastName].filter(Boolean).join(" ").trim();

  return {
    externalId: String(b.id),
    externalRoomTypeId: String(b.roomId),
    externalUnitId: b.unitId ? String(b.unitId) : undefined,
    status: b.status,
    subStatus: b.subStatus,
    checkIn: b.arrival,
    checkOut: b.departure,
    adults: b.numAdult ?? 1,
    children: b.numChild ?? 0,
    price: b.price ?? 0,
    currency: "USD",          // Beds24 property darajasida beradi
    guest: {
      fullName: fullName || "Noma'lum mehmon",
      phone: b.phone,
      email: b.email,
      country: b.country,
      address: b.address,
    },
    notes: b.notes,
    source: b.referer,
    payments: (b.invoiceItems ?? [])
      .filter((i) => i.type === "payment")
      .map((i) => ({ amount: i.amount, description: i.description })),
    modifiedAt: b.modifiedTime,
    isOwnEcho: b.referer === OWN_REFERER,
  };
}

function toExternalRoomType(rt: Beds24Property["roomTypes"][number]): ExternalRoomType {
  return {
    id: String(rt.id),
    name: rt.name,
    qty: rt.qty,
    maxPeople: rt.maxPeople,
    units: (rt.units ?? []).map((u) => ({ id: String(u.id), name: u.name })),
  };
}

/** Xatoni SyncResult ga aylantiradi — worker shu shaklni kutadi */
function toSyncFailure(e: unknown): SyncResult {
  if (e instanceof RateLimitError) {
    return { ok: false, error: e.message, retryable: true, retryAfterSeconds: e.retryAfterSeconds };
  }
  if (e instanceof Beds24ApiError) {
    return { ok: false, error: e.message, retryable: e.retryable };
  }
  if (e instanceof Beds24AuthError) {
    return { ok: false, error: e.message, retryable: e.retryable };
  }
  return { ok: false, error: String(e).slice(0, 200), retryable: false };
}

// ============================================================

export class Beds24Adapter implements ChannelAdapter {
  readonly code = "beds24";

  async ping() {
    try {
      await beds24Request<{ data: Beds24Property[] }>("/properties", { estimatedCost: 5 });
      const c = getCreditState();
      return {
        ok: true,
        detail: `Ulanish ishlaydi. Kredit: ${c.remaining}/${c.remaining + 0}`,
        creditsRemaining: c.remaining,
      };
    } catch (e) {
      return { ok: false, detail: String(e instanceof Error ? e.message : e).slice(0, 200) };
    }
  }

  async getRoomTypes(): Promise<ExternalProperty[]> {
    const res = await beds24Request<{ data: Beds24Property[] }>("/properties", {
      estimatedCost: 5,
    });

    return (res.data ?? []).map((p) => ({
      id: String(p.id),
      name: p.name,
      currency: p.currency ?? "USD",
      roomTypes: (p.roomTypes ?? []).map(toExternalRoomType),
    }));
  }

  async pullReservations(since: Date): Promise<ExternalReservation[]> {
    const res = await beds24Request<{ data: Beds24Booking[] }>("/bookings", {
      query: { modifiedFrom: since.toISOString() },
      estimatedCost: 3,
    });
    return (res.data ?? []).map(toExternalReservation);
  }

  async pushReservation(payload: Parameters<ChannelAdapter["pushReservation"]>[0]): Promise<SyncResult> {
    try {
      const item: Record<string, unknown> = {
        status: payload.status,
        arrival: payload.checkIn,
        departure: payload.checkOut,
        numAdult: payload.adults,
        numChild: payload.children,
        price: payload.totalPrice,
        firstName: payload.guestFirstName,
        lastName: payload.guestLastName,
        referer: OWN_REFERER,          // echo loop belgisi
      };

      if (payload.subStatus) item.subStatus = payload.subStatus;
      if (payload.phone) item.phone = payload.phone;
      if (payload.email) item.email = payload.email;
      if (payload.notes) item.notes = payload.notes;

      // `roomId` IKKALA holatda ham yuboriladi.
      //
      // Yaratishda majburiy, yangilashda esa xona almashtirilganda
      // kerak: mijoz qarori Q6 — "hona almashsa Beds24 da ham
      // korinishi kerak" (12-fayl §4). Faqat `id` yuborilsa Beds24
      // eski room type'da qoldiradi va OTA noto'g'ri xonani sotadi.
      item.roomId = Number(payload.externalRoomTypeId);
      if (payload.externalUnitId) item.unitId = Number(payload.externalUnitId);

      if (payload.externalId) {
        item.id = Number(payload.externalId);      // update
      }

      const res = await beds24Request<Array<Record<string, unknown>>>("/bookings", {
        method: "POST",
        body: [item],
        estimatedCost: 4,
      });

      const first = res[0] ?? {};

      if (first.errors) {
        const errs = first.errors as Array<{ field?: string; message?: string }>;
        return {
          ok: false,
          error: errs.map((e) => `${e.field ?? "?"}: ${e.message ?? "?"}`).join("; "),
          retryable: false,        // validatsiya xatosi — qayta yuborish foydasiz
        };
      }

      const created = (first.new ?? first.modified) as Beds24Booking | undefined;
      return { ok: true, externalId: created ? String(created.id) : payload.externalId };
    } catch (e) {
      return toSyncFailure(e);
    }
  }

  async pushAvailability(payload: AvailabilityPush): Promise<SyncResult> {
    try {
      // Ketma-ket bir xil qiymatli kunlarni oraliqqa yig'ish (07-fayl §4)
      const ranges = groupConsecutive(payload.days, (d) => d.available);

      await beds24Request("/inventory/rooms/calendar", {
        method: "POST",
        body: [{
          roomId: Number(payload.externalRoomTypeId),
          calendar: ranges.map((r) => ({
            from: r.from,
            to: r.to,
            numAvail: r.value,
          })),
        }],
        estimatedCost: 3,
      });

      return { ok: true, detail: `${payload.days.length} kun, ${ranges.length} oraliq` };
    } catch (e) {
      return toSyncFailure(e);
    }
  }

  async pushRates(payload: RatesPush): Promise<SyncResult> {
    try {
      const ranges = groupConsecutive(payload.days, (d) => d.price);

      await beds24Request("/inventory/rooms/calendar", {
        method: "POST",
        body: [{
          roomId: Number(payload.externalRoomTypeId),
          calendar: ranges.map((r) => ({
            from: r.from,
            to: r.to,
            price1: r.value,
          })),
        }],
        estimatedCost: 3,
      });

      return { ok: true, detail: `${payload.days.length} kun, ${ranges.length} oraliq` };
    } catch (e) {
      return toSyncFailure(e);
    }
  }

  async getAvailability(externalRoomTypeId: string, from: string, to: string) {
    const res = await beds24Request<{
      data: Array<{ roomId: number; calendar: Array<{ from: string; numAvail?: number; price1?: number }> }>;
    }>("/inventory/rooms/calendar", {
      query: { roomId: externalRoomTypeId, startDate: from, endDate: to },
      estimatedCost: 2,
    });

    const entry = res.data?.[0];
    return (entry?.calendar ?? []).map((c) => ({
      date: c.from,
      available: c.numAvail ?? 0,
      price: c.price1,
    }));
  }

  parseWebhook(payload: unknown): WebhookResult {
    const p = payload as { event?: string; booking?: Beds24Booking };

    if (!p?.booking) {
      return { event: p?.event ?? "unknown", externalId: null, isOwnEcho: false };
    }

    const reservation = toExternalReservation(p.booking);
    return {
      event: p.event ?? "booking.modified",
      externalId: reservation.externalId,
      reservation,
      isOwnEcho: reservation.isOwnEcho === true,
    };
  }
}

/**
 * Ketma-ket bir xil qiymatli kunlarni oraliqqa yig'adi.
 * 30 kunlik bir xil narx -> 1 ta oraliq (30 ta emas) = kredit tejash.
 */
function groupConsecutive<T extends { date: string }>(
  days: T[],
  valueOf: (d: T) => number
): Array<{ from: string; to: string; value: number }> {
  if (days.length === 0) return [];

  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const out: Array<{ from: string; to: string; value: number }> = [];

  let from = sorted[0].date;
  let to = sorted[0].date;
  let value = valueOf(sorted[0]);

  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i];
    const v = valueOf(d);
    const prev = new Date(to + "T00:00:00Z");
    prev.setUTCDate(prev.getUTCDate() + 1);
    const isNextDay = prev.toISOString().slice(0, 10) === d.date;

    if (v === value && isNextDay) {
      to = d.date;
    } else {
      out.push({ from, to, value });
      from = d.date;
      to = d.date;
      value = v;
    }
  }
  out.push({ from, to, value });

  return out;
}

export const beds24Adapter = new Beds24Adapter();
