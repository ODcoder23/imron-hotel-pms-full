-- AlterEnum
ALTER TYPE "CleaningStatus" ADD VALUE 'PENDING';

-- AlterTable
ALTER TABLE "CleaningTask" ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "finishedAt" TIMESTAMP(3);

