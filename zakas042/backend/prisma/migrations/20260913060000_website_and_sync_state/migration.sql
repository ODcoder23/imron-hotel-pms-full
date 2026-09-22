-- Website public API va sync poyga himoyasi
--
-- Manba: 13-WEBSITE-INTEGRATSIYA.md §2, §6 (bron kodi, sig'im),
--        12-PMS-DAN-BEDS24-GA-SYNC.md §3 (parallel yuborish himoyasi)
--
-- Bu uchta o'zgarish FAZA 12–13 da qo'shilgan edi.

-- 1. Yuborilayotgan bronni belgilash (12-fayl §3)
--
-- Ikki jarayon bir vaqtda yangi bronni yuborsa, ikkalasi ham
-- `externalReservationId` bo'sh deb ko'rib Beds24'da IKKITA booking
-- yaratishi mumkin. `syncStatus = SYNCING` bilan atomar band qilish
-- shuning oldini oladi.
ALTER TYPE "EntitySyncStatus" ADD VALUE IF NOT EXISTS 'SYNCING';

-- 2. Xona turining sig'imi (13-fayl §2)
--
-- Website qidiruvida filtr: mehmon 3 kishi so'rasa, 2 kishilik tur
-- ko'rsatilmaydi.
ALTER TABLE "RoomType" ADD COLUMN IF NOT EXISTS "maxAdults" INTEGER NOT NULL DEFAULT 2;

-- 3. Mehmonga ko'rsatiladigan bron kodi (13-fayl §2, §6)
--
-- "IMR-8F3K2" — mijoz bronini shu kod bilan tekshiradi. Ichki `id`
-- (cuid) berilmaydi: u uzun va boshqa bronlarni taxmin qilishga
-- yo'l ochishi mumkin.
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "code" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Reservation_code_key" ON "Reservation"("code");
