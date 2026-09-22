/**
 * Tozalash topshiriqlari — TOZALIK-BOT.md
 *
 * MANTIQ (2026-09-17 kechqurun, BOTLAR-REJA.md):
 *   Topshiriq FARROSHLAR GURUHIGA yuboriladi. Kim bo'sh bo'lsa
 *   "Men olaman" bosadi — birinchi bosgan oladi.
 *
 *   Ilgari topshiriq aniq faroshga biriktirilib, shaxsiy chatga
 *   borardi. U holda har farosh uchun `Employee.telegramId`
 *   sozlash kerak edi va bog'lanmagan farosh topshiriq
 *   ololmasdi.
 *
 * IKKI MANBA, BIR XIL OQIM:
 *   1. Avtomatik — mehmon chiqqanda (`isAuto = true`)
 *   2. Qo'lda — admin panelda (`isAuto = false`)
 *
 * TO'RT HOLAT:
 *   NEW → IN_PROGRESS → PENDING → DONE
 *   (guruh)   (guruh)    (admin panel tasdiqlaydi)
 *
 * Xona FAQAT `DONE` bo'lgach sotishga ochiladi.
 *
 * Bu fayl Telegram'ni BILMAYDI: u faqat ma'lumot bilan ishlaydi
 * va `onTaskChanged` callback'ini chaqiradi. Bot o'zini shu
 * callback'ga ulaydi. Shu sabab bot o'chirilgan bo'lsa ham
 * tozalash tizimi ishlayveradi (TZ 17, 19-band ruhida).
 */

