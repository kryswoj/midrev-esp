"use client";

import { useActionState } from "react";
import { Kopiuj } from "../../../../_dns/kopiuj";
import { Field, Input, PrzyciskFormularza } from "../../../../ui";
import { generujKodAkcja, type StanKodu } from "./akcje";

/** Krok 3: jednorazowy kod parowania (2 h). Kod żyje tylko w stanie strony, nie w adresie. */
export function KodParowania({ tenantId, adresDomyslny }: { tenantId: string; adresDomyslny: string }) {
  const [stan, akcja] = useActionState<StanKodu | undefined, FormData>(generujKodAkcja, undefined);
  return (
    <div className="space-y-4">
      <form action={akcja} className="space-y-3">
        <input type="hidden" name="tenantId" value={tenantId} />
        <Field label="Adres sklepu" htmlFor="adres" hint="Zalecane: kod zadziała tylko dla tego sklepu, a dostaniesz link prosto do ustawień wtyczki." error={stan?.blad}>
          <Input id="adres" name="adres" defaultValue={stan?.adres ?? adresDomyslny} placeholder="https://mojsklep.pl" autoComplete="off" />
        </Field>
        <PrzyciskFormularza variant={stan?.kod ? "secondary" : "primary"} trwa="Generuję…">{stan?.kod ? "Wygeneruj nowy kod" : "Wygeneruj kod parowania"}</PrzyciskFormularza>
      </form>
      {stan?.kod ? (
        <div className="rounded-lg border border-[var(--color-akcent-ramka)] bg-[var(--color-akcent-tlo)] p-4">
          <p className="text-[12px] font-medium text-[var(--color-tekst-2)]">Kod parowania (ważny 2 godziny, jednorazowy)</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <code className="break-all text-[18px] font-semibold tracking-wide text-[var(--color-tekst)]">{stan.kod}</code>
            <Kopiuj wartosc={stan.kod} etykieta="kod parowania" />
          </div>
          {stan.link ? (
            <a className="przycisk przycisk-maly mt-3 inline-flex" href={stan.link} target="_blank" rel="noopener noreferrer">
              Otwórz ustawienia wtyczki w sklepie
            </a>
          ) : (
            <p className="mt-2 text-[13px] text-[var(--color-tekst-2)]">W WordPressie: WooCommerce → MidRev ESP → wklej kod → „Połącz z MidRev”.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
