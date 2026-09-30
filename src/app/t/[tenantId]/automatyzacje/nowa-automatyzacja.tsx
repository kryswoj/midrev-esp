"use client";

import { useActionState, useState } from "react";
import { utworzAutomatyzacjeAkcja } from "./akcje";
import { BladFormularza } from "../../../blad-formularza";

/**
 * Nowa automatyzacja od zera: nazwa i wyzwalacz. Reszta (kroki, maile, warunki) powstaje
 * na kanwie, na ktora formularz przekierowuje po utworzeniu. useActionState (audyt B4):
 * blad z use-case'u wraca do formularza z echem wartosci, nie kasuje wpisanych pol.
 */
export function NowaAutomatyzacja({
  tenantId,
  triggery,
  listy,
}: {
  tenantId: string;
  triggery: Record<string, string>;
  listy: { id: string; name: string }[];
}) {
  const [stan, akcja, trwa] = useActionState(utworzAutomatyzacjeAkcja, undefined);
  const [zdarzenie, setZdarzenie] = useState(stan?.wartosci?.zdarzenie ?? Object.keys(triggery)[0] ?? "list.joined");

  return (
    <form action={akcja} className="space-y-4">
      <input type="hidden" name="tenantId" value={tenantId} />
      <BladFormularza blad={stan?.blad} />
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_260px]">
        <label className="block">
          <span className="etykieta mb-1.5 block">Nazwa</span>
          <input name="nazwa" required maxLength={200} placeholder="np. Powitanie po zapisie" defaultValue={stan?.wartosci?.nazwa ?? ""} className="pole" />
        </label>
        <label className="block">
          <span className="etykieta mb-1.5 block">Wyzwalacz</span>
          <select name="zdarzenie" className="pole" value={zdarzenie} onChange={(e) => setZdarzenie(e.target.value)}>
            {Object.entries(triggery).map(([wartosc, etykieta]) => (
              <option key={wartosc} value={wartosc}>{etykieta}</option>
            ))}
          </select>
        </label>
      </div>
      {zdarzenie === "list.joined" ? (
        <label className="block md:max-w-[420px]">
          <span className="etykieta mb-1.5 block">Lista</span>
          {listy.length ? (
            <select name="listId" className="pole" defaultValue={stan?.wartosci?.listId ?? listy[0].id}>
              {listy.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          ) : (
            <p className="text-[13px] text-[var(--color-tekst-2)]">Nie ma jeszcze żadnej listy. Utwórz ją w zakładce Listy.</p>
          )}
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button className="przycisk" type="submit" disabled={trwa || (zdarzenie === "list.joined" && listy.length === 0)}>
          {trwa ? "Tworzę…" : "Utwórz i otwórz kanwę"}
        </button>
        <span className="text-[13px] text-[var(--color-tekst-2)]">Powstanie jako szkic. Nic nie wyjdzie, dopóki nie włączysz automatyzacji na kanwie.</span>
      </div>
    </form>
  );
}