import type { CleaningStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import {
  getCleaningAuto,
  getCleaningTargetMinutes,
} from "./settings.js";
import { notifyRoomStatus } from "../realtime/notify.js";

/** Farosh lavozimi — `Employee.position` dagi qiymat */
const CLEANER_POSITION = "Farrosh";

/**
 * Topshiriq o'zgarganda chaqiriladi (bot shunga ulanadi).
 *
 * NEGA CALLBACK: servis Telegram'ni import qilsa, testlarda va
 * bot o'chirilganda keraksiz bog'liqlik paydo bo'lardi.
 */
export type TaskEvent = "created" | "updated" | "approved" | "rejected";

type TaskListener = (taskId: string, event: TaskEvent) => void | Promise<void>;

const listeners: TaskListener[] = [];

export function onTaskChanged(fn: TaskListener): void {
  listeners.push(fn);
}

function emit(taskId: string, event: TaskEvent): void {
  for (const fn of listeners) {
    try {
      void fn(taskId, event);
    } catch (e) {
      // Xabar yuborilmagani tozalash yozuvini buzmasligi kerak
      console.error("[cleaning] listener xatosi:", String(e).slice(0, 150));
    }
  }
}

/** Topshiriq o'qishda har doim shu bog'liqliklar kerak */
export const taskInclude = {
  room: { include: { roomType: true } },
  employee: { select: { id: true, fullName: true, telegramId: true } },
} as const;

/**
 * `nextCleaner()` OLIB TASHLANDI (2026-09-17).
 *
 * U navbat bo'yicha farosh tanlardi (bugun eng kam topshiriq
 * olgani). Guruh mantig'ida biriktirish yo'q — kim bo'sh bo'lsa
 * o'zi oladi, shuning uchun navbat hisobi keraksiz.
 *
 * `CLEANER_POSITION` `listCleaners()` da qoladi: admin panelda
 * farroshlar ro'yxati hali ko'rsatiladi.
 */

// ============================================================
//  Yaratish
// ============================================================

export type CreateTaskInput = {
  roomId: string;
  reason: string;
  /**
   * Kimga biriktirilsin — IXTIYORIY.
   *
   * Guruh mantig'ida odatda berilmaydi: topshiriq guruhga
   * ketadi va kim bo'sh bo'lsa oladi. Admin ataylab aniq
   * odamga bermoqchi bo'lsagina to'ldiriladi.
   */
  employeeId?: string;
  /** Mehmon chiqqanda avtomatik yaratilganmi */
  isAuto?: boolean;
  /** Qo'lda yuborgan foydalanuvchi */
  createdById?: string;
};

/**
 * Topshiriq yaratadi.
 *
 * TAKRORLANISHDAN HIMOYA: bir xonada tugallanmagan topshiriq
 * bo'lsa yangisi yaratilmaydi. Aks holda mehmon chiqqanda ham,
 * admin qo'lda yuborganda ham ikkita xabar ketardi.
 */
export async function createTask(input: CreateTaskInput) {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new ValidationError("Sabab yozilishi kerak (kamida 3 belgi)");
  }

  const room = await prisma.room.findUnique({ where: { id: input.roomId } });
  if (!room) throw new NotFoundError(`Xona ${input.roomId}`);

  const active = await prisma.cleaningTask.findFirst({
    where: { roomId: input.roomId, status: { in: ["NEW", "IN_PROGRESS"] } },
    include: taskInclude,
  });

  if (active) {
    // Xato emas: mavjud topshiriq qaytariladi, chaqiruvchi
    // buni "allaqachon bor" deb tushunadi
    return { task: active, created: false };
  }

  /**
   * GURUH MANTIG'I (2026-09-17, BOTLAR-REJA.md).
   *
   * Topshiriq oldindan hech kimga biriktirilmaydi — guruhga
   * yuboriladi va kim bo'sh bo'lsa "Men olaman" bosadi.
   * Ilgari `nextCleaner()` navbat bo'yicha farosh tanlardi va
   * Telegram bog'lanmagan farosh bo'lsa topshiriq yuborilmay
   * qolardi.
   *
   * `employeeId` faqat ataylab berilgan bo'lsa yoziladi
   * (admin paneldan qo'lda biriktirish imkoniyati saqlandi).
   */
  const employeeId = input.employeeId ?? null;

  /**
   * Foydalanuvchi mavjudligini tekshiramiz.
   *
   * Dev rejimida `authMiddleware` soxta `id: "dev"` beradi
   * (`AUTH_REQUIRED=false`) — bunday User yo'q va yozuv
   * foreign key xatosi bilan yiqilardi. Topshiriq yaratilishi
   * "kim yubordi" noma'lumligi tufayli to'xtamasligi kerak.
   */
  const createdById = input.createdById
    ? (await prisma.user.findUnique({
        where: { id: input.createdById },
        select: { id: true },
      }))?.id ?? null
    : null;

  const task = await prisma.cleaningTask.create({
    data: {
      roomId: input.roomId,
      reason,
      isAuto: input.isAuto ?? false,
      employeeId,
      createdById,
    },
    include: taskInclude,
  });

  /**
   * XABAR DARHOL YUBORILADI — vaqt cheklovi yo'q (2026-09-17).
   *
   * Ilgari ish vaqti (07:00–22:00) tashqarisida xabar
   * yuborilmasdi va topshiriq ertalabgacha kutardi. Mehmonxona
   * kechayu kunduz ishlaydi: mehmon yarim tunda chiqsa, xona
   * ertalabgacha iflos turishi va sotilmay qolishi mumkin edi.
   *
   * Farosh tunda band bo'lsa, xabar guruhda turadi va ertalab
   * kim bo'sh bo'lsa oladi — yo'qolmaydi.
   */
  emit(task.id, "created");

  return { task, created: true };
}

/**
 * Mehmon chiqqanda avtomatik topshiriq (TOZALIK-BOT.md §2A).
 *
 * `checkOut()` dan chaqiriladi. Sozlama o'chirilgan bo'lsa
 * hech narsa qilmaydi.
 *
 * XATO TASHLAMAYDI: tozalash topshirig'i yaratilmagani uchun
 * check-out bekor qilinmasligi kerak.
 */
