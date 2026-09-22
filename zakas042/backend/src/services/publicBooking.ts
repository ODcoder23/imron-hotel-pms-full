/**
 * Website public API — TZ 3, 20-band (FAZA 13)
 *
 * Manba: 13-WEBSITE-INTEGRATSIYA.md §2–§5
 *
 * ISH CHEGARASI (13-fayl §8): Customer Website kodiga kirish yo'q.
 * Shu fayldagi API to'liq yoziladi va test qilinadi, Website'ni
 * unga ulash ishi scope'dan tashqarida — kontrakt topshiriladi.
 *
 * ASOSIY OQIM (TZ 3-band):
 *   Website -> PMS -> Database -> Shaxmatka -> Beds24 -> OTA
 * va "Bron qilingan xona boshqa kanallarda mavjud bo'lmagan holatga
 * o'tishi kerak. OVERBOOKING BO'LMASLIGI SHART."
 *
 * Overbooking himoyasi shu yerda qayta yozilmaydi: bron
 * `createReservation` orqali yaratiladi, u esa `EXCLUDE USING gist`
 * constraint'i bilan himoyalangan (07-fayl §5). Website ham,
 * Shaxmatka ham, OTA ham bitta to'siqdan o'tadi.
 */

import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { fromDateKey, toDateKey, toNumber } from "../lib/serialize.js";
import { ValidationError, RoomUnavailableError } from "../lib/errors.js";
import { createReservation } from "./reservations.js";
import { readRange } from "./availability.js";
import { config } from "../lib/config.js";
import { getMealPrice } from "./settings.js";

// ============================================================
//  1. Bron kodi
// ============================================================

/**
 * Mehmonga ko'rsatiladigan kod — "IMR-8F3K2" (13-fayl §6).
 *
 * TAXMIN QILIB BO'LMAYDI: ketma-ket emas, `crypto.randomInt` bilan
 * yasaladi. Aks holda mijoz o'z kodini bir ko'targan holda boshqa
 * mehmonlarning bronini ko'ra olardi.
 *
 * Chalkashadigan belgilar (0/O, 1/I) alifbodan chiqarilgan —
 * mijoz kodni telefon orqali aytishi mumkin.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generateCode(): string {
  let out = "";
  for (let i = 0; i < 5; i++) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return `IMR-${out}`;
}

/** To'qnashuv bo'lsa qayta urinadi — 32^5 ≈ 33 mln variant */
async function uniqueCode(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = generateCode();
    const exists = await prisma.reservation.findUnique({ where: { code } });
    if (!exists) return code;
  }
  throw new Error("Bron kodi yaratib bo'lmadi");
}

// ============================================================
//  2. Bo'sh xonalarni qidirish (13-fayl §2)
// ============================================================

export type AvailabilityQuery = {
  from: string;
  to: string;
  adults?: number;
  children?: number;
};

export type PublicRoomType = {
  id: string;
  label: string;
  availableCount: number;
  pricePerNight: number;
  /** Xona narxi x kecha (nonushtasiz) */
  roomTotal: number;
  /** Nonushta: narx x kishi x kecha */
  mealTotal: number;
  /** Kishi boshiga nonushta narxi — saytda ko'rsatish uchun */
  mealPricePerPerson: number;
  /** roomTotal + mealTotal — mehmon shuni to'laydi */
  totalPrice: number;
  currency: string;
  maxAdults: number;
};

/**
 * Sanalarni tekshiradi (13-fayl §6).
 *
 * O'tmishga bron qilib bo'lmaydi, bir yildan uzoqqa ham —
 * ikkalasi ham noto'g'ri ma'lumot yoki hujum belgisi.
 */
export function validateRange(fromKey: string, toKey: string): { from: Date; to: Date; nights: number } {
  const from = fromDateKey(fromKey);
  const to = fromDateKey(toKey);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ValidationError("Sana formati noto'g'ri (YYYY-MM-DD)");
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  if (from < today) throw new ValidationError("O'tmishdagi sanaga bron qilib bo'lmaydi");
  if (to <= from) throw new ValidationError("Chiqish sanasi kirish sanasidan keyin bo'lishi kerak");

  const nights = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (nights > 365) throw new ValidationError("Maksimal muddat — 365 kecha");

  const maxAhead = new Date(today);
  maxAhead.setUTCFullYear(maxAhead.getUTCFullYear() + 1);
  if (from > maxAhead) throw new ValidationError("Bir yildan uzoqqa bron qilib bo'lmaydi");

  return { from, to, nights };
}

