import type { PrzebiegImportu } from "../../../../usecases/import-klaviyo/zadania";

/** Status przebiegu po polsku z tonem plakietki (NFR33: slowo, nigdy surowy enum). */
export const STATUS_PRZEBIEGU: Record<PrzebiegImportu["status"], { slowo: string; ton: "ok" | "uwaga" | "blad" | "szkic" | "nieaktywna" | "neutral" }> = {
  uploaded: { slowo: "plik wgrany", ton: "szkic" },
  mapped: { slowo: "w kreatorze", ton: "szkic" },
  suppressions: { slowo: "do uruchomienia", ton: "szkic" },
  planned: { slowo: "w kolejce", ton: "uwaga" },
  running: { slowo: "w toku", ton: "uwaga" },
  done: { slowo: "zakończony", ton: "ok" },
  failed: { slowo: "błąd", ton: "blad" },
};