export async function createOnCheckout(roomId: string): Promise<void> {
  try {
    if (!(await getCleaningAuto())) return;

    await createTask({
      roomId,
      reason: "Mehmon chiqdi",
      isAuto: true,
    });
  } catch (e) {
    console.error("[cleaning] avtomatik topshiriq:", String(e).slice(0, 150));
  }
}

// ============================================================
//  Holat o'zgarishlari
// ============================================================

/**
 * Guruhda kimdir "Men olaman" bosdi.
 *
 * BIRINCHI BOSGAN OLADI: xabar guruhdagi hammaga ko'rinadi,
 * kim birinchi ulgursa topshiriq o'shanikiga yoziladi.
 * Qolganlariga "Bu xonani Dilnoza oldi" deyiladi.
 *
 * `claimedByName` — Telegram'dagi ismi, hisobotda ko'rsatiladi.
 */
export async function acceptTask(
  taskId: string,
  telegramId: string,
  claimedByName?: string
) {
  /**
   * "BIRINCHI BOSGAN OLADI" — poyga himoyasi.
   *
   * Guruhda xabar hammaga ko'rinadi va ikki farosh bir vaqtda
   * bosishi mumkin. `updateMany` + `status: "NEW"` sharti bitta
   * SQL amalida hal qiladi: PostgreSQL qatorni qulflaydi va
   * faqat bittasi o'tadi.
   *
   * Avval o'qib, keyin yozganda ikkalasi ham "NEW" ko'rib
   * ikkalasiga ham ruxsat berilardi — ikkinchisi birinchisining
   * ismini almashtirib qo'yardi.
   */
  const claimed = await prisma.cleaningTask.updateMany({
    where: { id: taskId, status: "NEW" },
    data: {
      status: "IN_PROGRESS",
      acceptedAt: new Date(),
      claimedByTelegramId: telegramId,
      claimedByName: claimedByName?.slice(0, 100) ?? null,
    },
  });

  if (claimed.count === 0) {
    // Yo topshiriq yo'q, yo boshqa birov oldi — farqini aytamiz
    const task = await prisma.cleaningTask.findUnique({
      where: { id: taskId },
      include: taskInclude,
    });
    if (!task) throw new NotFoundError("Topshiriq");

    if (task.status === "IN_PROGRESS" || task.status === "PENDING") {
      const who = task.claimedByName ?? task.employee?.fullName ?? "boshqa xodim";
      throw new ValidationError(`Bu xonani ${who} oldi`);
    }
    throw new ValidationError("Bu topshiriq yopilgan");
  }

  const updated = await prisma.cleaningTask.findUniqueOrThrow({
    where: { id: taskId },
    include: taskInclude,
  });

  emit(taskId, "updated");
  return updated;
}

/**
 * Farosh "Tozaladim" bosdi.
 *
 * DIQQAT: xona HALI OCHILMAYDI. Topshiriq `PENDING` holatiga
 * o'tadi va admin tasdiqlashini kutadi (2026-09-17 qarori).
 *
 * NEGA: egasi tozalash sifatini tekshirishni xohladi. Xona
 * tasdiqlanmaguncha sotilmaydi — mehmon iflos xonaga
 * tushib qolmasin.
 */
