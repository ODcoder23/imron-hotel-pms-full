/**
 * Testlar uchun umumiy ma'lumot
 *
 * NEGA KERAK: testlar ilgari xona ID'lari ("107", "112") va
 * narxlarni ("pricePerNight: 35") qattiq yozgan edi. Loyiha
 * 12 xona / USD dan 18 xona / UZS ga o'tganda 200 dan ortiq test
 * yiqildi — kod xatosi tufayli emas, test ma'lumoti eskirgani
 * uchun.
 *
 * Bu yerdagi funksiyalar ma'lumotni BAZADAN oladi, shuning uchun
 * xona qo'shilsa yoki narx o'zgarsa testlar o'z-o'zidan moslashadi.
 *
 * ISHLATISH:
 *   const rooms = await realRooms();
 *   const price = await tariffFor(rooms[0]);
 */

// `127.0.0.1`, `localhost` EMAS: Node 18+ da `localhost` avval
// IPv6 (`::1`) ga hal bo'ladi, SSH tunnel esa IPv4 da tinglaydi
// (vitest.setup.ts dagi `ipv4()` izohiga qarang).
const BASE = (process.env.PMS_URL ?? "http://127.0.0.1:3000")
  .replace("//localhost:", "//127.0.0.1:");

type RoomInfo = { id: string; type: string; status: string };

/**
 * Kesh PROMISE saqlaydi, natijani emas.
 *
 * NEGA: parallel testlar bir vaqtda chaqirsa, natija keshi
 * bo'lganda har biri o'z so'rovini yuborardi (kesh hali bo'sh).
 * Promise keshlanganda birinchi chaqiruv so'rov yuboradi,
 * qolganlari o'sha promise'ni kutadi — bitta so'rov.
 */
let roomCache: Promise<RoomInfo[]> | null = null;
let priceCache: Promise<Map<string, number>> | null = null;

/** Bazadagi haqiqiy xonalar — birinchi chaqiruvda o'qiladi */
export function realRooms(): Promise<RoomInfo[]> {
  roomCache ??= (async () => {
    const res = await fetch(`${BASE}/api/rooms`);
    if (!res.ok) throw new Error(`Xonalarni o'qib bo'lmadi: ${res.status}`);
    return (await res.json()) as RoomInfo[];
  })();

  return roomCache;
}

/**
 * Xona turi bo'yicha tarif narxi.
 *
 * NEGA MUHIM: bron yaratishda narx tarifdan past bo'lsa, backend
 * chegirma sababini talab qiladi (SAVOLLAR.md S4). Test tarif
 * narxini ishlatsa, bu tekshiruvga urilmaydi.
 */
export function tariffPrices(): Promise<Map<string, number>> {
  priceCache ??= (async () => {
    const res = await fetch(`${BASE}/api/public/room-types`);
    if (!res.ok) throw new Error(`Tariflarni o'qib bo'lmadi: ${res.status}`);

    const types = (await res.json()) as Array<{ id: string; pricePerNight: number }>;
    return new Map(types.map((t) => [t.id, t.pricePerNight]));
  })();

  return priceCache;
}

/** Aniq bir xona uchun tarif narxi (bron yaratishda ishlatiladi) */
export async function tariffFor(roomId: string): Promise<number> {
  const rooms = await realRooms();
  const room = rooms.find((r) => r.id === roomId);
  if (!room) throw new Error(`Xona topilmadi: ${roomId}`);

  const prices = await tariffPrices();
  const price = prices.get(room.type);

  // Tarif yo'q bo'lsa 0 — backend bunday holatda narx
  // tekshiruvini o'tkazib yuboradi
  return price ?? 0;
}

/**
 * Test uchun N ta xona ID'si.
 *
 * Xonalar `sortOrder` bo'yicha keladi, shuning uchun har ishga
 * tushirishda bir xil tartib — test natijasi barqaror bo'ladi.
 */
export async function someRooms(count: number): Promise<string[]> {
  const rooms = await realRooms();
  if (rooms.length < count) {
    throw new Error(`Bazada ${count} ta xona yo'q (bor: ${rooms.length})`);
  }
  return rooms.slice(0, count).map((r) => r.id);
}

/**
 * Bazadagi haqiqiy xona turi ID'si.
 *
 * NEGA KERAK: testlar "standard", "double", "deluxe" deb yozgan
 * edi — bular 12 xonali eski tuzilishdan. Hozirgi turlar
 * "standard3", "comfort3", "famlux201" va hokazo.
 *
 * `index` — turlar ro'yxatidagi o'rin (sortOrder bo'yicha).
 */
export async function someType(index = 0): Promise<string> {
  const prices = await tariffPrices();
  const ids = [...prices.keys()];

  if (ids.length <= index) {
    throw new Error(`Bazada ${index + 1} ta xona turi yo'q (bor: ${ids.length})`);
  }
  return ids[index];
}

/**
 * Uchta ajratilgan xona turi — eski testlar uchun.
 *
 * NEGA: ko'p test uchta turni ishlatadi va ular BIR-BIRIGA
 * TEGMASLIGI kerak (biriga narx qo'yish ikkinchisiga ta'sir
 * qilmasin). Ilgari bu "standard", "double", "deluxe" deb
 * yozilardi — 12 xonali eski tuzilishdan qolgan nomlar.
 *
 * Endi bazadagi birinchi uchta tur olinadi: nomi o'zgarsa ham,
 * yangi tur qo'shilsa ham testlar ishlayveradi.
 *
 * `TYPES.a`, `TYPES.b`, `TYPES.c` — `loadTypes()` dan keyin
 * to'ladi.
 */
export const TYPES = { a: "", b: "", c: "" };

/** `beforeAll` da bir marta chaqiriladi */
export async function loadTypes(): Promise<typeof TYPES> {
  const prices = await tariffPrices();
  const ids = [...prices.keys()];

  if (ids.length < 3) {
    throw new Error(`Bazada 3 ta xona turi yo'q (bor: ${ids.length})`);
  }

  TYPES.a = ids[0];
  TYPES.b = ids[1];
  TYPES.c = ids[2];
  return TYPES;
}

/** Aniq bir xonaning turi */
export async function typeOf(roomId: string): Promise<string> {
  const rooms = await realRooms();
  const room = rooms.find((r) => r.id === roomId);
  if (!room) throw new Error(`Xona topilmadi: ${roomId}`);
  return room.type;
}

/** Bugundan N kun keyingi sana, "YYYY-MM-DD" */
export function day(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
