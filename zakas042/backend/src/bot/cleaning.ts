/**
 * Tozalash topshiriqlari — Telegram tomoni (BOTLAR-REJA.md)
 *
 * Bu fayl xabar MATNINI va TUGMALARINI yasaydi. Biznes mantiq
 * `services/cleaning.ts` da — bu yerda faqat ko'rinish.
 *
 * GURUH MANTIG'I (2026-09-17): xabar farroshlar guruhiga
 * yuboriladi, kim bo'sh bo'lsa "Men olaman" bosadi. Shu sabab
 * matnlar ikkinchi shaxsda emas ("Qabul qildingiz"), balki
 * uchinchi shaxsda ("Oldi: Dilnoza") — guruhdagi hamma o'qiydi.
 *
 * MUHIM: tozalash xabarida narx, daromad va mehmon telefoni
 * YO'Q. Faroshga faqat xona raqami, tur va sabab kerak.
 */

import { InlineKeyboard } from "grammy";
import type { CleaningStatus } from "@prisma/client";
import { esc } from "./format.js";

/** `taskInclude` bilan o'qilgan topshiriq shakli */
export type TaskView = {
  id: string;
  status: CleaningStatus;
  reason: string;
  createdAt: Date;
  acceptedAt: Date | null;
  finishedAt: Date | null;
  photoUrl: string | null;
  doneAt: Date | null;
  claimedByName: string | null;
  room: { id: string; floor: number; roomType: { label: string } | null };
  employee: { fullName: string } | null;
};

/** "14:32" */
export function hhmm(d: Date): string {
  return d.toLocaleTimeString("uz-UZ", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Ikki vaqt orasidagi daqiqa */
export function minutesBetween(a: Date, b: Date): number {
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 60_000));
}

/**
 * Kim olgani.
 *
 * Guruhda Telegram ismi ishlatiladi. Eski topshiriqlarda
 * (guruhga o'tishdan oldin) xodim biriktirilgan bo'lishi
 * mumkin — u holda xodim ismi.
 */
export function who(t: TaskView): string {
  return t.claimedByName ?? t.employee?.fullName ?? "—";
}

// ============================================================
//  Xabar matni
// ============================================================

/**
 * Topshiriq xabari — holatga qarab besh xil ko'rinish.
 *
 * Bir xabar tahrirlanadi, yangisi yuborilmaydi: guruh
 * to'lib ketmasin.
 */
export function taskMessage(t: TaskView, isPromptingPhoto = false): string {
  const type = t.room.roomType?.label ?? "";
  const head = `🏠 <b>${esc(t.room.id)}-xona</b>${type ? ` · ${esc(type)}` : ""}`;
  const floor = `📍 ${t.room.floor}-qavat`;

  if (t.status === "DONE") {
    const photoLine = t.photoUrl ? "\n📸 Xona rasmi biriktirilgan" : "";
    const timeLine = (t.acceptedAt && t.finishedAt)
      ? `⏱ ${hhmm(t.acceptedAt)} → ${hhmm(t.finishedAt)} (${minutesBetween(t.acceptedAt, t.finishedAt)} daqiqa)`
      : (t.finishedAt ? `⏱ Tugatildi: ${hhmm(t.finishedAt)}` : "");
    return [
      "✅ <b>Tasdiqlandi</b>",
      "",
      head,
      floor,
      "",
      `👤 ${esc(who(t))}`,
      ...(timeLine ? [timeLine + photoLine] : (photoLine ? [photoLine] : [])),
      "",
      "Xona sotishga ochildi.",
    ].join("\n");
  }

  /**
   * Tasdiqlash kutilmoqda (2026-09-17 qarori).
   *
   * Farosh ishini tugatdi, lekin admin hali tekshirmadi.
   * Xona bu holatda HALI SOTILMAYDI.
   */
  if (t.status === "PENDING") {
    const photoLine = t.photoUrl ? "\n📸 <b>Xona rasmi biriktirildi</b>" : "";
    const timeLine = (t.acceptedAt && t.finishedAt)
      ? `✅ Tozaladi: ${hhmm(t.finishedAt)} (${minutesBetween(t.acceptedAt, t.finishedAt)} daqiqa)`
      : (t.finishedAt ? `✅ Tozaladi: ${hhmm(t.finishedAt)}` : "");
    return [
      "⏳ <b>Tasdiqlash kutilmoqda</b>",
      "",
      head,
      floor,
      "",
      `👤 ${esc(who(t))}`,
      ...(timeLine ? [timeLine + photoLine] : (photoLine ? [photoLine] : [])),
      "",
      "Admin tekshirgandan keyin xona sotishga ochiladi.",
    ].join("\n");
  }

  if (t.status === "IN_PROGRESS") {
    if (isPromptingPhoto) {
      return [
        "📸 <b>XONA RASMINI YUBORING</b>",
        "",
        head,
        floor,
        "",
        `👤 ${esc(who(t))}`,
        "",
        "Iltimos, tozalangan xona rasmini galereyangizdan tanlab shu guruhga yuboring (pastdagi 📎 skrepka orqali).",
        "",
        "<i>Rasm yuborilishi bilan topshiriq adminga tasdiqlash uchun yuboriladi.</i>",
      ].join("\n");
    }

    return [
      "🧹 <b>Tozalanmoqda</b>",
      "",
      head,
      floor,
      "",
      `Sabab: ${esc(t.reason)}`,
      `⏰ ${hhmm(t.createdAt)}`,
      `👤 Ko'rdi va qabul qildi: ${esc(who(t))}${t.acceptedAt ? ` (${hhmm(t.acceptedAt)})` : ""}`,
    ].join("\n");
  }

  if (t.status === "CANCELLED") {
    return [
      "❌ <b>Bekor qilindi</b>",
      "",
      head,
      floor,
      "",
      "Bu topshiriq bekor qilindi.",
    ].join("\n");
  }

  // NEW — hali hech kim ko'rmagan / olmagan
  return [
    "🧹 <b>Tozalash kerak</b>",
    "",
    head,
    floor,
    "",
    `Sabab: ${esc(t.reason)}`,
    `⏰ ${hhmm(t.createdAt)}`,
  ].join("\n");
}

