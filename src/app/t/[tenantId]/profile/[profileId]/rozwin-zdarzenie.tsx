"use client";

import { useState, useTransition } from "react";
import { wlasciwosciZdarzeniaAkcja } from "./akcje-osi";

/** Rozwinięcie wpisu osi: właściwości ładowane dopiero na klik (6.4). */
export function RozwinZdarzenie({ tenantId, profileId, id, occurredAt, ile }: { tenantId: string; profileId: string; id: string; occurredAt: string; ile: number }) {
  const [tresc, ustawTresc] = useState<string | null | undefined>(undefined);
  const [otwarte, ustawOtwarte] = useState(false);
  const [trwa, startTransition] = useTransition();
  if (ile === 0) return <span className="tekst-meta">bez właściwości</span>;
  return (
    <div className="mt-1">
      <button
        type="button"
        className="tekst-pomocniczy font-medium !text-[var(--color-akcent)]"
        aria-expanded={otwarte}
        onClick={() => {
          const nastepne = !otwarte;
          ustawOtwarte(nastepne);
          if (nastepne && tresc === undefined) {
            startTransition(async () => ustawTresc(await wlasciwosciZdarzeniaAkcja(tenantId, profileId, id, occurredAt)));
          }
        }}
      >
        {otwarte ? "Zwiń właściwości" : `Pokaż właściwości (${ile})`}
      </button>
      {otwarte ? (
        trwa || tresc === undefined ? (
          <p className="tekst-meta mt-1">Wczytuję…</p>
        ) : tresc === null ? (
          <p className="tekst-meta mt-1">Nie znaleziono zdarzenia.</p>
        ) : (
          <pre className="mt-1 max-h-80 overflow-auto rounded-md bg-[var(--color-powierzchnia-2)] p-2 text-[12px] leading-4 whitespace-pre-wrap break-all">{tresc}</pre>
        )
      ) : null}
    </div>
  );
}
