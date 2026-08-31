"use client";

import { useActionState } from "react";
import { utworzAutomatyzacjeAkcja } from "./akcje";
import { BladFormularza } from "../../../blad-formularza";

// Formularz nowej automatyzacji przez useActionState (audyt B4): blad z use-case'u
// (np. duplikat nazwy) nie kasuje juz recznie pisanego HTML-a maila.
export function FormularzAutomatyzacji({
  tenantId,
  triggery,
}: {
  tenantId: string;
  triggery: Record<string, string>;
}) {
  const [stan, akcja, trwa] = useActionState(utworzAutomatyzacjeAkcja, undefined);

  return (
    <form action={akcja} className="space-y-3">
      <input type="hidden" name="tenantId" value={tenantId} />
      <BladFormularza blad={stan?.blad} />
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-2)]">Nazwa</span>
        <input
          name="nazwa"
          required
          placeholder="np. Powitanie po zapisie"
          defaultValue={stan?.wartosci?.nazwa ?? ""}
          className="pole"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-2)]">Wyzwalacz</span>
        <select
          name="trigger"
          className="pole"
          defaultValue={stan?.wartosci?.trigger ?? "popup.submitted"}
        >
          {Object.entries(triggery).map(([wartosc, etykieta]) => (
            <option key={wartosc} value={wartosc}>
              {etykieta}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-2)]">
          Opóźnienie (minuty od zdarzenia)
        </span>
        <input
          name="opoznienie"
          type="number"
          min={0}
          defaultValue={stan?.wartosci?.opoznienie ?? "0"}
          className="pole"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-2)]">Temat wiadomości</span>
        <input
          name="temat"
          required
          placeholder="to zobaczy odbiorca"
          defaultValue={stan?.wartosci?.temat ?? ""}
          className="pole"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-2)]">Treść (HTML)</span>
        <textarea
          name="html"
          required
          rows={6}
          placeholder="<p>Cześć!</p>"
          defaultValue={stan?.wartosci?.html ?? ""}
          className="pole font-mono text-xs"
        />
      </label>
      <button className="przycisk w-full justify-center" type="submit" disabled={trwa}>
        {trwa ? "Tworzę…" : "Utwórz automatyzację"}
      </button>
    </form>
  );
}
