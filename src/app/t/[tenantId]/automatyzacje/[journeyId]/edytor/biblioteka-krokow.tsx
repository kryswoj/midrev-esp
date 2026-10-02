"use client";

import { useDraggable } from "@dnd-kit/core";
import { CalendarClock, CircleStop, Clock, FlaskConical, GitFork, GripVertical, Mail, UserCog, Zap, type LucideIcon } from "lucide-react";
import { NAZWY_WEZLOW, type TypWezla } from "../../../../../../domain/automatyzacje/graf";

/** Kroki, ktore operator moze dolozyc na kanwe (wyzwalacz i koniec powstaja same). */
export type TypDoDodania = Exclude<TypWezla, "wyzwalacz" | "koniec">;

export const IKONY_WEZLOW: Record<TypWezla, LucideIcon> = {
  wyzwalacz: Zap,
  opoznienie: Clock,
  czekaj_do: CalendarClock,
  warunek: GitFork,
  ab_split: FlaskConical,
  email: Mail,
  profil: UserCog,
  koniec: CircleStop,
};

/** Kolor kafelka ikony wg kategorii (jak w Klaviyo: wiadomosci, logika, dane). */
export const KAFELEK: Record<TypWezla, string> = {
  wyzwalacz: "bg-[#16181d] text-white",
  email: "bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]",
  opoznienie: "bg-[var(--color-powierzchnia-2)] text-[var(--color-tekst-2)]",
  czekaj_do: "bg-[var(--color-powierzchnia-2)] text-[var(--color-tekst-2)]",
  warunek: "bg-[var(--color-powierzchnia-2)] text-[var(--color-tekst-2)]",
  ab_split: "bg-[var(--color-powierzchnia-2)] text-[var(--color-tekst-2)]",
  profil: "bg-[var(--color-info-tlo)] text-[var(--color-info)]",
  koniec: "bg-[var(--color-powierzchnia-2)] text-[var(--color-tekst-3)]",
};

export const KATEGORIE: { tytul: string; kroki: { typ: TypDoDodania; opis: string }[] }[] = [
  { tytul: "Wiadomości", kroki: [{ typ: "email", opis: "Mail z edytora bloków" }] },
  {
    tytul: "Logika",
    kroki: [
      { typ: "opoznienie", opis: "Odczekaj minuty, godziny, dni" },
      { typ: "czekaj_do", opis: "Do dnia tygodnia i godziny" },
      { typ: "warunek", opis: "Rozgałęzienie Tak / Nie" },
      { typ: "ab_split", opis: "Losowy podział na dwie gałęzie" },
    ],
  },
  { tytul: "Dane", kroki: [{ typ: "profil", opis: "Dodaj do listy lub usuń z listy" }] },
];

