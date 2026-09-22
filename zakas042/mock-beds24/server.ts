/**
 * Mock Beds24 API v2 server
 *
 * Manba: 11-BOSQICHLAR-ROADMAP.md FAZA 0.5
 *
 * NEGA KERAK. Bizda Beds24 hisobiga ulanish huquqi yo'q, lekin tizim
 * to'liq ishlaydigan holatda topshirilishi kerak. Bu server Beds24'ning
 * haqiqiy xatti-harakatini taqlid qiladi: token oqimi, kredit hisobi,
 * rate-limit headerlari, webhook qaytarish, xato holatlari.
 *
 * Shu bilan retry, backoff, rate-limit kechiktirish, echo loop himoyasi
 * va duplicate dedup — hammasi haqiqiy sinovdan o'tadi.
 *
 * Ishga tushirish:  npm run dev   (port 4000)
 *
 * PMS tomonda almashtirish bitta o'zgaruvchida:
 *   Test:       BEDS24_BASE_URL=http://localhost:4000
 *   Production: BEDS24_BASE_URL=https://api.beds24.com/v2
 */

import express from "express";
import { state } from "./state.js";
import { scenarioMiddleware, rateLimitMiddleware, authMiddleware } from "./scenarios.js";
import { authRouter } from "./routes/authentication.js";
import { propertiesRouter } from "./routes/properties.js";
import { bookingsRouter } from "./routes/bookings.js";
import { calendarRouter } from "./routes/calendar.js";
import { sendWebhook, sendDuplicateWebhook, sendRateWebhook } from "./webhook-sender.js";
import { ROOM_TYPE_IDS } from "./fixtures/properties.js";

const app = express();
const PORT = Number(process.env.MOCK_PORT ?? 4000);

app.use(express.json({ limit: "2mb" }));

// So'rovlarni log qilish
app.use((req, _res, next) => {
  const scenario = req.query.scenario ? ` [scenario=${req.query.scenario}]` : "";
  console.log(`${req.method} ${req.path}${scenario}`);
  next();
});

// Tartib muhim: scenario -> auth -> rate limit
app.use(scenarioMiddleware);
app.use(authMiddleware);
app.use(rateLimitMiddleware);

// --- Beds24 API v2 ------------------------------------------
app.use("/authentication", authRouter);
app.use("/properties", propertiesRouter);
app.use("/bookings", bookingsRouter);
app.use("/inventory/rooms/calendar", calendarRouter);

// ============================================================
//  /control/* — test boshqaruvi (haqiqiy Beds24'da yo'q)
// ============================================================

const control = express.Router();

/** Holatni tozalash — testlar orasida */
control.post("/reset", (_req, res) => {
  state.reset();
  res.json({ ok: true, message: "Holat tozalandi" });
});

/**
 * Bron qo'shish WEBHOOK YUBORMASDAN — polling fallback sinovi.
 *
 * TZ 10-band: "Webhook ishlamasa polling/sync fallback mexanizmi
 * bo'lsin." Buni sinash uchun webhook yetib kelmagan holatni
 * yaratish kerak: bron Beds24'da bor, PMS'da yo'q.
 */
control.post("/add-booking-silently", (req, res) => {
  const {
    roomTypeId = ROOM_TYPE_IDS.standard,
    arrival,
    departure,
    firstName = "Silent",
    lastName = "Booking",
    status = "confirmed",
    price = 100,
    numAdult = 2,
    referer = "Booking.com",
  } = req.body ?? {};

  if (!arrival || !departure) {
    res.status(400).json({ error: "arrival va departure kerak" });
    return;
  }

  const booking = state.addBooking({
    roomId: Number(roomTypeId),
    status,
    arrival,
    departure,
    numAdult,
    numChild: 0,
    price,
    firstName,
    lastName,
    phone: "+998900000000",
    referer,
  });

  // Webhook YUBORILMAYDI — polling tutib olishi kerak
  res.json({ ok: true, booking });
});

/**
 * Kreditni tiklash — testlar uchun.
 *
 * `/control/reset` dan farqi: bronlarni va calendarPushes'ni
 * TEGMAYDI. Testlar ketma-ket ishlaganda 100 kredit/5daqiqa
 * cheklovi tugab qoladi va job'lar kechiktiriladi — bu haqiqiy
 * xatti-harakat, lekin testni to'xtatib qo'yadi. Shu endpoint
 * faqat kredit hisobini nolga qaytaradi.
 */
control.post("/refill-credits", (_req, res) => {
  state.credits.reset();
  res.json({ ok: true, remaining: state.credits.remaining });
});

/** Kreditni sun'iy tugatish — rate-limit retry sinovi */
control.post("/drain-credits", (_req, res) => {
  state.credits.drain();
  res.json({
    ok: true,
    remaining: state.credits.remaining,
    resetsIn: state.credits.resetsIn,
  });
});