/**
 * Holatga mos tugma.
 *
 * 1-bosqich: `NEW` holatda — "👁 Ko'rdim"
 * 2-bosqich: `IN_PROGRESS` holatda — "🧹 Tozaladim"
 * 3-bosqich: Tasdiqlash — "✅ Ha, tozalab bo'ldim"
 * 4-bosqich: Rasm so'rash — "📸 Galereyadan rasm tanlash" / "⏭ Rasmsiz tasdiqlash"
 */
export function taskKeyboard(
  t: TaskView,
  mode: "normal" | "confirm_done" | "prompt_photo" = "normal"
): InlineKeyboard | undefined {
  if (t.status === "NEW") {
    return new InlineKeyboard().text("👁 Ko'rdim", `cl:accept:${t.id}`);
  }
  if (t.status === "IN_PROGRESS") {
    if (mode === "prompt_photo") {
      return new InlineKeyboard()
        .text("📸 Galereyadan rasm tanlash", `cl:photo_info:${t.id}`)
        .row()
        .text("⏭ Rasmsiz tasdiqlash", `cl:confirm_done:${t.id}`);
    }
    if (mode === "confirm_done") {
      return new InlineKeyboard()
        .text("✅ Ha, tozalab bo'ldim", `cl:ask_photo:${t.id}`)
        .row()
        .text("↩️ Hali tozalayapman", `cl:cancel_done:${t.id}`);
    }
    return new InlineKeyboard().text("🧹 Tozaladim", `cl:done:${t.id}`);
  }
  return undefined;
}

// ============================================================
//  Guruh ekrani
// ============================================================

/**
 * `/start` yoki `/tasks` — ochiq topshiriqlar ro'yxati.
 *
 * Moliya, bronlar va boshqa bo'limlar YO'Q: bu bot faqat
 * tozalash uchun. Farosh mehmonxona pulini ko'rmaydi.
 */
export function tasksOverview(tasks: TaskView[]): string {
  if (tasks.length === 0) {
    return [
      "🧹 <b>Tozalash</b>",
      "",
      "Hozircha ochiq topshiriq yo'q.",
      "",
      "Yangi xona tozalash kerak bo'lsa, shu yerga xabar keladi.",
    ].join("\n");
  }

  const lines = [
    "🧹 <b>Ochiq topshiriqlar</b>",
    "",
    `Jami: ${tasks.length} ta`,
    "",
  ];

  for (const t of tasks) {
    const type = t.room.roomType?.label ?? "";
    if (t.status === "IN_PROGRESS") {
      lines.push(
        `🧹 <b>${esc(t.room.id)}-xona</b>${type ? ` · ${esc(type)}` : ""}`,
        `   Oldi: ${esc(who(t))}`,
        ""
      );
    } else {
      lines.push(
        `⏳ <b>${esc(t.room.id)}-xona</b>${type ? ` · ${esc(type)}` : ""}`,
        `   ${esc(t.reason)} — hali hech kim olmagan`,
        ""
      );
    }
  }

  lines.push("Har topshiriq alohida xabarda — tugmalar o'sha yerda.");
  return lines.join("\n");
}

// ============================================================
//  Kechikish eslatmasi
// ============================================================

/**
 * Uzoq javobsiz qolgan topshiriq haqida guruhga eslatma.
 *
 * Avtomatik qayta biriktirilmaydi: guruhda hamma ko'radi,
 * kim bo'sh bo'lsa oladi.
 */
export function staleAlert(t: TaskView, minutes: number): string {
  const taken = t.status === "IN_PROGRESS";

  return [
    "⚠️ <b>Tozalash kechikmoqda</b>",
    "",
    `🏠 ${esc(t.room.id)}-xona`,
    taken ? `👤 Oldi: ${esc(who(t))}` : "👤 Hali hech kim olmagan",
    `⏰ ${minutes} daqiqadan beri`,
    "",
    `Sabab: ${esc(t.reason)}`,
  ].join("\n");
}