/**
 * Sayt "Xonalar" bo'limi uchun tarif ro'yxati.
 *
 * `searchAvailability` dan farqi: sana kerak emas. Sayt xonalarni
 * mehmon sana tanlashidan OLDIN ham ko'rsatadi, shuning uchun bu
 * yerda bandlik hisoblanmaydi — faqat tarif, narx va sig'im.
 *
 * Narx: bugundan boshlab birinchi topilgan `RatePlan` qiymati
 * ("dan boshlab" narx). Narx belgilanmagan tur ham ko'rsatiladi,
 * lekin `pricePerNight: 0` bilan — sayt uni "narx so'rang" deb
 * chiqarishi mumkin. Bu `searchAvailability` dan ataylab farq
 * qiladi: u yerda narxsiz turni sotib bo'lmaydi, bu yerda esa
 * shunchaki vitrina.
 */
export async function listRoomTypes() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  /**
   * IKKI SO'ROV, tur soniga bog'liq emas.
   *
   * Ilgari halqa ichida har tur uchun alohida `ratePlan`
   * so'rovi ketardi (N+1). 9 tur = 10 so'rov, tunnel orqali
   * ~7 soniya. Endi hamma narx bir so'rovda olinadi.
   */
  const [types, plans] = await Promise.all([
    prisma.roomType.findMany({
      where: { showOnSite: true },
      orderBy: { sortOrder: "asc" },
      include: { _count: { select: { rooms: true } } },
    }),

    // Bugundan boshlab har tur uchun eng yaqin narx
    prisma.ratePlan.findMany({
      where: { date: { gte: today } },
      orderBy: { date: "asc" },
      select: { roomTypeId: true, price: true, date: true },
    }),
  ]);

  // Har tur uchun eng birinchi (eng yaqin) narx
  const priceOf = new Map<string, number>();
  for (const p of plans) {
    if (!priceOf.has(p.roomTypeId)) {
      priceOf.set(p.roomTypeId, toNumber(p.price));
    }
  }

  return types
    // Faol xonasi yo'q tur saytda ko'rsatilmaydi
    .filter((t) => t._count.rooms > 0)
    .map((t) => ({
      id: t.id,
      label: t.label,
      pricePerNight: priceOf.get(t.id) ?? 0,
      currency: "UZS",
      maxAdults: t.maxAdults,
      roomCount: t._count.rooms,

      // Sayt bu maydonlarni kutadi (index.html: loadRooms)
      description: t.description ?? "",
      image: t.imageUrl ?? null,
      gallery: Array.isArray(t.gallery) ? t.gallery : [],
      amenities: Array.isArray(t.amenities) ? t.amenities : [],
    }));
}

/**
 * Oraliqdagi bo'sh xonalarni tur bo'yicha qaytaradi.
 *
 * `availableCount` — butun oraliq bo'yicha MINIMAL qiymat
 * (13-fayl §2). Agar 15-da 3 ta, 17-da 1 ta bo'sh bo'lsa, 5 kunlik
 * bron uchun javob 1 bo'ladi: mehmon bron qilmoqchi bo'lganda xato
 * chiqmasligi uchun.
 */
