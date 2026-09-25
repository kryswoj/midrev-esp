"use client";

import { useActionState } from "react";
import { utworzPopupAkcja } from "./akcje";
import { Alert, Button, Field, Input, Textarea } from "../../../ui";

// Formularz nowego popupu przez useActionState (audyt B4): "Treść jest za długa"
// nie kasuje już nagłówka, treści, przycisku i kodu naraz - wszystko wraca do pól.
export function FormularzPopupu({ tenantId }: { tenantId: string }) {
  const [stan, akcja, trwa] = useActionState(utworzPopupAkcja, undefined);

  return (
    <form action={akcja}>
      <input type="hidden" name="tenantId" value={tenantId} />
      {stan?.blad ? <div className="p-6 max-md:p-4"><Alert tone="blad" title="Nie udało się zapisać formularza">{stan.blad}</Alert></div> : null}

      <section className="formularz-sekcja">
        <div className="formularz-sekcja-opis"><h3>Podstawy</h3><p>Nazwa porządkuje formularze w panelu; nagłówek zobaczy klient sklepu.</p></div>
        <div className="formularz-sekcja-pola grid gap-4 sm:grid-cols-2">
          <Field label="Nazwa robocza" htmlFor="name">
            <Input id="name" name="name" required placeholder="np. Rabat powitalny" defaultValue={stan?.wartosci?.name ?? ""} />
          </Field>
          <Field label="Nagłówek" htmlFor="headline">
            <Input id="headline" name="headline" required placeholder="np. -10% na pierwsze zakupy" defaultValue={stan?.wartosci?.headline ?? ""} />
          </Field>
        </div>
      </section>

      <section className="formularz-sekcja">
        <div className="formularz-sekcja-opis"><h3>Treść</h3><p>Krótki komunikat, wezwanie do działania i opcjonalny kod rabatowy.</p></div>
        <div className="formularz-sekcja-pola space-y-4">
          <Field label="Treść" htmlFor="bodyText">
            <Textarea id="bodyText" name="bodyText" required rows={3} placeholder="Zostaw adres e-mail, a wyślemy Ci kod rabatowy." defaultValue={stan?.wartosci?.bodyText ?? ""} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tekst przycisku" htmlFor="buttonText">
              <Input id="buttonText" name="buttonText" required placeholder="np. Odbieram rabat" defaultValue={stan?.wartosci?.buttonText ?? ""} />
            </Field>
            <Field label="Kod rabatowy (opcjonalny)" htmlFor="discountCode">
              <Input id="discountCode" name="discountCode" placeholder="np. WITAJ10" defaultValue={stan?.wartosci?.discountCode ?? ""} />
            </Field>
          </div>
        </div>
      </section>

      <section className="formularz-sekcja">
        <div className="formularz-sekcja-opis"><h3>Wyświetlanie</h3><p>Opóźnienie liczone od wejścia klienta na stronę sklepu.</p></div>
        <div className="formularz-sekcja-pola space-y-4">
          <Field label="Pokaż po (sekundy)" htmlFor="delaySeconds" className="max-w-[220px]">
            <Input id="delaySeconds" name="delaySeconds" type="number" min={0} max={600} defaultValue={stan?.wartosci?.delaySeconds ?? "5"} />
          </Field>
          <Button type="submit" disabled={trwa} powodBlokady={trwa ? "Trwa zapisywanie formularza." : undefined}>{trwa ? "Zapisuję…" : "Zapisz formularz"}</Button>
        </div>
      </section>
    </form>
  );
}
