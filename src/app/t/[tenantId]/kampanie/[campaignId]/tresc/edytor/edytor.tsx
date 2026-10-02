"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
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
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  ExternalLink,
  Eye,
  GripVertical,
  Loader2,
  Lock,
  Minus,
  Monitor,
  PenLine,
  Plus,
  Redo2,
  Send,
  Smartphone,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  cofnij,
  kopiaBloku,
  linkiSledzone,
  nowaHistoria,
  nowyBlok,
  ponow,
  przeniesBlok,
  przesunBlok,
  przykladoweDane,
  przykladyWBloku,
  SILNIK_SZEROKOSC_KARTY,
  SILNIK_TLO,
  SILNIK_WCIECIE,
  usunBlok,
  wstawBlok,
  zapiszWHistorii,
  zmienBlok,
  type Blok,
  type DaneKonta,
  type DokumentMaila,
  type Historia,
  type StyleMaila,
  type TypBloku,
  type ZrodloDokumentu,
} from "../../../../../../../domain/email/bloki";
import { formaOdmiany } from "../../../../../../../domain/liczebniki";
import { renderujDokument } from "../../../../../../../usecases/tresc/render-blokow";
import { podgladBlokowAkcja, wyslijTestZEdytoraAkcja, zapiszBlokiAkcja } from "../../../../../../akcje";
import { IKONY_BLOKOW, NAZWY_BLOKOW } from "./biblioteka";
import { WidokBloku } from "./bloki-plotna";
import { akcjaKlawisza, kontekstZCelu } from "./klawisze";
import { MAKS_PLIKOW_NARAZ, ocenPlikObrazu, przeciaganePliki, wyslijObraz } from "./obrazy-klient";
import { PanelLewy, type ZakladkaLewa } from "./panel-lewy";
import { StyleGlobalne, WlasciwosciBloku } from "./panel-wlasciwosci";

/**
 * Edytor maila typu „przeciągnij i upuść" (krok 2 kreatora), na pełnym ekranie.
 *
 * Układ (audyt UX 02.10, P0-1): pasek górny edytora zamiast paska kroków, lewy panel
 * (Bloki / Szablony / Obrazy), płótno z zoomem i przełącznikiem komputer/telefon, prawy
 * panel właściwości. Na telefonie (<768 px) edytor jest podglądem tylko do odczytu
 * z „Wyślij test" (P0-4): układanie maila na 390 px nie ma sensu, a podgląd i test tak.
 *
 * Stan: historia dokumentów (cofnij/ponów), zaznaczony blok, blok w edycji tekstu, znacznik
 * zapisu. Dokument jest JEDYNYM źródłem prawdy — płótno i panel tylko go czytają i proponują
 * zmiany. Zapis idzie przez `zapiszBlokiAkcja`, która na serwerze waliduje, sanityzuje
 * i renderuje HTML do `content.html` (tam czyta silnik wysyłki).
 */

type Widok = "desktop" | "mobile";
type Tryb = "edycja" | "podglad";
type Przeciagany = { zrodlo: "paleta"; typ: TypBloku } | { zrodlo: "plotno"; id: string; typ: TypBloku };
type Skala = "dopasuj" | number;
type Toast = { tekst: string; cofnij?: boolean; ton?: "info" | "blad" | "trwa" };
type Brak = { tekst: string; link?: { href: string; etykieta: string }; wymagane?: boolean };

/** Dane konta do nagłówka, stopki i listy braków. Tylko to, co operator wpisał sam. */
export interface KontoEdytora {
  nazwaSklepu: string;
  firma: string | null;
  adres: string | null;
  nip: string | null;
}

const SZEROKOSC_URZADZENIA: Record<Widok, number> = { desktop: SILNIK_SZEROKOSC_KARTY + 2 * SILNIK_WCIECIE, mobile: 375 + 12 }; // 375 px ekranu + ramka telefonu
// Wymiary odwzorowują oprawę silnika (`zlozWiadomosc`): karta 560 px treści + 2 × 32 px
// wcięcia. Płótno pokazuje treść w tej szerokości, w jakiej dostanie ją odbiorca. Na
// komputerze szare tło płótna gra rolę tła silnika; na telefonie widać też wcięcie body.
const WCIECIE_BODY = 24;
/** odstęp maila od krawędzi płótna z każdej strony (przy „Dopasuj") */
const MARGINES_PLOTNA = 24;
const SKALE = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5];

function godzina(iso: string): string {
  return new Date(iso).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
}

function useEkranTelefonu(): boolean {
  const [telefon, setTelefon] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(max-width: 767px)");
    const zmiana = () => setTelefon(m.matches);
    zmiana();
    m.addEventListener("change", zmiana);
    return () => m.removeEventListener("change", zmiana);
  }, []);
  return telefon;
}

/** Zakres (kursor) w punkcie ekranu: Chromium/Safari i Firefox mają różne API. */
function zakresWPunkcie(x: number, y: number): Range | null {
  const d = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (d.caretRangeFromPoint) return d.caretRangeFromPoint(x, y);
  const p = d.caretPositionFromPoint?.(x, y);
  if (!p) return null;
  const r = document.createRange();
  r.setStart(p.offsetNode, p.offset);
  r.collapse(true);
  return r;
}

function liniaFirmy(konto: KontoEdytora): string {
  return [konto.firma, konto.adres?.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(", "), konto.nip ? `NIP ${konto.nip}` : null]
    .map((c) => (c ?? "").trim())
    .filter(Boolean)
    .join(" · ");
}

// ── Blok na płótnie ───────────────────────────────────────────────────────────────

