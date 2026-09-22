/**
 * Sozlamalar — TZ 7-band (source of truth)
 *
 * Manba: 07-AVAILABILITY-VA-RATES-SYNC.md §7
 *
 * NEGA DB'DA, `.env` DA EMAS: `SOURCE_OF_TRUTH_RATES` ishlash
 * paytida o'zgarishi mumkin (admin panelda tugma). `.env` o'zgarishi
 * server qayta ishga tushirilishini talab qiladi, bu esa ishlab
 * turgan mehmonxonada qabul qilib bo'lmaydigan narsa.
 *
 * `.env` qiymati BOSHLANG'ICH qiymat sifatida ishlatiladi: DB'da
 * yozuv bo'lmasa o'sha olinadi.
 */

import { prisma } from "../lib/prisma.js";
import { config } from "../lib/config.js";

export type SourceOfTruth = "pms" | "beds24";

export const SETTING_KEYS = {
  ratesSoT: "SOURCE_OF_TRUTH_RATES",
  availabilitySoT: "SOURCE_OF_TRUTH_AVAILABILITY",

  // --- Biznes qoidalari (2026-09-17, SAVOLLAR.md) ------------
  //
  // NEGA DB'DA: bular narx kabi o'zgarib turadi. Nonushta narxi
  // ko'tarilsa yoki komissiya shartnomasi yangilansa server
  // qayta ishga tushirilmasligi kerak.

  /** Nonushta — kishi boshiga, so'm (S10) */
  mealPrice: "MEAL_PRICE_PER_PERSON",
  /** Bepul bekor qilish oynasi, soat (S11) */
  freeCancelHours: "FREE_CANCEL_HOURS",
  /** Kech bekor qilishda necha kecha narxi olinadi (S11) */
  cancelFeeNights: "CANCEL_FEE_NIGHTS",
  /** OTA komissiyasi, foiz (S14) */
  otaCommissionPercent: "OTA_COMMISSION_PERCENT",
  /** Audit jurnali saqlash muddati, kun (S16) */
  auditRetentionDays: "AUDIT_RETENTION_DAYS",

  // --- Tozalash (TOZALIK-BOT.md) -----------------------------

  /** Mehmon chiqqanda avtomatik topshiriq yaratilsinmi */
  cleaningAuto: "CLEANING_AUTO",
  /** Javob bermasa necha daqiqadan keyin eslatilsin */
  cleaningRemindMinutes: "CLEANING_REMIND_MINUTES",
  /** Tozalash me'yori, daqiqa — hisobotda "kechikdi" uchun */
  cleaningTargetMinutes: "CLEANING_TARGET_MINUTES",
  /** Ish vaqti boshlanishi, soat (0-23) */
  cleaningWorkStart: "CLEANING_WORK_START",
  /** Ish vaqti tugashi, soat (0-23) */
  cleaningWorkEnd: "CLEANING_WORK_END",
} as const;

/**
 * Biznes sozlamalarining boshlang'ich qiymatlari.
 *
 * Bular 2026-09-17 da egasi bilan kelishilgan (SAVOLLAR.md).
 * Admin panelda o'zgartiriladi, bu yerda faqat birinchi qiymat.
 */
export const BUSINESS_DEFAULTS = {
  /** 25 000 so'm — kishi boshiga nonushta */
  mealPrice: 25_000,
  /** 24 soat — undan keyin jarima */
  freeCancelHours: 24,
  /** 1 kecha narxi jarima sifatida */
  cancelFeeNights: 1,
  /** Booking.com odatda 15-18% oladi */
  otaCommissionPercent: 15,
  /** Audit jurnali 1 yil saqlanadi */
  auditRetentionDays: 365,

  // --- Tozalash (2026-09-17 kelishuvi) -----------------------
  /** Mehmon chiqqanda topshiriq o'zi yaratiladi */
  cleaningAuto: true,
  /** 30 daqiqa javob bo'lmasa egasiga eslatma */
  cleaningRemindMinutes: 30,
  /** Tozalash 30 daqiqada bajarilishi kutiladi */
  cleaningTargetMinutes: 30,
  /** Ish vaqti boshlang'ich ma'lumot (tozalik boti 24 soat faol, navbatchilik uchun saqlangan) */
  cleaningWorkStart: 7,
  cleaningWorkEnd: 22,
} as const;

/**
 * Sozlamani o'qiydi.
 *
 * KESHLANMAYDI: admin qiymatni o'zgartirganda barcha worker'lar
 * darhol yangi qiymatni ko'rishi kerak. Narx sync'i baribir tashqi
 * API kutadi, bitta indeksli so'rov sezilmaydi.
 */
export async function getSetting(key: string, fallback: string): Promise<string> {
  try {
    const row = await prisma.settings.findUnique({ where: { key } });
    return row?.value ?? fallback;
  } catch {
    // DB yiqilsa ham sync to'xtamasin (TZ 17-band)
    return fallback;
  }
}

export async function setSetting(
  key: string,
  value: string,
  updatedBy?: string
): Promise<void> {
  await prisma.settings.upsert({
    where: { key },
    create: { key, value, updatedBy },
    update: { value, updatedBy },
  });
}

/**
 * Narx uchun source of truth (TZ 7-band).
 *
 * "pms"    — PMS narxi Beds24'ga yuboriladi, Beds24'dan kelgan
 *            narx RAD ETILADI (va qayta yozib yuborilmaydi ham —
 *            aks holda cheksiz halqa)
 * "beds24" — teskarisi
 */
