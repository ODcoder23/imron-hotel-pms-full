/**
 * Room type ro'yxati keshi — 03-fayl §8 (7-chora), 06-fayl §3
 *
 * MUAMMO: `GET /properties` har chaqiruvda ~5 kredit sarflaydi, kredit
 * esa 5 daqiqada 100 ta (03-fayl §3). Ro'yxat uch joydan chaqiriladi:
 * mapping sahifasi, admin ulanish holati, drift tekshiruvi. Kesh
 * bo'lmasa ular kreditni bekorga yeydi.
 *
 * 06-fayl §3: "Bu YAGONA JOY — boshqa hech qayerda `/properties`
 * chaqirilmaydi, natija cache qilinadi (kamdan-kam o'zgaradi)."
 *
 * TTL 10 daqiqa: Beds24'da yangi room type qo'shilsa admin
 * mapping sahifasini yangilaganda ko'radi. Darhol kerak bo'lsa
 * `invalidate()` bor (mapping sahifasidagi "Yangilash" tugmasi).
 */

import type { ExternalProperty } from "./types.js";
import { getChannel } from "./registry.js";

/**
 * Kesh muddati — `PROPERTY_CACHE_TTL_MS` bilan sozlanadi.
 *
 * Standart 10 daqiqa: ro'yxat kamdan-kam o'zgaradi va har chaqiruv
 * ~5 kredit sarflaydi (03-fayl §3).
 *
 * NOLGA QO'YISH testlarda kerak: ular mock holatini qayta-qayta
 * tozalaydi (`/control/reset`) va kesh eski javobni qaytarib
 * turardi. Kesh SERVER jarayonida yashaydi, shuning uchun
 * `NODE_ENV` bilan aniqlab bo'lmaydi — server dev rejimida
 * ishlaydi.
 */
const TTL_MS = Number(process.env.PROPERTY_CACHE_TTL_MS ?? 10 * 60_000);

type Entry = { at: number; data: ExternalProperty[] };

const cache = new Map<string, Entry>();

/**
 * Room type ro'yxatini qaytaradi — keshdan yoki kanaldan.
 *
 * `force: true` keshni chetlab o'tadi (admin "Yangilash" bosganda).
 */
export async function getRoomTypesCached(
  channelCode?: string,
  opts: { force?: boolean } = {}
): Promise<ExternalProperty[]> {
  const key = channelCode ?? "default";
  const hit = cache.get(key);

  if (!opts.force && hit && Date.now() - hit.at < TTL_MS) {
    return hit.data;
  }

  const data = await getChannel(channelCode).getRoomTypes();
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** Keshni tozalaydi — ulanish qayta sozlanganda chaqiriladi */
export function invalidateRoomTypes(channelCode?: string): void {
  if (channelCode) cache.delete(channelCode);
  else cache.clear();
}

/** Monitoring — kesh yangimi */
export function roomTypesCacheAge(channelCode?: string): number | null {
  const hit = cache.get(channelCode ?? "default");
  return hit ? Date.now() - hit.at : null;
}
