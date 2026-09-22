-- ============================================================
--  Overbooking himoyasi — TZ 3-band
--  "OVERBOOKING BO'LMASLIGI SHART"
--
--  Bu constraint'ni Prisma o'zi yarata olmaydi (EXCLUDE
--  qo'llab-quvvatlanmaydi), shuning uchun qo'lda yozilgan.
--  Hujjat: 02-DATABASE-SXEMA.md §2
--
--  Nima qiladi: bitta xonaga, sana oralig'i kesishadigan ikkita
--  FAOL bron yaratilishini DATABASE darajasida taqiqlaydi.
--  Dastur mantig'i xato qilsa ham, ikki parallel so'rov bir
--  vaqtda kelsa ham — ikkinchisi 23P01 xatosi bilan rad etiladi.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- '[)' chegara qoidasi: checkIn kiradi, checkOut kirmaydi.
-- Ya'ni bir mehmon 10-da chiqsa, boshqasi 10-da kirishi mumkin.
-- Bu Shaxmatka frontendidagi `ci < rco && co > rci` mantig'i
-- bilan aynan bir xil (index (7).html, isRoomAvailable).
ALTER TABLE "Reservation"
  ADD CONSTRAINT reservation_no_overlap
  EXCLUDE USING gist (
    "roomId" WITH =,
    daterange("checkIn"::date, "checkOut"::date, '[)') WITH &&
  )
  WHERE (status NOT IN ('CANCELLED', 'NO_SHOW'));
