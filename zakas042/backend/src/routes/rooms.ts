/**
 * Xona endpoint'lari — Shaxmatka uchun
 * Frontend `rooms` massivi shakliga mos (02-fayl §3).
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requirePermission, type AuthedRequest } from "../lib/authMiddleware.js";
import { asyncHandler, NotFoundError, ValidationError } from "../lib/errors.js";
import { serializeRoom, serializeRoomType, serializeFloor, fromDateKey } from "../lib/serialize.js";
import { isRoomFree } from "../services/reservations.js";
import {
  blockRooms,
  unblockRooms,
  blockFloor,
  unblockFloor,
  listBlocked,
} from "../services/roomBlocking.js";

export const roomsRouter = Router();

// --- GET /api/rooms -----------------------------------------
roomsRouter.get("/", requireAuth, requirePermission("reservation.read"), asyncHandler(async (_req, res) => {
  const rooms = await prisma.room.findMany({ orderBy: { sortOrder: "asc" } });
  res.json(rooms.map(serializeRoom));
}));

// --- GET /api/rooms/types -----------------------------------
roomsRouter.get("/types", requireAuth, requirePermission("reservation.read"), asyncHandler(async (_req, res) => {
  const types = await prisma.roomType.findMany({ orderBy: { sortOrder: "asc" } });
  res.json(types.map(serializeRoomType));
}));

// --- GET /api/rooms/available?from=&to= ---------------------
// Shaxmatkadagi availableRoomsFor() ga mos
roomsRouter.get("/available", requireAuth, requirePermission("reservation.read"), asyncHandler(async (req, res) => {
  const { from, to, exclude } = req.query;
  if (!from || !to) throw new ValidationError("from va to parametrlari kerak");

  const checkIn = fromDateKey(from);
  const checkOut = fromDateKey(to);

  /**
   * UCH SO'ROV, xona soniga bog'liq emas.
   *
   * Ilgari har xona uchun `isRoomFree()` chaqirilardi: 18 xona x
   * 2 so'rov = 36 ketma-ket so'rov. Prisma ulanish hovuzi (9 ta)
   * tugab, endpoint 10 soniyadan keyin 500 qaytarardi (P2024).
   * Xona soni ortgani sari holat yomonlashardi.
   *
   * Mantiq `isRoomFree()` bilan AYNAN bir xil bo'lishi shart:
   * band bron + yopilgan kun. Ikkalasi ham shu yerda takrorlangan,
   * chunki bittalab tekshiruv o'rniga to'plam olinmoqda.
   */
  const [rooms, busy, blocked] = await Promise.all([
    prisma.room.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),

    // Oraliqqa tushadigan bronlar — `[checkIn, checkOut)` qoidasi
    prisma.reservation.findMany({
      where: {
        status: { notIn: ["CANCELLED", "NO_SHOW"] },
        checkIn: { lt: checkOut },
        checkOut: { gt: checkIn },
        ...(exclude ? { id: { not: exclude } } : {}),
      },
      select: { roomId: true },
    }),

    // Ta'mir/xizmatdan chiqarilgan kunlar
    prisma.roomDayStatus.findMany({
      where: { isBlocked: true, date: { gte: checkIn, lt: checkOut } },
      select: { roomId: true },
    }),
  ]);

  const taken = new Set([
    ...busy.map((b) => b.roomId),
    ...blocked.map((b) => b.roomId),
  ]);

  res.json(rooms.filter((r) => !taken.has(r.id)).map(serializeRoom));
}));

// --- PATCH /api/rooms/:id — holat o'zgartirish --------------
//
// Katta harf ham qabul qilinadi: Shaxmatka kichik harf yuboradi
// ("dirty"), admin panel esa Prisma enum shaklida ("DIRTY").
// Ikkalasi ham to'g'ri — farqi tufayli so'rov yiqilmasin.
const statusSchema = z.object({
  status: z
    .string()
    .transform((v) => v.toLowerCase())
    .pipe(
      z.enum(["available", "reserved", "occupied", "dirty", "out_of_order", "out_of_service"])
    ),
});

// ============================================================
//  QAVATLAR
//  DIQQAT: bu yo'llar "/:id" dan OLDIN turishi shart, aks holda
//  Express "floors" ni xona ID'si deb qabul qiladi.
// ============================================================

