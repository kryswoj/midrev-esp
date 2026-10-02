"use client";

import "./globals.css";
import { EkranBledu } from "./ui/ekran-bledu";

/**
 * Ostatnia linia: błąd w samym root layoucie (albo taki, którego nie złapał żaden
 * error.tsx). Zastępuje cały dokument, więc ma własne <html> i <body>.
 */
export default function BladGlobalny({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="pl">
      <body>
        <main className="flex min-h-screen items-center justify-center bg-[var(--color-plotno)] px-6">
          <EkranBledu error={error} reset={reset} powrot={{ href: "/", etykieta: "Wróć do listy sklepów" }} />
        </main>
      </body>
    </html>
  );
}