function BlokNaPlotnie({
  blok,
  indeks,
  liczba,
  styl,
  mobile,
  zaznaczony,
  edycjaTekstu,
  przeciagany,
  celPliku,
  onZaznacz,
  onWejdzWTekst,
  onZmiana,
  onUsun,
  onDuplikuj,
  onPrzesun,
  menuOtwarte,
  onMenu,
  onDodajPo,
  trwaPrzeciaganie,
}: {
  blok: Blok;
  indeks: number;
  liczba: number;
  styl: StyleMaila;
  mobile: boolean;
  zaznaczony: boolean;
  /** tekst bloku jest edytowalny (drugi klik albo Enter) */
  edycjaTekstu: boolean;
  przeciagany: boolean;
  /** nad tym blokiem wisi plik z dysku, który podmieni obraz */
  celPliku: boolean;
  onZaznacz: () => void;
  onWejdzWTekst: (punkt?: { x: number; y: number }) => void;
  onZmiana: (zmiany: Partial<Blok>, klucz?: string) => void;
  onUsun: () => void;
  onDuplikuj: () => void;
  onPrzesun: (k: -1 | 1) => void;
  menuOtwarte: boolean;
  onMenu: (otwarte: boolean) => void;
  onDodajPo: (typ: TypBloku) => void;
  /** w trakcie przeciągania znika cała „chrom” zaznaczenia — zostaje tylko miejsce upuszczenia */
  trwaPrzeciaganie: boolean;
}) {
  const drop = useDroppable({ id: `blok:${blok.id}`, data: { id: blok.id } });
  // Stan zaznaczenia z chwili NACIŚNIĘCIA myszy: kliknięcie najpierw daje blokowi fokus
  // (onFocus go zaznacza), więc w onClick blok jest już „zaznaczony" i pierwszy klik
  // wchodziłby od razu w tekst. Decyduje to, co było przed naciśnięciem.
  const zaznaczonyPrzedKliknieciem = useRef(false);
  const drag = useDraggable({ id: `plotno:${blok.id}`, data: { zrodlo: "plotno", id: blok.id, typ: blok.typ } });
  const Ikona = IKONY_BLOKOW[blok.typ];
  const tlo = blok.tlo || undefined;
  const przyklady = przykladyWBloku(blok);
  const akcja = "grid h-8 w-8 place-items-center rounded-md text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-tekst)] disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div
      ref={(n) => {
        drop.setNodeRef(n);
        drag.setNodeRef(n);
      }}
      data-blok={blok.id}
      data-typ={blok.typ}
      tabIndex={0}
      role="group"
      aria-label={`${NAZWY_BLOKOW[blok.typ]}, blok ${indeks + 1} z ${liczba}${zaznaczony ? (edycjaTekstu ? ", edycja tekstu" : ", zaznaczony — Enter edytuje tekst") : ""}`}
      onPointerDown={() => {
        zaznaczonyPrzedKliknieciem.current = zaznaczony;
      }}
      onClick={(e) => {
        e.stopPropagation();
        const byl = zaznaczonyPrzedKliknieciem.current;
        zaznaczonyPrzedKliknieciem.current = true;
        if (!zaznaczony || !byl) {
          if (!zaznaczony) onZaznacz();
          return;
        }
        // drugi klik w tekst zaznaczonego bloku: wejście w pisanie dokładnie w miejscu kliknięcia
        if (!edycjaTekstu && (e.target as HTMLElement).closest("[role='textbox']")) onWejdzWTekst({ x: e.clientX, y: e.clientY });
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!edycjaTekstu && (e.target as HTMLElement).closest("[role='textbox']")) onWejdzWTekst({ x: e.clientX, y: e.clientY });
      }}
      onFocus={(e) => {
        if (e.target === e.currentTarget && !zaznaczony) onZaznacz();
      }}
      className={`group/blok relative outline-offset-[-1px] transition-[outline-color,opacity] ${
        celPliku
          ? "z-10 outline-dashed outline-2 outline-[var(--color-akcent)]"
          : zaznaczony && !trwaPrzeciaganie
            ? `z-10 outline outline-2 ${edycjaTekstu ? "outline-[var(--color-akcent-ramka)]" : "outline-[var(--color-akcent)]"}`
            : "outline outline-1 outline-transparent hover:outline-[var(--color-akcent-ramka)]"
      } ${przeciagany ? "opacity-35" : ""} ${zaznaczony && !edycjaTekstu ? "[&_[role=textbox]]:cursor-text" : "[&_[role=textbox]:not([contenteditable=true])]:cursor-default"}`}
      style={{ padding: `${blok.gora}px ${blok.boki}px ${blok.dol}px`, background: tlo }}
    >
      <span
        className={`pointer-events-none absolute left-0 top-0 z-20 flex items-center gap-1 rounded-br-md px-1.5 py-0.5 text-[11px] font-medium leading-4 ${
          trwaPrzeciaganie || edycjaTekstu ? "!hidden" : zaznaczony ? "bg-[var(--color-akcent)] text-white" : "hidden bg-[var(--color-akcent-ramka)] text-[var(--color-akcent)] group-hover/blok:flex"
        }`}
      >
        <Ikona size={12} aria-hidden="true" />
        {NAZWY_BLOKOW[blok.typ]}
        {zaznaczony && !edycjaTekstu && blok.typ !== "obraz" && blok.typ !== "separator" && blok.typ !== "odstep" && blok.typ !== "html" && blok.typ !== "social" ? (
          <span className="font-normal opacity-80">· kliknij jeszcze raz, żeby pisać</span>
        ) : null}
      </span>
      <div
        className={`absolute right-[-1px] top-0 z-20 -translate-y-full items-center gap-0.5 rounded-t-md border border-b-0 border-[var(--color-linia)] bg-white px-0.5 pt-0.5 ${
          trwaPrzeciaganie || edycjaTekstu ? "hidden" : zaznaczony ? "flex" : "hidden group-hover/blok:flex"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          ref={drag.setActivatorNodeRef}
          {...drag.listeners}
          {...drag.attributes}
          aria-label="Przeciągnij, żeby zmienić kolejność"
          title="Przeciągnij, żeby przenieść"
          className={`${akcja} cursor-grab active:cursor-grabbing`}
        >
          <GripVertical size={15} />
        </button>
        <button type="button" className={akcja} onClick={() => onPrzesun(-1)} disabled={indeks === 0} aria-label="Przesuń w górę" title="Przenieś wyżej (Alt+↑)">
          <ArrowUp size={15} />
        </button>
        <button type="button" className={akcja} onClick={() => onPrzesun(1)} disabled={indeks === liczba - 1} aria-label="Przesuń w dół" title="Przenieś niżej (Alt+↓)">
          <ArrowDown size={15} />
        </button>
        <button type="button" className={akcja} onClick={onDuplikuj} aria-label="Duplikuj blok" title="Duplikuj (Ctrl+D)">
          <Copy size={15} />
        </button>
        <span className="mx-0.5 h-4 w-px bg-[var(--color-linia)]" aria-hidden="true" />
        <button type="button" className={`${akcja} hover:!bg-[var(--color-blad-tlo)] hover:!text-[var(--color-blad)]`} onClick={onUsun} aria-label="Usuń blok" title="Usuń (Delete)">
          <Trash2 size={15} />
        </button>
      </div>
      <WidokBloku blok={blok} styl={styl} mobile={mobile} tylkoDoOdczytu={false} edycjaTekstu={zaznaczony && edycjaTekstu} onZmiana={onZmiana} />
      {przyklady.length && !trwaPrzeciaganie ? (
        // warstwa edytora, nie treść maila: nie przesuwa układu (audyt Codeksa, design r1)
        <span
          className="absolute right-1 top-1 z-20 flex h-6 items-center gap-1 rounded-full border border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] px-2 text-[11px] font-semibold leading-none text-[var(--color-czeka)] shadow-[var(--cien-karta)]"
          style={{ fontFamily: "var(--font-sans)" }}
          title={`Dane z szablonu: ${przyklady.join(", ")}. Zastąp je swoimi.`}
        >
          <AlertTriangle size={12} aria-hidden="true" /> Dane z szablonu: zastąp swoimi
        </span>
      ) : null}
      {/* „+” pod blokiem: szybkie wstawienie bez przeciągania (jak w Klaviyo) */}
      <div className={`absolute bottom-0 left-1/2 z-30 -translate-x-1/2 translate-y-1/2 ${trwaPrzeciaganie ? "hidden" : zaznaczony || menuOtwarte ? "block" : "hidden group-hover/blok:block"}`} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => onMenu(!menuOtwarte)}
          aria-label={`Dodaj blok pod: ${NAZWY_BLOKOW[blok.typ]}`}
          aria-expanded={menuOtwarte}
          className="group/plus flex h-6 items-center gap-1 rounded-full bg-[var(--color-akcent)] px-1.5 text-[12px] font-medium text-white shadow-[var(--cien-uniesiony)] ring-2 ring-white hover:bg-[#6f3cb0]"
        >
          <Plus size={14} strokeWidth={2.5} />
          <span className={`${menuOtwarte ? "inline" : "hidden group-hover/plus:inline"} pr-1`}>Dodaj blok</span>
        </button>
        {menuOtwarte ? (
          <div role="menu" className="absolute left-1/2 top-8 z-40 grid w-[300px] -translate-x-1/2 grid-cols-3 gap-1 rounded-[10px] border border-[var(--color-linia)] bg-white p-2 shadow-[var(--cien-uniesiony)]">
            {(Object.keys(NAZWY_BLOKOW) as TypBloku[]).map((t) => {
              const I = IKONY_BLOKOW[t];
              return (
                <button
                  key={t}
                  type="button"
                  role="menuitem"
                  onClick={() => onDodajPo(t)}
                  className="flex flex-col items-center gap-1 rounded-md px-1 py-2 text-center text-[11px] font-medium leading-[14px] text-[var(--color-tekst-2)] hover:bg-[var(--color-akcent-tlo)] hover:text-[var(--color-akcent)]"
                >
                  <I size={17} strokeWidth={1.7} aria-hidden="true" />
                  {NAZWY_BLOKOW[t]}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Miejsce upuszczenia: pełny placeholder w przepływie (sąsiedzi się rozsuwają), a nie
 * cienka linia. Sam placeholder jest strefą zrzutu — kursor nad nim trzyma bieżącą pozycję,
 * zamiast skakać na koniec maila.
 */
function Wskaznik({ nazwa }: { nazwa: string }) {
  const { setNodeRef } = useDroppable({ id: "wskaznik" });
  return (
    <div ref={setNodeRef} className="py-1" aria-hidden="true">
      <div className="flex h-12 items-center justify-center gap-2 rounded-md border-2 border-dashed border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)] text-[12px] font-medium text-[var(--color-akcent)]" style={{ fontFamily: "var(--font-sans)" }}>
        <Plus size={14} /> {nazwa}
      </div>
    </div>
  );
}

function ObszarPlotna({ children, onKlik }: { children: React.ReactNode; onKlik: () => void }) {
  const { setNodeRef } = useDroppable({ id: "plotno" });
  return (
    <div ref={setNodeRef} onClick={onKlik} className="flex min-h-full w-max min-w-full justify-center" style={{ padding: `40px ${MARGINES_PLOTNA}px 96px` }}>
      {children}
    </div>
  );
}

/** Lista braków w oknie testu: najpierw wymagane do wysyłki, potem zalecenia; 4 pozycje, reszta po kliknięciu. */
function ListaBrakow({ braki }: { braki: Brak[] }) {
  const [wszystkie, setWszystkie] = useState(false);
  const wymagane = braki.filter((b) => b.wymagane).length;
  const widoczne = wszystkie ? braki : braki.slice(0, 4);
  return (
    <div className="rounded-lg border border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] px-3 py-2.5">
      <div className="text-[13px] font-semibold leading-[18px] text-[var(--color-tekst)]">
        Możesz wysłać test.{" "}
        {wymagane
          ? `Przed wysyłką kampanii ${wymagane === 1 ? "została jedna wymagana rzecz" : `zostały ${wymagane} wymagane rzeczy`}${braki.length > wymagane ? ` i ${braki.length - wymagane} ${formaOdmiany(braki.length - wymagane, "zalecenie", "zalecenia", "zaleceń")}` : ""}:`
          : `Warto jeszcze poprawić ${braki.length === 1 ? "jedną rzecz" : `${braki.length} ${formaOdmiany(braki.length, "rzecz", "rzeczy", "rzeczy")}`}:`}
      </div>
      <ul className="mt-1.5 max-h-[40vh] space-y-1.5 overflow-y-auto text-[12px] leading-[17px] text-[var(--color-tekst-2)]">
        {widoczne.map((b, i) => (
          <li key={i} className="flex gap-1.5">
            <AlertTriangle size={12} className={`mt-[2px] shrink-0 ${b.wymagane ? "text-[var(--color-blad)]" : "text-[var(--color-czeka)]"}`} aria-label={b.wymagane ? "wymagane" : "zalecenie"} />
            <span>
              {b.tekst}
              {b.link ? (
                <>
                  {" "}
                  <a href={b.link.href} target="_blank" rel="noopener" className="inline-flex items-center gap-0.5 font-semibold text-[var(--color-akcent)] hover:underline">
                    {b.link.etykieta} <ExternalLink size={11} aria-hidden="true" />
                  </a>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {braki.length > 4 ? (
        <button type="button" onClick={() => setWszystkie((w) => !w)} className="mt-1.5 text-[12px] font-semibold text-[var(--color-akcent)] hover:underline">
          {wszystkie ? "Zwiń" : `Pokaż pozostałe ${braki.length - 4}`}
        </button>
      ) : null}
    </div>
  );
}

// ── Wysyłka testowa ─────────────────────────────────────────────────────────────────

/**
 * Dymek nad paskiem (lista braków, okno testu): Esc i klik poza nim zamykają go z każdego
 * miejsca, nie tylko z fokusem w środku; po zamknięciu fokus wraca tam, skąd go otwarto.
 */
function useDymek<T extends HTMLElement>(zamknij: () => void) {
  const ref = useRef<T | null>(null);
  const zamknijRef = useRef(zamknij);
  zamknijRef.current = zamknij;
  useEffect(() => {
    const poprzedni = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const naKlawisz = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      zamknijRef.current();
    };
    const naKlik = (e: PointerEvent) => {
      const cel = e.target as Node | null;
      if (ref.current && cel && !ref.current.contains(cel) && !(poprzedni && poprzedni.contains(cel))) zamknijRef.current();
    };
    document.addEventListener("keydown", naKlawisz, true);
    document.addEventListener("pointerdown", naKlik, true);
    return () => {
      document.removeEventListener("keydown", naKlawisz, true);
      document.removeEventListener("pointerdown", naKlik, true);
      if (poprzedni?.isConnected) poprzedni.focus();
    };
  }, []);
  return ref;
}

function DymekBrakow({ children, onZamknij }: { children: React.ReactNode; onZamknij: () => void }) {
  const ref = useDymek<HTMLDivElement>(onZamknij);
  useEffect(() => {
    ref.current?.focus();
  }, [ref]);
  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-label="Do poprawy przed wysyłką" className="absolute right-0 top-[calc(100%+8px)] z-50 w-[360px] rounded-[12px] border border-[var(--color-linia)] bg-white p-4 shadow-[var(--cien-uniesiony)] outline-none">
      {children}
    </div>
  );
}

function OknoTestu({
  tenantId,
  campaignId,
  temat,
  braki,
  brudny,
  zapisz,
  onZamknij,
}: {
  tenantId: string;
  campaignId: string;
  temat: string;
  braki: Brak[];
  brudny: boolean;
  zapisz: () => Promise<boolean>;
  onZamknij: () => void;
}) {
  const [adres, setAdres] = useState("");
  const [trwa, setTrwa] = useState(false);
  const [wynik, setWynik] = useState<{ ok: boolean; tekst: string } | null>(null);
  const bezTematu = !temat.trim();
  const ref = useDymek<HTMLFormElement>(onZamknij);
  return (
    <form
      ref={ref}
      className="absolute right-0 top-[calc(100%+8px)] z-50 w-[380px] space-y-3 rounded-[12px] border border-[var(--color-linia)] bg-white p-4 shadow-[var(--cien-uniesiony)] max-md:fixed max-md:inset-x-3 max-md:bottom-3 max-md:top-auto max-md:w-auto"
      role="dialog"
      aria-label="Wysyłka testowa"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onZamknij();
        }
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        setTrwa(true);
        setWynik(null);
        // test idzie z ZAPISANEJ treści, więc najpierw zapis
        if (brudny && !(await zapisz())) {
          setTrwa(false);
          setWynik({ ok: false, tekst: "Najpierw zapisz treść — zapis się nie udał." });
          return;
        }
        try {
          const w = await wyslijTestZEdytoraAkcja(tenantId, campaignId, adres);
          setWynik(w.ok ? { ok: true, tekst: w.komunikat } : { ok: false, tekst: w.blad });
        } catch {
          setWynik({ ok: false, tekst: "Brak połączenia z serwerem." });
        }
        setTrwa(false);
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[15px]">Wyślij test</h3>
        <button type="button" onClick={onZamknij} aria-label="Zamknij" className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-tekst-3)] hover:bg-[var(--color-powierzchnia-2)]">
          <X size={15} />
        </button>
      </div>
      {bezTematu ? (
        <div className="rounded-lg border border-[var(--color-blad-ramka)] bg-[var(--color-blad-tlo)] px-3 py-2.5 text-[13px] leading-[18px] text-[var(--color-blad)]">
          Mail nie ma jeszcze tematu, a bez niego test nie wyjdzie.{" "}
          <Link href={`/t/${tenantId}/kampanie/${campaignId}/ustawienia`} className="font-semibold underline">
            Dodaj temat
          </Link>
        </div>
      ) : null}
      <input type="email" required autoFocus value={adres} onChange={(e) => setAdres(e.target.value)} placeholder="twoj@adres.pl" className="pole" aria-label="Adres, na który wyślemy test" />
      {braki.length ? (
        <ListaBrakow braki={braki} />
      ) : (
        <p className="text-[12px] leading-[17px] text-[var(--color-tekst-2)]">
          {brudny ? "Najpierw zapiszemy zmiany. " : ""}Test dostaniesz od tego samego nadawcy i z tą samą stopką co klienci.
        </p>
      )}
      {wynik ? (
        <p role="status" className={`rounded-md px-2.5 py-2 text-[12px] leading-[17px] ${wynik.ok ? "bg-[var(--color-ok-tlo)] text-[var(--color-ok)]" : "bg-[var(--color-blad-tlo)] text-[var(--color-blad)]"}`}>
          {wynik.tekst}
        </p>
      ) : null}
      <button type="submit" className="przycisk w-full" disabled={trwa || bezTematu}>
        {trwa ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Wyślij test
      </button>
    </form>
  );
}

// ── Edytor ───────────────────────────────────────────────────────────────────────

export function Edytor({
  tenantId,
  campaignId,
  nazwaKampanii,
  stan,
  dokumentStartowy,
  zrodlo,
  konto,
  tylkoDoOdczytu,
  status,
  temat,
  komunikat,
}: {
  tenantId: string;
  campaignId: string;
  nazwaKampanii: string;
  stan: { etykieta: string; klasa: string };
  dokumentStartowy: DokumentMaila;
  zrodlo: ZrodloDokumentu;
  konto: KontoEdytora;
  tylkoDoOdczytu: boolean;
  status: string;
  temat: string;
  komunikat?: { ok?: string; blad?: string };
}) {
  const [historia, setHistoria] = useState<Historia>(() => nowaHistoria(dokumentStartowy));
  const dok = historia.biezacy;
  const [zapisanyJson, setZapisanyJson] = useState(() => JSON.stringify(dokumentStartowy));
  const dokJson = useMemo(() => JSON.stringify(dok), [dok]);
  // ostatnio WYSŁANA do zapisu wersja: „brudny" także wtedy, gdy ekran wrócił do zapisanej A,
  // a w drodze jest jeszcze B — wyjście nie może wtedy przepuścić B do bazy
  const ostatnioWyslany = useRef<string>(JSON.stringify(dokumentStartowy));
  const brudny = dokJson !== zapisanyJson || dokJson !== ostatnioWyslany.current;
  const [zaznaczony, setZaznaczony] = useState<string | null>(null);
  // blok, w którego tekście się pisze; `x/y` = miejsce drugiego kliknięcia (tam staje kursor)
  const [edycja, setEdycja] = useState<{ id: string; x?: number; y?: number } | null>(null);
  const [widok, setWidok] = useState<Widok>("desktop");
  const [tryb, setTryb] = useState<Tryb>(tylkoDoOdczytu ? "podglad" : "edycja");
  const [zapis, setZapis] = useState<{ trwa: boolean; blad?: string; kiedy?: string; komunikat?: string }>({ trwa: false });
  const [przeciagany, setPrzeciagany] = useState<Przeciagany | null>(null);
  const [wskaznik, setWskaznik] = useState<number | null>(null);
  const [menuPo, setMenuPo] = useState<string | null>(null);
  const [zakladka, setZakladka] = useState<ZakladkaLewa>("bloki");
  const [testOtwarty, setTestOtwarty] = useState(false);
  const [uwagiOtwarte, setUwagiOtwarte] = useState(false);
  const [podglad, setPodglad] = useState<{ html?: string; trwa: boolean; blad?: string }>({ trwa: false });
  const [skala, setSkala] = useState<Skala>("dopasuj");
  const [szerPlotna, setSzerPlotna] = useState(0);
  const [plikNad, setPlikNad] = useState<{ indeks: number | null; obraz: string | null } | null>(null);
  const [odswiezObrazy, setOdswiezObrazy] = useState(0);
  const plotnoRef = useRef<HTMLElement>(null);
  const router = useRouter();
  const telefon = useEkranTelefonu();

  const zablokowane = tylkoDoOdczytu;
  const mobile = widok === "mobile";
  const kontoDomeny: DaneKonta = useMemo(() => ({ nazwaSklepu: konto.nazwaSklepu, firma: konto.firma, adres: konto.adres }), [konto]);
  const baza = `/t/${tenantId}/kampanie/${campaignId}`;
  const adresDanychFirmy = `/t/${tenantId}/ustawienia/wysylka#dane-firmy`;

  // ── operacje na dokumencie (każda przez historię) ──
  const aktualizuj = useCallback((fn: (d: DokumentMaila) => DokumentMaila, klucz: string | null = null) => {
    setHistoria((h) => zapiszWHistorii(h, fn(h.biezacy), klucz));
    // nowa zmiana po nieudanym zapisie = nowa próba autozapisu
    setZapis((z) => (z.blad ? { ...z, blad: undefined } : z));
  }, []);

  const przewinDo = useCallback((id: string, fokus = false) => {
    requestAnimationFrame(() => {
      const el = plotnoRef.current?.querySelector<HTMLElement>(`[data-blok="${id}"]`);
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (fokus) el?.focus({ preventScroll: true });
    });
  }, []);

  const dodaj = useCallback(
    (typ: TypBloku, indeks?: number, zmiany: Partial<Blok> = {}) => {
      const blok = { ...nowyBlok(typ, kontoDomeny), ...zmiany } as Blok;
      aktualizuj((d) => {
        const po = zaznaczony ? d.bloki.findIndex((b) => b.id === zaznaczony) : -1;
        return wstawBlok(d, blok, indeks ?? (po >= 0 ? po + 1 : d.bloki.length));
      });
      setZaznaczony(blok.id);
      // fokus na nowym bloku: Delete i Ctrl+D działają od razu, jak w Canvie
      przewinDo(blok.id, true);
    },
    [aktualizuj, kontoDomeny, przewinDo, zaznaczony],
  );
  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast || toast.ton === "trwa") return;
    const t = setTimeout(() => setToast(null), toast.ton === "blad" ? 9000 : 6000);
    return () => clearTimeout(t);
  }, [toast]);
  const usun = useCallback((id: string) => {
    const typ = historia.biezacy.bloki.find((b) => b.id === id)?.typ;
    aktualizuj((d) => usunBlok(d, id));
    setZaznaczony((z) => (z === id ? null : z));
    if (typ) setToast({ tekst: `Usunięto blok „${NAZWY_BLOKOW[typ]}"`, cofnij: true });
  }, [aktualizuj, historia.biezacy]);
  const duplikuj = useCallback(
    (id: string) => {
      const zrodlowy = historia.biezacy.bloki.find((b) => b.id === id);
      if (!zrodlowy) return;
      const kopia = kopiaBloku(zrodlowy);
      aktualizuj((d) => {
        const i = d.bloki.findIndex((b) => b.id === id);
        return i === -1 ? d : wstawBlok(d, kopia, i + 1);
      });
      setZaznaczony(kopia.id);
      przewinDo(kopia.id, true);
    },
    [aktualizuj, historia.biezacy, przewinDo],
  );
  const przesun = useCallback((id: string, k: -1 | 1) => aktualizuj((d) => przesunBlok(d, id, k)), [aktualizuj]);
  const zmien = useCallback((id: string, zmiany: Partial<Blok>, klucz?: string) => aktualizuj((d) => zmienBlok(d, id, zmiany), klucz ? `${id}:${klucz}` : null), [aktualizuj]);
  const zmienStyl = useCallback((z: Partial<StyleMaila>, klucz?: string) => aktualizuj((d) => ({ ...d, style: { ...d.style, ...z } }), klucz ? `styl:${klucz}` : null), [aktualizuj]);

  // ── zaznaczenie a edycja tekstu ──
  // Zmiana zaznaczenia kończy pisanie w poprzednim bloku.
  useEffect(() => {
    if (edycja && edycja.id !== zaznaczony) setEdycja(null);
  }, [edycja, zaznaczony]);
  // Wejście w tekst: fokus w polu pod kursorem (albo w pierwszym polu bloku) i kursor tam,
  // gdzie padł drugi klik. Odpala się raz na wejście — `edycja` zmienia się tylko przy wejściu.
  useEffect(() => {
    if (!edycja) return;
    const blokEl = plotnoRef.current?.querySelector<HTMLElement>(`[data-blok="${edycja.id}"]`);
    if (!blokEl) return;
    let pole: HTMLElement | null = null;
    if (edycja.x !== undefined && edycja.y !== undefined) {
      const pod = document.elementFromPoint(edycja.x, edycja.y)?.closest<HTMLElement>("[role='textbox']") ?? null;
      if (pod && blokEl.contains(pod)) pole = pod;
    }
    pole ??= blokEl.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']");
    if (!pole || !pole.isContentEditable) return;
    pole.focus({ preventScroll: true });
    const sel = window.getSelection();
    let r = edycja.x !== undefined && edycja.y !== undefined ? zakresWPunkcie(edycja.x, edycja.y) : null;
    if (!r || !pole.contains(r.startContainer)) {
      r = document.createRange();
      r.selectNodeContents(pole);
      r.collapse(false);
    }
    sel?.removeAllRanges();
    sel?.addRange(r);
  }, [edycja]);
  const wyjdzZTekstu = useCallback(() => {
    const id = edycja?.id ?? zaznaczony;
    (document.activeElement as HTMLElement | null)?.blur();
    setEdycja(null);
    if (id) przewinDo(id, true);
  }, [edycja, przewinDo, zaznaczony]);

  // ── zapis ──
  // Zapisy idą w kolejce (jeden po drugim): odpowiedzi serwera nie mogą przyjść w odwrotnej
  // kolejności i nadpisać nowszej wersji starszą — także przy zapisie w tle przy wyjściu.
  const kolejkaZapisow = useRef<Promise<unknown>>(Promise.resolve());
  // wersja, której zapis serwer odrzucił — autozapis nie ponawia jej w kółko, ale każda INNA
  // wersja (np. po cofnięciu) zapisuje się normalnie (review Codeksa, runda 4)
  const odrzucony = useRef<string | null>(null);
  const zapiszDokument = useCallback(
    (dokument: DokumentMaila, auto: boolean): Promise<boolean> => {
      const json = JSON.stringify(dokument);
      ostatnioWyslany.current = json;
      const zadanie = kolejkaZapisow.current.then(async () => {
        setZapis((s) => ({ ...s, trwa: true, blad: undefined }));
        try {
          const w = await zapiszBlokiAkcja(tenantId, campaignId, json, auto);
          if (!w.ok) {
            odrzucony.current = json;
            setZapis({ trwa: false, blad: w.blad });
            return false;
          }
          odrzucony.current = null;
          setZapisanyJson(json);
          setZapis({
            trwa: false,
            kiedy: w.zapisanoO,
            komunikat:
              [
                w.cofnieta ? "Kampania wróciła do szkicu, a wcześniejsze linki akceptacji wygasły — klient akceptował inną wersję." : "",
                w.planZdjety ? "Plan wysyłki zdjęty — zaplanuj ponownie w przeglądzie, termin przejdzie listę kontrolną od nowa." : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined,
          });
          return true;
        } catch {
          odrzucony.current = json;
          setZapis({ trwa: false, blad: "Brak połączenia z serwerem — zmiany NIE zostały zapisane. Spróbuj ponownie." });
          return false;
        }
      });
      kolejkaZapisow.current = zadanie.catch(() => false);
      return zadanie;
    },
    [campaignId, tenantId],
  );
  const zapisz = useCallback(
    async (auto = false): Promise<boolean> => (zablokowane ? false : zapiszDokument(historia.biezacy, auto)),
    [historia.biezacy, zablokowane, zapiszDokument],
  );

  // ── autozapis ──
  // Szkic zapisuje się sam, 1,5 s po ostatniej zmianie — jak w Klaviyo. Kampania wysłana do
  // akceptacji albo zaakceptowana NIE: zapis zmienionej treści cofa ją do szkicu i wygasza
  // link klienta, więc to ma być świadoma decyzja (przycisk „Zapisz"), a nie efekt pisania.
  const autozapis = status === "draft" && !zablokowane;
  useEffect(() => {
    if (!autozapis || !brudny || zapis.trwa || dokJson === odrzucony.current) return;
    const t = setTimeout(() => void zapisz(true), 1500);
    return () => clearTimeout(t);
  }, [autozapis, brudny, zapis.trwa, zapis.blad, dokJson, zapisz]);

  // Odmontowanie z niezapisaną zmianą (np. Wstecz w przeglądarce, której router Nexta nie
  // zgłasza przez beforeunload): szkic dopisuje się w tle, zamiast przepaść.
  const porzucone = useRef(false);
  const doZapisuRef = useRef({ autozapis, dok: historia.biezacy, zapiszDokument });
  doZapisuRef.current = { autozapis, dok: historia.biezacy, zapiszDokument };
  useEffect(
    () => () => {
      const { autozapis: a, dok: d, zapiszDokument: z } = doZapisuRef.current;
      // porównanie z OSTATNIO WYSŁANĄ wersją, nie z potwierdzoną: cofnięcie ekranu do A
      // w trakcie zapisu B też musi trafić do bazy (review Codeksa, runda 3)
      if (a && !porzucone.current && JSON.stringify(d) !== ostatnioWyslany.current) void z(d, true);
    },
    [],
  );

  // ── skróty klawiszowe (reguły: klawisze.ts) ──
  useEffect(() => {
    const obsluz = (e: KeyboardEvent) => {
      const akcja = akcjaKlawisza(e, {
        ...kontekstZCelu(e.target),
        zaznaczony: Boolean(zaznaczony),
        edycjaMozliwa: !zablokowane && tryb === "edycja" && !telefon,
      });
      if (!akcja) return;
      if (akcja !== "wejdzWTekst" || zaznaczony) e.preventDefault();
      const i = zaznaczony ? dok.bloki.findIndex((b) => b.id === zaznaczony) : -1;
      switch (akcja) {
        case "zapisz":
          void zapisz();
          break;
        case "cofnij":
          setHistoria(cofnij);
          break;
        case "ponow":
          setHistoria(ponow);
          break;
        case "usun":
          if (zaznaczony) usun(zaznaczony);
          break;
        case "duplikuj":
          if (zaznaczony) duplikuj(zaznaczony);
          break;
        case "wejdzWTekst":
          if (zaznaczony) setEdycja({ id: zaznaczony });
          break;
        case "wyjdzZTekstu":
          wyjdzZTekstu();
          break;
        case "odznacz":
          setZaznaczony(null);
          setMenuPo(null);
          break;
        case "poprzedni":
        case "nastepny": {
          const cel = dok.bloki[Math.max(0, Math.min(dok.bloki.length - 1, i + (akcja === "poprzedni" ? -1 : 1)))];
          if (cel) {
            setZaznaczony(cel.id);
            przewinDo(cel.id, true);
          }
          break;
        }
        case "przesunWyzej":
        case "przesunNizej":
          if (zaznaczony) {
            przesun(zaznaczony, akcja === "przesunWyzej" ? -1 : 1);
            przewinDo(zaznaczony, true);
          }
          break;
      }
    };
    window.addEventListener("keydown", obsluz);
    return () => window.removeEventListener("keydown", obsluz);
  }, [dok.bloki, duplikuj, przesun, przewinDo, telefon, tryb, usun, wyjdzZTekstu, zablokowane, zapisz, zaznaczony]);

  // ── ostrzeżenie przed opuszczeniem strony z niezapisanymi zmianami ──
  useEffect(() => {
    if (!brudny) return;
    const przedWyjsciem = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    // Nawigacja Nexta (Link) nie odpala beforeunload — łapiemy kliknięcie w link w fazie
    // przechwytywania, zanim dostanie je router.
    const klik = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
      if (a.getAttribute("href")?.startsWith("#")) return;
      // link w treści maila na płótnie nie jest nawigacją (płótno blokuje go samo)
      if (a.closest("[data-plotno]")) return;
      if (!window.confirm("Masz niezapisane zmiany w treści. Wyjść bez zapisywania?")) {
        e.preventDefault();
        e.stopPropagation();
      } else {
        // operator świadomie porzuca zmiany — zapis w tle przy odmontowaniu nie może ich utrwalić
        porzucone.current = true;
      }
    };
    window.addEventListener("beforeunload", przedWyjsciem);
    document.addEventListener("click", klik, true);
    return () => {
      window.removeEventListener("beforeunload", przedWyjsciem);
      document.removeEventListener("click", klik, true);
    };
  }, [brudny]);

  // Plik upuszczony poza płótnem przeglądarka otworzyłaby zamiast panelu (i edytor by zniknął).
  useEffect(() => {
    const zatrzymaj = (e: DragEvent) => {
      if (przeciaganePliki(e.dataTransfer)) e.preventDefault();
    };
    window.addEventListener("dragover", zatrzymaj);
    window.addEventListener("drop", zatrzymaj);
    return () => {
      window.removeEventListener("dragover", zatrzymaj);
      window.removeEventListener("drop", zatrzymaj);
    };
  }, []);

  // ── podgląd (prawdziwe złożenie przez silnik); na telefonie to jedyny widok ──
  const pokazPodglad = tryb === "podglad" || telefon;
  useEffect(() => {
    if (!pokazPodglad) return;
    let aktualne = true;
    setPodglad((p) => ({ ...p, trwa: true, blad: undefined }));
    podgladBlokowAkcja(tenantId, campaignId, JSON.stringify(dok))
      .then((w) => {
        if (!aktualne) return;
        setPodglad(w.ok ? { trwa: false, html: w.html } : { trwa: false, blad: w.blad });
      })
      .catch(() => aktualne && setPodglad({ trwa: false, blad: "Nie udało się złożyć podglądu — brak połączenia z serwerem." }));
    return () => {
      aktualne = false;
    };
  }, [pokazPodglad, dok, tenantId, campaignId]);

  // ── zoom płótna ──
  const szerokoscUrzadzenia = SZEROKOSC_URZADZENIA[widok];
  useEffect(() => {
    const el = plotnoRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSzerPlotna(el.clientWidth));
    ro.observe(el);
    setSzerPlotna(el.clientWidth);
    return () => ro.disconnect();
  }, [tryb, telefon]);
  const dopasowana = szerPlotna > 0 ? Math.max(0.4, Math.min(1, (szerPlotna - 2 * MARGINES_PLOTNA) / szerokoscUrzadzenia)) : 1;
  const skalaEfektywna = skala === "dopasuj" ? dopasowana : skala;
  const zmienSkale = (k: -1 | 1) => {
    const teraz = skalaEfektywna;
    const nast = k > 0 ? SKALE.find((s) => s > teraz + 0.001) : [...SKALE].reverse().find((s) => s < teraz - 0.001);
    if (nast) setSkala(nast);
  };

  // ── przeciąganie bloków ──
  const sensory = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const kolizje: CollisionDetection = useCallback((args) => {
    const trafione = pointerWithin(args);
    // pierwszeństwo: placeholder (trzyma pozycję), potem bloki, na końcu całe płótno
    const miejsce = trafione.filter((c) => c.id === "wskaznik");
    if (miejsce.length) return miejsce;
    const bloki = trafione.filter((c) => String(c.id).startsWith("blok:"));
    return bloki.length ? bloki : trafione;
  }, []);

  const kursorY = useRef<number | null>(null);
  useEffect(() => {
    if (!przeciagany) {
      kursorY.current = null;
      return;
    }
    const ruch = (ev: PointerEvent) => {
      kursorY.current = ev.clientY;
    };
    window.addEventListener("pointermove", ruch, true);
    return () => window.removeEventListener("pointermove", ruch, true);
  }, [przeciagany]);
  const wskaznikRef = useRef<number | null>(null);
  wskaznikRef.current = wskaznik ?? plikNad?.indeks ?? null;
  /**
   * Pozycja wstawienia dla współrzędnej Y, z ŻYWEGO układu (getBoundingClientRect), a nie
   * z prostokątów zmierzonych na starcie przeciągania. Placeholder rozsuwa bloki, więc
   * zapamiętane prostokąty byłyby nieaktualne i miejsce zrzutu skakałoby pod kursorem.
   */
  const indeksDlaY = useCallback((y: number): number => {
    const bloki = Array.from(plotnoRef.current?.querySelectorAll<HTMLElement>("[data-blok]") ?? []);
    if (!bloki.length) return 0;
    for (let i = 0; i < bloki.length; i++) {
      const r = bloki[i].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return y < r.top + r.height / 2 ? i : i + 1;
    }
    if (y < bloki[0].getBoundingClientRect().top) return 0;
    const ostatni = bloki[bloki.length - 1].getBoundingClientRect();
    if (y > ostatni.bottom) return bloki.length;
    // kursor w szczelinie między blokami, czyli nad samym placeholderem: pozycja się nie zmienia
    const biezacy = wskaznikRef.current;
    if (biezacy !== null) return biezacy;
    const nastepny = bloki.findIndex((el) => el.getBoundingClientRect().top > y);
    return nastepny === -1 ? bloki.length : nastepny;
  }, []);
  const policzWskaznik = (e: DragMoveEvent): number | null => {
    if (!e.over) return null;
    // kursor z ostatniego pointermove; przy klawiaturze (brak kursora) środek przeciąganego elementu
    const y =
      kursorY.current ??
      (e.active.rect.current.translated?.top ?? 0) + (e.active.rect.current.translated?.height ?? 0) / 2;
    return indeksDlaY(y);
  };

  const naStart = (e: DragStartEvent) => {
    const d = e.active.data.current as Przeciagany | undefined;
    if (d) setPrzeciagany(d);
    if (d?.zrodlo === "plotno") setZaznaczony(d.id);
  };
  const naRuch = (e: DragMoveEvent) => setWskaznik(policzWskaznik(e));
  const naKoniec = (e: DragEndEvent) => {
    const d = e.active.data.current as Przeciagany | undefined;
    const cel = e.over ? policzWskaznik(e as unknown as DragMoveEvent) : null;
    setPrzeciagany(null);
    setWskaznik(null);
    if (!d || cel === null) return;
    if (d.zrodlo === "paleta") {
      dodaj(d.typ, cel);
    } else {
      const z = dok.bloki.findIndex((b) => b.id === d.id);
      const na = cel > z ? cel - 1 : cel;
      if (z !== -1 && na !== z) aktualizuj((dd) => przeniesBlok(dd, z, na));
    }
  };

  // ── pliki z dysku: upuszczenie na płótno = wgranie do biblioteki + blok obrazu ──
  const edycjaMozliwa = !zablokowane && tryb === "edycja";
  const wgrajPliki = useCallback(
    async (pliki: File[], cel: { indeks: number; obraz: string | null }) => {
      const bledy: string[] = [];
      if (pliki.length > MAKS_PLIKOW_NARAZ) bledy.push(`Naraz wgrasz najwyżej ${MAKS_PLIKOW_NARAZ} plików — pominęliśmy ${pliki.length - MAKS_PLIKOW_NARAZ}.`);
      const dobre = pliki.slice(0, MAKS_PLIKOW_NARAZ).filter((p) => {
        const blad = ocenPlikObrazu(p);
        if (blad) bledy.push(blad);
        return !blad;
      });
      if (!dobre.length) {
        if (bledy.length) setToast({ tekst: bledy.join(" "), ton: "blad" });
        return;
      }
      setToast({ tekst: `Wgrywam ${dobre.length === 1 ? "obraz" : `${dobre.length} ${formaOdmiany(dobre.length, "obraz", "obrazy", "obrazów")}`}…`, ton: "trwa" });
      // Najpierw wszystkie wysyłki, potem JEDNA zmiana dokumentu: cały drop to jeden krok
      // historii (Ctrl+Z i „Cofnij" w toaście cofają wszystkie obrazy naraz, review r1).
      const adresy: string[] = [];
      for (const plik of dobre) {
        const w = await wyslijObraz(tenantId, plik);
        if (w.ok) adresy.push(w.obraz.url);
        else bledy.push(w.blad);
      }
      const wstawione = adresy.length;
      let ostatni: string | null = null;
      if (wstawione) {
        const bloki = adresy.map((src) => ({ ...nowyBlok("obraz"), src }) as Blok);
        const podmiana = cel.obraz;
        const nowe = podmiana ? bloki.slice(1) : bloki;
        ostatni = nowe.length ? nowe[nowe.length - 1].id : podmiana;
        aktualizuj((d) => {
          let wynik = d;
          let indeks = Math.min(cel.indeks, d.bloki.length);
          // blok, na który upuszczono plik, mógł zniknąć w trakcie wysyłki: wtedy wszystko jako nowe bloki
          const i = podmiana ? d.bloki.findIndex((b) => b.id === podmiana) : -1;
          if (podmiana && i !== -1) {
            // plik upuszczony na blok obrazu podmienia jego zdjęcie, kolejne pliki lądują tuż pod nim
            wynik = zmienBlok(wynik, podmiana, { src: adresy[0] } as Partial<Blok>);
            indeks = i + 1;
          }
          for (const blok of podmiana && i === -1 ? bloki : nowe) {
            wynik = wstawBlok(wynik, blok, indeks);
            indeks += 1;
          }
          return wynik;
        });
      }
      setOdswiezObrazy((n) => n + 1);
      if (ostatni) {
        setZaznaczony(ostatni);
        przewinDo(ostatni);
      }
      if (bledy.length) setToast({ tekst: `${wstawione ? `Wstawiono ${wstawione}. ` : ""}${bledy.join(" ")}`, ton: "blad" });
      else setToast({ tekst: `${wstawione === 1 ? "Obraz jest w mailu" : `${wstawione} ${formaOdmiany(wstawione, "obraz jest", "obrazy są", "obrazów jest")} w mailu`} i w bibliotece sklepu. Dodaj opis obrazu w panelu po prawej.`, cofnij: true });
    },
    [aktualizuj, przewinDo, tenantId],
  );
  const obrazPod = (cel: EventTarget | null): string | null => {
    const el = (cel as HTMLElement | null)?.closest?.("[data-blok][data-typ='obraz']");
    return el?.getAttribute("data-blok") ?? null;
  };
  const naPlikNad = (e: React.DragEvent) => {
    if (!przeciaganePliki(e.dataTransfer)) return;
    e.preventDefault();
    if (!edycjaMozliwa) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    e.dataTransfer.dropEffect = "copy";
    const obraz = obrazPod(e.target);
    const indeks = obraz ? null : indeksDlaY(e.clientY);
    setPlikNad((p) => (p && p.indeks === indeks && p.obraz === obraz ? p : { indeks, obraz }));
  };
  const naPlikWyjscie = (e: React.DragEvent) => {
    const do_ = e.relatedTarget as Node | null;
    if (!do_ || !e.currentTarget.contains(do_)) setPlikNad(null);
  };
  const naPlikUpuszczony = (e: React.DragEvent) => {
    if (!przeciaganePliki(e.dataTransfer)) return;
    e.preventDefault();
    const cel = plikNad;
    setPlikNad(null);
    if (!edycjaMozliwa) return;
    const obraz = obrazPod(e.target) ?? cel?.obraz ?? null;
    void wgrajPliki(Array.from(e.dataTransfer.files), { indeks: cel?.indeks ?? indeksDlaY(e.clientY), obraz });
  };

  // obraz z zakładki „Obrazy": do zaznaczonego bloku obrazu albo jako nowy blok pod zaznaczeniem
  const wstawObraz = (url: string) => {
    const b = dok.bloki.find((x) => x.id === zaznaczony);
    if (b?.typ === "obraz") {
      zmien(b.id, { src: url } as Partial<Blok>);
      przewinDo(b.id);
    } else {
      dodaj("obraz", undefined, { src: url } as Partial<Blok>);
    }
  };

  // wskaźnik nie ma sensu tuż obok przeciąganego bloku (upuszczenie tam nic nie zmienia)
  const indeksPrzeciaganego = przeciagany?.zrodlo === "plotno" ? dok.bloki.findIndex((b) => b.id === przeciagany.id) : -1;
  const widocznyWskaznik = przeciagany
    ? wskaznik !== null && !(indeksPrzeciaganego !== -1 && (wskaznik === indeksPrzeciaganego || wskaznik === indeksPrzeciaganego + 1))
      ? wskaznik
      : null
    : plikNad?.indeks ?? null;
  const nazwaWskaznika = przeciagany ? `Upuść tutaj: ${NAZWY_BLOKOW[przeciagany.typ]}` : "Upuść, żeby wstawić obraz";

  // ── uwagi i braki ──
  const blokZaznaczony = dok.bloki.find((b) => b.id === zaznaczony) ?? null;
  const uwagiBloku = useMemo(() => (blokZaznaczony ? renderujDokument({ ...dok, bloki: [blokZaznaczony] }).uwagi : []), [blokZaznaczony, dok]);
  // Wymagane = to, co zablokuje wysyłkę na liście kontrolnej (adres firmy, dane z szablonu,
  // brak jakiegokolwiek linku). Reszta uwag renderu to zalecenia (audyt Codeksa, design r1).
  const wszystkieBraki = useMemo((): Brak[] => {
    const braki: Brak[] = [];
    // Wymagany jest adres (jak na liście kontrolnej serwera); sama nazwa firmy to zalecenie.
    if (!konto.adres?.trim()) {
      braki.push({ tekst: "W stopce brakuje adresu firmy. Bez niego kampania nie wyjdzie.", link: { href: adresDanychFirmy, etykieta: "Uzupełnij dane firmy" }, wymagane: true });
    } else if (!konto.firma?.trim()) {
      braki.push({ tekst: "W stopce brakuje nazwy firmy. Odbiorca zobaczy sam adres.", link: { href: adresDanychFirmy, etykieta: "Uzupełnij dane firmy" } });
    }
    const przyklady = przykladoweDane(dok);
    if (przyklady.length) braki.push({ tekst: `W mailu zostały dane z szablonu: ${przyklady.join(", ")}. Zastąp je swoimi.`, wymagane: true });
    const render = renderujDokument(dok);
    if (dok.bloki.length && !linkiSledzone(render.html).length) braki.push({ tekst: "W mailu nie ma żadnego linku do strony sklepu.", wymagane: true });
    for (const u of render.uwagi) if (!u.startsWith("W treści zostały przykładowe dane")) braki.push({ tekst: u });
    return braki;
  }, [adresDanychFirmy, dok, konto.adres, konto.firma]);
  const liczbaWymaganych = wszystkieBraki.filter((b) => b.wymagane).length;
  const liczbaZalecen = wszystkieBraki.length - liczbaWymaganych;

  // Przy węższym ekranie zostaje sama ikona (pełny tekst w podpowiedzi), żeby pasek
  // nie ucinał słowa do „Z" obok przycisków (design r1). Błąd zapisu zawsze z tekstem.
  const tekstStanu = "max-[1599px]:sr-only";
  const stanZapisu = zapis.trwa ? (
    <span className="flex items-center gap-1.5 text-[var(--color-tekst-2)]" title="Zapisuję…">
      <Loader2 size={14} className="animate-spin" aria-hidden="true" /> <span className={tekstStanu}>Zapisuję…</span>
    </span>
  ) : zapis.blad ? (
    <span className="flex items-center gap-1.5 text-[var(--color-blad)]" role="alert">
      <AlertTriangle size={14} aria-hidden="true" /> Nie zapisano
    </span>
  ) : brudny ? (
    <span className="flex items-center gap-1.5 font-medium text-[var(--color-czeka)]" title={autozapis ? "Zapis ruszy sam za chwilę" : "Kliknij Zapisz"}>
      <span className="h-2 w-2 rounded-full bg-[var(--color-czeka)]" aria-hidden="true" /> <span className={autozapis ? tekstStanu : ""}>{autozapis ? "Zapisuję za chwilę" : "Niezapisane"}</span>
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-[var(--color-tekst-2)]" title={zapis.kiedy ? `Zapisano o ${godzina(zapis.kiedy)}` : "Zapisano"}>
      <Check size={14} className="text-[var(--color-ok)]" aria-hidden="true" /> <span className={tekstStanu}>Zapisano{zapis.kiedy ? <span className="hidden min-[1600px]:inline"> o {godzina(zapis.kiedy)}</span> : null}</span>
    </span>
  );

  const przyciskPaska = "grid h-8 w-8 place-items-center rounded-lg text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-tekst)] disabled:opacity-35 disabled:hover:bg-transparent";
  const segment = (aktywny: boolean) =>
    `flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors ${aktywny ? "bg-white text-[var(--color-tekst)] shadow-[var(--cien-karta)]" : "text-[var(--color-tekst-2)] hover:text-[var(--color-tekst)]"}`;

  const dalej = async () => {
    // niezapisana zmiana nie może zginąć przy przejściu dalej: najpierw zapis
    if (brudny && !zablokowane && !(await zapisz(autozapis))) return;
    router.push(`${baza}/ustawienia`);
  };

  const przyciskTestu = (
    <div className="relative">
      <button type="button" className="przycisk przycisk-wtorny przycisk-maly whitespace-nowrap" onClick={() => setTestOtwarty((o) => !o)} aria-expanded={testOtwarty}>
        <Send size={14} /> Wyślij test
      </button>
      {testOtwarty ? (
        <OknoTestu tenantId={tenantId} campaignId={campaignId} temat={temat} braki={wszystkieBraki} brudny={brudny} zapisz={() => zapisz()} onZamknij={() => setTestOtwarty(false)} />
      ) : null}
    </div>
  );

  const ramkaPodgladu = (
    <div className="flex min-h-full justify-center px-2 py-3 md:px-6 md:py-8">
      <div className="w-full overflow-hidden rounded-xl border border-[var(--color-linia)] bg-white shadow-[var(--cien-uniesiony)]" style={{ maxWidth: mobile || telefon ? 400 : 720 }}>
        <div className="flex items-center gap-2 border-b border-[var(--color-linia)] px-4 py-2.5 text-[12px] text-[var(--color-tekst-3)]">
          <Eye size={14} aria-hidden="true" /> Tak zobaczy to klient, ze stopką i linkiem do wypisania się
        </div>
        {podglad.blad ? (
          <p role="alert" className="p-6 text-[13px] text-[var(--color-blad)]">{podglad.blad}</p>
        ) : podglad.html ? (
          <iframe title="Podgląd wiadomości" srcDoc={podglad.html} sandbox="" className="block h-[calc(var(--wysokosc-pelnego-ekranu,100dvh)-190px)] min-h-[480px] w-full border-0" />
        ) : (
          <div className="grid h-[480px] place-items-center text-[var(--color-tekst-3)]">
            <Loader2 className="animate-spin" />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <DndContext id={`edytor-${campaignId}`} sensors={sensory} collisionDetection={kolizje} autoScroll={{ threshold: { x: 0, y: 0.08 }, acceleration: 6 }} onDragStart={naStart} onDragMove={naRuch} onDragEnd={naKoniec} onDragCancel={() => { setPrzeciagany(null); setWskaznik(null); }}>
      <div className="edytor-maila flex h-[var(--wysokosc-pelnego-ekranu,100dvh)] min-h-0 flex-col overflow-hidden bg-[var(--color-plotno)]">
        {/* ── Pasek górny edytora: zastępuje nagłówek i pasek kroków kreatora ── */}
        <header className="relative z-30 grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--color-linia)] bg-white px-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <div className="flex min-w-0 items-center gap-2">
            <Link href={`/t/${tenantId}/kampanie`} className={przyciskPaska} aria-label="Wróć do kampanii" title="Kampanie">
              <ArrowLeft size={18} />
            </Link>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-[15px] leading-[20px]" title={nazwaKampanii}>{nazwaKampanii}</h1>
                <span className={`plakietka shrink-0 max-md:hidden ${stan.klasa}`}>{stan.etykieta}</span>
              </div>
              <nav aria-label="Kroki kampanii" className="flex min-w-0 items-center gap-1 whitespace-nowrap text-[12px] leading-[16px] text-[var(--color-tekst-2)] max-md:hidden">
                {konto.nazwaSklepu ? (
                  <>
                    <span className="max-w-[180px] truncate font-medium text-[var(--color-tekst)]" title={`Sklep: ${konto.nazwaSklepu}`}>{konto.nazwaSklepu}</span>
                    <span aria-hidden="true" className="mx-1 text-[var(--color-linia-mocna)]">|</span>
                  </>
                ) : null}
                <Link href={`${baza}/odbiorcy`} className="hover:text-[var(--color-akcent)]">Odbiorcy</Link>
                <span aria-hidden="true">›</span>
                <span aria-current="step" className="font-semibold text-[var(--color-tekst)]">Treść</span>
                <span aria-hidden="true">›</span>
                <Link href={`${baza}/ustawienia`} className="hover:text-[var(--color-akcent)]">Temat</Link>
                <span aria-hidden="true">›</span>
                <Link href={baza} className="hover:text-[var(--color-akcent)]">Wysyłka</Link>
              </nav>
            </div>
          </div>

          {/* Środek paska: tryb i urządzenie. Gdy piszesz w tekście, ich miejsce zajmuje pasek
              formatowania (gniazdo portalu), jak w Klaviyo. */}
          <div className="hidden items-center gap-2 md:flex [&:has(#edytor-formatowanie:not(:empty))>.przelaczniki]:hidden">
            <div id="edytor-formatowanie" className="flex empty:hidden" />
            <div className="przelaczniki flex items-center gap-2">
              <div role="radiogroup" aria-label="Tryb" className="flex rounded-lg bg-[var(--color-powierzchnia-2)] p-0.5">
                <button type="button" role="radio" aria-checked={tryb === "edycja"} disabled={zablokowane} title={zablokowane ? "Po starcie wysyłki treść jest zamrożona" : undefined} className={segment(tryb === "edycja")} onClick={() => setTryb("edycja")}>
                  <PenLine size={14} /> Edycja
                </button>
                <button type="button" role="radio" aria-checked={tryb === "podglad"} className={segment(tryb === "podglad")} onClick={() => setTryb("podglad")}>
                  <Eye size={14} /> Podgląd
                </button>
              </div>
              <div role="radiogroup" aria-label="Urządzenie" className="flex rounded-lg bg-[var(--color-powierzchnia-2)] p-0.5">
                <button type="button" role="radio" aria-checked={!mobile} className={segment(!mobile)} onClick={() => setWidok("desktop")} aria-label="Komputer" title="Komputer">
                  <Monitor size={15} />
                </button>
                <button type="button" role="radio" aria-checked={mobile} className={segment(mobile)} onClick={() => setWidok("mobile")} aria-label="Telefon" title="Telefon">
                  <Smartphone size={15} />
                </button>
              </div>
            </div>
          </div>

          <div className="flex min-w-0 items-center justify-end gap-2">
            <span className="hidden shrink-0 whitespace-nowrap text-[13px] lg:block" aria-live="polite">{stanZapisu}</span>
            <div className="hidden items-center md:flex">
              <button type="button" className={przyciskPaska} onClick={() => setHistoria(cofnij)} disabled={zablokowane || tryb !== "edycja" || !historia.przeszlosc.length} aria-label="Cofnij (Ctrl+Z)" title="Cofnij (Ctrl+Z)">
                <Undo2 size={17} />
              </button>
              <button type="button" className={przyciskPaska} onClick={() => setHistoria(ponow)} disabled={zablokowane || tryb !== "edycja" || !historia.przyszlosc.length} aria-label="Ponów (Ctrl+Shift+Z)" title="Ponów (Ctrl+Shift+Z)">
                <Redo2 size={17} />
              </button>
            </div>
            {wszystkieBraki.length && !zablokowane ? (
              <div className="relative hidden md:block">
                <button
                  type="button"
                  onClick={() => setUwagiOtwarte((o) => !o)}
                  aria-expanded={uwagiOtwarte}
                  title={`${liczbaWymaganych} wymaganych przed wysyłką, ${liczbaZalecen} ${formaOdmiany(liczbaZalecen, "zalecenie", "zalecenia", "zaleceń")}`}
                  className={`flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[13px] font-semibold hover:brightness-95 ${liczbaWymaganych ? "border-[var(--color-blad-ramka)] bg-[var(--color-blad-tlo)] text-[var(--color-blad)]" : "border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] text-[var(--color-czeka)]"}`}
                >
                  <AlertTriangle size={14} aria-hidden="true" />
                  {liczbaWymaganych ? <span>{liczbaWymaganych} <span className="hidden min-[1440px]:inline">{formaOdmiany(liczbaWymaganych, "wymagana", "wymagane", "wymaganych")}</span></span> : null}
                  {liczbaWymaganych && liczbaZalecen ? <span className="font-normal opacity-60">·</span> : null}
                  {liczbaZalecen ? <span className={liczbaWymaganych ? "font-medium text-[var(--color-czeka)]" : ""}>{liczbaZalecen} <span className="hidden min-[1440px]:inline">{formaOdmiany(liczbaZalecen, "zalecenie", "zalecenia", "zaleceń")}</span></span> : null}
                </button>
                {uwagiOtwarte ? (
                  <DymekBrakow onZamknij={() => setUwagiOtwarte(false)}>
                    <div className="flex items-center justify-between">
                      <h3 className="text-[14px]">Do poprawy przed wysyłką</h3>
                      <button type="button" onClick={() => setUwagiOtwarte(false)} aria-label="Zamknij" className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-tekst-3)] hover:bg-[var(--color-powierzchnia-2)]">
                        <X size={15} />
                      </button>
                    </div>
                    <ul className="mt-2 max-h-[min(420px,60vh)] space-y-2 overflow-y-auto text-[13px] leading-[18px] text-[var(--color-tekst-2)]">
                      {wszystkieBraki.map((b, i) => (
                        <li key={i} className="flex gap-2">
                          <AlertTriangle size={13} className={`mt-[3px] shrink-0 ${b.wymagane ? "text-[var(--color-blad)]" : "text-[var(--color-czeka)]"}`} aria-label={b.wymagane ? "wymagane" : "zalecenie"} />
                          <span>
                            {b.tekst}
                            {b.link ? (
                              <>
                                {" "}
                                <a href={b.link.href} target="_blank" rel="noopener" className="font-semibold text-[var(--color-akcent)] hover:underline">
                                  {b.link.etykieta}
                                </a>
                              </>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 border-t border-[var(--color-linia-0)] pt-2.5 text-[12px] leading-[17px] text-[var(--color-tekst-2)]">Czerwone zatrzymają wysyłkę kampanii, pomarańczowe to zalecenia. Bloki z brakami mają na płótnie znacznik, kliknij go, żeby poprawić w miejscu.</p>
                  </DymekBrakow>
                ) : null}
              </div>
            ) : null}
            {przyciskTestu}
            {zapis.blad ? (
              <button type="button" className="przycisk przycisk-maly max-md:hidden" onClick={() => void zapisz()} disabled={zapis.trwa}>
                Ponów zapis
              </button>
            ) : !autozapis && !zablokowane ? (
              <button
                type="button"
                className="przycisk przycisk-maly max-md:hidden"
                onClick={() => void zapisz()}
                disabled={zapis.trwa || !brudny}
                title="Zapisz (Ctrl+S). Zmieniona treść wraca do szkicu i wymaga ponownej akceptacji klienta."
              >
                Zapisz
              </button>
            ) : null}
            <button type="button" className="przycisk przycisk-maly shrink-0 whitespace-nowrap max-md:hidden" onClick={() => void dalej()}>
              Dalej: temat →
            </button>
          </div>
        </header>

        {zapis.blad || zapis.komunikat || zrodlo === "html" || zrodlo === "uszkodzony" || zablokowane || komunikat?.ok || komunikat?.blad ? (
          <div className="shrink-0 space-y-1.5 border-b border-[var(--color-linia)] bg-white px-4 py-2 text-[13px]">
            {komunikat?.blad ? <p role="alert" className="text-[var(--color-blad)]">{komunikat.blad}</p> : null}
            {komunikat?.ok ? <p role="status" className="text-[var(--color-ok)]">{komunikat.ok}</p> : null}
            {zablokowane ? (
              <p className="flex items-center gap-2 text-[var(--color-tekst-2)]">
                <Lock size={14} /> Wysyłka już ruszyła — treść jest zamrożona: odbiorcy dostali to, co zaakceptował klient. Widzisz podgląd tylko do odczytu.
              </p>
            ) : null}
            {zapis.blad ? <p role="alert" className="text-[var(--color-blad)]">{zapis.blad}</p> : null}
            {zapis.komunikat ? <p className="text-[var(--color-czeka)]">{zapis.komunikat}</p> : null}
            {!zablokowane && zrodlo === "html" ? (
              <p className="text-[var(--color-tekst-2)]">
                Ta kampania powstała przed edytorem bloków. Jej HTML jest teraz blokiem „Własny HTML" — zostaw go, dołóż bloki wokół albo zacznij od szablonu.
              </p>
            ) : null}
            {!zablokowane && zrodlo === "uszkodzony" ? (
              <p className="text-[var(--color-czeka)]">
                Zapisany układ bloków nie przeszedł sprawdzenia, więc pokazujemy treść, która faktycznie wychodzi w mailach. Zapis zastąpi uszkodzony układ.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* ── Telefon: podgląd tylko do odczytu + test (audyt P0-4) ── */}
        <div className="flex min-h-0 flex-1 flex-col md:hidden">
          <p className="flex shrink-0 items-start gap-2 border-b border-[var(--color-linia)] bg-[var(--color-akcent-tlo)] px-4 py-2.5 text-[13px] leading-[18px] text-[var(--color-tekst-2)]">
            <Monitor size={15} className="mt-px shrink-0 text-[var(--color-akcent)]" aria-hidden="true" />
            <span>
              <b className="font-semibold text-[var(--color-tekst)]">Edycja treści działa na komputerze.</b> Tu sprawdzisz, jak mail wygląda u klienta, i wyślesz sobie test.
            </span>
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-[#e9ecf0]">{telefon ? ramkaPodgladu : null}</div>
        </div>

        {/* ── Komputer: biblioteka | płótno | właściwości ── */}
        <div className="hidden min-h-0 flex-1 md:flex">
          {tryb === "edycja" ? (
            <aside className="w-[248px] shrink-0 border-r border-[var(--color-linia)] bg-[var(--color-panel)] min-[1400px]:w-[280px]" aria-label="Elementy maila">
              <PanelLewy
                tenantId={tenantId}
                zakladka={zakladka}
                onZakladka={setZakladka}
                onDodaj={(t) => dodaj(t)}
                maTresc={dok.bloki.length > 0}
                onSzablon={(d) => {
                  aktualizuj(() => d);
                  setZaznaczony(null);
                  setToast({ tekst: "Wstawiono szablon. Poprzednia treść wróci po Ctrl+Z.", cofnij: true });
                }}
                onObraz={wstawObraz}
                konto={kontoDomeny}
                zablokowane={zablokowane}
                odswiezObrazy={odswiezObrazy}
              />
            </aside>
          ) : null}

          <div className="relative flex min-w-0 flex-1 flex-col">
            <section
              ref={plotnoRef}
              data-plotno=""
              className="min-h-0 flex-1 overflow-auto bg-[#e9ecf0]"
              aria-label="Płótno maila"
              onClickCapture={(e) => {
                // link w treści to treść, nie nawigacja: klik w niego na płótnie nie wyprowadza z edytora
                if ((e.target as HTMLElement).closest("a[href]") && !(e.target as HTMLElement).closest("[data-poza-mailem]")) e.preventDefault();
              }}
              onDragOver={naPlikNad}
              onDragLeave={naPlikWyjscie}
              onDrop={naPlikUpuszczony}
            >
              {tryb === "podglad" ? (
                ramkaPodgladu
              ) : (
                <ObszarPlotna onKlik={() => { setZaznaczony(null); setMenuPo(null); }}>
                  <div className="shrink-0 transition-[width] duration-200" style={{ width: szerokoscUrzadzenia, zoom: skalaEfektywna }}>
                    <div className={`shadow-[var(--cien-uniesiony)] ${mobile ? "rounded-[28px] border-[6px] border-[#1f2328]" : "rounded-lg bg-white"}`} style={{ background: SILNIK_TLO, padding: mobile ? WCIECIE_BODY : 0 }}>
                      <div className="rounded-lg bg-white" style={{ padding: SILNIK_WCIECIE }}>
                        <div style={{ background: dok.style.tloTresci, color: dok.style.kolorTekstu }} className="relative">
                          {dok.bloki.length === 0 ? (
                            <div className={`flex flex-col items-center gap-4 rounded-lg border-2 border-dashed px-4 py-10 text-center transition-colors ${widocznyWskaznik !== null ? "border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)]" : "border-[var(--color-linia-mocna)]"}`} style={{ fontFamily: "var(--font-sans)" }}>
                              <div>
                                <div className="text-[15px] font-semibold text-[var(--color-tekst)]">Przeciągnij tu pierwszy blok</div>
                                <p className="mt-1 text-[13px] text-[var(--color-tekst-2)]">albo upuść zdjęcie z dysku, albo zacznij od szablonu z lewego panelu.</p>
                              </div>
                              <button
                                type="button"
                                data-poza-mailem=""
                                className="przycisk przycisk-wtorny przycisk-maly"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setZakladka("szablony");
                                }}
                              >
                                Pokaż szablony
                              </button>
                            </div>
                          ) : (
                            dok.bloki.map((b, i) => (
                              <div key={b.id}>
                                {widocznyWskaznik === i ? <Wskaznik nazwa={nazwaWskaznika} /> : null}
                                <BlokNaPlotnie
                                  blok={b}
                                  indeks={i}
                                  liczba={dok.bloki.length}
                                  styl={dok.style}
                                  mobile={mobile}
                                  zaznaczony={zaznaczony === b.id}
                                  edycjaTekstu={edycja?.id === b.id}
                                  przeciagany={przeciagany?.zrodlo === "plotno" && przeciagany.id === b.id}
                                  celPliku={plikNad?.obraz === b.id}
                                  onZaznacz={() => setZaznaczony(b.id)}
                                  onWejdzWTekst={(punkt) => setEdycja({ id: b.id, ...punkt })}
                                  onZmiana={(z, k) => zmien(b.id, z, k)}
                                  onUsun={() => usun(b.id)}
                                  onDuplikuj={() => duplikuj(b.id)}
                                  onPrzesun={(k) => przesun(b.id, k)}
                                  menuOtwarte={menuPo === b.id}
                                  onMenu={(o) => setMenuPo(o ? b.id : null)}
                                  trwaPrzeciaganie={przeciagany !== null}
                                  onDodajPo={(t) => {
                                    setMenuPo(null);
                                    dodaj(t, i + 1);
                                  }}
                                />
                              </div>
                            ))
                          )}
                          {dok.bloki.length > 0 && widocznyWskaznik === dok.bloki.length ? <Wskaznik nazwa={nazwaWskaznika} /> : null}
                        </div>
                        {/* Stopka silnika: odwzorowanie tego, co dokleja zlozWiadomosc. Nieedytowalna. */}
                        <div className="relative mt-8 select-none border-t border-[#e5e5e5] pt-4 text-[12px] leading-[1.6] text-[#8a8a8a]" aria-label="Stopka dodawana do każdego maila" style={{ fontFamily: "-apple-system,Segoe UI,sans-serif" }}>
                          <span className="absolute -top-3 right-0 flex items-center gap-1 rounded-full border border-[var(--color-linia)] bg-white px-2 py-0.5 text-[11px] font-medium text-[var(--color-tekst-3)]" style={{ fontFamily: "var(--font-sans)" }}>
                            <Lock size={11} /> dodajemy sami
                          </span>
                          <p>Otrzymujesz tę wiadomość, bo wyraziłaś/eś zgodę na komunikację od {konto.nazwaSklepu || "sklepu"}.</p>
                          {konto.adres?.trim() && konto.firma?.trim() ? (
                            <p>{liniaFirmy(konto)}</p>
                          ) : (
                            <a
                              href={adresDanychFirmy}
                              target="_blank"
                              rel="noopener"
                              data-poza-mailem=""
                              onClick={(e) => e.stopPropagation()}
                              className="my-1.5 flex items-center gap-2 rounded-md border border-dashed border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] px-3 py-2 text-[12px] font-medium text-[var(--color-czeka)] no-underline hover:brightness-95"
                              style={{ fontFamily: "var(--font-sans)" }}
                            >
                              <AlertTriangle size={13} aria-hidden="true" />
                              {liniaFirmy(konto) ? `${liniaFirmy(konto)} · ` : ""}Uzupełnij {!konto.firma?.trim() && !konto.adres?.trim() ? "nazwę i adres firmy" : !konto.adres?.trim() ? "adres firmy" : "nazwę firmy"} w ustawieniach
                              <ExternalLink size={12} aria-hidden="true" className="ml-auto" />
                            </a>
                          )}
                          <p className="underline">Wypisz się jednym kliknięciem</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </ObszarPlotna>
              )}
            </section>
            {tryb === "edycja" ? (
              <div className="pointer-events-none absolute bottom-4 right-4 flex justify-end">
                <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-[var(--color-linia)] bg-white p-1 text-[12px] shadow-[var(--cien-uniesiony)]" role="group" aria-label="Powiększenie płótna">
                  <button type="button" className="grid h-7 w-7 place-items-center rounded-full text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] disabled:opacity-35" onClick={() => zmienSkale(-1)} disabled={skalaEfektywna <= SKALE[0] + 0.001} aria-label="Pomniejsz">
                    <Minus size={14} />
                  </button>
                  <button type="button" className="h-7 min-w-[52px] rounded-full px-2 font-semibold tabular-nums text-[var(--color-tekst)] hover:bg-[var(--color-powierzchnia-2)]" onClick={() => setSkala(1)} title="Pokaż w rzeczywistym rozmiarze (100%)">
                    {Math.round(skalaEfektywna * 100)}%
                  </button>
                  <button type="button" className="grid h-7 w-7 place-items-center rounded-full text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] disabled:opacity-35" onClick={() => zmienSkale(1)} disabled={skalaEfektywna >= SKALE[SKALE.length - 1] - 0.001} aria-label="Powiększ">
                    <Plus size={14} />
                  </button>
                  <span className="mx-0.5 h-4 w-px bg-[var(--color-linia)]" aria-hidden="true" />
                  <button type="button" aria-pressed={skala === "dopasuj"} className={`h-7 rounded-full px-2.5 font-medium ${skala === "dopasuj" ? "bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]" : "text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)]"}`} onClick={() => setSkala("dopasuj")}>
                    Dopasuj
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {tryb === "edycja" ? (
            <aside className="w-[296px] shrink-0 overflow-y-auto border-l border-[var(--color-linia)] bg-white min-[1400px]:w-[320px]" aria-label="Właściwości">
              {przeciagany ? (
                <div className="pusty-stan">
                  <h2 className="text-[14px]">Upuść blok na płótnie</h2>
                  <p className="text-[13px]">Po upuszczeniu zobaczysz tu jego ustawienia.</p>
                </div>
              ) : blokZaznaczony ? (
                <WlasciwosciBloku key={blokZaznaczony.id} blok={blokZaznaczony} styl={dok.style} uwagi={uwagiBloku} zmien={(z, k) => zmien(blokZaznaczony.id, z, k)} />
              ) : (
                <>
                  <StyleGlobalne styl={dok.style} zmien={zmienStyl} />
                  {wszystkieBraki.length ? (
                    <section className="border-t border-[var(--color-linia)] px-4 py-4">
                      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-czeka)]">
                        <AlertTriangle size={14} /> Do poprawy przed wysyłką
                      </h3>
                      <ul className="mt-2 space-y-1.5 text-[12px] leading-[17px] text-[var(--color-tekst-2)]">
                        {wszystkieBraki.slice(0, 8).map((u, i) => (
                          <li key={i}>
                            {u.tekst}
                            {u.link ? (
                              <>
                                {" "}
                                <a href={u.link.href} target="_blank" rel="noopener" className="font-semibold text-[var(--color-akcent)] hover:underline">
                                  {u.link.etykieta}
                                </a>
                              </>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </>
              )}
            </aside>
          ) : null}
        </div>
      </div>

      {toast ? (
        <div role="status" className={`fixed bottom-6 left-1/2 z-[70] flex max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-lg py-2 pl-4 pr-2 text-[13px] text-white shadow-[var(--cien-uniesiony)] ${toast.ton === "blad" ? "bg-[var(--color-blad)]" : "bg-[#1f2328]"}`}>
          {toast.ton === "trwa" ? <Loader2 size={15} className="shrink-0 animate-spin" /> : toast.ton === "blad" ? <AlertTriangle size={15} className="shrink-0" /> : null}
          <span className="min-w-0">{toast.tekst}</span>
          {toast.cofnij ? (
            <button
              type="button"
              onClick={() => {
                setHistoria(cofnij);
                setToast(null);
              }}
              className="shrink-0 rounded-md px-2.5 py-1 font-semibold text-[#d9c4f2] hover:bg-white/10"
            >
              Cofnij
            </button>
          ) : (
            <button type="button" onClick={() => setToast(null)} aria-label="Zamknij" className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-white/10">
              <X size={14} />
            </button>
          )}
        </div>
      ) : null}

      <DragOverlay dropAnimation={null}>
        {przeciagany ? (
          <div className="flex w-max items-center gap-2 whitespace-nowrap rounded-lg border border-[var(--color-akcent-ramka)] bg-white px-3 py-2 text-[13px] font-medium text-[var(--color-akcent)] shadow-[var(--cien-uniesiony)]">
            {(() => {
              const I = IKONY_BLOKOW[przeciagany.typ];
              return <I size={16} />;
            })()}
            {NAZWY_BLOKOW[przeciagany.typ]}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
