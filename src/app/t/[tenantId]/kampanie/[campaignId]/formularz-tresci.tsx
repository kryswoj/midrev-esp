"use client";

import { useActionState } from "react";
import { zapiszTrescAkcja } from "../../../../akcje";
import { BladFormularza } from "../../../../blad-formularza";

// Formularz treści kampanii przez useActionState (audyt B4): błąd zapisu nie
// kasuje ręcznie pisanego HTML-a - temat, preheader i treść wracają do pól.
export function FormularzTresci({
  tenantId,
  campaignId,
  temat,
  preheader,
  html,
  poWysylce,
}: {
  tenantId: string;
  campaignId: string;
  temat: string;
  preheader: string;
  html: string;
  poWysylce: boolean;
}) {
  const [stan, akcja, trwa] = useActionState(zapiszTrescAkcja, undefined);

  return (
    <form action={akcja} className="space-y-3 p-3">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="campaignId" value={campaignId} />
      <BladFormularza blad={stan?.blad} />
      <label className="block">
        <span className="mb-1 block text-[12px] text-[var(--color-tekst-3)]">Temat</span>
        <input
          name="temat"
          defaultValue={stan?.wartosci?.temat ?? temat}
          readOnly={poWysylce}
          className="pole"
          placeholder="to zobaczy odbiorca w skrzynce"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[12px] text-[var(--color-tekst-3)]">Preheader</span>
        <input
          name="preheader"
          defaultValue={stan?.wartosci?.preheader ?? preheader}
          readOnly={poWysylce}
          className="pole"
          placeholder="szara linijka obok tematu"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[12px] text-[var(--color-tekst-3)]">
          Treść HTML · linki zostaną automatycznie przepisane na śledzone, stopka z wypisaniem dokleja się sama
        </span>
        <textarea
          name="html"
          rows={12}
          defaultValue={stan?.wartosci?.html ?? html}
          readOnly={poWysylce}
          className="pole font-mono text-[12px] leading-[18px]"
          placeholder={'<h1>Nagłówek</h1>\n<p>Treść…</p>\n<p><a href="https://sklep.pl/promocja">Zobacz promocję</a></p>'}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button className="przycisk przycisk-wtorny" type="submit" disabled={poWysylce || trwa}>
          {trwa ? "Zapisuję…" : "Zapisz treść"}
        </button>
        {poWysylce ? (
          <span className="text-[12px] text-[var(--color-tekst-3)]">
            po starcie wysyłki treść jest zamrożona: odbiorcy dostali to, co zaakceptował klient
          </span>
        ) : null}
      </div>
    </form>
  );
}
