import { prisma } from "../src/lib/prisma.js";

async function main() {
  console.log("Applying BotAccess migration...");
  await prisma.$executeRawUnsafe(`ALTER TABLE "BotAccess" ADD COLUMN IF NOT EXISTS "botType" TEXT NOT NULL DEFAULT 'FOUNDER';`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "BotAccess" ADD COLUMN IF NOT EXISTS "username" TEXT;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "BotAccess" ALTER COLUMN "telegramId" DROP NOT NULL;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "BotAccess" ALTER COLUMN "level" SET DEFAULT 'FULL';`);
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "BotAccess_telegramId_key";`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BotAccess_botType_idx" ON "BotAccess"("botType");`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BotAccess_telegramId_idx" ON "BotAccess"("telegramId");`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BotAccess_username_idx" ON "BotAccess"("username");`);
  console.log("BotAccess migration applied successfully!");
}

main().catch(console.error).finally(() => prisma.$disconnect());