export async function getRatesSoT(): Promise<SourceOfTruth> {
  const v = await getSetting(SETTING_KEYS.ratesSoT, config.sourceOfTruth.rates);
  return v === "beds24" ? "beds24" : "pms";
}

export async function getAvailabilitySoT(): Promise<SourceOfTruth> {
  const v = await getSetting(SETTING_KEYS.availabilitySoT, config.sourceOfTruth.availability);
  return v === "beds24" ? "beds24" : "pms";
}

/** Admin panel uchun — joriy sozlamalar */
export async function listSettings() {
  const rows = await prisma.settings.findMany({ orderBy: { key: "asc" } });
  const map = new Map(rows.map((r) => [r.key, r]));

  return {
    ratesSoT: await getRatesSoT(),
    availabilitySoT: await getAvailabilitySoT(),
    /** `.env` dan olinganmi yoki DB'da o'rnatilganmi */
    overrides: {
      ratesSoT: map.has(SETTING_KEYS.ratesSoT),
      availabilitySoT: map.has(SETTING_KEYS.availabilitySoT),
    },
    updatedAt: {
      ratesSoT: map.get(SETTING_KEYS.ratesSoT)?.updatedAt ?? null,
      availabilitySoT: map.get(SETTING_KEYS.availabilitySoT)?.updatedAt ?? null,
    },
  };
}

// ============================================================
//  Biznes sozlamalari — sonli qiymatlar
// ============================================================

/**
 * Sozlamani son sifatida o'qiydi.
 *
 * Noto'g'ri qiymat (bo'sh, matn, manfiy) bo'lsa boshlang'ich
 * qiymat qaytariladi: sozlama buzilgani uchun bron yaratish
 * to'xtab qolmasin.
 */
async function getNumber(key: string, fallback: number): Promise<number> {
  const raw = await getSetting(key, String(fallback));
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Nonushta narxi — kishi boshiga (S10) */
export function getMealPrice(): Promise<number> {
  return getNumber(SETTING_KEYS.mealPrice, BUSINESS_DEFAULTS.mealPrice);
}

/** Bepul bekor qilish oynasi, soat (S11) */
export function getFreeCancelHours(): Promise<number> {
  return getNumber(SETTING_KEYS.freeCancelHours, BUSINESS_DEFAULTS.freeCancelHours);
}

/** Jarima necha kecha narxi (S11) */
export function getCancelFeeNights(): Promise<number> {
  return getNumber(SETTING_KEYS.cancelFeeNights, BUSINESS_DEFAULTS.cancelFeeNights);
}

/** OTA komissiyasi, foiz (S14) */
export function getOtaCommissionPercent(): Promise<number> {
  return getNumber(
    SETTING_KEYS.otaCommissionPercent,
    BUSINESS_DEFAULTS.otaCommissionPercent
  );
}

/** Audit jurnali saqlash muddati, kun (S16) */
export function getAuditRetentionDays(): Promise<number> {
  return getNumber(
    SETTING_KEYS.auditRetentionDays,
    BUSINESS_DEFAULTS.auditRetentionDays
  );
}

// ============================================================
//  Tozalash sozlamalari (TOZALIK-BOT.md)
// ============================================================

/** Mantiqiy sozlamani o'qiydi */
async function getBool(key: string, fallback: boolean): Promise<boolean> {
  const raw = await getSetting(key, String(fallback));
  return raw === "true" || raw === "1";
}

/** Mehmon chiqqanda avtomatik topshiriq yaratilsinmi */
export function getCleaningAuto(): Promise<boolean> {
  return getBool(SETTING_KEYS.cleaningAuto, BUSINESS_DEFAULTS.cleaningAuto);
}

/** Javob bermasa eslatish vaqti, daqiqa */
export function getCleaningRemindMinutes(): Promise<number> {
  return getNumber(
    SETTING_KEYS.cleaningRemindMinutes,
    BUSINESS_DEFAULTS.cleaningRemindMinutes
  );
}

/** Tozalash me'yori, daqiqa */
export function getCleaningTargetMinutes(): Promise<number> {
  return getNumber(
    SETTING_KEYS.cleaningTargetMinutes,
    BUSINESS_DEFAULTS.cleaningTargetMinutes
  );
}

/**
 * Hozir ish vaqtimi.
 *
 * HOZIRDA ISHLATILMAYDI (2026-09-17 qarori): tozalik boti
 * 24 soat ishlaydi. Mehmonxona kechayu kunduz ishlaydi va
 * yarim tunda chiqqan mehmondan keyin xona ertalabgacha iflos
 * turib, sotilmay qolardi.
 *
 * Funksiya va `CLEANING_WORK_START`/`CLEANING_WORK_END`
 * sozlamalari QOLDIRILDI: kelajakda kerak bo'lsa (masalan
 * tungi smena yo'q mehmonxona) qayta ulash uchun tayyor turadi.
 *
 * Boshlanish tugashdan katta bo'lsa (masalan 22 - 7, tungi
 * smena) oraliq yarim tundan o'tadi deb hisoblanadi.
 */
export async function isWorkingHours(now = new Date()): Promise<boolean> {
  const [start, end] = await Promise.all([
    getNumber(SETTING_KEYS.cleaningWorkStart, BUSINESS_DEFAULTS.cleaningWorkStart),
    getNumber(SETTING_KEYS.cleaningWorkEnd, BUSINESS_DEFAULTS.cleaningWorkEnd),
  ]);

  const hour = now.getHours();

  // Oddiy oraliq: 07:00 - 22:00
  if (start <= end) return hour >= start && hour < end;

  // Yarim tundan o'tuvchi oraliq: 22:00 - 07:00
  return hour >= start || hour < end;
}
