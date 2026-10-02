"use client";

import { useParams } from "next/navigation";
import { EkranBledu } from "../../ui/ekran-bledu";

/**
 * Błąd strony panelu konta: rama (pasek, nawigacja) zostaje, a w miejscu treści
 * pojawia się komunikat. Stara karta po wdrożeniu: „Panel został zaktualizowany.
 * Odśwież stronę.” (ui/blad-wersji.ts); każdy inny błąd: ogólny ekran z ponowieniem.
 */
export default function BladKonta({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { tenantId } = useParams<{ tenantId: string }>();
  return (
    <div className="flex min-h-[60vh] items-center justify-center py-12">
      <EkranBledu error={error} reset={reset} powrot={tenantId ? { href: `/t/${tenantId}`, etykieta: "Wróć do przeglądu" } : undefined} />
    </div>
  );
}
