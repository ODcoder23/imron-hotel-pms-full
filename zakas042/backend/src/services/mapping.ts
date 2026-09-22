/**
 * Xona mapping — TZ 5-band, "Eng muhim qism"
 *
 * Manba: 06-XONA-MAPPING.md
 *
 * TZ: "Har bir mapping database'da saqlansin.
 *      Noto'g'ri xona turiga bron tushmasligi kerak."
 *
 * QAT'IY QOIDA (06-fayl §4): mapping topilmasa sync RAD ETILADI.
 * Taxminiy mapping — na "eng yaqin tur", na "standart tur", na
 * "birinchi topilgan" — ASLO ishlatilmaydi. Noto'g'ri xonaga tushgan
 * bron real overbooking yoki noto'g'ri narxlash keltiradi.
 */

import { prisma } from "../lib/prisma.js";
import { NotFoundError, ValidationError, AppError } from "../lib/errors.js";
import { getRoomTypesCached } from "./channel/propertyCache.js";

// --- O'qish -------------------------------------------------

export async function listMappings() {
  const channel = await prisma.channel.findUnique({ where: { code: "beds24" } });
  if (!channel) return [];

  return prisma.channelMapping.findMany({
    where: { channelId: channel.id, isActive: true },
    include: { roomType: true, room: true },
    orderBy: [{ roomType: { sortOrder: "asc" } }, { room: { sortOrder: "asc" } }],
  });
}

/**
 * RoomType uchun mapping topadi.
 *
 * Sync operatsiyalari shu funksiyani chaqiradi. `null` qaytsa —
 * sync bajarilmaydi (06-fayl §4).
 */
export async function findRoomTypeMapping(roomTypeId: string) {
  const channel = await prisma.channel.findUnique({ where: { code: "beds24" } });
  if (!channel) return null;

  return prisma.channelMapping.findFirst({
    where: { channelId: channel.id, roomTypeId, isActive: true },
  });
}

/**
 * Tashqi room type id bo'yicha PMS turini topadi (webhook uchun).
 * `externalUnitId` berilsa, avval aniq unit mapping'i qidiriladi.
 */
export async function findByExternal(externalRoomTypeId: string, externalUnitId?: string) {
  const channel = await prisma.channel.findUnique({ where: { code: "beds24" } });
  if (!channel) return null;

  // 1) Unit darajasi — eng aniq holat (06-fayl §5)
  if (externalUnitId) {
    const unitMapping = await prisma.channelMapping.findFirst({
      where: { channelId: channel.id, externalUnitId, isActive: true },
      include: { room: true, roomType: true },
    });
    if (unitMapping) return unitMapping;
  }

  // 2) Room type darajasi
  return prisma.channelMapping.findFirst({
    where: {
      channelId: channel.id,
      externalRoomTypeId,
      externalUnitId: null,
      isActive: true,
    },
    include: { room: true, roomType: true },
  });
}

// --- Yozish -------------------------------------------------

type UpsertInput = {
  roomTypeId?: string;
  roomId?: string;
  externalRoomTypeId: string;
  externalUnitId?: string;
  userId?: string;
};

/**
 * Mapping yaratadi yoki yangilaydi.
 * O'zgarish `AuditLog` ga yoziladi (TZ 18-band).
 */
