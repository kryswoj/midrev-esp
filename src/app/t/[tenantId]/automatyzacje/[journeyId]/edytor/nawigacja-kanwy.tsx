"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { AlertTriangle, Check, ChevronRight } from "lucide-react";
import { formaOdmiany } from "../../../../../../domain/liczebniki";
import type { BladGrafu } from "../../../../../../domain/automatyzacje/graf";
import type { Uklad } from "../../../../../../domain/automatyzacje/uklad";

/**
 * Elementy nawigacji kanwy (fala 1 UX, pkt 3 i 6): lista problemow w naglowku (licznik
 * zamiast tekstu bledu) i minimapa 160 x 100 w rogu. Bez wlasnego stanu grafu: dostaja uklad
 * i referencje przewijanego obszaru kanwy.
 */

// ── Licznik problemow z lista ────────────────────────────────────────────────

export function ListaProblemow({
  bledy,
  gotowa,
  nazwaKroku,
  onWybierz,
}: {
  bledy: BladGrafu[];
  /** pokazac "Gotowa do wlaczenia", gdy nie ma problemow (szkic) */
  gotowa: boolean;
  nazwaKroku: (wezelId: string) => string | null;
  onWybierz: (wezelId: string | null) => void;
}) {
  const [otwarta, setOtwarta] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!otwarta) return;
    const klik = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOtwarta(false); };
    const klawisz = (e: KeyboardEvent) => { if (e.key === "Escape") setOtwarta(false); };
    document.addEventListener("mousedown", klik);
    document.addEventListener("keydown", klawisz);
    return () => { document.removeEventListener("mousedown", klik); document.removeEventListener("keydown", klawisz); };
  }, [otwarta]);
  if (!bledy.length) {
    return gotowa ? (
      <span className="flex items-center gap-1.5 whitespace-nowrap text-[13px] text-[var(--color-ok)]"><Check size={14} /> Gotowa do włączenia</span>
    ) : null;
  }
  const n = bledy.length;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={otwarta}
        aria-haspopup="true"
        onClick={() => setOtwarta((o) => !o)}
        className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] px-2.5 text-[13px] font-medium text-[var(--color-czeka)] hover:brightness-[0.98]"
      >
        <AlertTriangle size={14} aria-hidden="true" />
        {n} {formaOdmiany(n, "rzecz", "rzeczy", "rzeczy")} do uzupełnienia
      </button>
      {otwarta ? (
        <div role="dialog" aria-label="Do uzupełnienia przed włączeniem" className="absolute right-0 top-10 z-40 w-[360px] max-w-[calc(100vw-32px)] rounded-[10px] border border-[var(--color-linia)] bg-white p-1.5 shadow-[var(--cien-uniesiony)]">
          <div className="etykieta px-2.5 pb-1 pt-1.5">Do uzupełnienia przed włączeniem</div>
          <ul>
            {bledy.map((b, i) => {
              const krok = b.wezelId ? nazwaKroku(b.wezelId) : null;
              return (
                <li key={`${b.wezelId}|${b.tresc}|${i}`}>
                  <button
                    type="button"
                    onClick={() => { setOtwarta(false); onWybierz(b.wezelId); }}
                    className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-[var(--color-akcent-tlo)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-semibold leading-4 text-[var(--color-tekst)]">{krok ?? "Ustawienia automatyzacji"}</span>
                      <span className="mt-0.5 block text-[13px] leading-[18px] text-[var(--color-tekst-2)]">{b.tresc}</span>
                    </span>
                    <ChevronRight size={14} className="mt-0.5 shrink-0 text-[var(--color-tekst-3)]" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ── Minimapa ─────────────────────────────────────────────────────────────────

const MINI_W = 160;
const MINI_H = 100;

export function Minimapa({
  uklad,
  zoom,
  kanwaRef,
  grafRef,
  zaznaczony,
  bledne,
}: {
  uklad: Uklad;
  zoom: number;
  kanwaRef: RefObject<HTMLElement | null>;
  grafRef: RefObject<HTMLElement | null>;
  zaznaczony: string | null;
  bledne: Set<string>;
}) {
  const [widok, setWidok] = useState<{ x: number; y: number; w: number; h: number; potrzebna: boolean } | null>(null);
  const przelicz = useCallback(() => {
    const el = kanwaRef.current;
    const graf = grafRef.current;
    if (!el || !graf) return;
    const k = el.getBoundingClientRect();
    const g = graf.getBoundingClientRect();
    setWidok({
      x: (k.left - g.left) / zoom,
      y: (k.top - g.top) / zoom,
      w: el.clientWidth / zoom,
      h: el.clientHeight / zoom,
      // minimapa tylko, gdy graf nie miesci sie w oknie kanwy
      potrzebna: uklad.szerokosc * zoom > el.clientWidth - 16 || uklad.wysokosc * zoom > el.clientHeight - 16,
    });
  }, [grafRef, kanwaRef, uklad.szerokosc, uklad.wysokosc, zoom]);
  useEffect(() => {
    const el = kanwaRef.current;
    if (!el) return;
    przelicz();
    el.addEventListener("scroll", przelicz, { passive: true });
    const ro = new ResizeObserver(przelicz);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", przelicz); ro.disconnect(); };
  }, [kanwaRef, przelicz]);
  if (!widok?.potrzebna) return null;
  const skala = Math.min(MINI_W / uklad.szerokosc, MINI_H / uklad.wysokosc);
  const w = uklad.szerokosc * skala;
  const h = uklad.wysokosc * skala;
  const przejdz = (e: React.MouseEvent<SVGSVGElement>) => {
    const el = kanwaRef.current;
    const graf = grafRef.current;
    if (!el || !graf) return;
    const r = e.currentTarget.getBoundingClientRect();
    const gx = (e.clientX - r.left - (MINI_W - w) / 2) / skala;
    const gy = (e.clientY - r.top - (MINI_H - h) / 2) / skala;
    const k = el.getBoundingClientRect();
    const g = graf.getBoundingClientRect();
    el.scrollBy({ left: g.left + gx * zoom - (k.left + el.clientWidth / 2), top: g.top + gy * zoom - (k.top + el.clientHeight / 2), behavior: "smooth" });
  };
  const ogranicz = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const vx = ogranicz(widok.x, 0, uklad.szerokosc), vy = ogranicz(widok.y, 0, uklad.wysokosc);
  const vw = ogranicz(widok.x + widok.w, 0, uklad.szerokosc) - vx, vh = ogranicz(widok.y + widok.h, 0, uklad.wysokosc) - vy;
  return (
    <div className="rounded-lg border border-[var(--color-linia)] bg-white/95 p-1.5 shadow-[var(--cien-uniesiony)]" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <svg width={MINI_W} height={MINI_H} viewBox={`0 0 ${MINI_W} ${MINI_H}`} role="img" aria-label="Minimapa automatyzacji: kliknij, żeby przejść w to miejsce" className="block cursor-pointer" onClick={przejdz}>
        <g transform={`translate(${(MINI_W - w) / 2} ${(MINI_H - h) / 2})`}>
          {uklad.wezly.map((p) => (
            <rect
              key={p.id}
              x={p.x * skala}
              y={p.y * skala}
              width={Math.max(2, p.w * skala)}
              height={Math.max(2, p.h * skala)}
              rx={2}
              fill={p.id === zaznaczony ? "var(--color-akcent)" : bledne.has(p.id) ? "var(--color-czeka)" : "#c9ced6"}
            />
          ))}
          <rect x={vx * skala} y={vy * skala} width={Math.max(4, vw * skala)} height={Math.max(4, vh * skala)} fill="rgba(129,74,200,0.10)" stroke="var(--color-akcent)" strokeWidth={1.25} rx={2} />
        </g>
      </svg>
    </div>
  );
}
