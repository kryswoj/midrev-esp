"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../../../ui";
import type { StanPolaczeniaSklepu } from "../../../../../usecases/sklep/kreator-sklepu";
import { stanPolaczeniaAkcja } from "./akcje";

/**
 * Krok 4 „Sprawdź połączenie”: kropki zapalają się same (odpytywanie co 3 s, tylko na widocznej
 * karcie). Ten sam mechanizm co podgląd na żywo integracji custom: zdarzenia z bazy + sygnał
 * pobrania skryptu z pamięci procesu.
 */
const NAZWY: Record<string, string> = {
  "Viewed Product": "Oglądany produkt",
  "Added to Cart": "Dodanie do koszyka",
  "Started Checkout": "Rozpoczęte zamówienie",
  "Placed Order": "Zamówienie",
  "Submitted Form": "Formularz",
};

function temu(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s temu`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min temu`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h temu` : `${Math.round(h / 24)} dni temu`;
}

export function SprawdzPolaczenie({ tenantId }: { tenantId: string }) {
  const [stan, ustawStan] = useState<StanPolaczeniaSklepu | null>(null);
  const [blad, ustawBlad] = useState(false);
  const trwa = useRef(false);
  useEffect(() => {
    let zyje = true;
    async function odswiez() {
      if (trwa.current || document.visibilityState !== "visible") return;
      trwa.current = true;
      try {
        const s = await stanPolaczeniaAkcja(tenantId);
        if (zyje) {
          ustawStan(s);
          ustawBlad(false);
        }
      } catch {
        if (zyje) ustawBlad(true);
      } finally {
        trwa.current = false;
      }
    }
    void odswiez();
    const t = window.setInterval(odswiez, 3000);
    return () => {
      zyje = false;
      window.clearInterval(t);
    };
  }, [tenantId]);

  const teraz = stan?.teraz ?? 0;
  const s = stan?.sklep;
  const zWtyczki = s?.metoda === "wtyczka";
  const kroki = [
    { ok: Boolean(s && s.status === "connected"), tekst: "Sklep połączony", detal: s ? `${s.adres.replace(/^https?:\/\//, "")}${zWtyczki ? ` · wtyczka ${s.wersjaWtyczki ?? ""}` : s.metoda === "wc_auth" ? " · wersja podstawowa" : ""}` : "Wklej kod we wtyczce" },
    { ok: Boolean(stan?.webhooki.ok), tekst: "Powiadomienia o zamówieniach", detal: stan ? `${stan.webhooki.aktywne} z ${stan.webhooki.wszystkie} aktywne${stan.webhooki.blad ? ` · ${stan.webhooki.blad}` : ""}` : "" },
    { ok: Boolean(stan?.skryptAt), tekst: "Kod śledzenia na stronie", detal: stan?.skryptAt ? temu(teraz - stan.skryptAt) : "Otwórz sklep w nowej karcie" },
    ...(["Viewed Product", "Added to Cart", "Started Checkout", "Placed Order"] as const).map((m) => ({
      ok: Boolean(stan?.zdarzenia[m]),
      tekst: NAZWY[m],
      detal: stan?.zdarzenia[m] ? temu(teraz - (stan.zdarzenia[m] as number)) : m === "Viewed Product" ? "Wejdź na kartę produktu (po zgodzie na cookies)" : m === "Placed Order" ? "Złóż testowe zamówienie" : zWtyczki ? "Dodaj produkt i wpisz e-mail w kasie" : "Wymaga wtyczki",
    })),
    { ok: (stan?.katalog.produkty ?? 0) > 0, tekst: "Katalog produktów", detal: stan?.katalog.produkty ? `${stan.katalog.produkty} produktów` : "Synchronizacja po połączeniu" },
  ];
  const gotowe = kroki.filter((k) => k.ok).length;
  return (
    <div className="space-y-4" aria-live="polite">
      <p className={`text-[15px] font-semibold ${gotowe === kroki.length ? "text-[var(--color-ok)]" : "text-[var(--color-tekst)]"}`}>
        {!s ? "Czekamy na połączenie sklepu…" : gotowe === kroki.length ? "Wszystko działa" : `Działa ${gotowe} z ${kroki.length}`}
      </p>
      <ol className="grid gap-2 sm:grid-cols-2">
        {kroki.map((k) => (
          <li key={k.tekst} className={`grid grid-cols-[18px_minmax(0,1fr)] gap-x-2 rounded-lg px-3 py-2.5 ${k.ok ? "bg-[var(--color-powierzchnia-3)]" : "bg-[var(--color-powierzchnia-2)]"}`}>
            <Icon name={k.ok ? "check" : "info"} size={16} className={`row-span-2 mt-0.5 ${k.ok ? "text-[var(--color-ok)]" : "text-[var(--color-tekst-3)]"}`} />
            <span className="text-[13px] font-medium leading-[18px] text-[var(--color-tekst)]">{k.tekst}</span>
            <span className="truncate text-[12px] leading-4 text-[var(--color-tekst-2)]">{k.detal}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 text-[12px] text-[var(--color-tekst-2)]">
          <span className={`h-2 w-2 rounded-full ${blad ? "bg-[var(--color-blad)]" : "animate-pulse bg-[var(--color-ok)]"}`} aria-hidden="true" />
          {blad ? "Brak połączenia z panelem, ponawiam…" : "Na żywo, odświeżane co 3 s"}
        </span>
        {s ? (
          <a className="przycisk przycisk-wtorny przycisk-maly" href={`${s.adres}/?mrv_debug=1`} target="_blank" rel="noopener noreferrer">Otwórz sklep</a>
        ) : null}
      </div>
      {stan?.ostatnie.length ? (
        <details className="overflow-hidden rounded-lg border border-[var(--color-linia)]">
          <summary className="cursor-pointer bg-[var(--color-powierzchnia-2)] px-3 py-2 text-[12px] font-medium text-[var(--color-tekst-2)]">Ostatnio ze sklepu</summary>
          <ul className="divide-y divide-[var(--color-linia-0)]">
            {stan.ostatnie.map((z) => (
              <li key={z.id} className="flex flex-wrap items-center gap-x-3 px-3 py-2 text-[13px]">
                <span className="font-medium">{NAZWY[z.metryka] ?? z.metryka}</span>
                <span className="text-[var(--color-tekst-3)]">{temu(teraz - z.kiedy)}</span>
                {z.profileId ? <Link className="ml-auto text-[12px] text-[var(--color-akcent)]" href={`/t/${tenantId}/profile/${z.profileId}`}>{z.osoba ?? "profil"}</Link> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
