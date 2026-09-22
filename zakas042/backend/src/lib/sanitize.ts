/**
 * Log sanitizatsiyasi — TZ 16, 18-band
 *
 * Manba: 10-SECURITY-VA-SYNCLOG.md §2
 *
 * TZ: "Secret/token/password log qilinmasin."
 *
 * BITTA FUNKSIYA, BITTA JOY. Har controllerda alohida yozilmaydi.
 * `SyncLog.request/response` va `WebhookEvent.rawPayload` shu
 * funksiyadan o'tadi.
 *
 * Kalit qidiruvi `includes` bilan — `x-auth-token`, `user_password`
 * kabi variantlar ham tutiladi.
 */

const SENSITIVE_KEYS = [
  "token", "accesstoken", "refreshtoken", "authorization", "auth",
  "password", "passwordhash", "secret", "apikey", "api_key",
  "cardnumber", "card_number", "cvv", "cvc", "cardholder",
  "expirydate", "expiry_date", "creditcard", "credit_card", "iban",
  "invitecode", "invite_code",
];

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 12;
const MAX_STRING = 2000;

function isSensitive(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, "");
  return SENSITIVE_KEYS.some((s) => k.includes(s.replace(/[-_]/g, "")));
}

/**
 * Maxfiy maydonlarni `[REDACTED]` bilan almashtiradi.
 *
 * Juda uzun matnlar qisqartiriladi — log jadvali cheksiz o'smasligi
 * uchun (10-fayl §5: SyncLog eng tez o'sadigan jadval).
 */
export function sanitizeForLog(data: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[MAX_DEPTH]";
  if (data === null || data === undefined) return data;

  if (typeof data === "string") {
    return data.length > MAX_STRING ? data.slice(0, MAX_STRING) + "...[qisqartirildi]" : data;
  }
  if (typeof data !== "object") return data;

  if (Array.isArray(data)) {
    return data.slice(0, 200).map((v) => sanitizeForLog(v, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    out[key] = isSensitive(key) ? REDACTED : sanitizeForLog(value, depth + 1);
  }
  return out;
}

/** Prisma `Json` maydoniga yozish uchun — undefined bo'lmasligi kerak */
export function sanitizeForJson(data: unknown): object {
  const clean = sanitizeForLog(data);
  if (clean === null || clean === undefined) return {};
  if (typeof clean !== "object") return { value: clean };
  return clean as object;
}
