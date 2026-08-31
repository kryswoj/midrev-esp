"use client";

import Link from "next/link";

/**
 * Nieprzewidziany wyjątek bez tej strony to surowa pięćsetka poza systemem "Noc".
 * Szczegół błędu zostaje w logu serwera, nie na ekranie operatora.
 */
export default function Blad({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-plotno)] px-6">
      <div className="karta max-w-md p-6">
        <p className="etykieta mb-2">Błąd</p>
        <h1>Coś poszło nie tak</h1>
        <p className="mt-2 text-[13px] text-[var(--color-tekst-2)]">
          Panel nie zdołał wyrenderować tej strony. Spróbuj ponownie, a jeśli błąd wraca,
          zgłoś go z adresem strony, na której wystąpił.
        </p>
        <div className="mt-4 flex gap-2">
          <button className="przycisk" type="button" onClick={reset}>
            Spróbuj ponownie
          </button>
          <Link href="/" className="przycisk przycisk-wtorny">
            Wróć do listy sklepów
          </Link>
        </div>
      </div>
    </main>
  );
}