export async function searchAvailability(q: AvailabilityQuery) {
  const { from, to, nights } = validateRange(q.from, q.to);
  const adults = q.adults ?? 1;
  const children = q.children ?? 0;

  if (adults < 1 || adults > 20) throw new ValidationError("Kattalar soni 1–20 orasida");

  /**
   * Nonushta narxi (BOTLAR-REJA.md, 2026-09-17).
   *
   * Saytdan kelgan bron HAR DOIM ovqat tarifi bilan. Narx
   * qidiruv paytida qo'shiladi — mehmon to'liq summani darhol
   * ko'rsin, tasdiqlashda kutilmagan qo'shimcha chiqmasin.
   */
  const guests = adults + children;
  const mealPrice = await getMealPrice();

  const types = await prisma.roomType.findMany({ orderBy: { sortOrder: "asc" } });

  const result: PublicRoomType[] = [];

  for (const type of types) {
    // Sig'imi yetmaydigan tur ko'rsatilmaydi
    if (adults > type.maxAdults) continue;

    const days = await readRange(type.id, from, to);

    // Oraliqda hech bo'lmasa bitta kun hisoblanmagan bo'lsa —
    // uni nol deb hisoblaymiz emas, qayta hisoblash kerak.
    // Lekin `recalcAvailability` public yo'ldan chaqirilmaydi
    // (qimmat), shuning uchun yetishmagan kunlarni to'g'ridan-
    // to'g'ri bronlardan sanaymiz.
    const availableCount =
      days.length === nights
        ? Math.min(...days.map((d) => d.availableCount))
        : await countFreeRooms(type.id, from, to);

    const price = await averagePrice(type.id, from, to);

    // Narx belgilanmagan turni sotib bo'lmaydi — mijozga "0 so'm"
    // ko'rsatish va keyin haqiqiy narx aytish yomon tajriba.
    // Admin narxni Narxlar panelida belgilamaguncha tur
    // ko'rsatilmaydi (07-fayl §8, Q8).
    if (price <= 0) continue;

    result.push({
      id: type.id,
      label: type.label,
      availableCount: Math.max(0, availableCount),
      pricePerNight: price,
      roomTotal: Math.round(price * nights),
      mealTotal: Math.round(mealPrice * guests * nights),
      mealPricePerPerson: mealPrice,
      // Saytdan kelgan bron HAR DOIM ovqat tarifi bilan
      // (BOTLAR-REJA.md, 2026-09-17) — narx darhol to'liq
      // ko'rsatiladi, tasdiqlashda kutilmagan qo'shimcha
      // chiqmasin.
      totalPrice: Math.round(price * nights + mealPrice * guests * nights),
      currency: "UZS",
      maxAdults: type.maxAdults,
    });
  }

  return { from: q.from, to: q.to, nights, roomTypes: result };
}

/**
 * Butun oraliqda BO'SH turgan xonalar soni.
 *
 * `Availability` jadvalida kun yetishmasa ishlatiladi. Bitta SQL:
 * shu turdagi faol xonalardan oraliqqa kesishuvchi broni
 * bo'lmaganlari sanaladi.
 */
async function countFreeRooms(roomTypeId: string, from: Date, to: Date): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ cnt: number }>>`
    SELECT COUNT(*)::int AS cnt
    FROM "Room" r
    WHERE r."roomTypeId" = ${roomTypeId}
      AND r."isActive" = true
      AND r.status NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
      AND NOT EXISTS (
        SELECT 1 FROM "Reservation" res
        WHERE res."roomId" = r.id
          AND res.status NOT IN ('CANCELLED', 'NO_SHOW')
          AND res."checkIn" < ${to}
          AND res."checkOut" > ${from}
      )
      -- Ta'mir/xizmatdan chiqarilgan kunlar (2026-09-16 qo'shildi).
      -- Busiz yopiq xona saytda sotuvda qolardi: kesh yo'li buni
      -- hisobga olardi, bu zaxira yo'l esa yo'q.
      AND NOT EXISTS (
        SELECT 1 FROM "RoomDayStatus" rds
        WHERE rds."roomId" = r.id
          AND rds."isBlocked" = true
          AND rds.date >= ${from}
          AND rds.date < ${to}
      )
  `;
  return rows[0]?.cnt ?? 0;
}

/** Oraliqdagi o'rtacha narx — `RatePlan` dan */
async function averagePrice(roomTypeId: string, from: Date, to: Date): Promise<number> {
  const plans = await prisma.ratePlan.findMany({
    where: { roomTypeId, date: { gte: from, lt: to } },
    select: { price: true },
  });

  if (plans.length === 0) return 0;    // narx belgilanmagan
  const sum = plans.reduce((n, p) => n + toNumber(p.price), 0);
  return Math.round((sum / plans.length) * 100) / 100;
}

