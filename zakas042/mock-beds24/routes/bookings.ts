/**
 * /bookings — 03-fayl §2, 12-fayl §3
 *
 * GET  — bronlarni olish (polling fallback uchun modifiedFrom filtri)
 * POST — yangi bron yoki mavjudini yangilash
 *
 * POST javobi Beds24 formatida: `[{ new: {...} }]` yoki
 * `[{ modified: {...} }]` — 12-fayl §3 dagi kod shu shaklni kutadi.
 */

import { Router } from "express";
import { state, type Booking } from "../state.js";
import { sendWebhook } from "../webhook-sender.js";

export const bookingsRouter = Router();

// --- GET /bookings ------------------------------------------
bookingsRouter.get("/", (req, res) => {
  const { modifiedFrom, arrivalFrom, arrivalTo, status, roomId, id } = req.query as Record<
    string,
    string | undefined
  >;

  let list = [...state.bookings.values()];

  if (id) {
    const wanted = new Set(id.split(",").map(Number));
    list = list.filter((b) => wanted.has(b.id));
  }
  if (modifiedFrom) {
    list = list.filter((b) => b.modifiedTime >= modifiedFrom);
  }
  if (arrivalFrom) list = list.filter((b) => b.arrival >= arrivalFrom);
  if (arrivalTo) list = list.filter((b) => b.arrival <= arrivalTo);
  if (status) {
    const wanted = new Set(status.split(","));
    list = list.filter((b) => wanted.has(b.status));
  }
  if (roomId) {
    const wanted = new Set(roomId.split(",").map(Number));
    list = list.filter((b) => wanted.has(b.roomId));
  }

  res.json({ success: true, count: list.length, data: list });
});

// --- POST /bookings -----------------------------------------
/**
 * Beds24 massiv qabul qiladi. Har element:
 *   `id` bor      -> mavjud bronni yangilash
 *   `id` yo'q     -> yangi bron (roomId majburiy)
 */
bookingsRouter.post("/", async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const results: Array<Record<string, unknown>> = [];

  for (const item of items) {
    // --- Mavjudini yangilash ---
    if (item.id) {
      const updated = state.updateBooking(Number(item.id), {
        status: item.status,
        subStatus: item.subStatus,
        arrival: item.arrival,
        departure: item.departure,
        numAdult: item.numAdult,
        numChild: item.numChild,
        price: item.price,
        roomId: item.roomId,
        unitId: item.unitId,
        notes: item.notes,
        referer: item.referer,
      });

      if (!updated) {
        results.push({ errors: [{ field: "id", message: `Booking ${item.id} not found` }] });
        continue;
      }

      results.push({ modified: updated });

      // Beds24 o'zgarishdan keyin webhook qaytaradi — echo loop sinovi.
      // PMS payloadHash orqali o'zining aks-sadosini tanishi kerak
      // (04-fayl §6).
      const event = updated.status === "cancelled" ? "booking.cancelled" : "booking.modified";
      void sendWebhook(event, updated, { delayMs: 150 });
      continue;
    }

    // --- Yangi bron ---
    if (!item.roomId) {
      results.push({ errors: [{ field: "roomId", message: "roomId is required" }] });
      continue;
    }

    const created = state.addBooking({
      roomId: Number(item.roomId),
      unitId: item.unitId ? Number(item.unitId) : undefined,
      status: item.status ?? "confirmed",
      subStatus: item.subStatus,
      arrival: item.arrival,
      departure: item.departure,
      numAdult: item.numAdult ?? 1,
      numChild: item.numChild ?? 0,
      price: item.price ?? 0,
      firstName: item.firstName ?? "",
      lastName: item.lastName ?? "",
      phone: item.phone,
      email: item.email,
      notes: item.notes,
      referer: item.referer,
      invoiceItems: item.invoiceItems,
    });

    results.push({ new: created });
    void sendWebhook("booking.new", created, { delayMs: 150 });
  }

  res.json(results);
});
