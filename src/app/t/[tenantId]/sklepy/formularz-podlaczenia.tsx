"use client";

import { useActionState } from "react";
import { podlaczSklepAkcja } from "../../../akcje";
import { Alert, Field, Input, PrzyciskFormularza } from "../../../ui";

// Formularz podłączenia sklepu przez useActionState (audyt B3/B4): błąd
// weryfikacji kluczy pokazuje się TUTAJ, a wpisany adres i klucze wracają
// do pól. Autoryzację tenanta robi akcja (wymaganyTenant) - hidden input
// to tylko deklaracja, nie dostęp.
export function FormularzPodlaczenia({ tenantId }: { tenantId: string }) {
  const [stan, akcja, trwa] = useActionState(podlaczSklepAkcja, undefined);

  return (
    <form action={akcja}>
      <input type="hidden" name="tenantId" value={tenantId} />
      {stan?.blad ? <div className="border-b border-[var(--color-linia-0)] p-4 sm:p-6"><Alert tone="blad" title="Nie udało się połączyć sklepu">{stan.blad}</Alert></div> : null}

      <section className="formularz-sekcja">
        <div className="formularz-sekcja-opis">
          <h3>Dane sklepu</h3>
          <p>Pełny adres sklepu WooCommerce, który ma zasilać to konto.</p>
        </div>
        <div className="formularz-sekcja-pola">
          <Field label="Adres sklepu" htmlFor="baseUrl" hint="Pełny adres sklepu wraz z https://">
            <Input
              id="baseUrl"
              name="baseUrl"
              required
              type="url"
              inputMode="url"
              placeholder="https://sklep.pl"
              defaultValue={stan?.wartosci?.baseUrl ?? ""}
            />
          </Field>
        </div>
      </section>

      <section className="formularz-sekcja">
        <div className="formularz-sekcja-opis">
          <h3>Dostęp REST API</h3>
          <p>Klucze służą do jednorazowego sprawdzenia dostępu i późniejszej synchronizacji.</p>
        </div>
        <div className="formularz-sekcja-pola space-y-6">
          <Field label="Consumer key" htmlFor="consumerKey">
            {/* klucz to token: monospace jest tu zgodny z kanonem, znak ma być odliczalny */}
            <Input
              id="consumerKey"
              name="consumerKey"
              required
              placeholder="ck_..."
              defaultValue={stan?.wartosci?.consumerKey ?? ""}
              className="font-mono text-[13px]"
            />
          </Field>
          <Field label="Consumer secret" htmlFor="consumerSecret" hint="Sekret nie jest ponownie wyświetlany po wysłaniu formularza.">
            {/* sekret nigdy nie wraca w stanie akcji (byłby w odpowiedzi RSC i w DOM),
                więc po błędzie pole jest puste - mówi o tym komunikat błędu */}
            <Input
              id="consumerSecret"
              name="consumerSecret"
              required
              type="password"
              placeholder="cs_..."
              className="font-mono text-[13px]"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <PrzyciskFormularza trwa="Sprawdzam klucze…" trwaZewnetrznie={trwa}>Sprawdź i podłącz</PrzyciskFormularza>
            {trwa ? (
              <span className="tekst-pomocniczy !text-[var(--color-tekst-3)]">
                Pytamy sklep o każde uprawnienie osobno — to trwa kilka sekund.
              </span>
            ) : null}
          </div>
        </div>
      </section>
    </form>
  );
}