// ============================================================
//  3. Xona avtomatik tanlash (13-fayl §3)
// ============================================================

/**
 * Turdan aniq xona tanlaydi.
 *
 * Mehmon TURNI tanlaydi, tizim ANIQ XONANI biriktiradi — Beds24'dan
 * kelgan bron mantig'i bilan bir xil (06-fayl §5).
 *
 * FRAGMENTATSIYA (13-fayl §3): har doim birinchi bo'sh xonani berish
 * 5 ta xonani 5 ta yarim-band xonaga aylantiradi. Shuning uchun
 * qo'shni band kunlari bor xonalar afzal — bu uzluksiz bo'shliqlarni
 * saqlaydi va uzoq bronlar uchun joy qoldiradi.
 *
 * `skip` — urinib ko'rilgan va band chiqqan xonalar (2026-09-17).
 * Parallel so'rovlar bir vaqtda kelganda hammasi bir xil xonani
 * tanlardi: eng yaxshi xona bittagina, `LIMIT 1` uni hammaga
 * berardi. Birinchisi yozib ulgurgach qolganlari "band" xatosini
 * olardi — garchi o'sha turda boshqa bo'sh xonalar turgan bo'lsa
 * ham. `createPublicBooking` band chiqqan xonani `skip` ga qo'shib
 * qayta chaqiradi, shunda navbatdagi eng yaxshi xona tanlanadi.
 */
export async function pickRoom(
  roomTypeId: string,
  from: Date,
  to: Date,
  skip: string[] = []
): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; neighbours: number }>>`
    SELECT
      r.id,
      -- Oraliqqa TEGIB turgan bronlar soni: checkOut = from yoki
      -- checkIn = to. Ular ko'p bo'lsa xona allaqachon "ishlatilgan",
      -- unga qo'shish bo'shliqni parchalamaydi.
      (
        SELECT COUNT(*)::int FROM "Reservation" res
        WHERE res."roomId" = r.id
          AND res.status NOT IN ('CANCELLED', 'NO_SHOW')
          AND (res."checkOut" = ${from}::date OR res."checkIn" = ${to}::date)
      ) AS neighbours
    FROM "Room" r
    WHERE r."roomTypeId" = ${roomTypeId}
      AND r."isActive" = true
      AND r.status NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
      -- Parallel so'rovda band chiqqan xonalar (skip)
      AND NOT (r.id = ANY(${skip}::text[]))
      AND NOT EXISTS (
        SELECT 1 FROM "Reservation" res
        WHERE res."roomId" = r.id
          AND res.status NOT IN ('CANCELLED', 'NO_SHOW')
          AND res."checkIn" < ${to}::date
          AND res."checkOut" > ${from}::date
      )
      -- Yopiq kunlar (2026-09-16 qo'shildi): tizim ta'mirdagi
      -- xonani avtomatik tanlab qo'ymasligi uchun
      AND NOT EXISTS (
        SELECT 1 FROM "RoomDayStatus" rds
        WHERE rds."roomId" = r.id
          AND rds."isBlocked" = true
          AND rds.date >= ${from}::date
          AND rds.date < ${to}::date
      )
    ORDER BY neighbours DESC, r."sortOrder" ASC, r.id ASC
    LIMIT 1
  `;

  return rows[0]?.id ?? null;
}

// ============================================================
//  4. Bron yaratish (13-fayl §2, §5)
// ============================================================

export type PublicBookingInput = {
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children?: number;
  /**
   * E'TIBORGA OLINMAYDI (2026-09-17): saytdan kelgan bron
   * har doim ovqat bilan. Maydon kontraktni buzmaslik uchun
   * qoldirilgan — eski sayt versiyasi yuborsa xato bermaydi.
   */
  withMeal?: boolean;
  guest: { fullName: string; phone: string; email?: string };
  notes?: string;
};

export type PublicBookingResult = {
  reservationCode: string;
  roomNumber: string;
  status: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  /** Nonushta — saytdan kelgan bronda har doim `true` */
  withMeal: boolean;
  /** Xona narxi x kecha */
  roomTotal: number;
  /** Nonushta: narx x kishi x kecha */
  mealTotal: number;
  /** roomTotal + mealTotal */
  totalPrice: number;
  currency: string;
};

