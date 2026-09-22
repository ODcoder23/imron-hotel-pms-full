-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "floorId" TEXT;

-- CreateTable
CREATE TABLE "Floor" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Floor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Floor_number_key" ON "Floor"("number");

-- CreateIndex
CREATE INDEX "Room_floorId_idx" ON "Room"("floorId");

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
--  Ma'lumot migratsiyasi: mavjud xonalarni qavatlarga bog'lash
--
--  Room.floor (Int) allaqachon to'ldirilgan. Har bir noyob qiymat
--  uchun Floor yozuvi yaratiladi va xonalar unga bog'lanadi.
--  Yangi xonalar qo'shilganda ham shu ID'lar ishlatiladi.
-- ============================================================

INSERT INTO "Floor" ("id", "number", "label", "isActive", "sortOrder")
SELECT DISTINCT
  'F' || r."floor",
  r."floor",
  r."floor" || '-qavat',
  true,
  r."floor"
FROM "Room" r
ON CONFLICT ("id") DO NOTHING;

UPDATE "Room" SET "floorId" = 'F' || "floor" WHERE "floorId" IS NULL;