function Krok({ typ, opis, onDodaj, powodBlokady }: { typ: TypDoDodania; opis: string; onDodaj: () => void; powodBlokady?: string }) {
  const drag = useDraggable({ id: `paleta:${typ}`, data: { zrodlo: "paleta", typ }, disabled: Boolean(powodBlokady) });
  const Ikona = IKONY_WEZLOW[typ];
  return (
    <div
      ref={drag.setNodeRef}
      className={`group flex items-center gap-2.5 rounded-lg border border-transparent px-2 py-2 ${powodBlokady ? "opacity-50" : "hover:border-[var(--color-linia)] hover:bg-white"}`}
      title={powodBlokady}
    >
      <button
        type="button"
        onClick={onDodaj}
        disabled={Boolean(powodBlokady)}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-not-allowed"
        aria-label={`Dodaj krok: ${NAZWY_WEZLOW[typ]}`}
      >
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md ${KAFELEK[typ]}`}><Ikona size={16} strokeWidth={1.9} /></span>
        <span className="min-w-0">
          <span className="block text-[14px] font-medium leading-5 text-[var(--color-tekst)]">{NAZWY_WEZLOW[typ]}</span>
          <span className="block truncate text-[12px] leading-4 text-[var(--color-tekst-3)]">{powodBlokady ?? opis}</span>
        </span>
      </button>
      <button
        type="button"
        ref={drag.setActivatorNodeRef}
        {...drag.listeners}
        {...drag.attributes}
        disabled={Boolean(powodBlokady)}
        aria-label={`Przeciągnij krok ${NAZWY_WEZLOW[typ]} na kanwę`}
        className="grid h-8 w-7 shrink-0 cursor-grab place-items-center rounded-md text-[var(--color-tekst-3)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing disabled:hidden"
      >
        <GripVertical size={15} />
      </button>
    </div>
  );
}

/**
 * Zwinieta paleta (domyslny stan na kanwie, fala 1 UX): same ikony 40 px w pasku 56 px.
 * Klik dodaje krok za zaznaczonym, przeciagniecie dziala jak z pelnej palety (inne id
 * przeciagania, bo obie wersje nie moga miec tego samego id w jednym DndContext).
 */
function KrokIkona({ typ, onDodaj, powodBlokady }: { typ: TypDoDodania; onDodaj: () => void; powodBlokady?: string }) {
  const drag = useDraggable({ id: `paleta-ikona:${typ}`, data: { zrodlo: "paleta", typ }, disabled: Boolean(powodBlokady) });
  const Ikona = IKONY_WEZLOW[typ];
  return (
    <button
      type="button"
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      onClick={onDodaj}
      disabled={Boolean(powodBlokady)}
      title={powodBlokady ?? `${NAZWY_WEZLOW[typ]}: kliknij, żeby dodać, albo przeciągnij na kanwę`}
      aria-label={`Dodaj krok: ${NAZWY_WEZLOW[typ]}`}
      className="grid h-10 w-10 cursor-grab place-items-center rounded-lg hover:bg-white hover:shadow-[var(--cien-karta)] active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className={`grid h-8 w-8 place-items-center rounded-md ${KAFELEK[typ]}`}><Ikona size={16} strokeWidth={1.9} /></span>
    </button>
  );
}

export function PasekKrokow({
  onDodaj,
  blokady,
}: {
  onDodaj: (typ: TypDoDodania) => void;
  blokady: Partial<Record<TypDoDodania, string>>;
}) {
  return (
    <div className="flex flex-col items-center gap-1 py-1">
      {KATEGORIE.map((k, i) => (
        <div key={k.tytul} className={`flex flex-col items-center gap-1 ${i ? "border-t border-[var(--color-linia-0)] pt-1" : ""}`} role="group" aria-label={k.tytul}>
          {k.kroki.map((s) => <KrokIkona key={s.typ} typ={s.typ} onDodaj={() => onDodaj(s.typ)} powodBlokady={blokady[s.typ]} />)}
        </div>
      ))}
    </div>
  );
}

export function BibliotekaKrokow({
  onDodaj,
  blokady,
}: {
  onDodaj: (typ: TypDoDodania) => void;
  blokady: Partial<Record<TypDoDodania, string>>;
}) {
  return (
    <div className="p-3">
      <div className="px-2 pb-2 pt-1 text-[15px] font-semibold">Kroki</div>
      <p className="px-2 pb-3 text-[12px] leading-4 text-[var(--color-tekst-3)]">Przeciągnij krok na kanwę albo kliknij, żeby dodać go za zaznaczonym.</p>
      {KATEGORIE.map((k) => (
        <section key={k.tytul} className="mb-3">
          <div className="etykieta px-2 pb-1">{k.tytul}</div>
          {k.kroki.map((s) => (
            <Krok key={s.typ} typ={s.typ} opis={s.opis} onDodaj={() => onDodaj(s.typ)} powodBlokady={blokady[s.typ]} />
          ))}
        </section>
      ))}
    </div>
  );
}
