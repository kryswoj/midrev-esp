"use client";

import { useDraggable } from "@dnd-kit/core";
import {
  Code,
  Columns2,
  Image as ObrazIkona,
  Minus,
  MousePointerClick,
  MoveVertical,
  PanelBottom,
  PanelTop,
  Share2,
  ShoppingBag,
  TicketPercent,
  Type,
  type LucideIcon,
} from "lucide-react";
import type { TypBloku } from "../../../../../../../domain/email/bloki";

export const NAZWY_BLOKOW: Record<TypBloku, string> = {
  naglowek: "Nagłówek z logo",
  tekst: "Tekst",
  obraz: "Obraz",
  przycisk: "Przycisk",
  separator: "Separator",
  odstep: "Odstęp",
  kolumny: "Dwie kolumny",
  produkt: "Produkt",
  kod: "Kod rabatowy",
  social: "Social",
  stopka: "Stopka",
  html: "Własny HTML",
};

export const IKONY_BLOKOW: Record<TypBloku, LucideIcon> = {
  naglowek: PanelTop,
  tekst: Type,
  obraz: ObrazIkona,
  przycisk: MousePointerClick,
  separator: Minus,
  odstep: MoveVertical,
  kolumny: Columns2,
  produkt: ShoppingBag,
  kod: TicketPercent,
  social: Share2,
  stopka: PanelBottom,
  html: Code,
};

const GRUPY: { tytul: string; typy: TypBloku[] }[] = [
  { tytul: "Podstawowe", typy: ["tekst", "obraz", "przycisk", "separator", "odstep", "kolumny"] },
  { tytul: "Sklep", typy: ["produkt", "kod", "social"] },
  { tytul: "Ramy maila", typy: ["naglowek", "stopka", "html"] },
];

function Kafel({ typ, onDodaj, zablokowane }: { typ: TypBloku; onDodaj: (typ: TypBloku) => void; zablokowane: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `paleta:${typ}`,
    data: { zrodlo: "paleta", typ },
    disabled: zablokowane,
  });
  const Ikona = IKONY_BLOKOW[typ];
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...listeners}
      {...attributes}
      disabled={zablokowane}
      // klik to druga droga do tego samego: blok ląduje pod zaznaczonym albo na końcu
      onClick={() => onDodaj(typ)}
      aria-label={`${NAZWY_BLOKOW[typ]} — przeciągnij na płótno albo kliknij, żeby dodać`}
      className={`group flex h-[72px] flex-col items-center justify-center gap-1.5 rounded-[10px] border border-[var(--color-linia)] bg-white px-2 text-center text-[12px] font-medium leading-[15px] text-[var(--color-tekst-2)] shadow-[var(--cien-karta)] transition-[border-color,box-shadow,color] hover:border-[var(--color-akcent-ramka)] hover:text-[var(--color-tekst)] hover:shadow-[var(--cien-uniesiony)] disabled:cursor-not-allowed disabled:opacity-50 ${
        isDragging ? "opacity-40" : ""
      } cursor-grab active:cursor-grabbing`}
    >
      <Ikona size={22} strokeWidth={1.6} className="text-[var(--color-tekst-3)] transition-colors group-hover:text-[var(--color-akcent)]" aria-hidden="true" />
      {NAZWY_BLOKOW[typ]}
    </button>
  );
}

export function Biblioteka({ onDodaj, zablokowane }: { onDodaj: (typ: TypBloku) => void; zablokowane: boolean }) {
  return (
    <div className="space-y-5 p-4">
      {GRUPY.map((g) => (
        <section key={g.tytul}>
          <h3 className="etykieta mb-2.5">{g.tytul}</h3>
          <div className="grid grid-cols-2 gap-2">
            {g.typy.map((t) => (
              <Kafel key={t} typ={t} onDodaj={onDodaj} zablokowane={zablokowane} />
            ))}
          </div>
        </section>
      ))}
      <p className="text-[12px] leading-[17px] text-[var(--color-tekst-3)]">
        Przeciągnij blok na płótno albo kliknij, żeby dodać go pod zaznaczonym.
      </p>
    </div>
  );
}
