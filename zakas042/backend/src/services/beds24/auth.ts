/**
 * Beds24 autentifikatsiya — 03-BEDS24-API-INTEGRATSIYA.md §1
 *
 * Oqim:
 *   1. Panelda invite code yaratiladi (dasturchi qiladi, FAZA 15)
 *   2. GET /authentication/setup  (header: code) -> refreshToken
 *   3. GET /authentication/token  (header: refreshToken) -> access token
 *   4. Keyingi so'rovlarda header: token
 *
 * MUHIM (03-fayl §1): access token 24 soat amal qiladi va har so'rov
 * uchun yangisini olish TAQIQLANADI — bu kredit sarflaydi. Token
 * DB'da cache qilinadi va muddati tugashiga yaqin yangilanadi.
 *
 * Token'lar shifrlangan holda saqlanadi (TZ 18-band, 10-fayl §6).
 */

import { prisma } from "../../lib/prisma.js";
import { config } from "../../lib/config.js";
import { encrypt, decrypt } from "../../lib/encryption.js";

/** Muddati tugashiga shu vaqt qolganda yangilanadi (5 daqiqa zaxira) */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class Beds24AuthError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "Beds24AuthError";
  }
}

/**
 * Invite code'ni refreshToken'ga almashtiradi va DB'ga yozadi.
 * Bir marta bajariladi — `npm run beds24:connect` orqali.
 */
export async function setupConnection(
  inviteCode: string,
  propertyId: string
): Promise<{ channelId: string; propertyId: string }> {
  const res = await fetch(`${config.beds24.baseUrl}/authentication/setup`, {
    headers: { code: inviteCode },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Beds24AuthError(
      `Invite code qabul qilinmadi (${res.status}): ${text.slice(0, 120)}`,
      false
    );
  }

  const body = (await res.json()) as { token: string; refreshToken: string; expiresIn: number };

  const channel = await prisma.channel.upsert({
    where: { code: "beds24" },
    create: { code: "beds24", name: "Beds24", isActive: true },
    update: { isActive: true },
  });

  await prisma.channelConnection.upsert({
    where: { channelId_propertyId: { channelId: channel.id, propertyId } },
    create: {
      channelId: channel.id,
      propertyId,
      refreshToken: encrypt(body.refreshToken),
      accessToken: encrypt(body.token),
      accessTokenExpiresAt: new Date(Date.now() + body.expiresIn * 1000),
      isActive: true,
    },
    update: {
      refreshToken: encrypt(body.refreshToken),
      accessToken: encrypt(body.token),
      accessTokenExpiresAt: new Date(Date.now() + body.expiresIn * 1000),
      isActive: true,
    },
  });

  // Ulanish o'zgardi — room type keshi eskirdi (06-fayl §3).
  //
  // Aks holda yangi hisobga ulangandan keyin ham eski hisobning
  // xona turlari ko'rsatilardi va admin noto'g'ri mapping qo'yardi.
  const { invalidateRoomTypes } = await import("../channel/propertyCache.js");
  invalidateRoomTypes();

  return { channelId: channel.id, propertyId };
}

/**
 * Yaroqli access token qaytaradi.
 *
 * Cache'dagi token hali amal qilsa — o'shani beradi (kredit sarflanmaydi).
 * Muddati tugagan yoki tugashiga yaqin bo'lsa — refreshToken bilan
 * yangilaydi va DB'ga yozadi.
 */
export async function getAccessToken(): Promise<string> {
  const conn = await prisma.channelConnection.findFirst({
    where: { channel: { code: "beds24" }, isActive: true },
    orderBy: { createdAt: "desc" },
  });

  if (!conn) {
    throw new Beds24AuthError(
      "Beds24 ulanishi sozlanmagan. Ishga tushiring: npm run beds24:connect",
      false
    );
  }

  // Cache hali yaroqli?
  const expiresAt = conn.accessTokenExpiresAt?.getTime() ?? 0;
  if (conn.accessToken && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return decrypt(conn.accessToken);
  }

  // Yangilash
  const refreshToken = decrypt(conn.refreshToken);
  const res = await fetch(`${config.beds24.baseUrl}/authentication/token`, {
    headers: { refreshToken },
  });

  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 429;
    throw new Beds24AuthError(
      `Token yangilanmadi (${res.status}). ` +
      (retryable
        ? "Vaqtinchalik muammo, qayta urinib ko'riladi."
        : "refreshToken yaroqsiz — npm run beds24:connect qayta ishga tushirilishi kerak."),
      retryable
    );
  }

  const body = (await res.json()) as { token: string; expiresIn: number };

  await prisma.channelConnection.update({
    where: { id: conn.id },
    data: {
      accessToken: encrypt(body.token),
      accessTokenExpiresAt: new Date(Date.now() + body.expiresIn * 1000),
    },
  });

  console.log(`[beds24] token yangilandi, ${Math.round(body.expiresIn / 3600)} soat amal qiladi`);
  return body.token;
}

/** Cache'ni majburan bekor qilish — 401 kelganda */
export async function invalidateToken(): Promise<void> {
  await prisma.channelConnection.updateMany({
    where: { channel: { code: "beds24" } },
    data: { accessToken: null, accessTokenExpiresAt: null },
  });
}

/** Ulanish holati — Admin panel uchun (TZ 13-band: token chiqmaydi) */
export async function getConnectionStatus(): Promise<{
  isConnected: boolean;
  propertyId: string | null;
  tokenExpiresAt: string | null;
}> {
  const conn = await prisma.channelConnection.findFirst({
    where: { channel: { code: "beds24" }, isActive: true },
    orderBy: { createdAt: "desc" },
  });

  return {
    isConnected: conn !== null,
    propertyId: conn?.propertyId ?? null,
    tokenExpiresAt: conn?.accessTokenExpiresAt?.toISOString() ?? null,
  };
}