/**
 * Website'dan bron yaratadi.
 *
 * STATUS `PENDING_PAYMENT` (13-fayl §5): mijoz hali to'lamagan.
 * Lekin xona SHU ZAHOTI band hisoblanadi va availability'dan
 * chiqariladi — aks holda ikki mijoz bir xonani "to'lovni
 * kutayotgan" holatda band qilib qo'yardi.
 *
 * Availability va Beds24 sync `createReservation` ichida avtomatik
 * ishga tushadi (FAZA 9, 10) — bu yerda qayta chaqirilmaydi.
 */
export async function createPublicBooking(
  input: PublicBookingInput
): Promise<PublicBookingResult> {
  const { from, to, nights } = validateRange(input.checkIn, input.checkOut);

  const fullName = input.guest.fullName.trim();
  if (fullName.length < 2 || fullName.length > 100) {
    throw new ValidationError("Ism 2–100 belgi orasida bo'lishi kerak");
  }

  const phone = input.guest.phone.trim();
  if (phone.length < 7 || phone.length > 20) {
    throw new ValidationError("Telefon raqami noto'g'ri");
  }

  const type = await prisma.roomType.findUnique({ where: { id: input.roomTypeId } });
  if (!type) throw new ValidationError("Bunday xona turi yo'q");

  if (input.adults > type.maxAdults) {
    throw new ValidationError(`Bu turda maksimal ${type.maxAdults} kattalar`);
  }

  // --- Spam himoyasi (13-fayl §6) ---
  // Bir telefon raqamiga 24 soatda 3 ta faol to'lanmagan bron
  await checkSpam(phone);

  const price = await averagePrice(input.roomTypeId, from, to);
  if (price <= 0) {
    // Narxsiz bron — keyinroq mijoz bilan tortishuv chiqadi
    throw new ValidationError(
      "Bu sanalarda narx hali belgilanmagan. Iltimos, biz bilan bog'laning."
    );
  }

  const code = await uniqueCode();

  /**
   * XONA TANLASH + BRON — qayta urinish bilan (2026-09-17).
   *
   * `pickRoom` tranzaksiyadan tashqarida ishlaydi, shuning uchun
   * parallel so'rovlar bir xil xonani olishi mumkin. Ilgari
   * birinchisidan keyingilari darhol "band" xatosini olardi:
   * jonli sinovda 3 bo'sh xonaga 6 parallel so'rov yuborilganda
   * faqat BITTASI o'tdi, 5 mijoz rad javobini oldi va 2 xona
   * bo'sh qoldi. Bu overbooking emas, uning teskarisi —
   * sotilmay qolgan xona.
   *
   * Endi band chiqqan xona `taken` ga qo'shiladi va navbatdagi
   * eng yaxshi xona tanlanadi. Urinishlar soni turdagi xona
   * sonidan oshmaydi, chunki har urinishda ro'yxat qisqaradi.
   *
   * Faqat "xona band" xatolari qayta urinishga sabab bo'ladi;
   * boshqa xatolar (narx, validatsiya) darhol yuqoriga chiqadi.
   */
  const taken: string[] = [];
  const MAX_ROOM_ATTEMPTS = 10;

  let reservation: Awaited<ReturnType<typeof createReservation>> | null = null;
  let roomId = "";

  for (let attempt = 0; attempt < MAX_ROOM_ATTEMPTS; attempt++) {
    const candidate = await pickRoom(input.roomTypeId, from, to, taken);
    if (!candidate) break;          // boshqa bo'sh xona yo'q

    try {
      reservation = await createReservation({
        roomId: candidate,
        guestName: fullName,
        phone,
        email: input.guest.email?.trim(),
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        adults: input.adults,
        children: input.children ?? 0,
        /**
         * SAYTDAN KELGAN BRON HAR DOIM OVQAT BILAN
         * (BOTLAR-REJA.md, 2026-09-17).
         *
         * Ilgari `input.withMeal ?? false` edi va sayt bu
         * maydonni yubormagani uchun bron OVQATSIZ yaratilardi.
         * Natijada mehmon qidiruvda bir summa ko'rib, bron
         * qilganda boshqasini olardi:
         *
         *   qidiruv:  1 050 000 (nonushta 150 000 bilan)
         *   bron:       900 000 (nonushtasiz)
         *
         * Oshxona hisoboti ham bo'sh qolardi — `withMeal = true`
         * bronlar umuman yo'q edi.
         *
         * Qabulxona (`/api/reservations`) va OTA boshqacha:
         * u yerda tanlov bor, shuning uchun bu qoida faqat
         * shu funksiyada.
         *
         * Nonushta narxi `createReservation` ichida sozlamadan
         * olinadi va bronga ko'chiriladi (SAVOLLAR.md S10).
         */
        withMeal: true,
        source: "website",
        pricePerNight: price,
        notes: input.notes?.slice(0, 500),
        status: "pending_payment",
      });
      roomId = candidate;
      break;
    } catch (e) {
      // Xona oradagi vaqtda band bo'lib qoldi — keyingisiga
      // o'tamiz. Ikki ko'rinishi bor:
      //   `RoomUnavailableError` — `isRoomFree` tekshiruvi (2-qatlam)
      //   `23P01` — DB constraint'i (1-qatlam). Servis darajasida u
      //             hali xom Prisma xatosi: `translatePrismaError`
      //             faqat `errorHandler` ichida chaqiriladi.
      // Qolgan xatolar chaqiruvchiga qaytadi.
      // `String(e)` yetarli emas: `PrismaClientUnknownRequestError`
      // ning `toString()` faqat sinf nomini beradi, constraint nomi
      // esa `message` ichida qoladi. Ikkalasi ham qaraladi.
      const raw = `${String(e)} ${e instanceof Error ? e.message : ""}`;
      const busy =
        e instanceof RoomUnavailableError ||
        raw.includes("reservation_no_overlap") ||
        raw.includes("23P01");

      if (busy) {
        taken.push(candidate);
        continue;
      }
      throw e;
    }
  }

  if (!reservation) {
    throw new RoomUnavailableError(
      "Afsuski, tanlangan sanalarda bo'sh xona qolmadi. Boshqa sanalarni tanlang."
    );
  }

  // Kodni yozamiz — `createReservation` uni bilmaydi
  await prisma.reservation.update({ where: { id: reservation.id }, data: { code } });

  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });

  /**
   * Nonushta jami summaga kiradi (BOTLAR-REJA.md).
   *
   * Narx BRONDAN olinadi — `createReservation` uni sozlamadan
   * o'qib ko'chirgan. Qidiruv natijasi bilan bir xil bo'lishi
   * shart, aks holda mehmon boshqa summa ko'rardi.
   */
  const guests = input.adults + (input.children ?? 0);
  const mealPrice = reservation.mealPricePerPerson
    ? toNumber(reservation.mealPricePerPerson)
    : 0;
  const mealTotal = reservation.withMeal ? mealPrice * guests * nights : 0;

  return {
    reservationCode: code,
    roomNumber: room.number,
    status: "pending_payment",
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    adults: input.adults,
    children: input.children ?? 0,
    withMeal: reservation.withMeal,
    roomTotal: Math.round(price * nights),
    mealTotal,
    totalPrice: Math.round(price * nights + mealTotal),
    currency: "UZS",
  };
}