/** Joriy holat — test tekshiruvi uchun */
control.get("/state", (_req, res) => {
  res.json({
    credits: {
      limit: state.credits.limit,
      remaining: state.credits.remaining,
      resetsIn: state.credits.resetsIn,
    },
    bookings: [...state.bookings.values()],
    calendarPushes: state.calendarPushes,
    webhooksSent: state.webhooksSent,
    roomTypeIds: ROOM_TYPE_IDS,
  });
});

/** Beds24'da narx o'zgarganini simulyatsiya qilish (TZ 7-band) */
control.post("/simulate-rate-change", async (req, res) => {
  const { roomId = ROOM_TYPE_IDS.standard, rates = [] } = req.body ?? {};

  if (!Array.isArray(rates) || rates.length === 0) {
    res.status(400).json({ error: "rates massivi kerak" });
    return;
  }

  // Mock o'z kalendarida ham yangilaydi — GET bilan solishtirish uchun
  state.setCalendar(rates.map((r: { date: string; price: number }) => ({
    roomId: Number(roomId),
    from: r.date,
    to: r.date,
    price1: r.price,
  })));

  await sendRateWebhook(Number(roomId), rates);
  res.json({ ok: true, sent: rates.length });
});

/** Beds24'dan bron kelishini simulyatsiya qilish (OTA -> Beds24 -> PMS) */
control.post("/simulate-ota-booking", async (req, res) => {
  const {
    roomTypeId = ROOM_TYPE_IDS.standard,
    arrival,
    departure,
    firstName = "Booking.com",
    lastName = "Mehmoni",
    status = "confirmed",
    price = 120,
    numAdult = 2,
    duplicate = false,
    referer = "Booking.com",
  } = req.body ?? {};

  if (!arrival || !departure) {
    res.status(400).json({ error: "arrival va departure kerak" });
    return;
  }

  const booking = state.addBooking({
    roomId: Number(roomTypeId),
    status,
    arrival,
    departure,
    numAdult,
    numChild: 0,
    price,
    firstName,
    lastName,
    phone: "+998900000000",
    referer,
  });

  if (duplicate) {
    await sendDuplicateWebhook("booking.new", booking);
  } else {
    await sendWebhook("booking.new", booking);
  }

  res.json({ ok: true, booking, duplicateSent: duplicate });
});

/** Mavjud bronni bekor qilish + webhook (OTA tomonidan bekor qilinishi) */
control.post("/simulate-cancellation", async (req, res) => {
  const { bookingId } = req.body ?? {};
  const updated = state.updateBooking(Number(bookingId), { status: "cancelled" });
  if (!updated) {
    res.status(404).json({ error: `Booking ${bookingId} topilmadi` });
    return;
  }
  await sendWebhook("booking.cancelled", updated);
  res.json({ ok: true, booking: updated });
});

/** To'lov qo'shish + webhook (TZ 14-band) */
control.post("/simulate-payment", async (req, res) => {
  const { bookingId, amount = 100, description = "OTA to'lovi" } = req.body ?? {};
  const existing = state.bookings.get(Number(bookingId));
  if (!existing) {
    res.status(404).json({ error: `Booking ${bookingId} topilmadi` });
    return;
  }
  const items = [...(existing.invoiceItems ?? []), { type: "payment", amount, description }];
  const updated = state.updateBooking(existing.id, { invoiceItems: items })!;
  await sendWebhook("payment.updated", updated);
  res.json({ ok: true, booking: updated });
});

app.use("/control", control);

// --- 404 ----------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: `Endpoint topilmadi: ${req.method} ${req.path}` });
});

// --- Ishga tushirish ----------------------------------------
app.listen(PORT, () => {
  console.log(`
  Mock Beds24 API v2
  http://localhost:${PORT}

  Room type ID'lar (9 tur, jami 18 xona):
    standard3 -> ${ROOM_TYPE_IDS.standard3}   comfort3  -> ${ROOM_TYPE_IDS.comfort3}
    semilux   -> ${ROOM_TYPE_IDS.semilux}   comfort4  -> ${ROOM_TYPE_IDS.comfort4}
    premium4  -> ${ROOM_TYPE_IDS.premium4}   deluxe4   -> ${ROOM_TYPE_IDS.deluxe4}
    famdeluxe -> ${ROOM_TYPE_IDS.famdeluxe}   famlux201 -> ${ROOM_TYPE_IDS.famlux201}
    famlux301 -> ${ROOM_TYPE_IDS.famlux301}

  Invite code: mock-invite-code
  Kredit: ${state.credits.limit} / 5 daqiqa

  Scenario'lar:  ?scenario=500 | 502 | timeout | 429 | malformed | empty
  Boshqaruv:     POST /control/{reset,drain-credits,simulate-ota-booking}
`);
});
