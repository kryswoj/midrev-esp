import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup-env.ts"],
    // Testy integracyjne dziela jedna baze sandboxa, wiec pliki ida po kolei.
    // Rownolegle sprzatanie jednego pliku wywracalo dane drugiego.
    fileParallelism: false,
  },
});
