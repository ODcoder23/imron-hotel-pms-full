-- AlterTable
ALTER TABLE "BotAccess" ADD COLUMN IF NOT EXISTS "botType" TEXT NOT NULL DEFAULT 'FOUNDER';
ALTER TABLE "BotAccess" ADD COLUMN IF NOT EXISTS "username" TEXT;
ALTER TABLE "BotAccess" ALTER COLUMN "telegramId" DROP NOT NULL;
ALTER TABLE "BotAccess" ALTER COLUMN "level" SET DEFAULT 'FULL';

-- DropIndex
DROP INDEX IF EXISTS "BotAccess_telegramId_key";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BotAccess_botType_idx" ON "BotAccess"("botType");
CREATE INDEX IF NOT EXISTS "BotAccess_telegramId_idx" ON "BotAccess"("telegramId");
CREATE INDEX IF NOT EXISTS "BotAccess_username_idx" ON "BotAccess"("username");
