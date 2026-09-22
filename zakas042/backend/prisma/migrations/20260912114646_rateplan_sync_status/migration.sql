-- AlterTable
ALTER TABLE "RatePlan" ADD COLUMN     "syncError" TEXT,
ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "RatePlan_syncedAt_idx" ON "RatePlan"("syncedAt");
