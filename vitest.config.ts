import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Osobna baza `midrev_esp_test`: globalSetup ja zaklada i migruje, setup-env przepina
    // DATABASE_URL i odmawia startu na bazie bez sufiksu `_test` (tests/baza-testowa.ts).
    // Dzieki temu testy nie dziela danych z serwerem :3005 ani z zywym workerem.
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/setup-env.ts"],
    // Pliki dalej ida po kolei: dziela jedna baze testowa, a rownolegle sprzatanie
    // jednego pliku wywracalo dane drugiego.
    fileParallelism: false,
  },
});