export async function completeTask(taskId: string, telegramId: string, photoUrl?: string | null) {
  const task = await prisma.cleaningTask.findUnique({
    where: { id: taskId },
    include: taskInclude,
  });
  if (!task) throw new NotFoundError("Topshiriq");

  if (task.status !== "IN_PROGRESS") {
    throw new ValidationError(
      task.status === "NEW"
        ? 'Avval "Ko\'rdim" tugmasini bosing'
        : "Bu topshiriq yopilgan"
    );
  }

  /**
   * Faqat OLGAN odam tugata oladi.
   *
   * Guruhda tugma hammaga ko'rinadi, lekin boshqa birov
   * "Tozaladim" bossa hisobot noto'g'ri bo'lardi: ish Dilnoza
   * nomiga yozilgan, tugatgani boshqa odam.
   *
   * Eski bog'lanish ham qabul qilinadi (`employee.telegramId`) —
   * guruhga o'tishdan oldin yaratilgan topshiriqlar uchun.
   */
  const owner = task.claimedByTelegramId ?? task.employee?.telegramId ?? null;
  if (owner && owner !== telegramId) {
    const who = task.claimedByName ?? task.employee?.fullName ?? "boshqa xodim";
    throw new ValidationError(`Bu xonani ${who} olgan`);
  }

  const updated = await prisma.cleaningTask.update({
    where: { id: taskId },
    data: {
      status: "PENDING",
      finishedAt: new Date(),
      ...(photoUrl ? { photoUrl } : {}),
    },
    include: taskInclude,
  });

  emit(taskId, "updated");
  return updated;
}

/** Tozalash topshirig'iga rasm biriktirish */
export async function attachCleaningPhoto(taskId: string, photoUrl: string) {
  const updated = await prisma.cleaningTask.update({
    where: { id: taskId },
    data: { photoUrl },
    include: taskInclude,
  });
  emit(taskId, "updated");
  return updated;
}

/**
 * Admin tozalashni tasdiqladi (2026-09-17).
 *
 * FAQAT SHU YERDA xona sotishga ochiladi (SAVOLLAR.md S12).
 * Farosh "tozaladim" degani yetarli emas — tekshiruv bor.
 *
 * Ta'mirdagi xona (`OUT_OF_ORDER`, `OUT_OF_SERVICE`) ochilmaydi:
 * ta'mir alohida narsa va tozalash uni tugatmaydi.
 */
export async function approveTask(taskId: string, userId?: string) {
  const task = await prisma.cleaningTask.findUnique({
    where: { id: taskId },
    include: taskInclude,
  });
  if (!task) throw new NotFoundError("Topshiriq");

  if (task.status !== "PENDING") {
    throw new ValidationError(
      task.status === "DONE"
        ? "Bu topshiriq allaqachon tasdiqlangan"
        : "Farosh hali tozalab bo'lmadi"
    );
  }

  // Dev rejimidagi soxta `id: "dev"` foreign key'ni buzardi
  const approvedById = userId
    ? (await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      }))?.id ?? null
    : null;

  const updated = await prisma.$transaction(async (tx) => {
    const t = await tx.cleaningTask.update({
      where: { id: taskId },
      data: { status: "DONE", doneAt: new Date(), approvedById },
      include: taskInclude,
    });

    const room = await tx.room.findUnique({ where: { id: t.roomId } });

    // Xonada ayni paytda yashayotgan faol mehmon borligini tekshiramiz.
    // Agar mehmon yashayotgan bo'lsa xona OCCUPIED qolishi kerak,
    // aks holda xona AVAILABLE (bo'sh va sotuvga tayyor) bo'ladi.
    const activeStay = await tx.reservation.findFirst({
      where: {
        roomId: t.roomId,
        status: "CHECKED_IN",
      },
      select: { id: true },
    });

    if (room?.status === "DIRTY") {
      await tx.room.update({
        where: { id: t.roomId },
        data: { status: activeStay ? "OCCUPIED" : "AVAILABLE" },
      });
    }

    return t;
  });

  emit(taskId, "approved");
  await notifyRoomStatus(updated.roomId).catch(() => {});
  return updated;
}

/**
 * Admin tozalashni rad etdi — qayta tozalash kerak.
 *
 * Topshiriq `IN_PROGRESS` ga qaytadi va farosh yana
 * "Tozaladim" bosishi kerak. Sabab xabarga qo'shiladi.
 */