/**
 * Bir telefon raqamiga ko'p to'lanmagan bron (13-fayl §6).
 *
 * Cheklovsiz bo'lsa bitta bot butun mehmonxonani "to'lov kutilmoqda"
 * holatida band qilib qo'yishi mumkin — real sotuv to'xtaydi.
 */
async function checkSpam(phone: string): Promise<void> {
  const since = new Date(Date.now() - 24 * 3600_000);

  const count = await prisma.reservation.count({
    where: {
      guest: { phone },
      status: "PENDING_PAYMENT",
      createdAt: { gte: since },
    },
  });

  if (count >= 3) {
    throw new ValidationError(
      "Bu raqamda tasdiqlanmagan bronlar bor. Iltimos, avvalgilarini to'lang yoki biz bilan bog'laning."
    );
  }
}

// ============================================================
//  5. Bronni kod bilan tekshirish (13-fayl §2)
// ============================================================

/**
 * Mijoz o'z bronini kod bilan ko'radi.
 *
 * JAVOBDA BOSHQA MEHMONLAR MA'LUMOTI YO'Q (13-fayl §6). Faqat shu
 * bronning o'zi va faqat mijozga kerakli maydonlar — ichki id,
 * Beds24 bookingId, sync holati berilmaydi.
 */
export async function findByCode(code: string) {
  const reservation = await prisma.reservation.findUnique({
    where: { code: code.trim().toUpperCase() },
    include: { guest: true, room: { include: { roomType: true } }, payments: true },
  });

  if (!reservation) return null;

  const nights = Math.round(
    (reservation.checkOut.getTime() - reservation.checkIn.getTime()) / 86_400_000
  );
  /**
   * Nonushta jami summaga kiradi (SAVOLLAR.md S10).
   *
   * Narx BRONDAN olinadi — bron yaratilganda ko'chirilgan.
   * Keyin sozlamada narx ko'tarilsa, mehmon kelishilgandan
   * ko'p to'lamaydi.
   */
  const guests = reservation.adults + reservation.children;
  const mealPrice = reservation.mealPricePerPerson
    ? toNumber(reservation.mealPricePerPerson)
    : 0;
  const mealTotal = reservation.withMeal ? mealPrice * guests * nights : 0;

  const total = toNumber(reservation.pricePerNight) * nights + mealTotal;
  const paid = reservation.payments.reduce((n, p) => n + toNumber(p.amount), 0);

  return {
    reservationCode: reservation.code,
    status: reservation.status.toLowerCase(),
    checkIn: toDateKey(reservation.checkIn),
    checkOut: toDateKey(reservation.checkOut),
    nights,
    roomNumber: reservation.room.number,
    roomType: reservation.room.roomType.label,
    adults: reservation.adults,
    children: reservation.children,
    guestName: reservation.guest.fullName,
    // Mehmon nima uchun to'laganini ko'rsin
    withMeal: reservation.withMeal,
    mealTotal,
    totalPrice: total,
    paidAmount: paid,
    remainingAmount: Math.max(total - paid, 0),
    currency: reservation.currency,
  };
}

