/**
 * Availability sync — PMS -> Beds24 (FAZA 9)
 *
 * Manba: 07-AVAILABILITY-VA-RATES-SYNC.md §1–§4
 * TZ 6-band:  "Xona band qilinsa Beds24'da availability kamayadi,
 *              bekor qilinsa qayta oshadi. Har bir o'zgarish queue
 *              orqali yuborilsin."
 * TZ 20-band: PMS va Beds24 bir xil inventory ko'rishi kerak.
 *
 * IKKI DARAJA (07-fayl §1):
 *   PMS ichida  — aniq xona (101, 102, ...) = haqiqat manbai
 *   Beds24'ga   — room type bo'yicha SON (numAvail)
 * Ikkinchisi birinchisidan hisoblab chiqariladi, qo'lda yozilmaydi.
 *
 * KREDIT TEJASH (07-fayl §4) — uch daraja:
 *   1. `syncedCount` bilan solishtirish: o'zgarmagan kun yuborilmaydi
 *   2. Ketma-ket bir xil qiymatli kunlar bitta oraliqqa yig'iladi
 *      (adapter ichida, `groupConsecutive`)
 *   3. Debounce: bir necha o'zgarish bitta job'ga birlashadi
 */

import { prisma } from "../lib/prisma.js";
import { toDateKey, fromDateKey } from "../lib/serialize.js";
import { logPush } from "../lib/syncLog.js";
import { findRoomTypeMapping } from "./mapping.js";
import { getChannel } from "./channel/registry.js";
import { notifyAvailability } from "../realtime/notify.js";
import { availabilitySyncQueue, enqueueWithTimeout } from "../queues/index.js";

/**
 * Debounce oynasi (07-fayl §4, kredit tejash 3-daraja).
 *
 * Shu vaqt ichidagi bir necha o'zgarish bitta yuborishga birlashadi.
 * Job ham shuncha kechikish bilan boshlanadi — oxirgi o'zgarish ham
 * hisobga olinishi uchun.
 */
const DEBOUNCE_MS = 3000;

/** Bir turning bir kunlik holati */
export type AvailabilityDay = {
  date: string;            // "YYYY-MM-DD"
  availableCount: number;
  syncedCount: number | null;
  totalRooms: number;
};

export type PushOutcome =
  | { status: "sent"; roomTypeId: string; days: number; detail: string }
  | { status: "skipped"; roomTypeId: string; reason: string }
  | { status: "failed"; roomTypeId: string; error: string };

// ============================================================
//  1. Qayta hisoblash (07-fayl §2 agregatsiya formulasi)
// ============================================================

/**
 * Availability'ni qayta hisoblaydi (07-fayl §2 agregatsiya formulasi).
 *
 * TRANZAKSIYADAN TASHQARIDA chaqiriladi. Sabab: bu funksiya butun
 * room type bo'yicha o'qiydi, shuning uchun `Serializable` tranzaksiya
 * ichida bo'lsa — turli xonalarga parallel bron ham konflikt beradi
 * (ikkalasi bir xil `Availability` sahifalariga tegadi).
 *
 * Overbooking himoyasiga ta'sir qilmaydi: u `reservation_no_overlap`
 * constraint bilan ta'minlanadi, `Availability` esa hisobot/keshdir.
 * Vaqtincha eskirgan qiymat zarar keltirmaydi — keyingi chaqiruv
 * to'g'rilaydi.
 *
 * Bitta SQL so'rov bilan bajariladi — N+1 dan qochish uchun.
 */
