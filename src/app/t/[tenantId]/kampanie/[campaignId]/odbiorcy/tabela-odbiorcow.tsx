"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { autozapisOdbiorcowAkcja } from "../../../../../akcje";

type Tryb = "" | "wlacz" | "wylacz";

export interface ZrodloWiersza {
  klucz: string;
  nazwa: string;
  typ: string;
  opis: string;
}

/**
 * Krok 1: jedna tabela źródeł z przełącznikiem Pomiń / Wyślij / Wyklucz, zapisywana od razu
 * po każdej zmianie (jak w Klaviyo). Po zapisie serwer przelicza rachunek odbiorców
 * (router.refresh), więc liczby po prawej zawsze opisują ZAPISANY wybór.
 * Jedna grupa radio na źródło = źródło nie może naraz dodawać i odejmować.
 */
export function TabelaOdbiorcow({
  tenantId,
  campaignId,
  zrodla,
  poczatkowe,
  zablokowane,
}: {
  tenantId: string;
  campaignId: string;
  zrodla: ZrodloWiersza[];
  poczatkowe: Record<string, Tryb>;
  zablokowane: boolean;
}) {
  const router = useRouter();
  const [wybor, setWybor] = useState<Record<string, Tryb>>(poczatkowe);
  const [stan, setStan] = useState<{ blad?: string; zapisano?: boolean }>({});
  const [trwa, startTransition] = useTransition();
  // Zapisy idą po kolei: dwa szybkie kliknięcia nie mogą dojść do serwera w odwrotnej
  // kolejności, bo wtedy w bazie zostałby starszy wybór niż ten na ekranie.
  const kolejka = useRef<Promise<void>>(Promise.resolve());
  // ostatni wybór POTWIERDZONY przez serwer i numer najnowszej zmiany: błąd starszego
  // zapisu nie może cofnąć ekranu, gdy za nim czeka już nowszy (review Codeksa, P1)
  const potwierdzony = useRef<Record<string, Tryb>>(poczatkowe);
  const numer = useRef(0);

  const zmien = (klucz: string, tryb: Tryb) => {
    const nowy = { ...wybor, [klucz]: tryb };
    setWybor(nowy);
    const moj = ++numer.current;
    startTransition(async () => {
      const poprzedni = kolejka.current;
      let zwolnij = () => {};
      kolejka.current = new Promise<void>((r) => (zwolnij = r));
      await poprzedni;
      try {
        await zapiszWybor();
      } finally {
        zwolnij();
      }
    });
    async function zapiszWybor() {
      const wlacz = Object.keys(nowy).filter((k) => nowy[k] === "wlacz");
      const wylacz = Object.keys(nowy).filter((k) => nowy[k] === "wylacz");
      let blad: string | null = null;
      try {
        const w = await autozapisOdbiorcowAkcja(tenantId, campaignId, { wlacz, wylacz });
        if (w.ok) potwierdzony.current = nowy;
        else blad = w.blad;
      } catch {
        blad = "Brak połączenia z serwerem — wybór NIE został zapisany.";
      }
      // tylko najnowsza zmiana decyduje o ekranie; starsze wyniki już nie są aktualne
      if (moj !== numer.current) return;
      if (blad) {
        setStan({ blad });
        setWybor(potwierdzony.current); // ekran = to, co naprawdę leży w bazie
        return;
      }
      setStan({ zapisano: true });
      router.refresh();
    }
  };

  const nazwy = (t: Tryb) => zrodla.filter((z) => wybor[z.klucz] === t).map((z) => z.nazwa);
  const wlaczone = nazwy("wlacz");
  const wykluczone = nazwy("wylacz");

  return (
    <section className="karta min-w-0 overflow-hidden">
      <div className="karta-naglowek">
        <h2>Listy i segmenty</h2>
        <span className="ml-auto flex items-center gap-1.5 text-[13px]" role="status">
          {trwa ? (
            <>
              <Loader2 size={14} className="animate-spin text-[var(--color-tekst-3)]" /> <span className="text-[var(--color-tekst-2)]">Zapisuję…</span>
            </>
          ) : stan.blad ? (
            <>
              <AlertTriangle size={14} className="text-[var(--color-blad)]" /> <span className="text-[var(--color-blad)]">{stan.blad}</span>
            </>
          ) : (
            <>
              <Check size={14} className="text-[var(--color-ok)]" />
              <span className="text-[var(--color-tekst-2)]">{stan.zapisano ? "Zapisano" : "Wszystko zapisane"}</span>
            </>
          )}
        </span>
      </div>
      <div className="border-b border-[var(--color-linia-0)] bg-[var(--color-powierzchnia-2)] px-4 py-2.5 text-[13px] text-[var(--color-tekst-2)]">
        {wlaczone.length || wykluczone.length ? (
          <>
            <span className="font-medium text-[var(--color-tekst)]">Wyślij do:</span> {wlaczone.join(", ") || "—"}
            {wykluczone.length ? (
              <>
                {" · "}
                <span className="font-medium text-[var(--color-tekst)]">wyklucz:</span> {wykluczone.join(", ")}
              </>
            ) : null}
          </>
        ) : (
          "„Wyślij” dodaje profile ze źródła, „Wyklucz” je odejmuje — nawet jeśli są w innym wybranym źródle."
        )}
      </div>
      <fieldset disabled={zablokowane}>
        <legend className="sr-only">Wybór odbiorców</legend>
        <table className="tabela">
          <thead>
            <tr>
              <th>Źródło</th>
              <th className="w-px whitespace-nowrap">Rozmiar</th>
              <th className="w-px whitespace-nowrap">Ta kampania</th>
            </tr>
          </thead>
          <tbody>
            {zrodla.map((z) => {
              const tryb = wybor[z.klucz] ?? "";
              return (
                <tr key={z.klucz} aria-selected={tryb === "wlacz"}>
                  <td>
                    <span className="flex items-center gap-2 font-medium">
                      {tryb ? (
                        <span
                          aria-hidden="true"
                          className={`h-2 w-2 rounded-full ${tryb === "wlacz" ? "bg-[var(--color-akcent)]" : "bg-[var(--color-blad)]"}`}
                        />
                      ) : null}
                      {z.nazwa}
                    </span>
                    <span className="text-[12px] text-[var(--color-tekst-3)]">{z.typ}</span>
                  </td>
                  <td className="liczba whitespace-nowrap text-[var(--color-tekst-2)]">{z.opis}</td>
                  <td>
                    <div role="radiogroup" aria-label={`${z.nazwa}: udział w kampanii`} className="inline-flex rounded-lg border border-[var(--color-linia-mocna)] bg-[var(--color-powierzchnia-2)] p-0.5">
                      {(
                        [
                          ["", "Pomiń", "has-[:checked]:text-[var(--color-tekst)]"],
                          ["wlacz", "Wyślij", "has-[:checked]:!bg-[var(--color-akcent)] has-[:checked]:text-white"],
                          ["wylacz", "Wyklucz", "has-[:checked]:!bg-[var(--color-blad)] has-[:checked]:text-white"],
                        ] as const
                      ).map(([wartosc, etykieta, kolor]) => (
                        <label
                          key={wartosc}
                          className={`cursor-pointer rounded-md px-3 py-1 text-[13px] font-medium text-[var(--color-tekst-2)] transition-colors hover:text-[var(--color-tekst)] has-[:checked]:bg-white has-[:checked]:shadow-[var(--cien-karta)] ${kolor} has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--color-akcent)] has-[:disabled]:cursor-not-allowed`}
                        >
                          <input type="radio" name={`tryb:${z.klucz}`} value={wartosc} checked={tryb === wartosc} onChange={() => zmien(z.klucz, wartosc)} className="sr-only" />
                          {etykieta}
                        </label>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </fieldset>
    </section>
  );
}
