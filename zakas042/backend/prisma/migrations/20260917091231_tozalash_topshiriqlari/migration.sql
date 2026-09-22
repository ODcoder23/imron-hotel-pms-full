-- CreateEnum
CREATE TYPE "CleaningStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "telegramId" TEXT;

-- CreateTable
CREATE TABLE "CleaningTask" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "status" "CleaningStatus" NOT NULL DEFAULT 'NEW',
    "reason" TEXT NOT NULL,
    "isAuto" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "employeeId" TEXT,
    "chatId" TEXT,
    "messageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "CleaningTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CleaningTask_status_createdAt_idx" ON "CleaningTask"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CleaningTask_roomId_idx" ON "CleaningTask"("roomId");

-- CreateIndex
CREATE INDEX "CleaningTask_employeeId_idx" ON "CleaningTask"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_telegramId_key" ON "Employee"("telegramId");

-- AddForeignKey
ALTER TABLE "CleaningTask" ADD CONSTRAINT "CleaningTask_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleaningTask" ADD CONSTRAINT "CleaningTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleaningTask" ADD CONSTRAINT "CleaningTask_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

