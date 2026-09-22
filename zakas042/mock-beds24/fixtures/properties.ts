/**
 * GET /properties javobi
 *
 * HAQIQIY TUZILMA (2026-09-17 da yangilandi): 9 room type, 18 xona.
 *
 * Ilgari bu yerda 3 tur / 12 xona turardi (`standard` 6,
 * `double` 4, `deluxe` 2) — FAZA 0.5 dagi taxmin. PMS 2026-09-16
 * da 18 xona / 9 tarifga o'tganda mock qoldirilgan edi va
 * natijada:
 *
 *   - 9 tarifdan 6 tasini umuman bog'lab bo'lmasdi (Beds24
 *     tomonida mos tur yo'q edi)
 *   - bog'langan 2 tasida xona soni mos kelmasdi
 *     ("PMS'da 1 xona, Beds24'da 6")
 *   - navbatlarda 1113 ta yiqilgan availability-sync to'plandi:
 *     `mapping topilmadi: premium4`
 *
 * Endi har PMS tarifiga bitta Beds24 room type to'g'ri keladi —
 * mapping 1:1, `qty` PMS'dagi xona soniga teng.
 *
 * ID sxemasi: 101001–101009, PMS tariflari tartibida
 * (`prisma/seed.ts` dagi `sortOrder`).
 *
 * `maxAdult` PMS'dagi `RoomType.maxAdults` bilan bir xil —
 * mos kelmasa sayt qidiruvi va Beds24 turli natija berardi.
 *
 * Dasturchi real hisobga ulangach bu qiymatlar farq qilsa —
 * faqat shu fayl o'zgaradi, kod emas.
 */

export const properties = [
  {
    id: 12345,
    name: "Imron Hotel",
    propertyType: "hotel",
    // PMS 2026-09-16 da UZS ga o'tdi (HOLAT.md) — mock ham
    // shunday bo'lishi kerak, aks holda narx tekshiruvlari
    // boshqa valyutani solishtirardi.
    currency: "UZS",
    country: "UZ",
    city: "Toshkent",
    roomTypes: [
      {
        id: 101001,
        name: "Standart 3 kishilik",
        qty: 1,                    // PMS: 102
        maxPeople: 3,
        maxAdult: 3,
        maxChildren: 1,
        // unit-level mapping bo'lsa shu ro'yxat to'ldiriladi.
        // Hozircha bo'sh — room-type darajasi taxmin qilingan.
        units: [],
      },
      {
        id: 101002,
        name: "Komfort 3 kishilik",
        qty: 3,                    // PMS: 101, 202, 302
        maxPeople: 3,
        maxAdult: 3,
        maxChildren: 1,
        units: [],
      },
      {
        id: 101003,
        name: "Oilaviy yarim lyuks",
        qty: 2,                    // PMS: 105, 305
        maxPeople: 3,
        maxAdult: 3,
        maxChildren: 2,
        units: [],
      },
      {
        id: 101004,
        name: "Komfort 4 kishilik",
        qty: 2,                    // PMS: 103, 304
        maxPeople: 4,
        maxAdult: 4,
        maxChildren: 2,
        units: [],
      },
      {
        id: 101005,
        name: "Premium 4 kishilik",
        qty: 4,                    // PMS: 104, 203, 204, 303
        maxPeople: 4,
        maxAdult: 4,
        maxChildren: 2,
        units: [],
      },
      {
        id: 101006,
        name: "Delyuks 4 kishilik",
        qty: 3,                    // PMS: 106, 206, 306
        maxPeople: 4,
        maxAdult: 4,
        maxChildren: 2,
        units: [],
      },
      {
        id: 101007,
        name: "Oilaviy Delyuks",
        qty: 1,                    // PMS: 205
        maxPeople: 3,
        maxAdult: 3,
        maxChildren: 2,
        units: [],
      },
      {
        id: 101008,
        name: "Oilaviy lyuks balkonli 201",
        qty: 1,                    // PMS: 201
        maxPeople: 4,
        maxAdult: 4,
        maxChildren: 2,
        units: [],
      },
      {
        id: 101009,
        name: "Oilaviy lyuks balkonli 301",
        qty: 1,                    // PMS: 301
        maxPeople: 3,
        maxAdult: 3,
        maxChildren: 2,
        units: [],
      },
    ],
  },
];

/**
 * PMS room type -> Beds24 roomId (mapping ekranida tanlanadigan
 * qiymatlar).
 *
 * Kalitlar PMS `RoomType.id` bilan AYNAN bir xil — shunda
 * avtomatik mapping (`POST /api/admin/mapping/auto`) nom
 * taxmin qilmasdan ishlaydi.
 *
 * Eski `standard`/`double`/`deluxe` kalitlari saqlanadi: mock
 * testlari va `server.ts` dagi standart qiymatlar ularga
 * ishora qiladi. Ular endi yangi ID'larga qaraydi.
 */
export const ROOM_TYPE_IDS = {
  standard3: 101001,
  comfort3:  101002,
  semilux:   101003,
  comfort4:  101004,
  premium4:  101005,
  deluxe4:   101006,
  famdeluxe: 101007,
  famlux201: 101008,
  famlux301: 101009,

  // Eski nomlar — moslik uchun (mock.test.ts, server.ts)
  standard: 101001,
  double:   101002,
  deluxe:   101003,
} as const;