// --- GET /api/rooms/floors ----------------------------------
roomsRouter.get("/floors", requireAuth, requirePermission("reservation.read"), asyncHandler(async (_req, res) => {
  const floors = await prisma.floor.findMany({ orderBy: { sortOrder: "asc" } });
  res.json(floors.map(serializeFloor));
}));

// ============================================================
//  XONA YOPISH (ta'mir, xizmatdan chiqarish)
//
//  Yopilgan xona butun zanjir bo'ylab tarqaladi:
//    RoomDayStatus -> Availability -> WebSocket -> Beds24 -> OTA
//  Tafsilot: services/roomBlocking.ts
// ============================================================

const blockRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from: YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to: YYYY-MM-DD"),
  reason: z.string().max(200).optional(),
});

const blockRoomsSchema = blockRangeSchema.extend({
  roomIds: z.array(z.string().min(1)).min(1, "Kamida bitta xona"),
  /** Bron bo'lsa ham yopish. Faqat ataylab ishlatiladi. */
  force: z.boolean().optional(),
});

const blockFloorSchema = blockRangeSchema.extend({
  floorId: z.string().min(1),
  force: z.boolean().optional(),
});

// --- GET /api/rooms/blocks?from=&to=&roomIds= ---------------
// Shaxmatka yopiq kunlarni kulrang ko'rsatishi uchun
roomsRouter.get("/blocks", requireAuth, requirePermission("reservation.read"), asyncHandler(async (req, res) => {
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  if (!from || !to) throw new ValidationError("from va to talab qilinadi");

  const raw = req.query.roomIds;
  const roomIds = typeof raw === "string" && raw.length > 0 ? raw.split(",") : undefined;

  res.json(await listBlocked(from, to, roomIds));
}));

// --- POST /api/rooms/blocks ---------------------------------
roomsRouter.post("/blocks", requireAuth, requirePermission("room.block"), asyncHandler(async (req: AuthedRequest, res) => {
  const { roomIds, force, ...range } = blockRoomsSchema.parse(req.body);
  const result = await blockRooms(roomIds, range, {
    userId: req.user?.id,
    force,
    ipAddress: req.ip,
  });
  res.status(201).json(result);
}));

// --- DELETE /api/rooms/blocks -------------------------------
// Yopiqni bekor qiladi. DELETE + body: o'chirilayotgan narsa
// bitta resurs emas, oraliq — URL'ga sig'maydi.
roomsRouter.delete("/blocks", requireAuth, requirePermission("room.block"), asyncHandler(async (req: AuthedRequest, res) => {
  const { roomIds, ...range } = blockRoomsSchema.omit({ force: true }).parse(req.body);
  const result = await unblockRooms(roomIds, range, {
    userId: req.user?.id,
    ipAddress: req.ip,
  });
  res.json(result);
}));

// --- POST /api/rooms/blocks/floor ---------------------------
roomsRouter.post("/blocks/floor", requireAuth, requirePermission("room.block"), asyncHandler(async (req: AuthedRequest, res) => {
  const { floorId, force, ...range } = blockFloorSchema.parse(req.body);
  const result = await blockFloor(floorId, range, {
    userId: req.user?.id,
    force,
    ipAddress: req.ip,
  });
  res.status(201).json(result);
}));

// --- DELETE /api/rooms/blocks/floor -------------------------
roomsRouter.delete("/blocks/floor", requireAuth, requirePermission("room.block"), asyncHandler(async (req: AuthedRequest, res) => {
  const { floorId, ...range } = blockFloorSchema.omit({ force: true }).parse(req.body);
  const result = await unblockFloor(floorId, range, {
    userId: req.user?.id,
    ipAddress: req.ip,
  });
  res.json(result);
}));

// ============================================================
//  XONA HOLATI
// ============================================================

roomsRouter.patch("/:id", requireAuth, requirePermission("checkin.write"), asyncHandler(async (req, res) => {
  const { status } = statusSchema.parse(req.body);
  const room = await prisma.room.findUnique({ where: { id: req.params.id } });
  if (!room) throw new NotFoundError(`Xona ${req.params.id}`);

  const updated = await prisma.room.update({
    where: { id: req.params.id },
    data: { status: status.toUpperCase() as never },
  });
  res.json(serializeRoom(updated));
}));