// ============================================================
//  6. To'lanmagan bronni avtomatik bekor qilish (13-fayl §5)
// ============================================================

export type ExpireResult = {
  checked: number;
  cancelled: number;
  codes: string[];
};

/**
 * Muddati o'tgan `PENDING_PAYMENT` bronlarni bekor qiladi.
 *
 * NEGA KERAK: to'lanmagan bron abadiy band qilib tursa, real sotuv
 * yo'qoladi. Bu TZ'da to'g'ridan-to'g'ri yozilmagan, lekin 3-bandning
 * teskari tomoni (13-fayl §5).
 *
 * `cancelReservation` chaqiriladi — u availability'ni qayta
 * hisoblaydi va Beds24'ga yuboradi, ya'ni xona OTA'da darhol
 * qayta sotuvga chiqadi.
 */
export async function expireUnpaidBookings(): Promise<ExpireResult> {
  const { cancelReservation } = await import("./reservations.js");

  const cutoff = new Date(Date.now() - config.pendingPaymentTimeoutHours * 3600_000);

  const stale = await prisma.reservation.findMany({
    where: {
      status: "PENDING_PAYMENT",
      createdAt: { lt: cutoff },
      // Faqat kelajakdagi bronlar — o'tmishdagilarni tegmaymiz,
      // ular tarix
      checkOut: { gte: new Date() },
    },
    select: { id: true, code: true },
    take: 100,
  });

  const codes: string[] = [];

  for (const r of stale) {
    try {
      await cancelReservation(r.id);
      codes.push(r.code ?? r.id);
    } catch (e) {
      console.warn(`[public] bekor qilinmadi ${r.id}: ${String(e).slice(0, 100)}`);
    }
  }

  return { checked: stale.length, cancelled: codes.length, codes };
}
