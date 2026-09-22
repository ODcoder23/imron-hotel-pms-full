/**
 * Xato holatlarini simulyatsiya qilish
 *
 * Manba: 11-BOSQICHLAR-ROADMAP.md FAZA 0.5 jadvali
 *
 * Ishlatish:
 *   GET /properties?scenario=500      -> majburan 500
 *   GET /properties?scenario=timeout  -> 30s kutadi
 *   GET /properties?scenario=429      -> rate limit
 *   POST /control/drain-credits       -> kreditni tugatish
 *
 * Retry, backoff va rate-limit kechiktirish mantig'ini haqiqiy
 * sinovdan o'tkazish uchun kerak.
 */

import type { Request, Response, NextFunction } from "express";
import { state } from "./state.js";

export type Scenario = "500" | "502" | "timeout" | "429" | "malformed" | "empty";

/** Har so'rov uchun kredit qiymati — Beds24'da dinamik, bizda taxminiy */
const COST: Record<string, number> = {
  "GET /properties": 5,
  "GET /bookings": 3,
  "POST /bookings": 4,
  "GET /inventory/rooms/calendar": 2,
  "POST /inventory/rooms/calendar": 3,
  "GET /authentication/token": 1,
};

export function scenarioMiddleware(req: Request, res: Response, next: NextFunction): void {
  const scenario = req.query.scenario as Scenario | undefined;

  // Boshqaruv endpoint'lari scenario'siz ishlaydi
  if (req.path.startsWith("/control")) { next(); return; }

  if (scenario === "500") {
    res.status(500).json({ error: "Internal Server Error (simulyatsiya)" });
    return;
  }
  if (scenario === "502") {
    res.status(502).type("html").send("<html><body>Bad Gateway</body></html>");
    return;
  }
  if (scenario === "timeout") {
    setTimeout(() => {
      if (!res.headersSent) res.status(504).json({ error: "Gateway Timeout" });
    }, 30_000);
    return;
  }
  if (scenario === "malformed") {
    res.status(200).type("json").send('{"broken": [1,2,');
    return;
  }
  if (scenario === "empty") {
    res.status(200).send("");
    return;
  }

  next();
}

/**
 * Rate limit — Beds24 xatti-harakatini aynan takrorlaydi (03-fayl §3).
 * Har javobda uch header, kredit tugasa 429.
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith("/control")) { next(); return; }

  const key = `${req.method} ${req.path}`;
  const cost = COST[key] ?? 2;
  const scenario = req.query.scenario as Scenario | undefined;

  const ok = scenario === "429" ? false : state.credits.spend(cost);

  res.setHeader("x-request-cost", String(cost));
  res.setHeader("x-five-min-limit-remaining", String(state.credits.remaining));
  res.setHeader("x-five-min-limit-resets-in", String(state.credits.resetsIn));

  if (!ok) {
    res.status(429).json({
      error: "Rate limit exceeded",
      resetsIn: state.credits.resetsIn,
    });
    return;
  }

  next();
}

/** Token tekshiruvi (03-fayl §1) */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Auth endpoint'lari va boshqaruv token talab qilmaydi
  if (req.path.startsWith("/authentication") || req.path.startsWith("/control")) {
    next();
    return;
  }

  const token = req.header("token");
  if (!state.isTokenValid(token)) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  next();
}