export async function rejectTask(taskId: string, note: string) {
  const task = await prisma.cleaningTask.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq");

  if (task.status !== "PENDING") {
    throw new ValidationError("Faqat tasdiqlash kutayotgan ishni rad etish mumkin");
  }

  const reason = note.trim();

  const updated = await prisma.cleaningTask.update({
    where: { id: taskId },
    data: {
      status: "IN_PROGRESS",
      finishedAt: null,
      // Sabab asosiy matnga qo'shiladi — farosh ko'rsin
      reason: reason
        ? `${task.reason}\n\u26a0\ufe0f Qayta: ${reason}`
        : task.reason,
    },
    include: taskInclude,
  });

  emit(taskId, "rejected");
  return updated;
}

/**
 * Boshqa faroshga berish (TOZALIK-BOT.md §4).
 *
 * Eski topshiriq bekor qilinadi, yangisi yaratiladi. Nega
 * o'zgartirmaymiz: eski xabar allaqachon yuborilgan va uni
 * "sizga emas" ga aylantirish chalkash bo'lardi. Tarix ham
 * saqlanib qoladi.
 */
export async function reassignTask(taskId: string, employeeId: string) {
  const old = await prisma.cleaningTask.findUnique({
    where: { id: taskId },
    include: taskInclude,
  });
  if (!old) throw new NotFoundError("Topshiriq");

  if (old.status === "DONE") {
    throw new ValidationError("Bajarilgan topshiriqni qayta berib bo'lmaydi");
  }

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, isActive: true, telegramId: true },
  });
  if (!employee) throw new NotFoundError("Xodim");
  if (!employee.isActive) throw new ValidationError("Xodim faol emas");
  if (!employee.telegramId) {
    throw new ValidationError("Bu xodimning Telegram ID'si kiritilmagan");
  }

  await prisma.cleaningTask.update({
    where: { id: taskId },
    data: { status: "CANCELLED" },
  });
  emit(taskId, "updated");

  const task = await prisma.cleaningTask.create({
    data: {
      roomId: old.roomId,
      reason: old.reason,
      isAuto: old.isAuto,
      employeeId,
      createdById: old.createdById,
    },
    include: taskInclude,
  });

  emit(task.id, "created");
  return task;
}

/** Admin topshiriqni bekor qiladi */
export async function cancelTask(taskId: string) {
  const task = await prisma.cleaningTask.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq");

  if (task.status === "DONE") {
    throw new ValidationError("Bajarilgan topshiriqni bekor qilib bo'lmaydi");
  }

  const updated = await prisma.cleaningTask.update({
    where: { id: taskId },
    data: { status: "CANCELLED" },
    include: taskInclude,
  });

  emit(taskId, "updated");
  return updated;
}

/** Telegram xabar ID'sini saqlaydi — keyin tahrirlash uchun */
export async function saveMessageRef(
  taskId: string,
  chatId: string,
  messageId: number
): Promise<void> {
  await prisma.cleaningTask.update({
    where: { id: taskId },
    data: { chatId, messageId },
  });
}

// ============================================================
//  O'qish
// ============================================================

/** Farroshning ochiq topshiriqlari */
export async function tasksForCleaner(telegramId: string) {
  return prisma.cleaningTask.findMany({
    where: {
      employee: { telegramId },
      status: { in: ["NEW", "IN_PROGRESS"] },
    },
    include: taskInclude,
    orderBy: { createdAt: "asc" },
  });
}

