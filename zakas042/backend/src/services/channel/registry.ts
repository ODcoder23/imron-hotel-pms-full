/**
 * Kanal registri — TZ 12-band
 *
 * Manba: 01-ARXITEKTURA-VA-QOIDALAR.md §4
 *
 * TZ: "Arxitektura faqat Beds24 bilan cheklanmasin. Keyinchalik
 * Bronevik, MyBooking kabi kanallarni qo'shish mumkin bo'ladigan
 * qilib yozilsin."
 *
 * MUAMMO BU FAYL YECHADIGAN: biznes qatlami (`availability.ts`,
 * `rates.ts`, `reservationSync.ts`, `reconciliation.ts`) avval
 * `beds24Adapter` ni TO'G'RIDAN-TO'G'RI import qilardi. Ya'ni
 * interfeys bor edi, lekin hech kim uni ishlatmasdi — yangi kanal
 * qo'shish uchun oltita faylni tahrirlash kerak bo'lardi.
 *
 * Endi ular `getChannel()` chaqiradi va `ChannelAdapter` tipini
 * ko'radi. Yangi kanal qo'shish = shu faylga bitta qator.
 *
 * NEGA `Map`, oddiy `if` emas: kanal kodi DB'da saqlanadi
 * (`Channel.code`), ya'ni qaysi adapter kerakligi ishlash paytida
 * aniqlanadi — kompilyatsiya paytida emas.
 */

import type { ChannelAdapter } from "./types.js";
import { beds24Adapter } from "../beds24/adapter.js";

/**
 * Ro'yxatdan o'tgan kanallar.
 *
 * Kalit — `Channel.code` DB'dagi qiymat bilan bir xil bo'lishi
 * SHART: `getChannel()` shu bo'yicha qidiradi.
 */
const adapters = new Map<string, ChannelAdapter>([
  ["beds24", beds24Adapter],
  // Kelajakda: ["bronevik", bronevikAdapter], ["mybooking", ...]
  //
  // TZ 12-band cheklovi: API mavjud bo'lmagan platforma uchun fake
  // API, scraping yoki browser automation ISHLATILMAYDI. Adapter
  // yozish uchun rasmiy API shart.
]);

/**
 * Joriy faol kanal kodi.
 *
 * Hozircha bitta kanal ishlatiladi. Ko'p kanal kerak bo'lganda
 * bu funksiya `Channel.isActive` bo'yicha ro'yxat qaytaradi va
 * chaqiruvchilar har biri uchun takrorlaydi.
 */
export const DEFAULT_CHANNEL = "beds24";

/**
 * Kanal adapterini qaytaradi.
 *
 * Noma'lum kod berilsa xato tashlanadi — jim `undefined` qaytarish
 * xatoni yashirib, keyinroq tushunarsiz joyda chiqarardi.
 */
export function getChannel(code: string = DEFAULT_CHANNEL): ChannelAdapter {
  const adapter = adapters.get(code);
  if (!adapter) {
    throw new Error(
      `Kanal adapteri topilmadi: "${code}". ` +
      `Mavjudlari: ${[...adapters.keys()].join(", ")}`
    );
  }
  return adapter;
}

/** Ro'yxatdan o'tgan kanal kodlari — admin panel uchun */
export function listChannels(): string[] {
  return [...adapters.keys()];
}

/**
 * Kanal ro'yxatdan o'tganmi.
 *
 * DB'da `Channel` qatori bo'lishi mumkin, lekin adapteri
 * yozilmagan bo'lishi ham mumkin (kelajakdagi kanal uchun joy
 * tayyorlangan). Bu funksiya shu farqni ko'rsatadi.
 */
export function hasChannel(code: string): boolean {
  return adapters.has(code);
}