export async function upsertMapping(input: UpsertInput) {
  if (!input.roomTypeId && !input.roomId) {
    throw new ValidationError("roomTypeId yoki roomId kerak");
  }
  if (!input.externalRoomTypeId) {
    throw new ValidationError("externalRoomTypeId kerak");
  }

  const channel = await prisma.channel.upsert({
    where: { code: "beds24" },
    create: { code: "beds24", name: "Beds24", isActive: true },
    update: {},
  });

  // PMS tomoni mavjudligini tekshirish
  if (input.roomTypeId) {
    const rt = await prisma.roomType.findUnique({ where: { id: input.roomTypeId } });
    if (!rt) throw new NotFoundError(`Xona turi ${input.roomTypeId}`);
  }
  if (input.roomId) {
    const room = await prisma.room.findUnique({ where: { id: input.roomId } });
    if (!room) throw new NotFoundError(`Xona ${input.roomId}`);
  }

  // Validatsiya (06-fayl §6): bitta tashqi tur bitta PMS turiga
  const conflict = await prisma.channelMapping.findFirst({
    where: {
      channelId: channel.id,
      externalRoomTypeId: input.externalRoomTypeId,
      externalUnitId: input.externalUnitId ?? null,
      isActive: true,
      ...(input.roomTypeId ? { roomTypeId: { not: input.roomTypeId } } : {}),
      ...(input.roomId ? { roomId: { not: input.roomId } } : {}),
    },
    include: { roomType: true, room: true },
  });

  if (conflict) {
    const who = conflict.roomType?.label ?? conflict.room?.number ?? "boshqa obyekt";
    throw new AppError(
      409,
      `Beds24'dagi ${input.externalRoomTypeId} allaqachon "${who}" ga bog'langan. ` +
      `Avval o'sha bog'lanishni o'chiring.`,
      "MAPPING_CONFLICT"
    );
  }

  // Mavjud mapping'ni qidirish
  const existing = await prisma.channelMapping.findFirst({
    where: {
      channelId: channel.id,
      ...(input.roomTypeId ? { roomTypeId: input.roomTypeId } : { roomId: input.roomId }),
      ...(input.roomId ? { roomId: input.roomId } : {}),
    },
  });

  const data = {
    channelId: channel.id,
    roomTypeId: input.roomTypeId ?? null,
    roomId: input.roomId ?? null,
    externalRoomTypeId: input.externalRoomTypeId,
    externalUnitId: input.externalUnitId ?? null,
    isActive: true,
  };

  const result = existing
    ? await prisma.channelMapping.update({ where: { id: existing.id }, data })
    : await prisma.channelMapping.create({ data });

  // Audit (TZ 18-band, 10-fayl §4)
  await prisma.auditLog.create({
    data: {
      userId: input.userId ?? null,
      action: existing ? "mapping.updated" : "mapping.created",
      entityType: "ChannelMapping",
      entityId: result.id,
      before: existing ? { externalRoomTypeId: existing.externalRoomTypeId, externalUnitId: existing.externalUnitId } : undefined,
      after: { externalRoomTypeId: result.externalRoomTypeId, externalUnitId: result.externalUnitId },
    },
  });

  return result;
}

/**
 * Mapping o'chiradi (soft delete).
 *
 * 06-fayl §6: faol bronlar bo'lsa ogohlantirish beradi.
 * `force` bo'lmasa — o'chirmaydi.
 */
