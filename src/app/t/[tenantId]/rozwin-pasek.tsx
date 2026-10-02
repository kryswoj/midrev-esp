"use client";

/**
 * Przycisk „Rozwiń / Zwiń menu” zwiniętego paska w trybie pełnego ekranu
 * (`src/app/ui/tryb-pelny-ekran.tsx`) oraz podpowiedzi z nazwą pozycji obok ikon.
 * Poza tym trybem przycisk jest ukryty w CSS, a podpowiedź się nie pokazuje.
 *
 * Stan rozwinięcia to wyłącznie `aria-expanded` tego przycisku; CSS czyta go przez
 * `.uklad-pasek:has(.uklad-pasek-rozwin[aria-expanded="true"])`, więc nie ma
 * imperatywnych atrybutów do sprzątania. Rozwinięty pasek wysuwa się NAD obszar roboczy
 * (kanwa się nie przesuwa), a zwija się sam po przejściu na inną stronę, po Escape
 * i po kliknięciu poza paskiem.
 */
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

type Podpowiedz = { tekst: string; x: number; y: number } | null;

function trybPelnyAktywny(pasek: HTMLElement) {
  return Boolean(pasek.closest(".uklad-panelu")?.querySelector(".uklad-tresc [data-esp-pelny-ekran]"));
}

export function RozwinPasek() {
  const [rozwiniety, ustawRozwiniety] = useState(false);
  const [podpowiedz, ustawPodpowiedz] = useState<Podpowiedz>(null);
  const przycisk = useRef<HTMLButtonElement>(null);
  const sciezka = usePathname();
  // wzorzec Reacta „dostosuj stan przy zmianie wartości”: zwinięcie w tym samym renderze,
  // w którym przychodzi nowa ścieżka (bez efektu i bez klatki z otwartym paskiem)
  const [poprzedniaSciezka, ustawPoprzedniaSciezka] = useState(sciezka);
  if (sciezka !== poprzedniaSciezka) {
    ustawPoprzedniaSciezka(sciezka);
    ustawRozwiniety(false);
    ustawPodpowiedz(null);
  }

  useEffect(() => {
    if (!rozwiniety) return;
    const pasek = przycisk.current?.closest<HTMLElement>(".uklad-pasek");
    if (!pasek) return;
    const naKlawisz = (e: KeyboardEvent) => { if (e.key === "Escape") ustawRozwiniety(false); };
    const naKlik = (e: PointerEvent) => { if (e.target instanceof Node && !pasek.contains(e.target)) ustawRozwiniety(false); };
    document.addEventListener("keydown", naKlawisz);
    document.addEventListener("pointerdown", naKlik);
    return () => {
      document.removeEventListener("keydown", naKlawisz);
      document.removeEventListener("pointerdown", naKlik);
    };
  }, [rozwiniety]);

  // Podpowiedzi: jeden element position:fixed, bo lista ikon się przewija (overflow-y),
  // a pseudo-element ::after zostałby ucięty przy krawędzi 64-pikselowego paska.
  useEffect(() => {
    const pasek = przycisk.current?.closest<HTMLElement>(".uklad-pasek");
    if (!pasek || rozwiniety) { ustawPodpowiedz(null); return; }
    const pokaz = (e: Event) => {
      const cel = (e.target as Element | null)?.closest<HTMLElement>("[data-etykieta]");
      if (!cel || !pasek.contains(cel) || !trybPelnyAktywny(pasek)) return;
      const r = cel.getBoundingClientRect();
      ustawPodpowiedz({ tekst: cel.dataset.etykieta ?? "", x: r.right + 10, y: r.top + r.height / 2 });
    };
    const ukryj = () => ustawPodpowiedz(null);
    pasek.addEventListener("pointerover", pokaz);
    pasek.addEventListener("focusin", pokaz);
    pasek.addEventListener("pointerleave", ukryj);
    pasek.addEventListener("focusout", ukryj);
    pasek.addEventListener("scroll", ukryj, true);
    return () => {
      pasek.removeEventListener("pointerover", pokaz);
      pasek.removeEventListener("focusin", pokaz);
      pasek.removeEventListener("pointerleave", ukryj);
      pasek.removeEventListener("focusout", ukryj);
      pasek.removeEventListener("scroll", ukryj, true);
    };
  }, [rozwiniety]);

  const etykieta = rozwiniety ? "Zwiń menu" : "Rozwiń menu";
  return (
    <>
      <button
        ref={przycisk}
        type="button"
        className="uklad-pasek-rozwin nawigacja-pozycja w-full cursor-pointer"
        aria-expanded={rozwiniety}
        aria-label={etykieta}
        data-etykieta={etykieta}
        onClick={() => ustawRozwiniety((r) => !r)}
      >
        {rozwiniety ? <PanelLeftClose aria-hidden="true" size={18} strokeWidth={1.75} /> : <PanelLeftOpen aria-hidden="true" size={18} strokeWidth={1.75} />}
        <span className="nawigacja-etykieta min-w-0 flex-1 whitespace-nowrap text-left">{etykieta}</span>
      </button>
      {/* nazwa linku i tak jest w jego treści (ukrytej wizualnie), więc podpowiedź jest tylko wizualna */}
      {podpowiedz ? <span className="uklad-podpowiedz" aria-hidden="true" style={{ left: podpowiedz.x, top: podpowiedz.y }}>{podpowiedz.tekst}</span> : null}
    </>
  );
}
