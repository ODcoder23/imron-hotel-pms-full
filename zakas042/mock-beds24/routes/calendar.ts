/**
 * /inventory/rooms/calendar — 03-fayl §2, 07-fayl §4
 *
 * POST — availability (numAvail) va narx (price1) yuborish
 * GET  — joriy holatni o'qish (drift tekshiruvi uchun, 07-fayl §6)
 *
 * MUHIM: availability room type darajasida SON sifatida keladi
 * (07-fayl §1 — agregatsiya). Mock qabul qilgan qiymatlarni
 * saqlaydi, test uni tekshiradi.
 */

import { Router } from "express";
import { state, type CalendarEntry } from "../state.js";

export const calendarRouter = Router();

// --- POST /inventory/rooms/calendar -------------------------
calendarRouter.post("/", (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const results: Array<Record<string, unknown>> = [];

  for (const item of items) {
    const roomId = Number(item.roomId);
    if (!roomId) {
      results.push({ errors: [{ field: "roomId", message: "roomId is required" }] });
      continue;
    }

    const calendar = Array.isArray(item.calendar) ? item.calendar : [];
    const entries: CalendarEntry[] = calendar.map((c: Record<string, unknown>) => ({
      roomId,
      from: String(c.from),
      to: String(c.to ?? c.from),
      numAvail: c.numAvail !== undefined ? Number(c.numAvail) : undefined,
      price1: c.price1 !== undefined ? Number(c.price1) : undefined,
      minStay: c.minStay !== undefined ? Number(c.minStay) : undefined,
    }));

    state.setCalendar(entries);
    state.calendarPushes.push({
      at: new Date().toISOString(),
      roomId,
      entries,
    });

    const days = entries.reduce((n, e) => {
      const from = new Date(e.from + "T00:00:00Z").getTime();
      const to = new Date(e.to + "T00:00:00Z").getTime();
      return n + Math.floor((to - from) / 86_400_000) + 1;
    }, 0);

    console.log(`[calendar] roomId=${roomId}, ${entries.length} oraliq, ${days} kun`);
    results.push({ success: true, modified: days });
  }

  res.json(results);
});

// --- GET /inventory/rooms/calendar --------------------------
calendarRouter.get("/", (req, res) => {
  const { roomId, startDate, endDate } = req.query as Record<string, string | undefined>;

  if (!roomId || !startDate || !endDate) {
    res.status(400).json({ error: "roomId, startDate, endDate required" });
    return;
  }

  const ids = roomId.split(",").map(Number);
  const data = ids.map((id) => ({
    roomId: id,
    calendar: state.getCalendar(id, startDate, endDate),
  }));

  res.json({ success: true, data });
});
