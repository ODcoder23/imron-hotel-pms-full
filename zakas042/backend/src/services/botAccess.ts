/**
 * Telegram botlariga ruxsatlarni boshqarish xizmati
 *
 * Founder va Oshxona botlariga xodimlarni Telegram ID yoki
 * Telegram username (@username) orqali biriktirish, tahrirlash
 * va avtomatik tanib olish (auto-binding).
 */

import type { BotAccess, BotAccessLevel } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ValidationError, NotFoundError } from "../lib/errors.js";

/** Username'ni tozalash: "@" olib tashlanadi va kichik harfga o'tkaziladi */
export function cleanUsername(u: string | null | undefined): string | null {
  if (!u) return null;
  const cleaned = u.trim().replace(/^@+/, "").toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

/** Telegram ID'ni tozalash: faqat raqamlar */
export function cleanTelegramId(id: string | number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  return s.length > 0 ? s : null;
}

export type CreateBotAccessInput = {
  botType?: "FOUNDER" | "KITCHEN";
  telegramId?: string | number | null;
  username?: string | null;
  label: string;
  level?: BotAccessLevel;
  createdById?: string;
};

export type UpdateBotAccessInput = {
  botType?: "FOUNDER" | "KITCHEN";
  telegramId?: string | number | null;
  username?: string | null;
  label?: string;
  level?: BotAccessLevel;
  isActive?: boolean;
};

/**
 * Barcha ruxsatlar ro'yxati.
 */
export async function listBotAccess(botType?: string): Promise<BotAccess[]> {
  return prisma.botAccess.findMany({
    where: botType ? { botType } : undefined,
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Yangi ruxsat qo'shish.
 */
export async function createBotAccess(input: CreateBotAccessInput): Promise<BotAccess> {
  const botType = input.botType === "KITCHEN" ? "KITCHEN" : "FOUNDER";
  const label = input.label?.trim();
  if (!label) {
    throw new ValidationError("Ism yoki izoh kiritilishi shart");
  }

  const tgId = cleanTelegramId(input.telegramId);
  const uname = cleanUsername(input.username);

  if (!tgId && !uname) {
    throw new ValidationError("Telegram ID yoki @username dan kamida biri kiritilishi shart");
  }

  // Takrorlanishni tekshirish
  if (tgId) {
    const existing = await prisma.botAccess.findFirst({
      where: { botType, telegramId: tgId },
    });
    if (existing) {
      throw new ValidationError(`Ushbu Telegram ID (${tgId}) allaqachon ${botType} botiga biriktirilgan`);
    }
  }

  if (uname) {
    const existing = await prisma.botAccess.findFirst({
      where: { botType, username: uname },
    });
    if (existing) {
      throw new ValidationError(`Ushbu username (@${uname}) allaqachon ${botType} botiga biriktirilgan`);
    }
  }

  return prisma.botAccess.create({
    data: {
      botType,
      telegramId: tgId,
      username: uname,
      label,
      level: input.level || "FULL",
      isActive: true,
      createdById: input.createdById,
    },
  });
}

/**
 * Ruxsatni yangilash.
 */
export async function updateBotAccess(id: string, input: UpdateBotAccessInput): Promise<BotAccess> {
  const existing = await prisma.botAccess.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Ruxsat yozuvi topilmadi");

  const data: Partial<BotAccess> = {};

  if (input.botType !== undefined) {
    data.botType = input.botType === "KITCHEN" ? "KITCHEN" : "FOUNDER";
  }
  if (input.label !== undefined) {
    const l = input.label.trim();
    if (!l) throw new ValidationError("Ism yoki izoh bo'sh bo'lishi mumkin emas");
    data.label = l;
  }
  if (input.telegramId !== undefined) {
    data.telegramId = cleanTelegramId(input.telegramId);
  }
  if (input.username !== undefined) {
    data.username = cleanUsername(input.username);
  }
  if (input.level !== undefined) {
    data.level = input.level;
  }
  if (input.isActive !== undefined) {
    data.isActive = Boolean(input.isActive);
  }

  return prisma.botAccess.update({
    where: { id },
    data,
  });
}

/**
 * Ruxsatni o'chirish.
 */
export async function deleteBotAccess(id: string): Promise<void> {
  const existing = await prisma.botAccess.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Ruxsat yozuvi topilmadi");

  await prisma.botAccess.delete({ where: { id } });
}

/**
 * Bot foydalanuvchisini aniqlash va Telegram ID ni avtomatik bog'lash (Auto-bind).
 *
 * Foydalanuvchi botda /start bosganda yoki xabar yozganda:
 * 1. Avval telegramId bo'yicha qidiradi.
 * 2. Topilmasa va username bo'lsa, username bo'yicha qidiradi.
 * 3. Agar username bo'yicha topilsa va telegramId hali bo'sh bo'lsa,
 *    Telegram ID avtomatik ravishda bazaga yoziladi!
 */
export async function resolveAndBindBotUser(
  botType: "FOUNDER" | "KITCHEN",
  rawTelegramId: number | string | undefined,
  rawUsername: string | undefined
): Promise<{ allowed: boolean; record: BotAccess | null; role: "owner" | "manager" | "none" }> {
  const tgId = cleanTelegramId(rawTelegramId);
  const uname = cleanUsername(rawUsername);

  if (!tgId && !uname) {
    return { allowed: false, record: null, role: "none" };
  }

  // 1. Telegram ID bo'yicha tekshirish
  if (tgId) {
    const record = await prisma.botAccess.findFirst({
      where: { botType, telegramId: tgId, isActive: true },
    });
    if (record) {
      // Agar bazada username hali saqlanmagan bo'lsa, uni ham to'ldirib qo'yamiz
      if (!record.username && uname) {
        await prisma.botAccess.update({
          where: { id: record.id },
          data: { username: uname },
        }).catch(() => {});
      }
      return {
        allowed: true,
        record,
        role: record.level === "FULL" ? "owner" : "manager",
      };
    }
  }

  // 2. Username bo'yicha tekshirish
  if (uname) {
    const record = await prisma.botAccess.findFirst({
      where: { botType, username: uname, isActive: true },
    });
    if (record) {
      // AUTO-BINDING: Foydalanuvchining Telegram ID si hali yo'q bo'lsa yoki o'zgargan bo'lsa bog'laymiz
      if (tgId && record.telegramId !== tgId) {
        await prisma.botAccess.update({
          where: { id: record.id },
          data: { telegramId: tgId },
        }).catch((e) => {
          console.error(`[bot-access] Auto-bind xatosi (@${uname}):`, e);
        });
        record.telegramId = tgId;
        console.log(`[bot-access] @${uname} uchun Telegram ID (${tgId}) muvaffaqiyatli bog'landi (${botType})`);
      }

      return {
        allowed: true,
        record,
        role: record.level === "FULL" ? "owner" : "manager",
      };
    }
  }

  return { allowed: false, record: null, role: "none" };
}

/**
 * Bildirishnomalar boradigan barcha faol Telegram ID'lar ro'yxati.
 */
export async function getActiveBotRecipients(botType: "FOUNDER" | "KITCHEN"): Promise<string[]> {
  const rows = await prisma.botAccess.findMany({
    where: {
      botType,
      isActive: true,
      telegramId: { not: null },
    },
    select: { telegramId: true },
  });

  return rows
    .map((r) => r.telegramId)
    .filter((id): id is string => Boolean(id));
}
