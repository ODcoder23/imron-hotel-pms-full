import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Modul importlaridan OLDIN ishlaydi — config.ts env'ni topadi
    setupFiles: ["./vitest.setup.ts"],
    // Testlar bir xil DB va mock holatiga tegadi — ketma-ket
    fileParallelism: false,
    testTimeout: 30_000,

    /**
     * Hook chegarasi 30 s (vitest standarti 10 s).
     *
     * NEGA: baza serverda (Contabo VPS) va SSH tunnel orqali
     * keladi — har so'rov ~0.5-1.5 s oladi. `beforeEach` da esa
     * bir necha tozalash amali bor (syncLog, webhookEvent,
     * ratePlan, mapping), jami 10 s dan oshadi.
     *
     * Mahalliy bazada bu chegara sezilmaydi; tunnel orqali esa
     * usiz testlar "Hook timed out" bilan yiqiladi.
     */
    hookTimeout: 30_000,
  },
});