export async function recalcAvailability(
  roomTypeIds: string[],
  from: Date,
  to: Date
): Promise<void> {
  if (roomTypeIds.length === 0) return;

  // Bitta so'rov: har tur × har kun uchun band xonalar soni.
  // generate_series sana oralig'ini yoyadi, LEFT JOIN bronlarni sanaydi.
  await prisma.$executeRaw`
    INSERT INTO "Availability" (
      id, "roomTypeId", date, "totalRooms", "bookedRooms",
      "blockedRooms", "availableCount", "updatedAt"
    )
    SELECT
      gen_random_uuid()::text,
      rt.id,
      d.date::date,
      rt.total,
      COALESCE(b.cnt, 0),
      COALESCE(bl.cnt, 0),
      GREATEST(0, rt.total - COALESCE(b.cnt, 0) - COALESCE(bl.cnt, 0)),
      NOW()
    FROM (
      SELECT t.id, COUNT(r.id)::int AS total
      FROM "RoomType" t
      LEFT JOIN "Room" r ON r."roomTypeId" = t.id AND r."isActive" = true
      WHERE t.id = ANY(${roomTypeIds})
      GROUP BY t.id
    ) rt
    CROSS JOIN generate_series(${from}::date, ${to}::date - 1, '1 day') AS d(date)
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt
      FROM "Reservation" res
      JOIN "Room" rm ON rm.id = res."roomId"
      WHERE rm."roomTypeId" = rt.id
        AND res.status NOT IN ('CANCELLED', 'NO_SHOW')
        AND res."checkIn" <= d.date
        AND res."checkOut" > d.date
    ) b ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt
      FROM "RoomDayStatus" rds
      JOIN "Room" rm ON rm.id = rds."roomId"
      WHERE rm."roomTypeId" = rt.id
        AND rds.date = d.date
        AND rds."isBlocked" = true
    ) bl ON true
    ON CONFLICT ("roomTypeId", date) DO UPDATE SET
      "totalRooms"     = EXCLUDED."totalRooms",
      "bookedRooms"    = EXCLUDED."bookedRooms",
      "blockedRooms"   = EXCLUDED."blockedRooms",
      "availableCount" = EXCLUDED."availableCount",
      "updatedAt"      = NOW()
  `;
}

// ============================================================
//  2. Oraliqni o'qish
// ============================================================

/**
 * Oraliqdagi kunlarni qaytaradi.
 *
 * `recalcAvailability` (FAZA 2) hisoblab `Availability` jadvaliga
 * yozib qo'ygan. Bu funksiya faqat o'qiydi — qayta hisoblamaydi,
 * chunki hisob bronni yaratgan tranzaksiyadan KEYIN darhol bajarilgan.
 *
 * `to` CHIQMAYDI: `'[)'` chegara qoidasi (02-fayl §4). Mehmon
 * checkOut kuni xonada yo'q, ya'ni o'sha kun band emas.
 */
export async function readRange(
  roomTypeId: string,
  from: Date,
  to: Date
): Promise<AvailabilityDay[]> {
  const rows = await prisma.availability.findMany({
    where: {
      roomTypeId,
      date: { gte: from, lt: to },
    },
    orderBy: { date: "asc" },
  });

  return rows.map((r) => ({
    date: toDateKey(r.date) ?? "",
    availableCount: r.availableCount,
    syncedCount: r.syncedCount,
    totalRooms: r.totalRooms,
  }));
}

// ============================================================
//  3. Beds24'ga yuborish
// ============================================================

/**
 * Bitta room type uchun oraliqni Beds24'ga yuboradi.
 *
 * QAT'IY QOIDA (06-fayl §3): mapping topilmasa yuborilmaydi va
 * taxminiy mapping ASLO ishlatilmaydi — noto'g'ri room type'ga
 * ketgan son real overbooking keltiradi.
 */
