"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  AlignLeft,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  GripVertical,
  Heading,
  Image as IkonaObrazu,
  ListChecks,
  Loader2,
  Mail,
  Monitor,
  MoreHorizontal,
  MousePointerClick,
  PartyPopper,
  Phone,
  Plus,
  Redo2,
  ShieldCheck,
  Smartphone,
  Tag,
  Trash2,
  Undo2,
  User,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  dodajKrok,
  dozwolonyBlok,
  duplikujBlok,
  duplikujKrok,
  krokPoId,
  nazwaKroku,
  NAZWY_BLOKOW,
  NAZWY_TYPOW,
  nowyBlok,
  problemyPublikacji,
  przeniesBlok,
  przeniesKrok,
  rozneDefinicje,
  usunBlok,
  usunKrok,
  wstawBlok,
  zmienBlok,
  zmienNazweKroku,
  type Blok,
  type DefinicjaFormularza,
  type Problem,
  type StylFormularza,
  type TypBloku,
} from "../../../../../domain/formularze/model";
import type { RegulyWyswietlania } from "../../../../../domain/formularze/wyswietlanie";
import type { WynikiFormularza } from "../../../../../usecases/popupy/wyswietlenia";
import { akcjaListyFormularzy, opublikujAkcja, wstrzymajAkcja, zapiszSzkicAkcja } from "../akcje";
import { AtrapaSklepu, PodgladFormularza, PodgladTeasera, StylePodgladu, WidokBloku } from "../podglad";
import { UstawieniaFormularza, UstawieniaTeasera, WlasciwosciBloku } from "./wlasciwosci";
import { ZakladkaWyniki } from "./zakladka-wyniki";
import { ZakladkaWyswietlanie } from "./zakladka-wyswietlanie";

/**
 * Builder formularza na pełnym ekranie, jak w Klaviyo: lewo kroki i bloki, środek podgląd
 * na żywo (komputer / telefon) z przeciąganiem, prawo właściwości. Zakładki u góry:
 * Projekt, Wyświetlanie, Wyniki. Autozapis szkicu (1,2 s), cofnij/ponów, publikacja
 * z listą rzeczy do poprawy. Szkic nigdy nie trafia na stronę bez „Opublikuj”.
 */

const IKONY: Record<TypBloku, LucideIcon> = {
  naglowek: Heading,
  tekst: AlignLeft,
  obraz: IkonaObrazu,
  email: Mail,
  imie: User,
  telefon: Phone,
  pytanie: ListChecks,
  przycisk: MousePointerClick,
  zgoda: ShieldCheck,
  kod: Tag,
  nie_dziekuje: XCircle,
};

const GRUPY: { nazwa: string; typy: TypBloku[] }[] = [
  { nazwa: "Treść", typy: ["naglowek", "tekst", "obraz"] },
  { nazwa: "Pola", typy: ["email", "imie", "telefon", "pytanie"] },
  { nazwa: "Akcje", typy: ["przycisk", "nie_dziekuje", "zgoda", "kod"] },
];

type Zakladka = "projekt" | "wyswietlanie" | "wyniki";

interface Historia {
  przeszlosc: DefinicjaFormularza[];
  obecny: DefinicjaFormularza;
  przyszlosc: DefinicjaFormularza[];
}

export interface DaneBuildera {
  tenantId: string;
  formId: string;
  nazwa: string;
  szkic: DefinicjaFormularza;
  opublikowana: DefinicjaFormularza | null;
  aktywny: boolean;
  revision: number;
  wersjaKlauzuli: number | null;
  listy: { id: string; name: string }[];
  firma: string;
  snippet: string;
  wyniki: WynikiFormularza;
  staryFormat: boolean;
}

function godzina(d: Date) {
  return d.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
}

// ── Elementy przeciągane ────────────────────────────────────────────────────

function KafelekBloku({ typ, dozwolony, powod, onDodaj }: { typ: TypBloku; dozwolony: boolean; powod?: string; onDodaj: () => void }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: `nowy:${typ}`, data: { typ }, disabled: !dozwolony });
  const I = IKONY[typ];
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...listeners}
      {...attributes}
      onClick={dozwolony ? onDodaj : undefined}
      aria-disabled={!dozwolony}
      title={dozwolony ? `Dodaj: ${NAZWY_BLOKOW[typ]} (kliknij albo przeciągnij)` : powod}
      className={`flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-lg border px-1.5 py-2 text-center text-[12px] font-medium leading-[14px] transition-colors ${
        dozwolony ? "cursor-grab border-[var(--color-linia)] bg-white text-[var(--color-tekst)] hover:border-[var(--color-akcent-ramka)] hover:text-[var(--color-akcent)] active:cursor-grabbing" : "cursor-not-allowed border-dashed border-[var(--color-linia)] bg-transparent text-[var(--color-tekst-3)] opacity-60"
      } ${isDragging ? "opacity-40" : ""}`}
    >
      <I size={18} aria-hidden="true" />
      {NAZWY_BLOKOW[typ]}
    </button>
  );
}

