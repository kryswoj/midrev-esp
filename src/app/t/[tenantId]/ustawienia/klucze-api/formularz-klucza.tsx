"use client";

import { useActionState } from "react";
import { Kopiuj } from "../wysylka/kopiuj";
import { utworzKluczAkcja, type StanNowegoKlucza } from "./akcje";

/**
 * Tworzenie klucza. Klucz widać RAZ, zaraz po utworzeniu: w bazie jest tylko jego hash,
 * więc po odświeżeniu strony nie da się go już pokazać (jak w Klaviyo).
 */
export function FormularzKlucza({
  tenantId,
  zakresy,
}: {
  tenantId: string;
  zakresy: { wartosc: string; opis: string; domyslny: boolean }[];
}) {
  const [stan, akcja, trwa] = useActionState<StanNowegoKlucza | undefined, FormData>(utworzKluczAkcja, undefined);
  return (
    <div className="space-y-3">
      {stan?.nowy ? (
        <div className="rounded-lg border border-[var(--color-ok,#16a34a)] p-3" role="status">
          <p className="text-[13px] font-[600]">Klucz „{stan.nowy.nazwa}” utworzony. Skopiuj go teraz: nie pokażemy go drugi raz.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-[var(--color-tlo-2,#f4f4f5)] px-2 py-1 text-[12px]">{stan.nowy.jawny}</code>
            <Kopiuj wartosc={stan.nowy.jawny} etykieta="klucz API" />
          </div>
          <p className="mt-2 text-[12px] text-[var(--color-tekst-2)]">
            W n8n: nagłówek <code>Authorization</code> = <code>Klaviyo-API-Key {stan.nowy.prefiks}…</code> (cały klucz), nagłówek <code>revision</code> bez zmian.
          </p>
        </div>
      ) : null}
      {stan?.blad ? <p className="text-[13px] text-[var(--color-blad,#dc2626)]" role="alert">{stan.blad}</p> : null}
      <form action={akcja} className="space-y-3">
        <input type="hidden" name="tenantId" value={tenantId} />
        <label className="block text-[13px]">
          <span className="font-[600]">Nazwa</span>
          <input name="nazwa" required maxLength={80} placeholder="np. n8n quiz" className="pole mt-1 w-full" />
        </label>
        <fieldset className="text-[13px]">
          <legend className="font-[600]">Zakresy</legend>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {zakresy.map((z) => (
              <label key={z.wartosc} className="flex items-center gap-2">
                <input type="checkbox" name="zakresy" value={z.wartosc} defaultChecked={z.domyslny} />
                <span>
                  {z.opis} <code className="text-[11px] text-[var(--color-tekst-3)]">{z.wartosc}</code>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" disabled={trwa} className="przycisk">
          {trwa ? "Tworzę…" : "Utwórz klucz"}
        </button>
      </form>
    </div>
  );
}
