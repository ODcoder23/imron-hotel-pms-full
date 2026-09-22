/**
 * Beds24 HTTP client — 03-BEDS24-API-INTEGRATSIYA.md §3, §4
 *
 * YAGONA CHIQISH NUQTASI. Bu fayldan tashqarida hech qayerda
 * `fetch("api.beds24.com/...")` chaqirilmaydi. Maqsad: rate-limit va
 * retry mantig'ini bitta joyda ushlab turish (03-fayl §4).
 *
 * RATE LIMIT (03-fayl §3): account darajasida, 5 daqiqalik aylanma
 * oyna, standart 100 kredit. Har javobda uch header keladi:
 *   x-five-min-limit-remaining
 *   x-five-min-limit-resets-in
 *   x-request-cost
 *
 * Kredit tugasa — bu XATO EMAS. Job kechiktiriladi va `attempts`
 * hisobiga kirmaydi (05-fayl §3). Aks holda normal yuklamada
 * job'lar bekorga "failed" bo'lib qolardi.
 */

import { config } from "../../lib/config.js";
import { getAccessToken, invalidateToken, Beds24AuthError } from "./auth.js";

// --- Kredit holati (xotirada, jarayon davomida) -------------
type CreditState = {
  remaining: number;
  resetsIn: number;
  updatedAt: number;
};

let credits: CreditState = {
  remaining: config.beds24.creditLimit,
  resetsIn: 0,
  updatedAt: 0,
};

export function getCreditState(): CreditState & { isLow: boolean } {
  return { ...credits, isLow: credits.remaining < config.beds24.creditSafetyThreshold };
}

/** Test uchun — kredit holatini tiklash */
export function resetCreditState(): void {
  credits = { remaining: config.beds24.creditLimit, resetsIn: 0, updatedAt: 0 };
}

// --- Xatolar ------------------------------------------------

/**
 * Kredit tugagan. `retryAfterSeconds` — qancha kutish kerak.
 * BullMQ bu xatoni ko'rib job'ni kechiktiradi, failed deb belgilamaydi.
 */
export class RateLimitError extends Error {
  readonly retryable = true;
  constructor(readonly retryAfterSeconds: number) {
    super(`Beds24 kredit tugadi, ${retryAfterSeconds}s kutish kerak`);
    this.name = "RateLimitError";
  }
}

export class Beds24ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable: boolean,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "Beds24ApiError";
  }
}

// --- So'rov -------------------------------------------------

type RequestOptions = {
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Taxminiy kredit qiymati — oldindan tekshirish uchun */
  estimatedCost?: number;
  /** 401 kelganda token yangilanib qayta urinilganmi */
  _retriedAuth?: boolean;
};

/**
 * Beds24'ga so'rov yuboradi.
 *
 * Oldindan tekshiradi: kredit yetarlimi. Yetmasa darhol
 * `RateLimitError` — bekorga so'rov yuborilmaydi.
 */
export async function beds24Request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", query, body, estimatedCost = 3 } = opts;

  // --- Oldindan kredit tekshiruvi (05-fayl §3) ---
  if (credits.updatedAt > 0) {
    const elapsed = (Date.now() - credits.updatedAt) / 1000;
    const windowExpired = elapsed > credits.resetsIn;

    if (!windowExpired && credits.remaining < estimatedCost) {
      const wait = Math.max(1, Math.ceil(credits.resetsIn - elapsed));
      throw new RateLimitError(wait);
    }
  }

  // --- URL ---
  const url = new URL(`${config.beds24.baseUrl}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  // --- Token ---
  const token = await getAccessToken();

  // --- So'rov ---
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const msg = String(e);
    const isTimeout = msg.includes("timeout") || msg.includes("aborted");
    throw new Beds24ApiError(
      0,
      isTimeout ? "Beds24 javob bermadi (timeout)" : `Tarmoq xatosi: ${msg.slice(0, 100)}`,
      true
    );
  }

  // --- Rate-limit headerlarini o'qish ---
  const remaining = res.headers.get("x-five-min-limit-remaining");
  const resetsIn = res.headers.get("x-five-min-limit-resets-in");
  const cost = res.headers.get("x-request-cost");

  if (remaining !== null) {
    credits = {
      remaining: Number(remaining),
      resetsIn: Number(resetsIn ?? 300),
      updatedAt: Date.now(),
    };
    if (credits.remaining < config.beds24.creditSafetyThreshold) {
      console.warn(
        `[beds24] kredit kam: ${credits.remaining}/${config.beds24.creditLimit}, ` +
        `${credits.resetsIn}s ichida tiklanadi`
      );
    }
  }

  if (config.isDev && cost) {
    console.log(`[beds24] ${method} ${path} — narx ${cost}, qoldi ${remaining ?? "?"}`);
  }

  // --- 429: kredit tugadi ---
  if (res.status === 429) {
    const bodyJson = await res.json().catch(() => ({}) as Record<string, unknown>);
    const wait = Number((bodyJson as { resetsIn?: number }).resetsIn ?? resetsIn ?? 60);
    throw new RateLimitError(Math.max(1, wait));
  }

  // --- 401: token eskirgan, bir marta yangilab qayta urinish ---
  if (res.status === 401 && !opts._retriedAuth) {
    console.log("[beds24] 401 — token yangilanadi va qayta urinilodi");
    await invalidateToken();
    return beds24Request<T>(path, { ...opts, _retriedAuth: true });
  }

  // --- Boshqa xatolar ---
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const retryable = res.status >= 500;
    throw new Beds24ApiError(
      res.status,
      `Beds24 ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`,
      retryable,
      text
    );
  }

  // --- Javobni parse qilish ---
  const text = await res.text();
  if (!text) {
    throw new Beds24ApiError(res.status, "Beds24 bo'sh javob qaytardi", true);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Beds24ApiError(
      res.status,
      `Beds24 noto'g'ri JSON qaytardi: ${text.slice(0, 120)}`,
      true
    );
  }
}

/** Xato qayta urinishga arziydimi — BullMQ shu funksiyaga qaraydi */
export function isRetryable(e: unknown): boolean {
  if (e instanceof RateLimitError) return true;
  if (e instanceof Beds24ApiError) return e.retryable;
  if (e instanceof Beds24AuthError) return e.retryable;
  return false;
}

/** Qancha kutish kerak (sekund) — rate limit uchun */
export function getRetryDelay(e: unknown): number | null {
  if (e instanceof RateLimitError) return e.retryAfterSeconds;
  return null;
}
