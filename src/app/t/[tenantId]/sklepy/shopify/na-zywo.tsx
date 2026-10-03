"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Icon } from "../../../../ui";
import { stanAkcja } from "./akcje";
import type { StanShopify } from "../../../../../usecases/shopify/stan";

/**
 * „Sprawdź połączenie” (plan F.1 krok 3) i pasek importu (krok 4): odpytywanie co 3 s, tylko
 * gdy karta jest widoczna. Kropki zapalają się same, gdy przyjdzie pierwsze zdarzenie.
 */

function temu(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s temu`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min temu`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h temu` : `${Math.round(h / 24)} dni temu`;
}

function useStan(tenantId: string, storeId: string, poczatkowy: StanShopify | null) {
  const [stan, ustaw] = useState<StanShopify | null>(poczatkowy);
  const [blad, ustawBlad] = useState(false);
  const trwa = useRef(false);
  useEffect(() => {
    let zyje = true;
    async function odswiez() {
      if (trwa.current || document.visibilityState !== "visible") return;
      trwa.current = true;
      try {
        const s = await stanAkcja(tenantId, storeId);
        if (zyje) {
          ustaw(s);
          ustawBlad(false);
        }
      } catch {
        if (zyje) ustawBlad(true);
      } finally {
        trwa.current = false;
      }
    }
    const t = window.setInterval(odswiez, 3000);
    return () => {
      zyje = false;
      window.clearInterval(t);
    };
  }, [tenantId, storeId]);
  return { stan, blad };
}

export function SprawdzNaZywo({ tenantId, storeId, poczatkowy }: { tenantId: string; storeId: string; poczatkowy: StanShopify | null }) {
  const { stan, blad } = useStan(tenantId, storeId, poczatkowy);
  if (!stan) return null;
  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y divide-[var(--color-linia-0)] overflow-hidden rounded-lg border border-[var(--color-linia)]">
        {stan.punkty.map((p) => (
          <li key={p.klucz} className="flex items-center gap-3 px-3 py-2.5">
            <span
              aria-hidden
              className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${p.ok ? "bg-[var(--color-ok)] text-white" : "border-2 border-dashed border-[var(--color-linia)]"}`}
            >
              {p.ok ? <Icon name="check" size={13} /> : null}
            </span>
            <span className="min-w-0 flex-1 text-[14px] leading-5 text-[var(--color-tekst)]">{p.opis}</span>
            <span className="tekst-meta shrink-0">{p.ostatnio ? temu(stan.teraz - p.ostatnio) : p.ok ? "" : "czekamy"}</span>
            <span className="sr-only">{p.ok ? "działa" : "jeszcze nie"}</span>
          </li>
        ))}
      </ul>
      <p className="tekst-meta" aria-live="polite">
        {blad ? "Nie udało się odświeżyć. Spróbujemy ponownie za chwilę." : "Odświeża się samo co 3 sekundy. Otwórz sklep, obejrzyj produkt i dodaj go do koszyka, żeby zobaczyć zdarzenia."}
      </p>
    </div>
  );
}

const ETAPY: Record<string, string> = { produkty: "Produkty", klienci: "Klienci ze zgodą", zamowienia: "Zamówienia", koniec: "Gotowe" };

export function PasekImportu({ tenantId, storeId, poczatkowy }: { tenantId: string; storeId: string; poczatkowy: StanShopify | null }) {
  const { stan } = useStan(tenantId, storeId, poczatkowy);
  const imp = stan?.import;
  if (!imp) return null;
  const zrobione = imp.postep.zakonczoneEtapy?.length ?? 0;
  const procent = imp.status === "done" ? 100 : Math.min(95, Math.round((zrobione / 3) * 100) + 5);
  const l = imp.liczniki as Record<string, number | string | null>;
  const najstarsza = typeof l.najstarszaData === "string" ? new Date(l.najstarszaData).toLocaleDateString("pl-PL") : null;
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[14px] font-medium text-[var(--color-tekst)]">
          {imp.status === "done" ? "Import zakończony" : imp.status === "failed" ? "Import przerwany" : `Etap: ${ETAPY[imp.postep.etap ?? "produkty"] ?? "start"}`}
        </span>
        <Badge ton={imp.status === "done" ? "ok" : imp.status === "failed" ? "blad" : "neutral"}>
          {imp.status === "done" ? "gotowe" : imp.status === "failed" ? "błąd" : `${procent}%`}
        </Badge>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--color-powierzchnia-3)]" role="progressbar" aria-valuenow={procent} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${imp.status === "failed" ? "bg-[var(--color-blad)]" : "bg-[var(--color-akcent)]"}`} style={{ width: `${procent}%` }} />
      </div>
      {imp.status === "running" || imp.status === "planned" ? (
        <p className="tekst-meta">Shopify przygotowuje dane{imp.postep.obiekty ? `: ${imp.postep.obiekty.toLocaleString("pl-PL")} obiektów` : ""}. Możesz zamknąć tę kartę.</p>
      ) : null}
      {imp.status === "done" ? (
        <p className="tekst-meta">
          W bazie: {Number(l.wBazieZamowien ?? 0).toLocaleString("pl-PL")} zamówień i {Number(l.wBazieProduktow ?? 0).toLocaleString("pl-PL")} produktów
          {najstarsza ? `, najstarsze zamówienie ${najstarsza}` : ""}. Klienci ze zgodą: {Number(l.zgody ?? 0).toLocaleString("pl-PL")}.
        </p>
      ) : null}
      {imp.status === "failed" && imp.blad ? <p className="tekst-meta !text-[var(--color-blad)]">{imp.blad}</p> : null}
    </div>
  );
}
