"use client";

import { useState } from "react";
import { duplikujKampanieAkcja, usunSzkicKampaniiAkcja } from "../../../akcje";

/**
 * Akcje przy kampanii: „Duplikuj" (lista i szczegół) oraz „Usuń" dla szkicu (lista).
 *
 * Przyciski stoją w wierszu tabeli, który cały jest linkiem (`wiersz-link-cel::after`
 * kryje wiersz), więc same podnoszą się nad tę warstwę (`relative z-[1]`) — inaczej klik
 * w „Usuń" otwierałby kampanię.
 */

export function PrzyciskDuplikuj({ tenantId, campaignId, maly = true }: { tenantId: string; campaignId: string; maly?: boolean }) {
  const [trwa, setTrwa] = useState(false);
  return (
    <form action={duplikujKampanieAkcja} onSubmit={() => setTrwa(true)} className="relative z-[1] inline-flex">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="campaignId" value={campaignId} />
      <button
        type="submit"
        disabled={trwa}
        className={`przycisk przycisk-wtorny ${maly ? "przycisk-maly" : ""}`}
        title="Nowy szkic z tą samą treścią, tematem i odbiorcami. Bez planu i akceptacji klienta."
      >
        {trwa ? "Kopiuję…" : "Duplikuj"}
      </button>
    </form>
  );
}

/**
 * Usunięcie szkicu w dwóch krokach: pierwszy klik pokazuje pytanie z nazwą kampanii,
 * dopiero drugi wysyła formularz z `potwierdzenie=tak`. Bez okna `confirm()`, żeby
 * pytanie było w tym samym miejscu, w którym operator patrzy.
 */
export function PrzyciskUsunSzkic({ tenantId, campaignId, nazwa }: { tenantId: string; campaignId: string; nazwa: string }) {
  const [pyta, setPyta] = useState(false);
  const [trwa, setTrwa] = useState(false);
  if (!pyta) {
    return (
      <button
        type="button"
        onClick={() => setPyta(true)}
        className="przycisk przycisk-wtorny przycisk-maly relative z-[1] hover:!border-[var(--color-blad)] hover:!text-[var(--color-blad)]"
        aria-label={`Usuń szkic ${nazwa}`}
      >
        Usuń
      </button>
    );
  }
  return (
    <form
      action={usunSzkicKampaniiAkcja}
      onSubmit={() => setTrwa(true)}
      className="relative z-[1] flex flex-wrap items-center gap-2"
      role="group"
      aria-label={`Potwierdź usunięcie szkicu ${nazwa}`}
    >
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="potwierdzenie" value="tak" />
      <span className="text-[13px] text-[var(--color-tekst-2)]">Usunąć szkic na stałe?</span>
      <button type="submit" disabled={trwa} className="przycisk przycisk-niebezpieczny przycisk-maly" autoFocus>
        {trwa ? "Usuwam…" : "Usuń"}
      </button>
      <button type="button" disabled={trwa} onClick={() => setPyta(false)} className="przycisk przycisk-wtorny przycisk-maly">
        Anuluj
      </button>
    </form>
  );
}
