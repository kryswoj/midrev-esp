"use client";

import { useState } from "react";
import { Eye, Loader2 } from "lucide-react";
import { odmien } from "../../../../../../domain/liczebniki";
import type { WynikPodgladu } from "../../../../../../usecases/automatyzacje/podglad-wyzwalacza";
import { podgladWyzwalaczaAkcja } from "../../akcje";

/**
 * Podglad wyzwalacza (E4b 4.10): ostatnie zdarzenia metryki z 30 dni z werdyktem dla kazdego
 * („weszłaby” albo powod odpadniecia), liczony na biezacym szkicu z kanwy. Na zadanie
 * (przycisk), nie przy kazdej zmianie: to do 200 zapytan o filtr profilu.
 */
export function PodgladWyzwalacza({ tenantId, flowId, szkicJson }: { tenantId: string; flowId: string; szkicJson: string }) {
  const [stan, setStan] = useState<{ trwa: boolean; wynik: WynikPodgladu | null; dla: string | null }>({ trwa: false, wynik: null, dla: null });
  const [wszystkie, setWszystkie] = useState(false);
  const policz = async () => {
    setStan((s) => ({ ...s, trwa: true }));
    try {
      const wynik = await podgladWyzwalaczaAkcja(tenantId, flowId, szkicJson);
      setStan({ trwa: false, wynik, dla: szkicJson });
    } catch {
      setStan({ trwa: false, wynik: { ok: false, blad: "Brak połączenia z serwerem." }, dla: szkicJson });
    }
  };
  const w = stan.wynik;
  const nieaktualny = w && stan.dla !== szkicJson;
  const wiersze = w?.ok ? (wszystkie ? w.wiersze : w.wiersze.slice(0, 8)) : [];
  return (
    <section className="border-b border-[var(--color-linia-0)] px-4 py-4" aria-label="Podgląd wyzwalacza">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Podgląd: kto by wszedł</h3>
        <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={policz} disabled={stan.trwa}>
          {stan.trwa ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />} {w ? "Przelicz" : "Pokaż"}
        </button>
      </div>
      {!w ? <p className="text-[12px] leading-4 text-[var(--color-tekst-3)]">Ostatnie zdarzenia z 30 dni sprawdzone na tym szkicu: filtr wyzwalacza, filtr profilu, ponowne wejście.</p> : null}
      {w && !w.ok ? <p className="text-[12px] leading-4 text-[var(--color-blad)]">{w.blad}</p> : null}
      {w?.ok ? (
        <>
          <p className="text-[13px] leading-5">
            W ostatnich {w.dni} dniach weszł{w.weszloby === 1 ? "aby" : "oby"} <span className="liczba font-semibold">{odmien(w.weszloby, "osoba", "osoby", "osób")}</span>
            <span className="text-[var(--color-tekst-3)]"> (z {odmien(w.przeanalizowane, "zdarzenia", "zdarzeń", "zdarzeń")})</span>.
          </p>
          {nieaktualny ? <p className="mt-1 text-[12px] leading-4 text-[var(--color-czeka)]">Szkic się zmienił. Przelicz, żeby zobaczyć aktualny wynik.</p> : null}
          <ul className="mt-2 divide-y divide-[var(--color-linia-0)] rounded-md border border-[var(--color-linia)] bg-white">
            {wiersze.map((r) => (
              <li key={r.eventId} className="flex items-start gap-2 px-2.5 py-2 text-[12px] leading-4">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${r.wszedlby ? "bg-[var(--color-ok)]" : "bg-[var(--color-tekst-3)]"}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-[var(--color-tekst)]">{r.email ?? "osoba bez adresu"}</span>
                  <span className={r.wszedlby ? "text-[var(--color-ok)]" : "text-[var(--color-tekst-2)]"}>{r.wszedlby ? "Wejdzie" : `Nie wejdzie: ${r.opis}`}</span>
                </span>
                <time className="shrink-0 text-[var(--color-tekst-3)]" dateTime={r.kiedy}>{new Date(r.kiedy).toLocaleString("pl-PL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time>
              </li>
            ))}
            {!wiersze.length ? <li className="px-2.5 py-2 text-[12px] text-[var(--color-tekst-3)]">Brak zdarzeń tej metryki w ostatnich {w.dni} dniach.</li> : null}
          </ul>
          {w.wiersze.length > 8 ? (
            <button type="button" className="przycisk przycisk-wtorny przycisk-maly mt-2 w-full" onClick={() => setWszystkie((x) => !x)}>
              {wszystkie ? "Pokaż mniej" : `Pokaż wszystkie (${w.wiersze.length})`}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