export async function pushAvailability(
  roomTypeId: string,
  from: Date,
  to: Date
): Promise<PushOutcome> {
  const started = Date.now();

  // --- 1. Mapping ---
  const mapping = await findRoomTypeMapping(roomTypeId);
  if (!mapping?.externalRoomTypeId) {
    const reason = `mapping topilmadi: ${roomTypeId}`;
    await logPush("push_availability", "FAILED", { errorMessage: reason });
    return { status: "failed", roomTypeId, error: reason };
  }

  // --- 2. Kunlarni o'qish ---
  const days = await readRange(roomTypeId, from, to);
  if (days.length === 0) {
    await logPush("push_availability", "SKIPPED", {
      response: { detail: "oraliqda kun yo'q" },
    });
    return { status: "skipped", roomTypeId, reason: "oraliqda kun yo'q" };
  }

  // --- 3. Faqat O'ZGARGAN kunlar (kredit tejash 1-daraja) ---
  const changed = days.filter((d) => d.availableCount !== d.syncedCount);
  if (changed.length === 0) {
    await logPush("push_availability", "SKIPPED", {
      response: { detail: `${days.length} kun tekshirildi, o'zgarish yo'q` },
    });
    return { status: "skipped", roomTypeId, reason: "o'zgarish yo'q" };
  }

  // --- 4. Yuborish (oraliqqa yig'ish adapter ichida) ---
  const result = await getChannel().pushAvailability({
    externalRoomTypeId: mapping.externalRoomTypeId,
    days: changed.map((d) => ({ date: d.date, available: d.availableCount })),
  });

  const durationMs = Date.now() - started;

  if (!result.ok) {
    await logPush("push_availability", "FAILED", {
      request: { roomTypeId, from: toDateKey(from), to: toDateKey(to), days: changed.length },
      errorMessage: result.error,
      durationMs,
    });
    // Xato retryable bo'lsa worker qayta uradi — shu yerda yutib
    // yubormaymiz, chaqiruvchi qaror qiladi.
    return { status: "failed", roomTypeId, error: result.error };
  }

  // --- 5. Yuborilgan qiymatni belgilash ---
  // Endi bu kunlar qayta yuborilmaydi (kredit tejash 1-daraja asosi).
  await markSynced(roomTypeId, changed);

  await logPush("push_availability", "SUCCESS", {
    request: { roomTypeId, externalRoomTypeId: mapping.externalRoomTypeId, days: changed.length },
    response: { detail: result.detail },
    durationMs,
  });

  return {
    status: "sent",
    roomTypeId,
    days: changed.length,
    detail: result.detail ?? `${changed.length} kun`,
  };
}

/**
 * `syncedCount` ni yangilaydi.
 *
 * Bitta SQL: har kun uchun alohida UPDATE qilish 30 kunlik oraliqda
 * 30 so'rov bo'lardi.
 */
async function markSynced(roomTypeId: string, days: AvailabilityDay[]): Promise<void> {
  if (days.length === 0) return;

  const dates = days.map((d) => fromDateKey(d.date));
  const counts = days.map((d) => d.availableCount);

  await prisma.$executeRaw`
    UPDATE "Availability" a
    SET "syncedCount" = v.count, "syncedAt" = NOW()
    FROM (
      SELECT unnest(${dates}::date[]) AS date, unnest(${counts}::int[]) AS count
    ) v
    WHERE a."roomTypeId" = ${roomTypeId} AND a.date = v.date
  `;
}

// ============================================================
//  4. Bir necha turni birga yuborish (worker chaqiradi)
// ============================================================

export type SyncRangeResult = {
  outcomes: PushOutcome[];
  sent: number;
  skipped: number;
  failed: number;
};

/**
 * Job'dagi barcha turlarni yuboradi.
 *
 * Bir tur yiqilsa qolganlari baribir yuboriladi — qisman muvaffaqiyat
 * to'liq muvaffaqiyatsizlikdan yaxshi (TZ 17-band). Yiqilganlar
 * `failed` sifatida qaytadi, worker qayta urinish haqida qaror qiladi.
 */
export async function syncAvailabilityRange(
  roomTypeIds: string[],
  fromKey: string,
  toKey: string,
  opts: { recalc?: boolean } = {}
): Promise<SyncRangeResult> {
  const from = fromDateKey(fromKey);
  const to = fromDateKey(toKey);

  // Job navbatda turganda yana bron kelishi mumkin — eng so'nggi
  // holatni olish uchun qayta hisoblash imkoniyati.
  if (opts.recalc) {
    await recalcAvailability(roomTypeIds, from, to);
  }

  const outcomes: PushOutcome[] = [];
  for (const roomTypeId of roomTypeIds) {
    outcomes.push(await pushAvailability(roomTypeId, from, to));
  }

  return {
    outcomes,
    sent: outcomes.filter((o) => o.status === "sent").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
  };
}

// ============================================================
//  5. Trigger — navbatga qo'yish (07-fayl §3)
// ============================================================

