/**
 * Bot ekranlari — to'rtta bo'lim
 *
 *   Dashboard       bugungi holat bir qarashda
 *   Moliya          daromad, to'lov, qarz
 *   Xona ma'lumoti  18 xona jonli holati
 *   Bron tushishi   so'nggi bronlar + avtomatik bildirishnoma
 *
 * Har funksiya tayyor HTML matn qaytaradi. Telegram bilan
 * gaplashish `index.ts` zimmasida — shunda ekranlarni alohida
 * sinab ko'rish mumkin.
 */

import {
  getTodaySnapshot,
  getFinanceReport,
  getRoomStates,
  getRecentBookings,
  periodRange,
} from "../services/stats.js";
import {
  esc, som, mln, longDate, shortDate, bar,
  SOURCE_LABEL, STATUS_LABEL, ROOM_STATUS_ICON, ROOM_STATUS_LABEL,
} from "./format.js";

// ============================================================
//  1. Dashboard
// ============================================================

export async function screenDashboard(): Promise<string> {
  const s = await getTodaySnapshot();

  const lines = [
    `<b>📊 Bugungi holat</b>`,
    `<i>${longDate(s.date)}</i>`,
    ``,
    `<b>Xonalar</b>`,
    `${bar(s.occupancyPercent)} ${s.occupancyPercent}%`,
    `🔵 Band: <b>${s.occupiedRooms}</b>  🟢 Bo'sh: <b>${s.freeRooms}</b>` +
      (s.blockedRooms > 0 ? `  🔴 Yopiq: <b>${s.blockedRooms}</b>` : ``),
    `Jami: ${s.totalRooms} xona`,
    ``,
    `<b>Bugun</b>`,
    `➡️ Kirish: <b>${s.arrivals}</b>`,
    `⬅️ Chiqish: <b>${s.departures}</b>`,
    `🏠 Yashayotgan: <b>${s.staying}</b>`,
    ``,
    `<b>Bugungi tushum</b>`,
    `💰 ${mln(s.todayRevenue)}`,
  ];

  return lines.join("\n");
}

// ============================================================
//  2. Moliya
// ============================================================

export async function screenFinance(
  period: "today" | "week" | "month" = "month"
): Promise<string> {
  const { from, to } = periodRange(period);
  const r = await getFinanceReport(from, to);

  const title =
    period === "today" ? "Bugun" : period === "week" ? "Shu hafta" : "Shu oy";

  const lines = [
    `<b>💰 Moliya — ${title}</b>`,
    `<i>${longDate(r.from)} – ${longDate(r.to)}</i>`,
    ``,
    `Bronlar: <b>${r.bookings}</b> ta`,
    ``,
    `Xona narxi:  ${som(r.roomRevenue)}`,
  ];

  if (r.charges > 0) {
    lines.push(`Qo'shimcha: ${som(r.charges)}`);
  }

  lines.push(
    `<b>Jami: ${som(r.total)}</b>`,
    ``,
    `✅ To'langan: ${som(r.paid)}`,
  );

  if (r.debt > 0) {
    lines.push(`⚠️ Qarz: <b>${som(r.debt)}</b>`);
  }

  if (r.bySource.length > 0) {
    lines.push(``, `<b>Manba bo'yicha</b>`);
    for (const s of r.bySource) {
      const label = SOURCE_LABEL[s.source] ?? s.source;
      lines.push(`• ${esc(label)}: ${s.count} ta — ${som(s.amount)}`);
    }
  }

  if (r.bookings === 0) {
    lines.push(``, `<i>Bu oraliqda bron yo'q.</i>`);
  }

  return lines.join("\n");
}

// ============================================================
//  3. Xona ma'lumoti
// ============================================================

export async function screenRooms(): Promise<string> {
  const rooms = await getRoomStates();

  if (rooms.length === 0) return `<b>🏨 Xonalar</b>\n\n<i>Xona topilmadi.</i>`;

  // Qavat bo'yicha guruhlash — 18 xonani bir ro'yxatda o'qish qiyin
  const byFloor = new Map<number, typeof rooms>();
  for (const r of rooms) {
    const list = byFloor.get(r.floor) ?? [];
    list.push(r);
    byFloor.set(r.floor, list);
  }

  const occupied = rooms.filter((r) => r.occupied).length;
  const blocked = rooms.filter((r) => r.blocked).length;
  const free = rooms.length - occupied - blocked;

  const lines = [
    `<b>🏨 Xonalar holati</b>`,
    `🔵 ${occupied} band · 🟢 ${free} bo'sh` + (blocked > 0 ? ` · 🔴 ${blocked} yopiq` : ``),
    ``,
  ];

  for (const floor of [...byFloor.keys()].sort((a, b) => a - b)) {
    lines.push(`<b>${floor}-qavat</b>`);

    for (const r of byFloor.get(floor)!) {
      // Yopiq holati boshqa hamma narsadan ustun
      const icon = r.blocked ? "🔴" : r.occupied ? "🔵" : ROOM_STATUS_ICON[r.status] ?? "⚪";

      let right: string;
      if (r.blocked) {
        right = "yopiq (ta'mir)";
      } else if (r.occupied) {
        right = `${esc(r.guestName)} → ${shortDate(r.until ?? "")}`;
      } else {
        right = ROOM_STATUS_LABEL[r.status] ?? r.status;
      }

      lines.push(`${icon} <b>${r.id}</b> · ${esc(r.typeLabel)} — ${right}`);
    }
    lines.push(``);
  }

  return lines.join("\n").trimEnd();
}

// ============================================================
//  4. Bron tushishi
// ============================================================

export async function screenBookings(limit = 8): Promise<string> {
  const rows = await getRecentBookings(limit);

  if (rows.length === 0) {
    return `<b>📋 So'nggi bronlar</b>\n\n<i>Hali bron yo'q.</i>`;
  }

  const lines = [`<b>📋 So'nggi ${rows.length} ta bron</b>`, ``];

  for (const b of rows) {
    lines.push(
      `<b>${esc(b.guestName)}</b> · ${b.roomId}-xona`,
      `${shortDate(b.checkIn)} → ${shortDate(b.checkOut)} (${b.nights} kecha) · ${som(b.total)}`,
      `${STATUS_LABEL[b.status] ?? b.status} · ${esc(SOURCE_LABEL[b.source] ?? b.source)}`,
      ``
    );
  }

  return lines.join("\n").trimEnd();
}

/**
 * Yangi bron kelganda yuboriladigan bildirishnoma.
 *
 * `screenBookings` dan farqi: bu bitta bron haqida va darhol
 * yuboriladi (WebSocket event orqali).
 */
export function notifyNewBooking(b: {
  guestName: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  total: number;
  source: string;
  status: string;
  phone?: string;
}): string {
  const lines = [
    `🔔 <b>Yangi bron</b>`,
    ``,
    `👤 <b>${esc(b.guestName)}</b>`,
    `🏠 ${b.roomId}-xona`,
    `📅 ${longDate(b.checkIn)} → ${longDate(b.checkOut)} (${b.nights} kecha)`,
    `💰 ${som(b.total)}`,
    `📍 ${esc(SOURCE_LABEL[b.source] ?? b.source)}`,
    `${STATUS_LABEL[b.status] ?? b.status}`,
  ];

  if (b.phone) lines.push(`📞 ${esc(b.phone)}`);

  return lines.join("\n");
}