export async function deleteMapping(id: string, opts: { force?: boolean; userId?: string } = {}) {
  const mapping = await prisma.channelMapping.findUnique({
    where: { id },
    include: { roomType: true, room: true },
  });
  if (!mapping) throw new NotFoundError("Mapping");

  // Faol bronlarni tekshirish
  const activeCount = await prisma.reservation.count({
    where: {
      status: { in: ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN"] },
      ...(mapping.roomId
        ? { roomId: mapping.roomId }
        : mapping.roomTypeId
          ? { room: { roomTypeId: mapping.roomTypeId } }
          : {}),
    },
  });

  if (activeCount > 0 && !opts.force) {
    throw new AppError(
      409,
      `Bu mapping bo'yicha ${activeCount} ta faol bron bor. ` +
      `O'chirilsa ular Beds24 bilan sinxronlanmay qoladi.`,
      "MAPPING_HAS_ACTIVE_RESERVATIONS"
    );
  }

  // Soft delete — tarixiy SyncLog yozuvlari ma'nosini yo'qotmasligi uchun
  const result = await prisma.channelMapping.update({
    where: { id },
    data: { isActive: false },
  });

  await prisma.auditLog.create({
    data: {
      userId: opts.userId ?? null,
      action: "mapping.deleted",
      entityType: "ChannelMapping",
      entityId: id,
      before: {
        externalRoomTypeId: mapping.externalRoomTypeId,
        roomTypeId: mapping.roomTypeId,
        activeReservations: activeCount,
        forced: opts.force ?? false,
      },
    },
  });

  return result;
}

// --- To'liqlik tekshiruvi (06-fayl §7) ----------------------

export type MappingHealth = {
  isComplete: boolean;
  roomTypes: Array<{
    id: string;
    label: string;
    rooms: number;
    mapped: boolean;
    externalRoomTypeId?: string;
    externalName?: string;
    externalQty?: number;
    /** Mapping yozuvi id — ovqat belgisini o'zgartirish uchun */
    mappingId?: string;
    /** Bu tarif ovqat bilan keladimi (BOTLAR-REJA.md) */
    includesMeal?: boolean;
    warning?: string;
  }>;
  unmappedRoomCount: number;
  orphanMappings: Array<{ id: string; externalRoomTypeId: string; reason: string }>;
  /** Beds24'da bor, lekin PMS'ga bog'lanmagan turlar */
  unusedExternal: Array<{ id: string; name: string; qty: number }>;
  channelConnected: boolean;
};

/**
 * Mapping to'liqmi — FAZA 5 tayyorlik mezoni va doimiy nazorat.
 *
 * Beds24'ga ulanish bo'lmasa ham ishlaydi (faqat PMS tomonini
 * tekshiradi) — chunki mapping ekranini ulanishdan oldin ham
 * ko'rish mumkin.
 */
export async function getMappingHealth(): Promise<MappingHealth> {
  const [roomTypes, mappings, channel] = await Promise.all([
    prisma.roomType.findMany({
      include: { _count: { select: { rooms: { where: { isActive: true } } } } },
      orderBy: { sortOrder: "asc" },
    }),
    listMappings(),
    prisma.channelConnection.findFirst({
      where: { channel: { code: "beds24" }, isActive: true },
    }),
  ]);

  // Beds24 tomonidagi turlar — ulanish bo'lsa
  let externalTypes: Array<{ id: string; name: string; qty: number }> = [];
  if (channel) {
    try {
      // 06-fayl §3: /properties keshlanadi — kredit tejash
      const props = await getRoomTypesCached();
      externalTypes = props.flatMap((p) =>
        p.roomTypes.map((rt) => ({ id: rt.id, name: rt.name, qty: rt.qty }))
      );
    } catch {
      // Ulanish bor lekin API javob bermadi — PMS tomonini baribir ko'rsatamiz
    }
  }

  const byRoomType = new Map(
    mappings.filter((m) => m.roomTypeId).map((m) => [m.roomTypeId!, m])
  );

  let unmappedRoomCount = 0;
  const rows: MappingHealth["roomTypes"] = [];

  for (const rt of roomTypes) {
    const mapping = byRoomType.get(rt.id);
    const rooms = rt._count.rooms;

    if (!mapping) {
      unmappedRoomCount += rooms;
      rows.push({
        id: rt.id,
        label: rt.label,
        rooms,
        mapped: false,
        warning: "mapping yo'q — bu turdagi bronlar OTA'da ko'rinmaydi",
      });
      continue;
    }

    const ext = externalTypes.find((e) => e.id === mapping.externalRoomTypeId);
    const row: MappingHealth["roomTypes"][number] = {
      id: rt.id,
      label: rt.label,
      rooms,
      mapped: true,
      externalRoomTypeId: mapping.externalRoomTypeId,
      externalName: ext?.name,
      externalQty: ext?.qty,
      mappingId: mapping.id,
      includesMeal: mapping.includesMeal,
    };

    // Xona sonlari mos kelmasa — availability noto'g'ri bo'ladi (07-fayl §2)
    if (ext && ext.qty !== rooms) {
      row.warning =
        `PMS'da ${rooms} xona, Beds24'da ${ext.qty} — availability noto'g'ri hisoblanadi`;
    }
    rows.push(row);
  }

  // Orphan: mapping bor, lekin Beds24'da bunday tur yo'q
  const orphanMappings = mappings
    .filter(
      (m) =>
        externalTypes.length > 0 &&
        !externalTypes.some((e) => e.id === m.externalRoomTypeId)
    )
    .map((m) => ({
      id: m.id,
      externalRoomTypeId: m.externalRoomTypeId,
      reason: "Beds24'da bunday room type topilmadi",
    }));

  // Beds24'da bor, lekin PMS'ga bog'lanmagan
  const mappedExternalIds = new Set(mappings.map((m) => m.externalRoomTypeId));
  const unusedExternal = externalTypes.filter((e) => !mappedExternalIds.has(e.id));

  return {
    isComplete: rows.length > 0 && rows.every((r) => r.mapped) && orphanMappings.length === 0,
    roomTypes: rows,
    unmappedRoomCount,
    orphanMappings,
    unusedExternal,
    channelConnected: channel !== null,
  };
}
