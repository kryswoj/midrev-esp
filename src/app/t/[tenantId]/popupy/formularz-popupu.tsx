"use client";

import { useActionState } from "react";
import { utworzPopupAkcja } from "./akcje";
import { BladFormularza } from "../../../blad-formularza";

// Formularz nowego popupu przez useActionState (audyt B4): "Treść jest za długa"
// nie kasuje już nagłówka, treści, przycisku i kodu naraz - wszystko wraca do pól.
export function FormularzPopupu({ tenantId }: { tenantId: string }) {
  const [stan, akcja, trwa] = useActionState(utworzPopupAkcja, undefined);

  return (
    <form action={akcja} className="space-y-3">
      <input type="hidden" name="tenantId" value={tenantId} />
      <BladFormularza blad={stan?.blad} />
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-3)]">Nazwa robocza</span>
        <input
          name="name"
          required
          placeholder="np. Rabat powitalny"
          defaultValue={stan?.wartosci?.name ?? ""}
          className="pole"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-3)]">Nagłówek</span>
        <input
          name="headline"
          required
          placeholder="np. -10% na pierwsze zakupy"
          defaultValue={stan?.wartosci?.headline ?? ""}
          className="pole"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-3)]">Treść</span>
        <textarea
          name="bodyText"
          required
          rows={3}
          placeholder="Zostaw adres e-mail, a wyślemy Ci kod rabatowy."
          defaultValue={stan?.wartosci?.bodyText ?? ""}
          className="pole"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-3)]">Tekst przycisku</span>
        <input
          name="buttonText"
          required
          placeholder="np. Odbieram rabat"
          defaultValue={stan?.wartosci?.buttonText ?? ""}
          className="pole"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-3)]">
          Kod rabatowy (opcjonalny)
        </span>
        <input
          name="discountCode"
          placeholder="np. WITAJ10"
          defaultValue={stan?.wartosci?.discountCode ?? ""}
          className="pole"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-tekst-3)]">
          Pokaż po (sekundy)
        </span>
        <input
          name="delaySeconds"
          type="number"
          min={0}
          max={600}
          defaultValue={stan?.wartosci?.delaySeconds ?? "5"}
          className="pole"
        />
      </label>
      <button className="przycisk w-full justify-center" type="submit" disabled={trwa}>
        {trwa ? "Zapisuję…" : "Zapisz popup"}
      </button>
    </form>
  );
}
