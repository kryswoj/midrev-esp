"use client";

import { useId, useState, type ReactNode } from "react";
import { AlignCenter, AlignLeft, AlignRight, ExternalLink } from "lucide-react";
import { bezpiecznyUrl } from "../../../../../../../domain/email/bloki";

/** Drobne kontrolki panelu właściwości. Klasy z globals.css (`pole`, `etykieta`) + Tailwind. */

export function Sekcja({ tytul, children, opis }: { tytul: string; children: ReactNode; opis?: ReactNode }) {
  return (
    <section className="space-y-3.5 border-b border-[var(--color-linia-0)] px-4 py-4 last:border-b-0">
      <div>
        <h3 className="text-[13px] font-semibold">{tytul}</h3>
        {opis ? <p className="mt-0.5 text-[12px] leading-[17px] text-[var(--color-tekst-3)]">{opis}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function Pole({ etykieta, children, podpowiedz, blad }: { etykieta: string; children: (id: string) => ReactNode; podpowiedz?: ReactNode; blad?: string | null }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="etykieta mb-1.5 block">
        {etykieta}
      </label>
      {children(id)}
      {blad ? (
        <p role="alert" className="mt-1 text-[12px] leading-[17px] text-[var(--color-blad)]">
          {blad}
        </p>
      ) : podpowiedz ? (
        <p className="mt-1 text-[12px] leading-[17px] text-[var(--color-tekst-3)]">{podpowiedz}</p>
      ) : null}
    </div>
  );
}

export function PoleTekstu({ etykieta, wartosc, onZmiana, placeholder, podpowiedz, wielolinijkowe, maks, mono }: { etykieta: string; wartosc: string; onZmiana: (w: string) => void; placeholder?: string; podpowiedz?: ReactNode; wielolinijkowe?: number; maks?: number; mono?: boolean }) {
  return (
    <Pole etykieta={etykieta} podpowiedz={podpowiedz}>
      {(id) =>
        wielolinijkowe ? (
          <textarea id={id} rows={wielolinijkowe} value={wartosc} maxLength={maks} onChange={(e) => onZmiana(e.target.value)} placeholder={placeholder} className={`pole ${mono ? "font-mono text-[12px] leading-[18px]" : ""}`} />
        ) : (
          <input id={id} value={wartosc} maxLength={maks} onChange={(e) => onZmiana(e.target.value)} placeholder={placeholder} className="pole" />
        )
      }
    </Pole>
  );
}

/** Adres: walidacja na bieżąco, ten sam test co w renderze (http/https, opcjonalnie mailto). */
export function PoleUrl({ etykieta, wartosc, onZmiana, placeholder = "https://", mail = false, podpowiedz }: { etykieta: string; wartosc: string; onZmiana: (w: string) => void; placeholder?: string; mail?: boolean; podpowiedz?: ReactNode }) {
  const [dotkniete, setDotkniete] = useState(false);
  const zly = wartosc.trim() !== "" && !bezpiecznyUrl(wartosc, mail ? "www-lub-mail" : "www");
  return (
    <Pole
      etykieta={etykieta}
      podpowiedz={podpowiedz}
      blad={zly && dotkniete ? `Adres musi zaczynać się od https:// albo http://${mail ? " (albo mailto:)" : ""} i nie może mieć spacji.` : null}
    >
      {(id) => {
        const cel = bezpiecznyUrl(wartosc, mail ? "www-lub-mail" : "www");
        return (
          <div className="flex items-center gap-1.5">
            <input
              id={id}
              type="url"
              inputMode="url"
              value={wartosc}
              title={wartosc || undefined}
              onChange={(e) => onZmiana(e.target.value)}
              onBlur={() => setDotkniete(true)}
              placeholder={placeholder}
              aria-invalid={zly}
              className={`pole ${zly && dotkniete ? "!border-[var(--color-blad)]" : ""}`}
            />
            {cel && !cel.startsWith("mailto:") ? (
              // sprawdzenie celu linku jednym kliknięciem; noopener, żeby otwarta strona nie dostała panelu
              <a href={cel} target="_blank" rel="noopener noreferrer" title="Otwórz adres w nowej karcie" aria-label="Otwórz adres w nowej karcie" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[var(--color-linia-mocna)] text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-akcent)]">
                <ExternalLink size={15} />
              </a>
            ) : null}
          </div>
        );
      }}
    </Pole>
  );
}

