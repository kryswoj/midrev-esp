"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { DefinicjaFormularza } from "../../../../../domain/formularze/model";
import type { WynikiFormularza } from "../../../../../usecases/popupy/wyswietlenia";
import { wynikiAkcja } from "../akcje";

/**
 * Zakładka „Wyniki” (Klaviyo: raport formularza): wyświetlenia, zapisy, konwersja i lejek
 * kroków z ostatnich 7 / 30 / 90 dni. Dane ze strumienia zdarzeń (Viewed Form, Viewed Form
 * Step, Submitted Form), liczone dla opublikowanej wersji formularza.
 */

const liczba = (n: number) => n.toLocaleString("pl-PL");
const procent = (n: number | null) => (n === null ? "–" : `${n.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%`);

export function ZakladkaWyniki({ tenantId, formId, def, poczatkowe }: { tenantId: string; formId: string; def: DefinicjaFormularza; poczatkowe: WynikiFormularza }) {
  const [dni, setDni] = useState(poczatkowe.dni);
  const [dane, setDane] = useState(poczatkowe);
  const [trwa, setTrwa] = useState(false);

  useEffect(() => {
    if (dni === dane.dni) return;
    let aktualne = true;
    setTrwa(true);
    void wynikiAkcja(tenantId, formId, dni).then((w) => {
      if (aktualne && w) setDane(w);
      if (aktualne) setTrwa(false);
    });
    return () => {
      aktualne = false;
    };
  }, [dni, dane.dni, tenantId, formId]);

  const kroki = [...def.kroki.map((k, i) => ({ indeks: i, nazwa: k.nazwa || `Krok ${i + 1}` })), { indeks: def.kroki.length, nazwa: "Sukces (po zapisie)" }];
  const pierwszy = dane.kroki.find((k) => k.indeks === 0)?.wyswietlenia ?? 0;

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-plotno)]">
      <div className="mx-auto max-w-[880px] space-y-4 px-4 py-6 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[17px]">Wyniki formularza</h2>
          <div className="flex items-center gap-2">
            {trwa ? <Loader2 size={16} className="animate-spin text-[var(--color-tekst-3)]" aria-label="Wczytuję" /> : null}
            <div role="radiogroup" aria-label="Okres" className="inline-flex rounded-lg border border-[var(--color-linia-mocna)] bg-[var(--color-powierzchnia-2)] p-0.5">
              {[7, 30, 90].map((d) => (
                <button key={d} type="button" role="radio" aria-checked={dni === d} onClick={() => setDni(d)} className={`h-8 rounded-md px-3 text-[13px] font-medium ${dni === d ? "bg-white shadow-[var(--cien-karta)]" : "text-[var(--color-tekst-2)]"}`}>
                  {d} dni
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-[var(--color-linia)] bg-white shadow-[var(--cien-karta)]">
          {[
            ["Wyświetlenia", liczba(dane.wyswietlenia), "osoby, które zobaczyły formularz (raz dziennie na osobę)"],
            ["Zapisy", liczba(dane.zapisy), "adresy zostawione w kroku z e-mailem"],
            ["Konwersja", procent(dane.konwersja), "zapisy ÷ wyświetlenia"],
          ].map(([t, w, o], i) => (
            <div key={t} className={`px-5 py-4 max-md:px-3 ${i < 2 ? "border-r border-[var(--color-linia-0)]" : ""}`}>
              <div className="etykieta">{t}</div>
              <div className="mt-1 text-[28px] font-semibold tabular-nums leading-tight max-md:text-[22px]">{w}</div>
              <div className="mt-1 text-[12px] leading-[16px] text-[var(--color-tekst-3)] max-md:hidden">{o}</div>
            </div>
          ))}
        </div>

        <section className="rounded-xl border border-[var(--color-linia)] bg-white p-5 shadow-[var(--cien-karta)] max-md:p-4">
          <h3 className="text-[15px]">Kroki</h3>
          <p className="mt-0.5 text-[13px] text-[var(--color-tekst-2)]">Ile osób doszło do każdego kroku. Spadek między krokami pokazuje, gdzie ludzie rezygnują.</p>
          {dane.wyswietlenia === 0 ? (
            <p className="mt-4 rounded-lg bg-[var(--color-powierzchnia-2)] px-4 py-6 text-center text-[13px] text-[var(--color-tekst-2)]">
              W tym okresie nikt jeszcze nie zobaczył formularza. Wyniki pojawią się po publikacji i pierwszych odsłonach w sklepie.
            </p>
          ) : (
            <ol className="mt-4 space-y-3">
              {kroki.map((k) => {
                const w = dane.kroki.find((x) => x.indeks === k.indeks)?.wyswietlenia ?? 0;
                const udzial = pierwszy > 0 ? Math.min(100, (w / pierwszy) * 100) : 0;
                return (
                  <li key={k.indeks}>
                    <div className="flex items-baseline justify-between gap-3 text-[13px]">
                      <span className="font-medium">
                        <span className="text-[var(--color-tekst-3)]">{k.indeks < def.kroki.length ? `${k.indeks + 1}.` : "✓"}</span> {k.nazwa}
                      </span>
                      <span className="tabular-nums text-[var(--color-tekst-2)]">
                        <b className="text-[var(--color-tekst)]">{liczba(w)}</b> · {procent(pierwszy > 0 ? Math.round(udzial * 10) / 10 : null)}
                      </span>
                    </div>
                    <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-[var(--color-powierzchnia-2)]">
                      <div className="h-full rounded-full bg-[var(--color-akcent)]" style={{ width: `${udzial}%` }} />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="mt-4 border-t border-[var(--color-linia-0)] pt-3 text-[12px] text-[var(--color-tekst-3)]">Wszystkie zapisy od początku: {liczba(dane.zapisyRazem)}. Zapisy liczymy przy kroku z e-mailem, więc osoba, która pominęła dalsze kroki, też jest w zapisach.</p>
        </section>
      </div>
    </div>
  );
}
