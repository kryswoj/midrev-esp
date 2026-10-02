"use client";

import { EkranBledu } from "./ui/ekran-bledu";

/**
 * Nieprzewidziany wyjątek bez tej strony to surowa pięćsetka poza systemem „Dzień”.
 * Błąd starej karty po wdrożeniu dostaje komunikat „odśwież stronę” (ui/blad-wersji.ts).
 */
export default function Blad({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-plotno)] px-6">
      <EkranBledu error={error} reset={reset} powrot={{ href: "/", etykieta: "Wróć do listy sklepów" }} />
    </main>
  );
}