const HEX = /^#[0-9a-f]{6}$/i;

export function PoleKoloru({ etykieta, wartosc, onZmiana, pusty, zablokowane, powod, zastepczy }: { etykieta: string; wartosc: string; onZmiana: (w: string) => void; /** etykieta stanu dziedziczonego (np. „kolor marki") — gdy podana, pole może być puste */ pusty?: string; zablokowane?: boolean; powod?: string; /** kolor dziedziczony, pokazywany w próbniku, gdy pole jest puste */ zastepczy?: string }) {
  const [tekst, setTekst] = useState(wartosc);
  const [poprzednia, setPoprzednia] = useState(wartosc);
  if (wartosc !== poprzednia) {
    setPoprzednia(wartosc);
    setTekst(wartosc);
  }
  const dziedziczony = Boolean(pusty) && !wartosc;
  const probka = HEX.test(wartosc) ? wartosc : zastepczy && HEX.test(zastepczy) ? zastepczy : "#ffffff";
  return (
    <Pole etykieta={etykieta} podpowiedz={zablokowane ? powod : undefined}>
      {(id) => (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${etykieta}: wybór z palety`}
            value={probka}
            disabled={zablokowane}
            onChange={(e) => onZmiana(e.target.value.toLowerCase())}
            className="h-9 w-10 shrink-0 cursor-pointer rounded-lg border border-[var(--color-linia-mocna)] bg-white p-1 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {dziedziczony && !zablokowane ? (
            // Wartość dziedziczona to nie jest puste pole: widać, skąd kolor pochodzi, i jak go nadpisać
            <>
              <span id={id} className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-dashed border-[var(--color-linia-mocna)] bg-[var(--color-powierzchnia-2)] px-2.5 text-[13px] text-[var(--color-tekst-2)]">
                <span className="truncate">{pusty}</span>
              </span>
              <button type="button" onClick={() => onZmiana(probka === "#ffffff" && !zastepczy ? "#ffffff" : probka)} className="przycisk przycisk-wtorny przycisk-maly shrink-0">
                Nadpisz
              </button>
            </>
          ) : (
            <>
              <input
                id={id}
                value={tekst}
                disabled={zablokowane}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setTekst(v);
                  if (HEX.test(v)) onZmiana(v.toLowerCase());
                }}
                className="pole font-mono text-[13px] disabled:bg-[var(--color-powierzchnia-2)] disabled:text-[var(--color-tekst-3)]"
                maxLength={7}
              />
              {pusty && !zablokowane ? (
                <button type="button" onClick={() => onZmiana("")} className="przycisk przycisk-wtorny przycisk-maly shrink-0" title={`Wróć do: ${pusty}`}>
                  Domyślny
                </button>
              ) : null}
            </>
          )}
        </div>
      )}
    </Pole>
  );
}

export function Suwak({ etykieta, wartosc, onZmiana, min, maks, krok = 1, jednostka = "px" }: { etykieta: string; wartosc: number; onZmiana: (w: number) => void; min: number; maks: number; krok?: number; jednostka?: string }) {
  const id = useId();
  const [tekst, setTekst] = useState(String(wartosc));
  const [poprzednia, setPoprzednia] = useState(wartosc);
  if (wartosc !== poprzednia) {
    setPoprzednia(wartosc);
    setTekst(String(wartosc));
  }
  return (
    <div>
      <label htmlFor={id} className="etykieta mb-1.5 block">
        {etykieta}
      </label>
      <div className="flex items-center gap-2.5">
        <input type="range" aria-label={`${etykieta} (suwak)`} min={min} max={maks} step={krok} value={wartosc} onChange={(e) => onZmiana(Number(e.target.value))} className="min-w-0 flex-1 accent-[var(--color-akcent)]" />
        <div className="relative w-[84px] shrink-0">
          <input
            id={id}
            type="number"
            inputMode="numeric"
            min={min}
            max={maks}
            step={krok}
            value={tekst}
            onChange={(e) => {
              setTekst(e.target.value);
              const n = Number(e.target.value);
              if (e.target.value !== "" && Number.isFinite(n)) onZmiana(Math.min(maks, Math.max(min, Math.round(n))));
            }}
            onBlur={() => setTekst(String(wartosc))}
            className="pole h-8 pl-2 pr-8 text-right tabular-nums"
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-[var(--color-tekst-3)]">{jednostka}</span>
        </div>
      </div>
    </div>
  );
}

export function Segmenty<T extends string>({ etykieta, wartosc, onZmiana, opcje }: { etykieta: string; wartosc: T; onZmiana: (w: T) => void; opcje: { wartosc: T; etykieta: ReactNode; opis: string }[] }) {
  return (
    <div>
      <span className="etykieta mb-1.5 block">{etykieta}</span>
      <div role="radiogroup" aria-label={etykieta} className="inline-flex w-full rounded-lg border border-[var(--color-linia-mocna)] bg-[var(--color-powierzchnia-2)] p-0.5">
        {opcje.map((o) => (
          <button
            key={o.wartosc}
            type="button"
            role="radio"
            aria-checked={wartosc === o.wartosc}
            title={o.opis}
            aria-label={o.opis}
            onClick={() => onZmiana(o.wartosc)}
            className={`flex h-8 flex-1 items-center justify-center rounded-md text-[13px] font-medium transition-colors ${
              wartosc === o.wartosc ? "bg-white text-[var(--color-tekst)] shadow-[var(--cien-karta)]" : "text-[var(--color-tekst-2)] hover:text-[var(--color-tekst)]"
            }`}
          >
            {o.etykieta}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Wyrownanie({ wartosc, onZmiana }: { wartosc: "left" | "center" | "right"; onZmiana: (w: "left" | "center" | "right") => void }) {
  return (
    <Segmenty
      etykieta="Wyrównanie"
      wartosc={wartosc}
      onZmiana={onZmiana}
      opcje={[
        { wartosc: "left", etykieta: <AlignLeft size={16} />, opis: "Do lewej" },
        { wartosc: "center", etykieta: <AlignCenter size={16} />, opis: "Do środka" },
        { wartosc: "right", etykieta: <AlignRight size={16} />, opis: "Do prawej" },
      ]}
    />
  );
}

export function Wybor<T extends string>({ etykieta, wartosc, onZmiana, opcje, zablokowane }: { etykieta: string; wartosc: T; onZmiana: (w: T) => void; opcje: { wartosc: T; etykieta: string }[]; zablokowane?: boolean }) {
  return (
    <Pole etykieta={etykieta}>
      {(id) => (
        <select id={id} value={wartosc} disabled={zablokowane} onChange={(e) => onZmiana(e.target.value as T)} className="pole">
          {opcje.map((o) => (
            <option key={o.wartosc} value={o.wartosc}>
              {o.etykieta}
            </option>
          ))}
        </select>
      )}
    </Pole>
  );
}

export function Przelacznik({ etykieta, wartosc, onZmiana }: { etykieta: string; wartosc: boolean; onZmiana: (w: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px]">
      <span className="text-[var(--color-tekst)]">{etykieta}</span>
      <input type="checkbox" checked={wartosc} onChange={(e) => onZmiana(e.target.checked)} className="h-4 w-4 accent-[var(--color-akcent)]" />
    </label>
  );
}
