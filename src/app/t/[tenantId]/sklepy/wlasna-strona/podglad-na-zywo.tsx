"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge, Icon } from "../../../../ui";
import { podgladAkcja, type StanPodgladu } from "./akcje";

/**
 * „Sprawdź połączenie”: podgląd na żywo (odpytywanie co 3 s, tylko gdy karta jest widoczna).
 * Checklista zapala się sama: skrypt pobrany, zdarzenia przeglądarki, osoba rozpoznana.
 */

const NAZWY: Record<string, string> = {
  "Viewed Product": "Oglądany produkt",
  "Added to Cart": "Dodanie do koszyka",
  "Started Checkout": "Rozpoczęte zamówienie",
  "Active on Site": "Aktywność na stronie",
  "Submitted Form": "Wysłany formularz",
  identify: "Rozpoznanie osoby",
};

function temu(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s temu`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min temu`;
  return `${Math.round(m / 60)} h temu`;
}

const OPIS_SYGNALU: Record<string, string> = {
  skrypt: "Skrypt pobrany przez stronę",
  anonimowe: "Gość jeszcze nierozpoznany (nic nie zapisujemy)",
  przyjete: "Przyjęte",
  odrzucone: "Odrzucone",
  subskrypcja: "Zapis na newsletter przyjęty",
};

export function PodgladNaZywo({ tenantId, stronaTestowa }: { tenantId: string; stronaTestowa: string | null }) {
  const [stan, ustawStan] = useState<StanPodgladu | null>(null);
  const [blad, ustawBlad] = useState(false);
  const trwa = useRef(false);

  useEffect(() => {
    let zyje = true;
    async function odswiez() {
      if (trwa.current || document.visibilityState !== "visible") return;
      trwa.current = true;
      try {
        const s = await podgladAkcja(tenantId);
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
  const skrypt = stan?.sygnaly.find((s) => s.rodzaj === "skrypt");
  const zdarzeniePrzegladarki = stan?.sygnaly.find((s) => s.rodzaj === "przyjete" || s.rodzaj === "anonimowe") ?? null;
  const rozpoznane = stan?.zdarzenia[0] ?? null;
  const kroki = [
    { ok: Boolean(skrypt), tekst: "Kod jest na stronie", detal: skrypt ? `${skrypt.origin ?? "strona"} · ${temu(teraz - skrypt.kiedy)}` : "Otwórz swoją stronę w nowej karcie" },
    { ok: Boolean(zdarzeniePrzegladarki || rozpoznane), tekst: "Strona wysyła zdarzenia", detal: zdarzeniePrzegladarki ? `${NAZWY[zdarzeniePrzegladarki.metryka ?? ""] ?? zdarzeniePrzegladarki.metryka} · ${temu(teraz - zdarzeniePrzegladarki.kiedy)}` : "Wejdź na kartę produktu i zaakceptuj cookies" },
    { ok: Boolean(rozpoznane), tekst: "Rozpoznajemy osoby", detal: rozpoznane ? `${rozpoznane.osoba ?? "profil"} · ${temu(teraz - rozpoznane.kiedy)}` : "Zapisz się w formularzu albo kliknij link z maila" },
  ];

  return (
    <div className="space-y-4" aria-live="polite">
      <ol className="grid gap-2 sm:grid-cols-3">
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
        {stronaTestowa ? (
          <a className="przycisk przycisk-wtorny przycisk-maly" href={stronaTestowa} target="_blank" rel="noopener noreferrer">
            Otwórz stronę ze znacznikiem
          </a>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-lg border border-[var(--color-linia)]">
        <div className="border-b border-[var(--color-linia-0)] bg-[var(--color-powierzchnia-2)] px-3 py-2 text-[12px] font-medium text-[var(--color-tekst-2)]">Ostatnio z Twojej strony</div>
        {!stan ? (
          <p className="px-3 py-4 text-[13px] text-[var(--color-tekst-2)]">Łączę…</p>
        ) : stan.zdarzenia.length === 0 && stan.sygnaly.length === 0 ? (
          <p className="px-3 py-4 text-[13px] text-[var(--color-tekst-2)]">Jeszcze nic. Otwórz swoją stronę, a wpisy pojawią się tu same.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-linia-0)]">
            {stan.zdarzenia.slice(0, 8).map((z) => (
              <li key={z.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
                <Badge ton="ok">zapisane</Badge>
                <span className="font-medium">{NAZWY[z.metryka] ?? z.metryka}</span>
                <span className="text-[var(--color-tekst-3)]">{temu(teraz - z.kiedy)}</span>
                {z.sciezka ? <code className="truncate text-[12px] text-[var(--color-tekst-2)]">{z.sciezka}</code> : null}
                {z.profileId ? (
                  <Link className="ml-auto text-[12px] text-[var(--color-akcent)] underline-offset-2 hover:underline" href={`/t/${tenantId}/profile/${z.profileId}`}>
                    {z.osoba ?? "profil"}
                  </Link>
                ) : null}
              </li>
            ))}
            {stan.sygnaly.slice(0, 8).map((s, i) => (
              <li key={`s${i}-${s.kiedy}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
                <Badge ton={s.rodzaj === "odrzucone" ? "blad" : "neutral"}>{s.rodzaj === "odrzucone" ? "odrzucone" : s.rodzaj === "skrypt" ? "skrypt" : "sygnał"}</Badge>
                <span className="font-medium">{s.metryka ? NAZWY[s.metryka] ?? s.metryka : OPIS_SYGNALU[s.rodzaj]}</span>
                <span className="text-[var(--color-tekst-3)]">{temu(teraz - s.kiedy)}</span>
                {s.sciezka ? <code className="truncate text-[12px] text-[var(--color-tekst-2)]">{s.sciezka}</code> : null}
                <span className="text-[12px] text-[var(--color-tekst-2)]">{s.powod ?? (s.metryka ? OPIS_SYGNALU[s.rodzaj] : s.origin ?? "")}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
