import { prisma } from "../src/lib/prisma.js";

async function main() {
  try {
    const records = await prisma.$queryRaw`SELECT * FROM "BotAccess";`;
    console.log("Current BotAccess records:", records);
  } catch (e: any) {
    console.error("Error inspecting BotAccess:", e.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