/** Admin panel uchun — barcha topshiriqlar */
export async function listTasks(status?: CleaningStatus) {
  const dayStart = new Date();
  dayStart.setDate(dayStart.getDate() - 7);

  return prisma.cleaningTask.findMany({
    where: {
      ...(status ? { status } : {}),
      // Yopilganlardan faqat oxirgi haftasi — ro'yxat
      // cheksiz o'smasin
      ...(status ? {} : { createdAt: { gte: dayStart } }),
    },
    include: taskInclude,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
}

/** Faol farroshlar — biriktirish ro'yxati uchun */
export async function listCleaners() {
  return prisma.employee.findMany({
    where: { isActive: true, position: CLEANER_POSITION },
    select: { id: true, fullName: true, telegramId: true },
    orderBy: { fullName: "asc" },
  });
}

// ============================================================
//  Davriy vazifalar
// ============================================================

/**
 * Ish vaqti boshlanganda to'plangan topshiriqlarni yuboradi.
 *
 * Tunda mehmon chiqsa topshiriq yaratiladi, lekin xabar
 * yuborilmaydi (TOZALIK-BOT.md §7). Ertalab shu funksiya
 * ularni jo'natadi.
 */
export async function sendPendingTasks(): Promise<{ sent: number }> {
  /**
   * Ish vaqti tekshiruvi OLIB TASHLANDI (2026-09-17) — bot
   * 24 soat ishlaydi. Bu funksiya endi faqat zaxira yo'l:
   * xabar yuborishda xato bo'lgan topshiriqlarni (masalan bot
   * vaqtincha o'chirilgan edi) davriy vazifa qayta yuboradi.
   */

  /**
   * `employeeId: { not: null }` SHARTI OLIB TASHLANDI
   * (2026-09-17). Guruh mantig'ida topshiriq hech kimga
   * biriktirilmaydi — bu shart bilan hech narsa topilmasdi va
   * kechada to'plangan topshiriqlar ertalab ham yuborilmay
   * qolardi.
   *
   * `messageId: null` — hali yuborilmaganlari.
   */
  const pending = await prisma.cleaningTask.findMany({
    where: {
      status: "NEW",
      messageId: null,
    },
    select: { id: true },
    take: 50,
  });

  for (const t of pending) emit(t.id, "created");
  return { sent: pending.length };
}

/**
 * Javob bermagan topshiriqlarni topadi (TOZALIK-BOT.md §4).
 *
 * Avtomatik qayta biriktirilmaydi — kim band ekanini egasi
 * biladi. Faqat eslatma yuboriladi.
 */
export async function findStaleTasks() {
  const minutes = await import("./settings.js").then((m) =>
    m.getCleaningRemindMinutes()
  );

  const cutoff = new Date(Date.now() - minutes * 60_000);

  return prisma.cleaningTask.findMany({
    where: {
      status: "NEW",
      createdAt: { lt: cutoff },
      messageId: { not: null },
    },
    include: taskInclude,
    take: 20,
  });
}

// ============================================================
//  Nazorat — TOZALIK-TAHLIL.md
// ============================================================

/**
 * Topshiriqsiz iflos xonalar (TOZALIK-TAHLIL.md §1).
 *
 * MUAMMO: xona `DIRTY`, lekin tozalash topshirig'i yo'q —
 * hech kim bilmaydi va xona sotilmay turaveradi.
 *
 * QACHON UCHRAYDI:
 *   - Tizim ishga tushganda mavjud iflos xonalar
 *   - Bot o'chirilgan paytda chiqqan mehmonlar
 *   - Topshiriq bekor qilingan, lekin xona hali iflos
 *
 * Bu eng jiddiy bo'shliq edi: panel "0 ta topshiriq" deb
 * ko'rsatardi, garchi xona tozalanishi kerak bo'lsa ham.
 */
export async function dirtyWithoutTask(): Promise<
  Array<{ id: string; label: string; floor: number }>
> {
  const dirty = await prisma.room.findMany({
    where: { status: "DIRTY", isActive: true },
    select: { id: true, floor: true, roomType: { select: { label: true } } },
    orderBy: { sortOrder: "asc" },
  });

  if (dirty.length === 0) return [];

  const open = await prisma.cleaningTask.findMany({
    where: {
      roomId: { in: dirty.map((r) => r.id) },
      status: { in: ["NEW", "IN_PROGRESS"] },
    },
    select: { roomId: true },
  });

  const covered = new Set(open.map((t) => t.roomId));

  return dirty
    .filter((r) => !covered.has(r.id))
    .map((r) => ({
      id: r.id,
      label: r.roomType?.label ?? "",
      floor: r.floor,
    }));
}

/**
 * Bugungi ish rejasi (TOZALIK-TAHLIL.md §4).
 *
 * Qabulxona ertalab bilishi kerak: nechta xona chiqadi
 * (tozalash kerak bo'ladi) va nechta mehmon keladi (xona
 * tayyor bo'lishi kerak).
 */
export async function todayPlan(): Promise<{
  departures: number;
  arrivals: number;
  /** Hali kelmaganlar — xona tayyor bo'lishi kerak */
  pendingArrivals: number;
  needCleaning: number;
}> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const [departures, arrivals, pendingArrivals, needCleaning] =
    await Promise.all([
      prisma.reservation.count({
        where: {
          checkOut: { gte: start, lt: end },
          status: { in: ["CHECKED_IN", "CHECKED_OUT"] },
        },
      }),
      // Bugun kelishi kerak bo'lganlar — kirganlari ham
      prisma.reservation.count({
        where: {
          checkIn: { gte: start, lt: end },
          status: { in: ["CONFIRMED", "PENDING_PAYMENT", "CHECKED_IN"] },
        },
      }),
      // Hali kelmaganlar — aynan shular uchun xona tayyor
      // bo'lishi kerak. `arrivalsReadiness()` shu ro'yxatni
      // qaytaradi, shuning uchun sonlar mos kelsin.
      prisma.reservation.count({
        where: {
          checkIn: { gte: start, lt: end },
          status: { in: ["CONFIRMED", "PENDING_PAYMENT"] },
        },
      }),
      prisma.room.count({ where: { status: "DIRTY", isActive: true } }),
    ]);

  return { departures, arrivals, pendingArrivals, needCleaning };
}

/**
 * Bugun keladigan mehmonlar va xona tayyorligi
 * (TOZALIK-TAHLIL.md §5).
 *
 * Eng muhim savol qabulxona uchun: "103-xona bugun mehmonga
 * tayyormi?" Ilgari javob berish uchun uch joyga qarash kerak
 * edi — Shaxmatka, Xonalar, Tozalik.
 */
export async function arrivalsReadiness(): Promise<
  Array<{
    roomId: string;
    guestName: string;
    checkIn: string;
    roomStatus: string;
    ready: boolean;
    hasTask: boolean;
  }>
> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const arrivals = await prisma.reservation.findMany({
    where: {
      checkIn: { gte: start, lt: end },
      status: { in: ["CONFIRMED", "PENDING_PAYMENT"] },
    },
    select: {
      roomId: true,
      checkIn: true,
      guest: { select: { fullName: true } },
      room: { select: { status: true } },
    },
    orderBy: { roomId: "asc" },
  });

  if (arrivals.length === 0) return [];

  const tasks = await prisma.cleaningTask.findMany({
    where: {
      roomId: { in: arrivals.map((a) => a.roomId) },
      status: { in: ["NEW", "IN_PROGRESS"] },
    },
    select: { roomId: true },
  });

  const withTask = new Set(tasks.map((t) => t.roomId));

  return arrivals.map((a) => ({
    roomId: a.roomId,
    guestName: a.guest.fullName,
    checkIn: a.checkIn.toISOString().slice(0, 10),
    roomStatus: a.room.status,
    // Tayyor: iflos ham emas, ta'mirda ham emas
    ready: a.room.status === "AVAILABLE" || a.room.status === "RESERVED",
    hasTask: withTask.has(a.roomId),
  }));
}

