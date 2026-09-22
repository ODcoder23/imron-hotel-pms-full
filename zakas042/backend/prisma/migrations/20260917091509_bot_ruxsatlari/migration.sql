-- CreateEnum
CREATE TYPE "BotAccessLevel" AS ENUM ('FULL', 'LIMITED');

-- CreateTable
CREATE TABLE "BotAccess" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "level" "BotAccessLevel" NOT NULL DEFAULT 'LIMITED',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "BotAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BotAccess_telegramId_key" ON "BotAccess"("telegramId");

-- CreateIndex
CREATE INDEX "BotAccess_isActive_idx" ON "BotAccess"("isActive");

