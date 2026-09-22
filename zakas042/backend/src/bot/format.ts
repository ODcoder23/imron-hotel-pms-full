/**
 * Telegram xabarlarini formatlash
 *
 * Bot HTML parse_mode ishlatadi (Markdown emas): mehmon ismida
 * `_` yoki `*` bo'lsa Markdown buziladi, HTML esa escape bilan
 * ishonchli.
 */

/** Telegram HTML uchun xavfsiz matn */
export function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 450000 -> "450 000 so'm" */
export function som(n: number): string {
  return Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ") + " so'm";
}

/** 1600000 -> "1.6 mln" (katta summalar uchun) */
export function mln(n: number): string {
  if (n < 1_000_000) return som(n);
  return (n / 1_000_000).toFixed(1) + " mln so'm";
}

/** "2026-09-16" -> "16.09" */
export function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
}

const MONTHS = [
  "yanvar", "fevral", "mart", "aprel", "may", "iyun",
  "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr",
];

/** "2026-09-16" -> "16-sentabr" */
export function longDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)}-${MONTHS[Number(m) - 1]}`;
}

/** Bron manbai -> o'zbekcha nom */
export const SOURCE_LABEL: Record<string, string> = {
  direct: "To'g'ridan-to'g'ri",
  website: "Veb-sayt",
  booking_com: "Booking.com",
  airbnb: "Airbnb",
  expedia: "Expedia",
  phone: "Telefon",
  walk_in: "Bevosita kelgan",
  other: "Boshqa",
};

/** Bron holati -> o'zbekcha nom va belgi */
export const STATUS_LABEL: Record<string, string> = {
  pending_payment: "⏳ To'lov kutilmoqda",
  confirmed: "✅ Tasdiqlangan",
  checked_in: "🏠 Kirgan",
  checked_out: "👋 Chiqqan",
  cancelled: "❌ Bekor qilingan",
  no_show: "🚫 Kelmadi",
};

/** Xona holati -> belgi */
export const ROOM_STATUS_ICON: Record<string, string> = {
  available: "🟢",
  reserved: "🟡",
  occupied: "🔵",
  dirty: "🟠",
  out_of_order: "🔴",
  out_of_service: "⚫",
};

export const ROOM_STATUS_LABEL: Record<string, string> = {
  available: "Bo'sh",
  reserved: "Band qilingan",
  occupied: "Band",
  dirty: "Tozalanmagan",
  out_of_order: "Nosoz",
  out_of_service: "Xizmatdan chiqarilgan",
};

/**
 * Oddiy matn progress chizig'i.
 *
 * `bar(60)` -> "██████░░░░"
 */
export function bar(percent: number, width = 10): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