/**
 * Kechikkan topshiriqlar (TOZALIK-TAHLIL.md §2).
 *
 * Jadval hammasini bir xil ko'rsatardi: 5 daqiqa oldin
 * yuborilgan ham, 2 soat oldin yuborilgan ham. Endi me'yordan
 * oshganlari ajratiladi.
 *
 * `NEW` — farosh hali qabul qilmadi (yaratilganidan beri)
 * `IN_PROGRESS` — qabul qildi, lekin tugatmadi (qabuldan beri)
 */
export async function lateTasks(): Promise<
  Array<{ id: string; roomId: string; minutes: number; status: string }>
> {
  const target = await getCleaningTargetMinutes();
  const cutoff = new Date(Date.now() - target * 60_000);

  const rows = await prisma.cleaningTask.findMany({
    where: {
      OR: [
        { status: "NEW", createdAt: { lt: cutoff } },
        { status: "IN_PROGRESS", acceptedAt: { lt: cutoff } },
      ],
    },
    select: { id: true, roomId: true, status: true, createdAt: true, acceptedAt: true },
  });

  const now = Date.now();

  return rows
    .map((r) => {
      const since = r.status === "NEW" ? r.createdAt : (r.acceptedAt ?? r.createdAt);
      return {
        id: r.id,
        roomId: r.roomId,
        status: r.status,
        minutes: Math.round((now - since.getTime()) / 60_000),
      };
    })
    .sort((a, b) => b.minutes - a.minutes);
}

