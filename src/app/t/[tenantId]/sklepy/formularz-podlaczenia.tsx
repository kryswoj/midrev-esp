"use client";

import { useActionState } from "react";
import { podlaczSklepAkcja } from "../../../akcje";
import { BladFormularza } from "../../../blad-formularza";

// Formularz podłączenia sklepu przez useActionState (audyt B3/B4): błąd
// weryfikacji kluczy pokazuje się TUTAJ, a wpisany adres i klucze wracają
// do pól. Autoryzację tenanta robi akcja (wymaganyTenant) - hidden input
// to tylko deklaracja, nie dostęp.
export function FormularzPodlaczenia({ tenantId }: { tenantId: string }) {
  const [stan, akcja, trwa] = useActionState(podlaczSklepAkcja, undefined);

  return (
    <form action={akcja} className="space-y-3">
      <input type="hidden" name="tenantId" value={tenantId} />
      <BladFormularza blad={stan?.blad} />
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-2)]">Adres sklepu</span>
        <input
          name="baseUrl"
          required
          type="url"
          inputMode="url"
          placeholder="https://sklep.pl"
          defaultValue={stan?.wartosci?.baseUrl ?? ""}
          className="pole"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-2)]">Consumer key</span>
        <input
          name="consumerKey"
          required
          placeholder="ck_..."
          defaultValue={stan?.wartosci?.consumerKey ?? ""}
          className="pole"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-2)]">Consumer secret</span>
        {/* sekret nigdy nie wraca w stanie akcji (byłby w odpowiedzi RSC i w DOM),
            więc po błędzie pole jest puste - mówi o tym komunikat błędu */}
        <input
          name="consumerSecret"
          required
          type="password"
          placeholder="cs_..."
          className="pole"
        />
      </label>
      <button className="przycisk" type="submit" disabled={trwa}>
        {trwa ? "Sprawdzam klucze…" : "Sprawdź i podłącz"}
      </button>
    </form>
  );
}
