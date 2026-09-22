/**
 * Credentials shifrlash — TZ 18-band
 *
 * Manba: 10-SECURITY-VA-SYNCLOG.md §6
 *
 * `refreshToken` va `accessToken` DB'da shifrlangan holda saqlanadi.
 * Kalit faqat `.env` da (`ENCRYPTION_KEY`), repoga kirmaydi.
 *
 * AES-256-GCM tanlandi: shifrlash + autentifikatsiya birga.
 * Ya'ni shifrlangan matn o'zgartirilsa, deshifrlash xato beradi
 * (oddiy CBC'da bu sezilmaydi).
 *
 * Format:  base64(iv) : base64(authTag) : base64(ciphertext)
 */

import crypto from "node:crypto";
import { config } from "./config.js";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;        // GCM uchun tavsiya etilgan
const KEY_LENGTH = 32;       // 256 bit

/** Kalitni bir marta tekshirib oladi */
function getKey(): Buffer {
  const hex = config.encryptionKey;

  if (!hex) {
    throw new Error(
      "ENCRYPTION_KEY yo'q. Yaratish: openssl rand -hex 32"
    );
  }

  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY ${KEY_LENGTH} bayt (64 hex belgi) bo'lishi kerak, ` +
      `hozir ${key.length} bayt`
    );
  }
  return key;
}

export function encrypt(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decrypt(payload: string): string {
  const key = getKey();
  const parts = payload.split(":");

  if (parts.length !== 3) {
    throw new Error("Shifrlangan qiymat formati noto'g'ri");
  }

  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Dev muhitida kalit yo'q bo'lsa ogohlantiradi.
 * Production'da `config.ts` serverni ko'tarmaydi.
 */
export function checkEncryptionKey(): void {
  try {
    const probe = "test";
    if (decrypt(encrypt(probe)) !== probe) {
      throw new Error("Shifrlash tekshiruvi muvaffaqiyatsiz");
    }
  } catch (e) {
    if (config.isDev) {
      console.warn(`[xavfsizlik] ENCRYPTION_KEY muammosi: ${(e as Error).message}`);
    } else {
      throw e;
    }
  }
}
