"use client";

import { useActionState, useEffect, useState } from "react";
import { PrzyciskFormularza } from "../../../../ui";
import type { StanImportu } from "../../../../../usecases/sklep/kreator-sklepu";
import { planImportuAkcja, stanImportuAkcja, startImportuAkcja, type PlanImportuWidok } from "./akcje";

/**
 * Krok 5 „Import historii”: najpierw plan z licznościami i skutkami ubocznymi (lista kontrolna
 * pkt 6), potem import w tle z paskiem postępu i odczytem zwrotnym na końcu.
 */
const liczba = (n: number | undefined) => new Intl.NumberFormat("pl-PL").format(n ?? 0);

export function ImportHistorii({ tenantId, storeId, poczatkowy }: { tenantId: string; storeId: string; poczatkowy: StanImportu }) {
  const [plan, zaplanuj] = useActionState<PlanImportuWidok | undefined, FormData>(planImportuAkcja, undefined);
  const [stan, ustawStan] = useState<StanImportu>(poczatkowy);
  const [blad, ustawBlad] = useState<string | null>(null);
  const trwa = stan.stan === "w_kolejce" || stan.stan === "trwa";
  useEffect(() => {
    if (!trwa) return;
    const t = window.setInterval(async () => {
      try {
        ustawStan(await stanImportuAkcja(tenantId, storeId));
      } catch {
        /* następne odpytanie */
      }
    }, 2000);
    return () => window.clearInterval(t);
  }, [trwa, tenantId, storeId]);

  const procent = stan.postep && stan.postep.plan > 0 ? Math.min(100, Math.round((stan.postep.objete / stan.postep.plan) * 100)) : stan.stan === "gotowe" ? 100 : 0;
  return (
    <div className="space-y-4">
      {trwa ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[13px]">
            <span className="font-medium">{stan.stan === "w_kolejce" ? "W kolejce…" : stan.postep?.etap === "klienci" ? "Importuję klientów…" : "Importuję zamówienia…"}</span>
            <span className="liczba text-[var(--color-tekst-2)]">{stan.postep ? `${liczba(stan.postep.objete)} z ${liczba(stan.postep.plan)}` : ""}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--color-powierzchnia-2)]" role="progressbar" aria-valuenow={procent} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-[var(--color-akcent)] transition-all" style={{ width: `${procent}%` }} />
          </div>
          <p className="text-[12px] text-[var(--color-tekst-2)]">Możesz zamknąć tę stronę, import idzie w tle.</p>
        </div>
      ) : stan.stan === "gotowe" || stan.stan === "blad" ? (
        <div className={`rounded-lg px-4 py-3 text-[13px] ${stan.stan === "gotowe" ? "bg-[var(--color-powierzchnia-3)]" : "bg-[var(--color-czeka-tlo)]"}`}>
          {stan.stan === "gotowe" ? (
            <>Zaimportowane: <b className="liczba">{liczba(Number(stan.wynik?.utworzoneZamowienia ?? 0))}</b> nowych zamówień, <b className="liczba">{liczba(Number(stan.wynik?.utworzoneProfile ?? 0))}</b> nowych profili (bez zgody marketingowej). Żadne nie weszło do automatyzacji.</>
          ) : (
            <>Import przerwany: {stan.blad ?? "nieznany błąd"}. Uruchom ponownie: już zapisane dane się nie zdublują.</>
          )}
        </div>
      ) : null}

      {!trwa ? (
        <form action={zaplanuj} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="storeId" value={storeId} />
          <PrzyciskFormularza variant="secondary" trwa="Liczę…">{stan.stan === "gotowe" ? "Zaimportuj ponownie" : "Sprawdź, co wejdzie"}</PrzyciskFormularza>
        </form>
      ) : null}

      {plan?.blad ? <p className="text-[13px] text-[var(--color-blad)]">{plan.blad}</p> : null}
      {plan && !plan.blad && !trwa ? (
        <div className="rounded-lg border border-[var(--color-linia)] p-4">
          <ul className="space-y-1 text-[13px]">
            <li><b className="liczba">{liczba(plan.zamowienia)}</b> zamówień{plan.najstarsze ? <> od <span className="liczba">{new Date(plan.najstarsze).toLocaleDateString("pl-PL")}</span></> : null}</li>
            <li><b className="liczba">{liczba(plan.klienci)}</b> kont klientów, <b className="liczba">{liczba(plan.noweProfile)}</b> nowych profili (bez zgody na newsletter)</li>
            <li><b className="liczba">0</b> wejść do automatyzacji: historia nie uruchamia maili</li>
          </ul>
          <button
            type="button"
            className="przycisk mt-3"
            onClick={async () => {
              ustawBlad(null);
              const w = await startImportuAkcja(tenantId, storeId);
              if (!w.ok) ustawBlad(w.blad ?? "Nie udało się uruchomić importu.");
              else ustawStan({ ...stan, stan: "w_kolejce" });
            }}
          >
            Importuj historię
          </button>
          {blad ? <p className="mt-2 text-[13px] text-[var(--color-blad)]">{blad}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