// ============================================================
//  Hisobot
// ============================================================

export type CleanerStat = {
  employeeId: string;
  fullName: string;
  done: number;
  avgMinutes: number;
  late: number;
};

/**
 * Farroshlar samaradorligi (TOZALIK-BOT.md §9).
 *
 * `late` — me'yordan uzoq davom etganlar. Bu bandlikka ta'sir
 * qiladi: xona tez tozalansa, tezroq sotiladi.
 */
export async function cleanerStats(from: Date, toEx: Date): Promise<CleanerStat[]> {
  const target = await getCleaningTargetMinutes();

  /**
   * Farosh ISHI bo'yicha hisoblanadi: qabul qilgandan
   * "tozaladim" bosgangacha. Admin tasdiqlashini kutgan vaqt
   * faroshning aybi emas, shuning uchun `doneAt` emas
   * `finishedAt` ishlatiladi.
   */
  /**
   * `employeeId: { not: null }` SHARTI OLIB TASHLANDI
   * (2026-09-17). Guruh mantig'ida topshiriq hech kimga
   * biriktirilmaydi — `employeeId` bo'sh qoladi va hisobot
   * butunlay bo'sh chiqardi.
   *
   * Endi kim olgani `claimedByTelegramId` dan aniqlanadi.
   */
  const tasks = await prisma.cleaningTask.findMany({
    where: {
      status: { in: ["PENDING", "DONE"] },
      finishedAt: { gte: from, lt: toEx },
    },
    select: {
      employeeId: true,
      claimedByTelegramId: true,
      claimedByName: true,
      acceptedAt: true,
      finishedAt: true,
      employee: { select: { fullName: true } },
    },
  });

  const byEmployee = new Map<string, { name: string; mins: number[]; late: number }>();

  for (const t of tasks) {
    if (!t.acceptedAt || !t.finishedAt) continue;

    /**
     * Kalit: xodim yozuvi bo'lsa `employeeId`, aks holda
     * Telegram ID. Ikkalasi ham yo'q bo'lsa (eski ma'lumot)
     * o'tkazib yuboriladi — kimga yozishni bilmaymiz.
     */
    const key = t.employeeId ?? t.claimedByTelegramId;
    if (!key) continue;

    const mins = Math.round((t.finishedAt.getTime() - t.acceptedAt.getTime()) / 60_000);
    const row = byEmployee.get(key) ?? {
      name: t.employee?.fullName ?? t.claimedByName ?? "—",
      mins: [],
      late: 0,
    };

    row.mins.push(mins);
    if (mins > target) row.late += 1;
    byEmployee.set(key, row);
  }

  return [...byEmployee.entries()]
    .map(([employeeId, r]) => ({
      employeeId,
      fullName: r.name,
      done: r.mins.length,
      avgMinutes: Math.round(r.mins.reduce((s, m) => s + m, 0) / r.mins.length),
      late: r.late,
    }))
    .sort((a, b) => b.done - a.done);
}