/**
 * Availability sync'ni navbatga qo'yadi.
 *
 * DEBOUNCE (07-fayl §4, kredit tejash 3-daraja): bir xil tur va
 * oraliq uchun `jobId` bir xil bo'ladi, `delay` bilan qo'yiladi.
 * BullMQ bir xil `jobId`li job'ni ikkinchi marta qabul qilmaydi,
 * shuning uchun 3 soniya ichidagi bir necha o'zgarish bitta
 * yuborishga birlashadi.
 *
 * Redis yo'q bo'lsa xato TASHLANMAYDI: bron yaratish availability
 * yuborilmagani uchun yiqilmasligi kerak (TZ 17, 19-band). Qiymat
 * `Availability` jadvalida to'g'ri turadi, keyingi o'zgarishda yoki
 * drift tekshiruvida yuboriladi.
 */
export async function enqueueAvailabilitySync(
  roomTypeIds: string[],
  from: Date,
  to: Date,
  reason: string
): Promise<{ queued: boolean; jobId?: string }> {
  if (roomTypeIds.length === 0) return { queued: false };

  const fromKey = toDateKey(from) ?? "";
  const toKey = toDateKey(to) ?? "";
  const types = [...new Set(roomTypeIds)].sort();

  // Debounce oynasi: bir xil tur+oraliq uchun bitta job.
  //
  // BullMQ `jobId`da ":" belgisini QABUL QILMAYDI ("Custom Id cannot
  // contain :") — Redis kalitlarida ajratgich sifatida ishlatiladi.
  // Shuning uchun "_" bilan tuzamiz va sanadagi "-" ni olib tashlaymiz.
  //
  // `jobId`ga OYNA RAQAMI ham kiradi. Sababi: BullMQ tugagan job'ni
  // 24 soat saqlaydi (`removeOnComplete.age`) va o'sha `jobId`li
  // yangi job'ni JIM RAD ETADI. Oyna raqamisiz bir marta yuborilgan
  // oraliq bir sutka davomida qayta yuborilmas edi — bron bekor
  // qilinsa Beds24 eski sonni ko'rib qolardi (TZ 6-band buzilishi).
  //
  // Oyna = DEBOUNCE_MS uzunlikdagi vaqt bo'lagi. Shu bo'lak ichidagi
  // bir necha o'zgarish birlashadi (kredit tejash 3-daraja), keyingi
  // bo'lakda esa yangi job qabul qilinadi.
  const dateKey = (k: string) => k.replace(/-/g, "");
  const window = Math.floor(Date.now() / DEBOUNCE_MS);
  const jobId = `avail_${types.join("-")}_${dateKey(fromKey)}_${dateKey(toKey)}_${window}`;

  const added = await enqueueWithTimeout(
    () => availabilitySyncQueue.add(
      "sync",
      { roomTypeIds: types, from: fromKey, to: toKey, reason },
      { jobId, delay: DEBOUNCE_MS }
    ),
    `availability-sync (${reason})`
  );

  return added ? { queued: true, jobId } : { queued: false };
}

// ============================================================
//  6. Qayta hisoblash + yuborish (bron amallaridan chaqiriladi)
// ============================================================

/**
 * Bron o'zgarganda chaqiriladi: hisoblash + event + navbat.
 *
 * TARTIB MUHIM:
 *   1. `recalcAvailability` — DB'dagi son to'g'ri bo'ladi
 *   2. `notifyAvailability` — Website/Admin darhol ko'radi
 *   3. `enqueueAvailabilitySync` — Beds24'ga debounce bilan
 *
 * Uchinchisi sekin (tashqi API), shuning uchun oxirida va navbat
 * orqali. Birinchi ikkitasi darhol.
 */
export async function onAvailabilityChanged(
  roomTypeIds: string[],
  from: Date,
  to: Date,
  reason: string
): Promise<void> {
  if (roomTypeIds.length === 0) return;

  await recalcAvailability(roomTypeIds, from, to);
  notifyAvailability(roomTypeIds, from, to);
  await enqueueAvailabilitySync(roomTypeIds, from, to, reason);
}