function BlokSortowalny({ blok, zaznaczony, onZaznacz, children, pierwszy, ostatni, onPrzesun, onDuplikuj, onUsun, wskaznik }: { blok: Blok; zaznaczony: boolean; onZaznacz: () => void; children: ReactNode; pierwszy: boolean; ostatni: boolean; onPrzesun: (k: -1 | 1) => void; onDuplikuj: () => void; onUsun: () => void; wskaznik: boolean }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: blok.id });
  const jedyny = blok.typ === "email" || blok.typ === "zgoda";
  const przycisk = "grid h-7 w-7 place-items-center rounded-md text-white/85 hover:bg-white/15 hover:text-white disabled:opacity-30";
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className="relative">
      {wskaznik ? <div className="mf-wskaznik" aria-hidden="true" /> : null}
      <div
        {...attributes}
        {...listeners}
        className="mfb"
        data-zaznaczony={zaznaczony}
        data-przeciagany={isDragging}
        role="button"
        tabIndex={0}
        aria-pressed={zaznaczony}
        aria-label={`${NAZWY_BLOKOW[blok.typ]}${zaznaczony ? " (zaznaczony)" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onZaznacz();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onZaznacz();
          }
        }}
      >
        <div style={{ pointerEvents: "none" }}>{children}</div>
      </div>
      {zaznaczony ? (
        <div className="absolute left-[calc(100%+14px)] top-0 z-10 flex flex-col items-center gap-0.5 rounded-lg bg-[#1f2328] p-0.5 shadow-[var(--cien-uniesiony)]" style={{ fontFamily: "var(--font-sans)" }} onClick={(e) => e.stopPropagation()}>
          <span className="grid h-7 w-7 place-items-center text-white/60" title={`${NAZWY_BLOKOW[blok.typ]}: przeciągnij blok, żeby przenieść`}>
            <GripVertical size={13} aria-hidden="true" />
          </span>
          <button type="button" className={przycisk} disabled={pierwszy} onClick={() => onPrzesun(-1)} aria-label="Przesuń wyżej">
            <ArrowUp size={14} />
          </button>
          <button type="button" className={przycisk} disabled={ostatni} onClick={() => onPrzesun(1)} aria-label="Przesuń niżej">
            <ArrowDown size={14} />
          </button>
          {!jedyny ? (
            <button type="button" className={przycisk} onClick={onDuplikuj} aria-label="Duplikuj blok">
              <Copy size={14} />
            </button>
          ) : null}
          <button type="button" className={przycisk} onClick={onUsun} aria-label="Usuń blok (Delete)">
            <Trash2 size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Strefa na końcu kroku: upuszczony tu blok ląduje na końcu. Widoczna tylko w trakcie przeciągania. */
function StrefaKonca({ aktywna, przeciaganie }: { aktywna: boolean; przeciaganie: boolean }) {
  const { setNodeRef } = useDroppable({ id: "koniec" });
  return (
    <div
      ref={setNodeRef}
      aria-hidden="true"
      style={{
        minHeight: przeciaganie ? 44 : 4,
        marginTop: przeciaganie ? 0 : -8,
        borderRadius: 8,
        border: przeciaganie ? `1.5px dashed ${aktywna ? "#814ac8" : "color-mix(in srgb, var(--mf-tekst) 25%, transparent)"}` : "none",
        background: aktywna ? "rgba(129,74,200,.08)" : "transparent",
      }}
    />
  );
}

function WierszKroku({ id, numer, nazwa, aktywny, onWybierz, onDuplikuj, onUsun, mozeUsunac, def, krokIndeks, celUpuszczenia }: { id: string; numer: number; nazwa: string; aktywny: boolean; onWybierz: () => void; onDuplikuj: () => void; onUsun: () => void; mozeUsunac: boolean; def: DefinicjaFormularza; krokIndeks: number; celUpuszczenia: boolean }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: `krok:${id}` });
  const [menu, setMenu] = useState(false);
  const krok = def.kroki[krokIndeks];
  const zEmailem = krok.bloki.some((b) => b.typ === "email");
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={`relative ${isDragging ? "z-10 opacity-70" : ""}`}>
      <div className={`group flex items-center gap-2 rounded-[10px] border p-1.5 pr-1 transition-colors ${aktywny ? "border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)]" : celUpuszczenia ? "border-[var(--color-akcent-ramka)] bg-[var(--color-akcent-tlo)]" : "border-[var(--color-linia)] bg-white hover:border-[var(--color-linia-mocna)]"}`}>
        <button type="button" {...attributes} {...listeners} className="grid h-8 w-5 shrink-0 cursor-grab place-items-center text-[var(--color-tekst-3)] active:cursor-grabbing" aria-label={`Przeciągnij, żeby zmienić kolejność: krok ${numer}`}>
          <GripVertical size={14} />
        </button>
        <button type="button" onClick={onWybierz} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-current={aktywny ? "step" : undefined}>
          <span className="relative block h-[46px] w-[58px] shrink-0 overflow-hidden rounded-md border border-[var(--color-linia)] bg-[#eef0f3]" aria-hidden="true">
            <span className="pointer-events-none absolute left-1/2 top-1 block w-[440px] -translate-x-1/2" style={{ zoom: 0.12 }}>
              <PodgladFormularza def={def} krok={krok} statyczny bezNakladki />
            </span>
          </span>
          <span className="min-w-0">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--color-tekst-3)]">Krok {numer}</span>
            <span className="block truncate text-[13px] font-semibold">{nazwa || `Krok ${numer}`}</span>
            {zEmailem ? <span className="block text-[11px] text-[var(--color-akcent)]">e-mail i zgoda</span> : null}
          </span>
        </button>
        <div className="relative">
          <button type="button" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-label={`Działania: krok ${numer}`} className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-tekst-3)] hover:bg-[var(--color-powierzchnia-2)]">
            <MoreHorizontal size={16} />
          </button>
          {menu ? (
            <div className="absolute right-0 top-9 z-30 w-44 rounded-[10px] border border-[var(--color-linia)] bg-white p-1 shadow-[var(--cien-uniesiony)]" onMouseLeave={() => setMenu(false)}>
              <button type="button" className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-[var(--color-powierzchnia-2)]" onClick={() => { setMenu(false); onDuplikuj(); }}>
                <Copy size={14} /> Duplikuj krok
              </button>
              {mozeUsunac ? (
                <button type="button" className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-[var(--color-blad)] hover:bg-[var(--color-powierzchnia-2)]" onClick={() => { setMenu(false); onUsun(); }}>
                  <Trash2 size={14} /> Usuń krok
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

// ── Builder ─────────────────────────────────────────────────────────────────

export function Builder(p: DaneBuildera) {
  const { tenantId, formId } = p;
  const [historia, setHistoria] = useState<Historia>({ przeszlosc: [], obecny: p.szkic, przyszlosc: [] });
  const def = historia.obecny;
  const [nazwa, setNazwa] = useState(p.nazwa);
  const [zakladka, setZakladka] = useState<Zakladka>("projekt");
  const [krokId, setKrokId] = useState(p.szkic.kroki[0].id);
  const [blokId, setBlokId] = useState<string | null>(null);
  const [teaser, setTeaser] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [opublikowana, setOpublikowana] = useState(p.opublikowana);
  const [aktywny, setAktywny] = useState(p.aktywny);
  const [wersjaKlauzuli, setWersjaKlauzuli] = useState(p.wersjaKlauzuli);
  // stary format zapisuje się w nowym przy pierwszej zmianie; do tego czasu nic nie jest „brudne”
  const [brudny, setBrudny] = useState(false);
  const [zapis, setZapis] = useState<{ trwa: boolean; blad: string | null; kiedy: Date | null }>({ trwa: false, blad: null, kiedy: null });
  const [konflikt, setKonflikt] = useState(false);
  const [problemyOtwarte, setProblemyOtwarte] = useState(false);
  const [menu, setMenu] = useState(false);
  const [publikacja, setPublikacja] = useState<{ trwa: boolean; problemy: Problem[] | null }>({ trwa: false, problemy: null });
  const [toast, setToast] = useState<{ tekst: string; ton?: "blad" } | null>(null);
  const [przeciagany, setPrzeciagany] = useState<string | null>(null);
  const [nad, setNad] = useState<string | null>(null);
  const revisionRef = useRef(p.revision);
  const zapisRef = useRef<Promise<boolean> | null>(null);
  const defRef = useRef(def);
  const nazwaRef = useRef(nazwa);
  defRef.current = def;
  nazwaRef.current = nazwa;

  const krok = krokPoId(def, krokId) ?? def.kroki[0];
  const sukces = krok.id === def.sukces.id;
  const blok = blokId ? krok.bloki.find((b) => b.id === blokId) ?? null : null;
  const problemy = useMemo(() => problemyPublikacji(def), [def]);
  const wymagane = problemy.filter((x) => x.wymagane);
  const niepublikowane = !aktywny || rozneDefinicje(def, opublikowana);

  // ── zmiany z historią ──
  const aktualizuj = useCallback((f: (d: DefinicjaFormularza) => DefinicjaFormularza) => {
    setHistoria((h) => {
      const n = f(h.obecny);
      if (n === h.obecny) return h;
      return { przeszlosc: [...h.przeszlosc.slice(-60), h.obecny], obecny: n, przyszlosc: [] };
    });
    setBrudny(true);
  }, []);
  const cofnij = () => {
    setHistoria((h) => (h.przeszlosc.length ? { przeszlosc: h.przeszlosc.slice(0, -1), obecny: h.przeszlosc[h.przeszlosc.length - 1], przyszlosc: [h.obecny, ...h.przyszlosc] } : h));
    setBrudny(true);
  };
  const ponow = () => {
    setHistoria((h) => (h.przyszlosc.length ? { przeszlosc: [...h.przeszlosc, h.obecny], obecny: h.przyszlosc[0], przyszlosc: h.przyszlosc.slice(1) } : h));
    setBrudny(true);
  };

  // gdy krok zniknął (cofnij, usuń), wracamy do pierwszego
  useEffect(() => {
    if (!krokPoId(def, krokId)) setKrokId(def.kroki[0].id);
  }, [def, krokId]);

  // ── zapis ──
  const zapisz = useCallback(async (): Promise<boolean> => {
    if (zapisRef.current) await zapisRef.current;
    const wysylany = defRef.current;
    const nazwaWysylana = nazwaRef.current.trim() || "Formularz";
    const zadanie = (async () => {
      setZapis((z) => ({ ...z, trwa: true }));
      try {
        const w = await zapiszSzkicAkcja(tenantId, formId, revisionRef.current, wysylany, nazwaWysylana);
        if (w.ok) {
          revisionRef.current = w.revision;
          setZapis({ trwa: false, blad: null, kiedy: new Date() });
          if (defRef.current === wysylany && nazwaRef.current.trim() === nazwaWysylana) setBrudny(false);
          return true;
        }
        if ("konflikt" in w) {
          setKonflikt(true);
          setZapis({ trwa: false, blad: "Ten formularz zmienił się w innej karcie. Odśwież stronę, żeby nie nadpisać zmian.", kiedy: null });
          return false;
        }
        setZapis({ trwa: false, blad: w.blad, kiedy: null });
        return false;
      } catch {
        setZapis({ trwa: false, blad: "Brak połączenia. Zmiany są w tej karcie, ponowimy zapis.", kiedy: null });
        return false;
      }
    })();
    zapisRef.current = zadanie;
    const wynik = await zadanie;
    zapisRef.current = null;
    return wynik;
  }, [tenantId, formId]);

  useEffect(() => {
    if (!brudny || konflikt) return;
    const t = setTimeout(() => void zapisz(), 1200);
    return () => clearTimeout(t);
  }, [def, nazwa, brudny, konflikt, zapisz]);

  useEffect(() => {
    const przed = (e: BeforeUnloadEvent) => {
      if (brudny) e.preventDefault();
    };
    window.addEventListener("beforeunload", przed);
    return () => window.removeEventListener("beforeunload", przed);
  }, [brudny]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // ── publikacja ──
  const [pytanieOListe, setPytanieOListe] = useState(false);
  const opublikuj = async (bezListy = false) => {
    setProblemyOtwarte(false);
    setPytanieOListe(false);
    if (wymagane.length) {
      setPublikacja({ trwa: false, problemy: wymagane });
      setProblemyOtwarte(true);
      return;
    }
    // formularz zapisu bez listy to zwykle przeoczenie: pytamy raz, świadomie (jak w Klaviyo)
    if (!defRef.current.listaId && !bezListy) {
      setPytanieOListe(true);
      return;
    }
    setPublikacja({ trwa: true, problemy: null });
    if ((brudny || p.staryFormat) && !(await zapisz())) {
      setPublikacja({ trwa: false, problemy: null });
      return;
    }
    const w = await opublikujAkcja(tenantId, formId, revisionRef.current);
    if (w.ok) {
      revisionRef.current += 1;
      setOpublikowana(defRef.current);
      setAktywny(true);
      setWersjaKlauzuli(w.wersjaKlauzuli);
      setPublikacja({ trwa: false, problemy: null });
      setToast({ tekst: w.nowaWersja ? `Opublikowano. Nowa treść zgody to wersja ${w.wersjaKlauzuli}. Sklep pokaże zmiany w ciągu minuty.` : "Opublikowano. Sklep pokaże zmiany w ciągu minuty." });
    } else if ("problemy" in w) {
      setPublikacja({ trwa: false, problemy: w.problemy });
      setProblemyOtwarte(true);
    } else if ("konflikt" in w) {
      setKonflikt(true);
      setPublikacja({ trwa: false, problemy: null });
      setToast({ tekst: "Formularz zmienił się w innej karcie. Odśwież stronę.", ton: "blad" });
    } else {
      setPublikacja({ trwa: false, problemy: null });
      setToast({ tekst: w.blad, ton: "blad" });
    }
  };

  const wstrzymaj = async () => {
    setMenu(false);
    const w = await wstrzymajAkcja(tenantId, formId, false);
    if (w.ok) {
      setAktywny(false);
      setToast({ tekst: "Wstrzymano. Formularz zniknie ze strony sklepu w ciągu minuty." });
    }
  };

  // ── bloki ──
  const dodaj = (typ: TypBloku, celKrok = krok.id, indeks?: number) => {
    const ok = dozwolonyBlok(def, celKrok, typ);
    if (!ok.ok) {
      setToast({ tekst: ok.powod ?? "Tego bloku nie da się tu dodać.", ton: "blad" });
      return;
    }
    const b = nowyBlok(typ, p.firma);
    const docelowy = krokPoId(def, celKrok);
    const gdzie = indeks ?? (celKrok === krok.id && blokId ? (docelowy?.bloki.findIndex((x) => x.id === blokId) ?? -1) + 1 || undefined : undefined);
    aktualizuj((d) => wstawBlok(d, celKrok, b, gdzie));
    setKrokId(celKrok);
    setBlokId(b.id);
    setTeaser(false);
  };
  const usun = (id: string) => {
    aktualizuj((d) => usunBlok(d, krok.id, id));
    if (blokId === id) setBlokId(null);
    setToast({ tekst: "Usunięto blok. Cofniesz to przez Ctrl+Z." });
  };
  const przesun = (id: string, k: -1 | 1) => {
    const i = krok.bloki.findIndex((b) => b.id === id);
    aktualizuj((d) => przeniesBlok(d, krok.id, i, i + k));
  };

  // ── klawiatura ──
  useEffect(() => {
    const naKlawisz = (e: KeyboardEvent) => {
      const cel = e.target as HTMLElement;
      const wPolu = cel.closest("input, textarea, select, [contenteditable=true]");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !wPolu) {
        e.preventDefault();
        if (e.shiftKey) ponow();
        else cofnij();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void zapisz();
      } else if (e.key === "Escape") {
        setBlokId(null);
        setProblemyOtwarte(false);
        setMenu(false);
        setPytanieOListe(false);
      } else if ((e.key === "Delete" || e.key === "Backspace") && blokId && !wPolu && zakladka === "projekt") {
        e.preventDefault();
        usun(blokId);
      }
    };
    window.addEventListener("keydown", naKlawisz);
    return () => window.removeEventListener("keydown", naKlawisz);
  });

  // ── przeciąganie ──
  const sensory = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const kolizje: CollisionDetection = useCallback((args) => {
    const aktywny = String(args.active.id);
    if (aktywny.startsWith("krok:")) return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith("krok:")) });
    const trafienia = pointerWithin(args);
    const bloki = trafienia.filter((c) => !String(c.id).startsWith("krok:") && c.id !== "koniec");
    if (bloki.length) return bloki;
    if (trafienia.length) return trafienia;
    if (aktywny.startsWith("nowy:")) return [];
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => !String(c.id).startsWith("krok:") && c.id !== "koniec") });
  }, []);

  const naStart = (e: DragStartEvent) => {
    setPrzeciagany(String(e.active.id));
    if (!String(e.active.id).startsWith("krok:")) setTeaser(false);
  };
  const naNad = (e: DragOverEvent) => setNad(e.over ? String(e.over.id) : null);
  const naKoniec = (e: DragEndEvent) => {
    const a = String(e.active.id);
    const o = e.over ? String(e.over.id) : null;
    setPrzeciagany(null);
    setNad(null);
    if (!o) return;
    if (a.startsWith("krok:") && o.startsWith("krok:")) {
      const z = def.kroki.findIndex((k) => `krok:${k.id}` === a);
      const na = def.kroki.findIndex((k) => `krok:${k.id}` === o);
      aktualizuj((d) => przeniesKrok(d, z, na));
      return;
    }
    if (a.startsWith("nowy:")) {
      const typ = a.slice(5) as TypBloku;
      if (o.startsWith("krok:")) dodaj(typ, o.slice(5));
      else if (o === "koniec") dodaj(typ, krok.id, krok.bloki.length);
      else {
        const i = krok.bloki.findIndex((b) => b.id === o);
        if (i >= 0) dodaj(typ, krok.id, i);
      }
      return;
    }
    if (o !== a && !o.startsWith("krok:") && o !== "koniec") {
      const z = krok.bloki.findIndex((b) => b.id === a);
      const na = krok.bloki.findIndex((b) => b.id === o);
      if (z >= 0 && na >= 0) aktualizuj((d) => przeniesBlok(d, krok.id, z, na));
    }
  };
  const nowyNad = przeciagany?.startsWith("nowy:") ? nad : null;

  // ── widoki ──
  const przyciskPaska = "grid h-8 w-8 place-items-center rounded-lg text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-tekst)] disabled:opacity-35 disabled:hover:bg-transparent";
  const segment = (a: boolean) => `flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors ${a ? "bg-white text-[var(--color-tekst)] shadow-[var(--cien-karta)]" : "text-[var(--color-tekst-2)] hover:text-[var(--color-tekst)]"}`;

  const stanZapisu = zapis.trwa ? (
    <span className="flex items-center gap-1.5 text-[var(--color-tekst-2)]">
      <Loader2 size={14} className="animate-spin" /> Zapisuję…
    </span>
  ) : zapis.blad ? (
    <span className="flex items-center gap-1.5 font-medium text-[var(--color-blad)]">
      <AlertTriangle size={14} /> Nie zapisano
    </span>
  ) : brudny ? (
    <span className="flex items-center gap-1.5 text-[var(--color-czeka)]">
      <span className="h-2 w-2 rounded-full bg-[var(--color-czeka)]" /> Zmiany…
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-[var(--color-tekst-2)]">
      <Check size={14} className="text-[var(--color-ok)]" /> {niepublikowane && opublikowana ? "Zapisane, czeka na publikację" : "Szkic zapisany"}{zapis.kiedy ? <span className="hidden xl:inline"> o {godzina(zapis.kiedy)}</span> : null}
    </span>
  );

  const etykietaPublikacji = !opublikowana ? "Opublikuj" : !aktywny ? "Opublikuj i włącz" : niepublikowane ? "Opublikuj zmiany" : "Opublikowano";
  const status = aktywny ? (niepublikowane ? <span className="plakietka plakietka-uwaga">na stronie, zmiany w szkicu</span> : <span className="plakietka plakietka-ok">na stronie</span>) : opublikowana ? <span className="plakietka plakietka-nieaktywna">wstrzymany</span> : <span className="plakietka plakietka-szkic">szkic</span>;

  const plotno = (
    <div className={`relative mx-auto h-full ${mobile ? "w-[390px] py-6" : "w-full"}`}>
      <div className={`relative h-full overflow-hidden ${mobile ? "rounded-[34px] border-[8px] border-[#1f2328] shadow-[var(--cien-uniesiony)]" : "rounded-xl border border-[var(--color-linia)] shadow-[var(--cien-karta)]"}`} style={{ containerType: "inline-size" }}>
        <AtrapaSklepu mobile={mobile}>
          {teaser ? (
            <PodgladTeasera def={def} />
          ) : def.typ === "embed" ? (
            <div className="absolute inset-x-0 bottom-0 top-[38%] overflow-y-auto bg-white/95 px-4 py-6 backdrop-blur-[1px]">{tresc()}</div>
          ) : (
            tresc()
          )}
        </AtrapaSklepu>
      </div>
    </div>
  );

  function tresc() {
    return (
      <SortableContext items={krok.bloki.map((b) => b.id)} strategy={verticalListSortingStrategy}>
        <div onClick={() => setBlokId(null)} className="contents">
          <PodgladFormularza
            def={def}
            krok={krok}
            owinBlok={(b, i, widok) => (
              <BlokSortowalny
                key={b.id}
                blok={b}
                zaznaczony={blokId === b.id}
                onZaznacz={() => setBlokId(b.id)}
                pierwszy={i === 0}
                ostatni={i === krok.bloki.length - 1}
                onPrzesun={(k) => przesun(b.id, k)}
                onDuplikuj={() => aktualizuj((d) => duplikujBlok(d, krok.id, b.id))}
                onUsun={() => usun(b.id)}
                wskaznik={nowyNad === b.id}
              >
                {widok}
              </BlokSortowalny>
            )}
            poBlokach={<StrefaKonca aktywna={nowyNad === "koniec"} przeciaganie={Boolean(przeciagany?.startsWith("nowy:"))} />}
          />
        </div>
      </SortableContext>
    );
  }

  const krokIndeks = def.kroki.findIndex((k) => k.id === krok.id);

  return (
    <DndContext id={`builder-${formId}`} sensors={sensory} collisionDetection={kolizje} onDragStart={naStart} onDragOver={naNad} onDragEnd={naKoniec} onDragCancel={() => { setPrzeciagany(null); setNad(null); }}>
      <StylePodgladu />
      <div className="flex h-[var(--wysokosc-pelnego-ekranu,100dvh)] min-h-0 flex-col overflow-hidden bg-[var(--color-plotno)]">
        {/* ── Pasek górny ── */}
        <header className="relative z-30 grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--color-linia)] bg-white px-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <div className="flex min-w-0 items-center gap-2">
            <Link href={`/t/${tenantId}/popupy`} className={przyciskPaska} aria-label="Wróć do formularzy" title="Formularze zapisu">
              <ArrowLeft size={18} />
            </Link>
            <div className="min-w-0">
              <input
                value={nazwa}
                onChange={(e) => {
                  setNazwa(e.target.value.slice(0, 120));
                  setBrudny(true);
                }}
                aria-label="Nazwa formularza"
                className="w-full min-w-0 truncate rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[15px] font-semibold leading-[20px] hover:border-[var(--color-linia)] focus:border-[var(--color-akcent)] focus:outline-none"
              />
              <div className="flex items-center gap-2 px-1.5 text-[12px] leading-[16px] text-[var(--color-tekst-2)] max-md:hidden">
                {status}
                <span>{NAZWY_TYPOW[def.typ].nazwa}</span>
              </div>
            </div>
          </div>

          <nav role="tablist" aria-label="Sekcje formularza" className="hidden rounded-lg bg-[var(--color-powierzchnia-2)] p-0.5 md:flex">
            {(
              [
                ["projekt", "Projekt"],
                ["wyswietlanie", "Wyświetlanie"],
                ["wyniki", "Wyniki"],
              ] as [Zakladka, string][]
            ).map(([z, t]) => (
              <button key={z} type="button" role="tab" aria-selected={zakladka === z} className={segment(zakladka === z)} onClick={() => setZakladka(z)}>
                {t}
              </button>
            ))}
          </nav>

          <div className="flex min-w-0 items-center justify-end gap-2">
            <span className="hidden shrink-0 whitespace-nowrap text-[13px] lg:block" aria-live="polite">
              {stanZapisu}
            </span>
            <div className="hidden items-center md:flex">
              <button type="button" className={przyciskPaska} onClick={cofnij} disabled={!historia.przeszlosc.length} aria-label="Cofnij (Ctrl+Z)" title="Cofnij (Ctrl+Z)">
                <Undo2 size={17} />
              </button>
              <button type="button" className={przyciskPaska} onClick={ponow} disabled={!historia.przyszlosc.length} aria-label="Ponów (Ctrl+Shift+Z)" title="Ponów (Ctrl+Shift+Z)">
                <Redo2 size={17} />
              </button>
            </div>
            {wymagane.length ? (
              <div className="relative hidden md:block">
                <button
                  type="button"
                  onClick={() => setProblemyOtwarte((o) => !o)}
                  aria-expanded={problemyOtwarte}
                  className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] px-2.5 text-[13px] font-semibold text-[var(--color-czeka)] hover:brightness-95"
                >
                  <AlertTriangle size={14} aria-hidden="true" />
                  {wymagane.length} <span className="hidden min-[1360px]:inline">do uzupełnienia</span>
                </button>
              </div>
            ) : null}
            <div className="relative hidden md:block">
              <button type="button" className={przyciskPaska} onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-label="Więcej działań">
                <MoreHorizontal size={18} />
              </button>
              {menu ? (
                <div className="absolute right-0 top-10 z-40 w-60 rounded-[10px] border border-[var(--color-linia)] bg-white p-1 shadow-[var(--cien-uniesiony)]">
                  {aktywny ? (
                    <button type="button" onClick={() => void wstrzymaj()} className="flex w-full rounded-md px-3 py-2 text-left text-[13px] hover:bg-[var(--color-powierzchnia-2)]">
                      Wstrzymaj (zdejmij ze strony)
                    </button>
                  ) : null}
                  <form action={akcjaListyFormularzy}>
                    <input type="hidden" name="tenantId" value={tenantId} />
                    <input type="hidden" name="popupId" value={formId} />
                    <button name="akcja" value="duplikuj" className="flex w-full rounded-md px-3 py-2 text-left text-[13px] hover:bg-[var(--color-powierzchnia-2)]">
                      Duplikuj formularz
                    </button>
                    <button name="akcja" value="archiwizuj" className="flex w-full rounded-md px-3 py-2 text-left text-[13px] text-[var(--color-blad)] hover:bg-[var(--color-powierzchnia-2)]">
                      Przenieś do archiwum
                    </button>
                  </form>
                </div>
              ) : null}
            </div>
            <button type="button" className="przycisk przycisk-maly shrink-0 whitespace-nowrap max-md:hidden" onClick={() => void opublikuj()} disabled={publikacja.trwa || konflikt || (aktywny && !niepublikowane && !brudny)}>
              {publikacja.trwa ? <Loader2 size={14} className="animate-spin" /> : null}
              {etykietaPublikacji}
            </button>
          </div>

          {pytanieOListe ? (
            <div className="absolute right-3 top-[52px] z-40 w-[360px] rounded-xl border border-[var(--color-linia)] bg-white p-4 shadow-[var(--cien-uniesiony)]" role="dialog" aria-label="Publikacja bez listy">
              <h3 className="text-[14px]">Zapisywać osoby na listę?</h3>
              <p className="mt-1 text-[13px] leading-[18px] text-[var(--color-tekst-2)]">Formularz nie ma listy docelowej. Zapisy trafią do profili i rejestru zgód, ale nie na listę, więc nie uruchomią automatyzacji z wyzwalaczem „dołączenie do listy”.</p>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={() => void opublikuj(true)}>Opublikuj bez listy</button>
                <button type="button" className="przycisk przycisk-maly" onClick={() => { setPytanieOListe(false); setZakladka("projekt"); setTeaser(false); setBlokId(null); setToast({ tekst: "Wybierz listę w panelu po prawej: „Zapisz na listę”." }); }}>Wybierz listę</button>
              </div>
            </div>
          ) : null}
          {problemyOtwarte ? (
            <div className="absolute right-3 top-[52px] z-40 w-[380px] rounded-xl border border-[var(--color-linia)] bg-white p-4 shadow-[var(--cien-uniesiony)]" role="dialog" aria-label="Do uzupełnienia przed publikacją">
              <div className="flex items-center justify-between">
                <h3 className="text-[14px]">Do uzupełnienia przed publikacją</h3>
                <button type="button" onClick={() => setProblemyOtwarte(false)} aria-label="Zamknij" className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-tekst-3)] hover:bg-[var(--color-powierzchnia-2)]">
                  <X size={15} />
                </button>
              </div>
              <ul className="mt-2 max-h-[min(420px,60vh)] space-y-1 overflow-y-auto">
                {(publikacja.problemy ?? problemy).map((x, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="flex w-full gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-[18px] text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)]"
                      onClick={() => {
                        setProblemyOtwarte(false);
                        if (x.krokId) {
                          setZakladka("projekt");
                          setTeaser(false);
                          setKrokId(x.krokId);
                          setBlokId(x.blokId ?? null);
                        } else if (x.tekst.startsWith("Wyświetlanie")) setZakladka("wyswietlanie");
                      }}
                    >
                      <AlertTriangle size={13} className={`mt-[3px] shrink-0 ${x.wymagane ? "text-[var(--color-blad)]" : "text-[var(--color-czeka)]"}`} aria-label={x.wymagane ? "blokuje publikację" : "zalecenie"} />
                      <span>{x.tekst}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 border-t border-[var(--color-linia-0)] pt-2 text-[12px] text-[var(--color-tekst-3)]">Czerwone blokują publikację, pomarańczowe to zalecenia. Kliknij, żeby przejść do miejsca.</p>
            </div>
          ) : null}
        </header>

        {zapis.blad || konflikt || p.staryFormat ? (
          <div className="shrink-0 border-b border-[var(--color-linia)] bg-white px-4 py-2 text-[13px]">
            {zapis.blad ? (
              <p role="alert" className="flex items-center gap-2 text-[var(--color-blad)]">
                {zapis.blad}
                {!konflikt ? (
                  <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={() => void zapisz()}>
                    Ponów zapis
                  </button>
                ) : (
                  <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={() => window.location.reload()}>
                    Odśwież
                  </button>
                )}
              </p>
            ) : p.staryFormat ? (
              <p className="text-[var(--color-tekst-2)]">Ten formularz powstał przed builderem. Pokazujemy go jako jeden krok w tym samym wyglądzie. Zmiany zobaczysz w sklepie po „Opublikuj zmiany”.</p>
            ) : null}
          </div>
        ) : null}

        {/* ── Telefon: tylko podgląd ── */}
        <div className="flex min-h-0 flex-1 flex-col md:hidden">
          <p className="flex shrink-0 items-start gap-2 border-b border-[var(--color-linia)] bg-[var(--color-akcent-tlo)] px-4 py-2.5 text-[13px] leading-[18px] text-[var(--color-tekst-2)]">
            <Monitor size={15} className="mt-px shrink-0 text-[var(--color-akcent)]" aria-hidden="true" />
            <span>
              <b className="font-semibold text-[var(--color-tekst)]">Builder działa na komputerze.</b> Tu sprawdzisz, jak formularz wygląda na telefonie.
            </span>
          </p>
          <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-[var(--color-linia)] bg-white px-3 py-2">
            {[...def.kroki, def.sukces].map((k, i) => (
              <button key={k.id} type="button" onClick={() => setKrokId(k.id)} className={`h-9 shrink-0 rounded-full border px-3 text-[13px] font-medium ${krok.id === k.id ? "border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]" : "border-[var(--color-linia)]"}`}>
                {k.id === def.sukces.id ? "Sukces" : `${i + 1}. ${k.nazwa}`}
              </button>
            ))}
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden" style={{ containerType: "inline-size" }}>
            <AtrapaSklepu mobile>
              {def.typ === "embed" ? (
                <div className="absolute inset-x-0 bottom-0 top-[30%] overflow-y-auto bg-white px-3 py-4">
                  <PodgladFormularza def={def} krok={krok} />
                </div>
              ) : (
                <PodgladFormularza def={def} krok={krok} />
              )}
            </AtrapaSklepu>
          </div>
        </div>

        {/* ── Komputer ── */}
        <div className="hidden min-h-0 flex-1 md:flex">
          {zakladka === "wyswietlanie" ? (
            <div className="min-w-0 flex-1">
              <ZakladkaWyswietlanie def={def} formId={formId} snippet={p.snippet} zmienReguly={(z: Partial<RegulyWyswietlania>) => aktualizuj((d) => ({ ...d, wyswietlanie: { ...d.wyswietlanie, ...z } }))} />
            </div>
          ) : zakladka === "wyniki" ? (
            <div className="min-w-0 flex-1">
              <ZakladkaWyniki tenantId={tenantId} formId={formId} def={opublikowana ?? def} poczatkowe={p.wyniki} />
            </div>
          ) : (
            <>
              {/* Lewo: kroki + bloki */}
              <aside className="flex w-[272px] shrink-0 flex-col overflow-y-auto border-r border-[var(--color-linia)] bg-[var(--color-panel)]" aria-label="Kroki i bloki">
                <section className="px-3 pb-3 pt-4">
                  <h2 className="mb-2 px-1 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--color-tekst-3)]">Kroki</h2>
                  <SortableContext items={def.kroki.map((k) => `krok:${k.id}`)} strategy={verticalListSortingStrategy}>
                    <ol className="space-y-1.5">
                      {def.kroki.map((k, i) => (
                        <WierszKroku
                          key={k.id}
                          id={k.id}
                          numer={i + 1}
                          nazwa={k.nazwa}
                          def={def}
                          krokIndeks={i}
                          aktywny={!teaser && krok.id === k.id}
                          celUpuszczenia={przeciagany?.startsWith("nowy:") === true && nad === `krok:${k.id}`}
                          onWybierz={() => {
                            setTeaser(false);
                            setKrokId(k.id);
                            setBlokId(null);
                          }}
                          onDuplikuj={() => {
                            const w = duplikujKrok(def, k.id);
                            aktualizuj(() => w.def);
                            setKrokId(w.krokId);
                            setBlokId(null);
                          }}
                          onUsun={() => {
                            aktualizuj((d) => usunKrok(d, k.id));
                            setBlokId(null);
                            setToast({ tekst: `Usunięto krok ${i + 1}. Cofniesz to przez Ctrl+Z.` });
                          }}
                          mozeUsunac={def.kroki.length > 1}
                        />
                      ))}
                    </ol>
                  </SortableContext>
                  {def.kroki.length < 8 ? (
                    <button
                      type="button"
                      className="mt-2 flex h-10 w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-[var(--color-linia-mocna)] text-[13px] font-semibold text-[var(--color-tekst-2)] hover:border-[var(--color-akcent)] hover:text-[var(--color-akcent)]"
                      onClick={() => {
                        const w = dodajKrok(def, krokIndeks >= 0 ? krok.id : undefined);
                        aktualizuj(() => w.def);
                        setKrokId(w.krokId);
                        setBlokId(null);
                        setTeaser(false);
                      }}
                    >
                      <Plus size={15} /> Dodaj krok
                    </button>
                  ) : null}
                  <h2 className="mb-2 mt-4 px-1 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--color-tekst-3)]">Po zapisie i po zamknięciu</h2>
                  <div className="space-y-1.5">
                    <button type="button" onClick={() => { setTeaser(false); setKrokId(def.sukces.id); setBlokId(null); }} className={`flex w-full items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left text-[13px] font-semibold ${!teaser && sukces ? "border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)]" : "border-[var(--color-linia)] bg-white hover:border-[var(--color-linia-mocna)]"}`}>
                      <PartyPopper size={16} className="text-[var(--color-ok)]" aria-hidden="true" /> Sukces
                      <span className="ml-auto text-[11px] font-normal text-[var(--color-tekst-3)]">kod, podziękowanie</span>
                    </button>
                    {def.typ !== "embed" ? (
                      <button type="button" onClick={() => { setTeaser(true); setBlokId(null); }} className={`flex w-full items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left text-[13px] font-semibold ${teaser ? "border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)]" : "border-[var(--color-linia)] bg-white hover:border-[var(--color-linia-mocna)]"}`}>
                        <Tag size={16} className="text-[var(--color-tekst-3)]" aria-hidden="true" /> Teaser
                        <span className="text-[11px] font-normal text-[var(--color-tekst-3)]">po zamknięciu</span>
                        <span className={`ml-auto text-[11px] font-normal ${def.teaser.wlaczony ? "text-[var(--color-ok)]" : "text-[var(--color-tekst-3)]"}`}>{def.teaser.wlaczony ? "włączony" : "wyłączony"}</span>
                      </button>
                    ) : null}
                  </div>
                </section>
                <section className="border-t border-[var(--color-linia)] px-3 pb-4 pt-3">
                  <h2 className="mb-1 px-1 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--color-tekst-3)]">Bloki</h2>
                  <p className="mb-2 px-1 text-[12px] leading-[16px] text-[var(--color-tekst-3)]">Kliknij albo przeciągnij do kroku: {teaser ? "wybierz krok" : nazwaKroku(def, krok.id)}.</p>
                  {GRUPY.map((g) => (
                    <div key={g.nazwa} className="mb-2.5">
                      <div className="mb-1 px-1 text-[11px] font-medium text-[var(--color-tekst-3)]">{g.nazwa}</div>
                      <div className="grid grid-cols-3 gap-1.5">
                        {g.typy.map((t) => {
                          const ok = dozwolonyBlok(def, krok.id, t);
                          return <KafelekBloku key={t} typ={t} dozwolony={ok.ok && !teaser} powod={teaser ? "Wybierz krok, do którego dodasz blok." : ok.powod} onDodaj={() => dodaj(t)} />;
                        })}
                      </div>
                    </div>
                  ))}
                </section>
              </aside>

              {/* Środek: płótno */}
              <section className="relative flex min-w-0 flex-1 flex-col" aria-label="Podgląd formularza">
                <div className="flex h-12 shrink-0 items-center justify-between gap-3 px-4">
                  <div className="min-w-0 truncate text-[13px] text-[var(--color-tekst-2)]">
                    {teaser ? (
                      <b className="font-semibold text-[var(--color-tekst)]">Teaser po zamknięciu</b>
                    ) : (
                      <>
                        <b className="font-semibold text-[var(--color-tekst)]">{sukces ? "Sukces" : `Krok ${krokIndeks + 1} z ${def.kroki.length}`}</b>
                        {!sukces && krok.nazwa ? <span> · {krok.nazwa}</span> : null}
                      </>
                    )}
                  </div>
                  <div role="radiogroup" aria-label="Urządzenie" className="flex rounded-lg bg-white p-0.5 shadow-[var(--cien-karta)]">
                    <button type="button" role="radio" aria-checked={!mobile} className={segment(!mobile)} onClick={() => setMobile(false)}>
                      <Monitor size={15} /> Komputer
                    </button>
                    <button type="button" role="radio" aria-checked={mobile} className={segment(mobile)} onClick={() => setMobile(true)}>
                      <Smartphone size={15} /> Telefon
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 px-4 pb-4" onClick={() => setBlokId(null)}>
                  {plotno}
                </div>
              </section>

              {/* Prawo: właściwości */}
              <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-[var(--color-linia)] bg-white" aria-label="Właściwości">
                {przeciagany ? (
                  <div className="pusty-stan">
                    <h2 className="text-[14px]">Upuść blok w formularzu</h2>
                    <p className="text-[13px]">Albo na kroku po lewej, żeby dodać go na końcu tego kroku.</p>
                  </div>
                ) : blok ? (
                  <WlasciwosciBloku
                    key={blok.id}
                    blok={blok}
                    sukces={sukces}
                    wersjaKlauzuli={wersjaKlauzuli}
                    zmien={(z) => aktualizuj((d) => zmienBlok(d, krok.id, blok.id, z))}
                    onUsun={() => usun(blok.id)}
                    onDuplikuj={() => aktualizuj((d) => duplikujBlok(d, krok.id, blok.id))}
                    onZamknij={() => setBlokId(null)}
                  />
                ) : teaser ? (
                  <UstawieniaTeasera def={def} zmienDef={aktualizuj} zmienStyl={(z: Partial<StylFormularza>) => aktualizuj((d) => ({ ...d, styl: { ...d.styl, ...z } }))} />
                ) : (
                  <UstawieniaFormularza
                    def={def}
                    krok={krok}
                    sukces={sukces}
                    listy={p.listy}
                    zmienDef={aktualizuj}
                    zmienStyl={(z: Partial<StylFormularza>) => aktualizuj((d) => ({ ...d, styl: { ...d.styl, ...z } }))}
                    zmienNazweKroku={(n) => aktualizuj((d) => zmienNazweKroku(d, krok.id, n))}
                    onDuplikujKrok={() => {
                      const w = duplikujKrok(def, krok.id);
                      aktualizuj(() => w.def);
                      setKrokId(w.krokId);
                    }}
                    onUsunKrok={() => {
                      aktualizuj((d) => usunKrok(d, krok.id));
                      setToast({ tekst: "Usunięto krok. Cofniesz to przez Ctrl+Z." });
                    }}
                    mozeUsunac={def.kroki.length > 1}
                  />
                )}
              </aside>
            </>
          )}
        </div>
      </div>

      {toast ? (
        <div role="status" className={`fixed bottom-6 left-1/2 z-[70] flex max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-lg py-2 pl-4 pr-2 text-[13px] text-white shadow-[var(--cien-uniesiony)] ${toast.ton === "blad" ? "bg-[var(--color-blad)]" : "bg-[#1f2328]"}`}>
          <span className="min-w-0">{toast.tekst}</span>
          <button type="button" onClick={() => setToast(null)} aria-label="Zamknij" className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-white/10">
            <X size={14} />
          </button>
        </div>
      ) : null}

      <DragOverlay dropAnimation={null}>
        {przeciagany?.startsWith("nowy:") ? (
          <div className="flex w-max items-center gap-2 rounded-lg border border-[var(--color-akcent-ramka)] bg-white px-3 py-2 text-[13px] font-medium text-[var(--color-akcent)] shadow-[var(--cien-uniesiony)]">
            {(() => {
              const I = IKONY[przeciagany.slice(5) as TypBloku];
              return <I size={16} />;
            })()}
            {NAZWY_BLOKOW[przeciagany.slice(5) as TypBloku]}
          </div>
        ) : przeciagany && !przeciagany.startsWith("krok:") ? (
          (() => {
            const b = krok.bloki.find((x) => x.id === przeciagany);
            return b ? (
              <div className="mf-root w-[360px] rounded-lg bg-white p-3 opacity-90 shadow-[var(--cien-uniesiony)]" style={{ ["--mf-tekst" as string]: def.styl.kolorTekstu, ["--mf-tlo" as string]: def.styl.tlo, ["--mf-przycisk" as string]: def.styl.kolorPrzycisku, ["--mf-przycisk-tekst" as string]: def.styl.kolorTekstuPrzycisku, ["--mf-radius" as string]: `${def.styl.zaokraglenie}px` }}>
                <WidokBloku blok={b} />
              </div>
            ) : null;
          })()
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
