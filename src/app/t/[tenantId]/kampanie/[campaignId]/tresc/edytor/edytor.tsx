"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ArrowUp,
  Check,
  Copy,
  Eye,
  GripVertical,
  LayoutTemplate,
  Loader2,
  Lock,
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
  nowaHistoria,
  nowyBlok,
  ponow,
  przeniesBlok,
  przesunBlok,
  SILNIK_SZEROKOSC_KARTY,
  SILNIK_TLO,
  SILNIK_WCIECIE,
  SZABLONY,
  usunBlok,
  wstawBlok,
  zapiszWHistorii,
  zmienBlok,
  type Blok,
  type DokumentMaila,
  type Historia,
  type StyleMaila,
  type TypBloku,
  type ZrodloDokumentu,
} from "../../../../../../../domain/email/bloki";
import { renderujDokument } from "../../../../../../../usecases/tresc/render-blokow";
import { podgladBlokowAkcja, wyslijTestZEdytoraAkcja, zapiszBlokiAkcja } from "../../../../../../akcje";
import { Biblioteka, IKONY_BLOKOW, NAZWY_BLOKOW } from "./biblioteka";
import { WidokBloku } from "./bloki-plotna";
import { StyleGlobalne, WlasciwosciBloku } from "./panel-wlasciwosci";

/**
 * Edytor maila typu „przeciągnij i upuść" (krok 2 kreatora).
 *
 * Stan: historia dokumentów (cofnij/ponów), zaznaczony blok, znacznik zapisu. Dokument
 * jest JEDYNYM źródłem prawdy — płótno i panel tylko go czytają i proponują zmiany.
 * Zapis idzie przez `zapiszBlokiAkcja`, która na serwerze waliduje, sanityzuje i renderuje
 * HTML do `content.html` (tam czyta silnik wysyłki).
 */

type Widok = "desktop" | "mobile";
type Tryb = "edycja" | "podglad";
type Przeciagany = { zrodlo: "paleta"; typ: TypBloku } | { zrodlo: "plotno"; id: string; typ: TypBloku };

const SZEROKOSC_URZADZENIA: Record<Widok, number> = { desktop: SILNIK_SZEROKOSC_KARTY + 2 * SILNIK_WCIECIE, mobile: 375 + 12 }; // 375 px ekranu + ramka telefonu
// Wymiary odwzorowują oprawę silnika (`zlozWiadomosc`): karta 560 px treści + 2 × 32 px
// wcięcia. Płótno pokazuje treść w tej szerokości, w jakiej dostanie ją odbiorca. Na
// komputerze szare tło płótna gra rolę tła silnika; na telefonie widać też wcięcie body.
const WCIECIE_BODY = 24;

function godzina(iso: string): string {
  return new Date(iso).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
}

// ── Blok na płótnie ───────────────────────────────────────────────────────────────

function BlokNaPlotnie({
  blok,
  indeks,
  liczba,
  styl,
  mobile,
  zaznaczony,
  przeciagany,
  onZaznacz,
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
  przeciagany: boolean;
  onZaznacz: () => void;
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
  const drag = useDraggable({ id: `plotno:${blok.id}`, data: { zrodlo: "plotno", id: blok.id, typ: blok.typ } });
  const Ikona = IKONY_BLOKOW[blok.typ];
  const tlo = blok.tlo || undefined;
  const akcja = "grid h-8 w-8 place-items-center rounded-md text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-tekst)] disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div
      ref={(n) => {
        drop.setNodeRef(n);
        drag.setNodeRef(n);
      }}
      data-blok={blok.id}
      tabIndex={0}
      role="group"
      aria-label={`${NAZWY_BLOKOW[blok.typ]}, blok ${indeks + 1} z ${liczba}${zaznaczony ? ", zaznaczony" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onZaznacz();
      }}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onZaznacz();
      }}
      className={`group/blok relative outline-offset-[-1px] transition-[outline-color,opacity] ${
        zaznaczony && !trwaPrzeciaganie
          ? "z-10 outline outline-2 outline-[var(--color-akcent)]"
          : "outline outline-1 outline-transparent hover:outline-[var(--color-akcent-ramka)]"
      } ${przeciagany ? "opacity-35" : ""}`}
      style={{ padding: `${blok.gora}px ${blok.boki}px ${blok.dol}px`, background: tlo }}
    >
      <span
        className={`pointer-events-none absolute left-[-1px] top-0 z-20 flex -translate-y-full items-center gap-1 rounded-t-md px-1.5 py-0.5 text-[11px] font-medium leading-4 ${
          trwaPrzeciaganie ? "!hidden" : zaznaczony ? "bg-[var(--color-akcent)] text-white" : "hidden bg-[var(--color-akcent-ramka)] text-[var(--color-akcent)] group-hover/blok:flex"
        }`}
      >
        <Ikona size={12} aria-hidden="true" />
        {NAZWY_BLOKOW[blok.typ]}
      </span>
      <div
        className={`absolute right-[-1px] top-0 z-20 -translate-y-full items-center gap-0.5 rounded-t-md border border-b-0 border-[var(--color-linia)] bg-white px-0.5 pt-0.5 ${
          trwaPrzeciaganie ? "hidden" : zaznaczony ? "flex" : "hidden group-hover/blok:flex"
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
        <button type="button" className={akcja} onClick={() => onPrzesun(-1)} disabled={indeks === 0} aria-label="Przesuń w górę" title="Przenieś wyżej">
          <ArrowUp size={15} />
        </button>
        <button type="button" className={akcja} onClick={() => onPrzesun(1)} disabled={indeks === liczba - 1} aria-label="Przesuń w dół" title="Przenieś niżej">
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
      <WidokBloku blok={blok} styl={styl} mobile={mobile} tylkoDoOdczytu={false} onZmiana={onZmiana} />
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
          <span className={`${zaznaczony || menuOtwarte ? "inline" : "hidden group-hover/plus:inline"} pr-1`}>Dodaj blok</span>
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
      <div className="flex h-12 items-center justify-center gap-2 rounded-md border-2 border-dashed border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)] text-[12px] font-medium text-[var(--color-akcent)]">
        <Plus size={14} /> {nazwa}
      </div>
    </div>
  );
}

function ObszarPlotna({ children, onKlik }: { children: React.ReactNode; onKlik: () => void }) {
  const { setNodeRef } = useDroppable({ id: "plotno" });
  return (
    <div ref={setNodeRef} onClick={onKlik} className="min-h-full px-3 py-8">
      {children}
    </div>
  );
}

// ── Szablony ─────────────────────────────────────────────────────────────────────

function KartySzablonow({ onWybierz, kompaktowe = false }: { onWybierz: (d: DokumentMaila) => void; kompaktowe?: boolean }) {
  return (
    <div className={`grid gap-3 ${kompaktowe ? "grid-cols-2" : "grid-cols-2 lg:grid-cols-4"}`}>
      {SZABLONY.map((s) => {
        const d = s.zbuduj();
        return (
          <button
            key={s.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onWybierz(d);
            }}
            className="group flex flex-col overflow-hidden rounded-[10px] border border-[var(--color-linia)] bg-white text-left shadow-[var(--cien-karta)] transition-[border-color,box-shadow] hover:border-[var(--color-akcent-ramka)] hover:shadow-[var(--cien-uniesiony)]"
          >
            <div className="flex h-[132px] flex-col gap-1 overflow-hidden bg-[var(--color-powierzchnia-2)] px-5 pt-4">
              {d.bloki.length === 0 ? (
                <div className="grid flex-1 place-items-center rounded-t-md border-2 border-dashed border-[var(--color-linia-mocna)] bg-white text-[12px] text-[var(--color-tekst-3)]">
                  pusty
                </div>
              ) : (
                <div className="flex flex-1 flex-col gap-1 rounded-t-md bg-white p-2 shadow-[var(--cien-karta)]">
                  {d.bloki.slice(0, 7).map((b) => (
                    <MiniaturaBloku key={b.id} blok={b} marka={d.style.kolorMarki} />
                  ))}
                </div>
              )}
            </div>
            <div className="border-t border-[var(--color-linia)] px-3 py-2.5">
              <div className="text-[13px] font-semibold group-hover:text-[var(--color-akcent)]">{s.nazwa}</div>
              <div className="mt-0.5 text-[12px] leading-[16px] text-[var(--color-tekst-3)]">{s.opis}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function MiniaturaBloku({ blok, marka }: { blok: Blok; marka: string }) {
  const szary = "bg-[#e3e6ea]";
  switch (blok.typ) {
    case "naglowek":
      return <div className="mx-auto h-2 w-10 rounded-sm" style={{ background: blok.tlo || "#1f2328" }} />;
    case "obraz":
      return <div className={`h-6 w-full rounded-sm ${szary}`} />;
    case "tekst":
      return blok.wariant === "h1" ? <div className="mx-auto h-2 w-3/4 rounded-sm bg-[#1f2328]" /> : <div className={`h-1.5 w-full rounded-sm ${szary}`} />;
    case "przycisk":
      return <div className="mx-auto h-2.5 w-12 rounded-sm" style={{ background: marka }} />;
    case "kod":
      return <div className="mx-auto h-4 w-3/4 rounded-sm border border-dashed" style={{ borderColor: marka }} />;
    case "kolumny":
      return (
        <div className="flex gap-1">
          <div className={`h-4 flex-1 rounded-sm ${szary}`} />
          <div className={`h-4 flex-1 rounded-sm ${szary}`} />
        </div>
      );
    case "produkt":
      return <div className={`mx-auto h-5 w-1/2 rounded-sm ${szary}`} />;
    default:
      return <div className="h-1 w-full rounded-sm bg-[#eef0f3]" />;
  }
}

// ── Edytor ───────────────────────────────────────────────────────────────────────

export function Edytor({
  tenantId,
  campaignId,
  dokumentStartowy,
  zrodlo,
  nazwaSklepu,
  tylkoDoOdczytu,
  status,
  temat,
}: {
  tenantId: string;
  campaignId: string;
  dokumentStartowy: DokumentMaila;
  zrodlo: ZrodloDokumentu;
  nazwaSklepu: string;
  tylkoDoOdczytu: boolean;
  status: string;
  temat: string;
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
  const [widok, setWidok] = useState<Widok>("desktop");
  const [tryb, setTryb] = useState<Tryb>(tylkoDoOdczytu ? "podglad" : "edycja");
  const [zapis, setZapis] = useState<{ trwa: boolean; blad?: string; kiedy?: string; komunikat?: string }>({ trwa: false });
  const [przeciagany, setPrzeciagany] = useState<Przeciagany | null>(null);
  const [wskaznik, setWskaznik] = useState<number | null>(null);
  const [menuPo, setMenuPo] = useState<string | null>(null);
  const [szablonyOtwarte, setSzablonyOtwarte] = useState(false);
  const [test, setTest] = useState<{ otwarty: boolean; adres: string; trwa: boolean; wynik?: { ok: boolean; tekst: string } }>({ otwarty: false, adres: "", trwa: false });
  const [podglad, setPodglad] = useState<{ html?: string; trwa: boolean; blad?: string }>({ trwa: false });
  const plotnoRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const zablokowane = tylkoDoOdczytu;
  const mobile = widok === "mobile";

  // ── operacje na dokumencie (każda przez historię) ──
  const aktualizuj = useCallback((fn: (d: DokumentMaila) => DokumentMaila, klucz: string | null = null) => {
    setHistoria((h) => zapiszWHistorii(h, fn(h.biezacy), klucz));
    // nowa zmiana po nieudanym zapisie = nowa próba autozapisu
    setZapis((z) => (z.blad ? { ...z, blad: undefined } : z));
  }, []);

  const dodaj = useCallback(
    (typ: TypBloku, indeks?: number) => {
      const blok = nowyBlok(typ);
      aktualizuj((d) => {
        const po = zaznaczony ? d.bloki.findIndex((b) => b.id === zaznaczony) : -1;
        return wstawBlok(d, blok, indeks ?? (po >= 0 ? po + 1 : d.bloki.length));
      });
      setZaznaczony(blok.id);
      requestAnimationFrame(() => plotnoRef.current?.querySelector(`[data-blok="${blok.id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    },
    [aktualizuj, zaznaczony],
  );
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  const usun = useCallback((id: string) => {
    const typ = historia.biezacy.bloki.find((b) => b.id === id)?.typ;
    aktualizuj((d) => usunBlok(d, id));
    setZaznaczony((z) => (z === id ? null : z));
    if (typ) setToast(`Usunięto blok „${NAZWY_BLOKOW[typ]}"`);
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
    },
    [aktualizuj, historia.biezacy],
  );
  const przesun = useCallback((id: string, k: -1 | 1) => aktualizuj((d) => przesunBlok(d, id, k)), [aktualizuj]);
  const zmien = useCallback((id: string, zmiany: Partial<Blok>, klucz?: string) => aktualizuj((d) => zmienBlok(d, id, zmiany), klucz ? `${id}:${klucz}` : null), [aktualizuj]);
  const zmienStyl = useCallback((z: Partial<StyleMaila>, klucz?: string) => aktualizuj((d) => ({ ...d, style: { ...d.style, ...z } }), klucz ? `styl:${klucz}` : null), [aktualizuj]);

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

  // ── skróty klawiszowe ──
  useEffect(() => {
    const obsluz = (e: KeyboardEvent) => {
      const cel = e.target as HTMLElement | null;
      const wPolu = Boolean(cel?.closest("input, textarea, select"));
      const wTekscie = Boolean(cel?.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      const klawisz = e.key.toLowerCase();
      if (mod && klawisz === "s") {
        e.preventDefault();
        void zapisz();
        return;
      }
      if (zablokowane || tryb !== "edycja") return;
      // w polach panelu działa natywne cofanie przeglądarki; na płótnie (także w tekście) — nasze
      if (mod && (klawisz === "z" || klawisz === "y") && !wPolu) {
        e.preventDefault();
        setHistoria((h) => (klawisz === "y" || e.shiftKey ? ponow(h) : cofnij(h)));
        return;
      }
      if (wPolu || wTekscie) return;
      if (zaznaczony && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        usun(zaznaczony);
      } else if (zaznaczony && mod && klawisz === "d") {
        e.preventDefault();
        duplikuj(zaznaczony);
      } else if (e.key === "Escape") {
        setZaznaczony(null);
        setMenuPo(null);
      }
    };
    window.addEventListener("keydown", obsluz);
    return () => window.removeEventListener("keydown", obsluz);
  }, [duplikuj, tryb, usun, zablokowane, zapisz, zaznaczony]);

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

  // ── podgląd (prawdziwe złożenie przez silnik) ──
  useEffect(() => {
    if (tryb !== "podglad") return;
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
  }, [tryb, dok, tenantId, campaignId]);

  // ── przeciąganie ──
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
  wskaznikRef.current = wskaznik;
  /**
   * Pozycja wstawienia liczona z ŻYWEGO układu (getBoundingClientRect), a nie z prostokątów
   * zmierzonych przez dnd-kit na starcie przeciągania. Placeholder rozsuwa bloki, więc
   * zapamiętane prostokąty byłyby nieaktualne i miejsce zrzutu skakałoby pod kursorem.
   * dnd-kit odpowiada tylko na pytanie „czy kursor jest nad płótnem".
   */
  const policzWskaznik = (e: DragMoveEvent): number | null => {
    if (!e.over) return null;
    // kursor z ostatniego pointermove; przy klawiaturze (brak kursora) środek przeciąganego elementu
    const y =
      kursorY.current ??
      (e.active.rect.current.translated?.top ?? 0) + (e.active.rect.current.translated?.height ?? 0) / 2;
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
    return wskaznikRef.current ?? bloki.findIndex((el) => el.getBoundingClientRect().top > y);
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

  // wskaźnik nie ma sensu tuż obok przeciąganego bloku (upuszczenie tam nic nie zmienia)
  const indeksPrzeciaganego = przeciagany?.zrodlo === "plotno" ? dok.bloki.findIndex((b) => b.id === przeciagany.id) : -1;
  const widocznyWskaznik = wskaznik !== null && !(indeksPrzeciaganego !== -1 && (wskaznik === indeksPrzeciaganego || wskaznik === indeksPrzeciaganego + 1)) ? wskaznik : null;

  const nazwaPrzeciaganego = przeciagany ? `Upuść tutaj: ${NAZWY_BLOKOW[przeciagany.typ]}` : "";

  const uwagiDokumentu = useMemo(() => renderujDokument(dok).uwagi, [dok]);
  const blokZaznaczony = dok.bloki.find((b) => b.id === zaznaczony) ?? null;
  const uwagiBloku = useMemo(() => (blokZaznaczony ? renderujDokument({ ...dok, bloki: [blokZaznaczony] }).uwagi : []), [blokZaznaczony, dok]);

  const stanZapisu = zapis.trwa ? (
    <span className="flex items-center gap-1.5 text-[var(--color-tekst-2)]">
      <Loader2 size={14} className="animate-spin" /> Zapisuję…
    </span>
  ) : zapis.blad ? (
    <span className="flex items-center gap-1.5 text-[var(--color-blad)]" role="alert">
      <AlertTriangle size={14} /> Nie zapisano
    </span>
  ) : brudny ? (
    <span className="flex items-center gap-1.5 font-medium text-[var(--color-czeka)]" title={autozapis ? "Zapis ruszy sam za chwilę" : "Kliknij Zapisz"}>
      <span className="h-2 w-2 rounded-full bg-[var(--color-czeka)]" /> Niezapisane zmiany
    </span>
  ) : zapis.kiedy ? (
    <span className="flex items-center gap-1.5 text-[var(--color-tekst-2)]">
      <Check size={14} className="text-[var(--color-ok)]" /> Zapisano o {godzina(zapis.kiedy)}
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-[var(--color-tekst-3)]">
      <Check size={14} className="text-[var(--color-ok)]" /> Wszystko zapisane
    </span>
  );

  const przyciskPaska = "grid h-8 w-8 place-items-center rounded-lg text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-tekst)] disabled:opacity-35 disabled:hover:bg-transparent";
  const segment = (aktywny: boolean) =>
    `flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors ${aktywny ? "bg-white text-[var(--color-tekst)] shadow-[var(--cien-karta)]" : "text-[var(--color-tekst-2)] hover:text-[var(--color-tekst)]"}`;

  const szerokoscUrzadzenia = SZEROKOSC_URZADZENIA[widok];

  return (
    <DndContext id={`edytor-${campaignId}`} sensors={sensory} collisionDetection={kolizje} autoScroll={{ threshold: { x: 0, y: 0.08 }, acceleration: 6 }} onDragStart={naStart} onDragMove={naRuch} onDragEnd={naKoniec} onDragCancel={() => { setPrzeciagany(null); setWskaznik(null); }}>
      {/* Pasek narzędzi edytora */}
      <div className="flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-linia)] bg-[var(--color-app)] px-3 py-2">
        <div className="flex items-center gap-0.5">
          <button type="button" className={przyciskPaska} onClick={() => setHistoria(cofnij)} disabled={zablokowane || tryb !== "edycja" || !historia.przeszlosc.length} aria-label="Cofnij (Ctrl+Z)" title="Cofnij (Ctrl+Z)">
            <Undo2 size={17} />
          </button>
          <button type="button" className={przyciskPaska} onClick={() => setHistoria(ponow)} disabled={zablokowane || tryb !== "edycja" || !historia.przyszlosc.length} aria-label="Ponów (Ctrl+Shift+Z)" title="Ponów (Ctrl+Shift+Z)">
            <Redo2 size={17} />
          </button>
          <span className="mx-1.5 h-5 w-px bg-[var(--color-linia)]" />
          <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={() => setSzablonyOtwarte(true)} disabled={zablokowane}>
            <LayoutTemplate size={15} /> Szablony
          </button>
        </div>

        {/* Środek paska: przełączniki trybu i urządzenia. Gdy piszesz w tekście, ich miejsce
            zajmuje pasek formatowania (gniazdo portalu), jak w Klaviyo. */}
        <div className="mx-auto flex items-center gap-2 [&:has(#edytor-formatowanie:not(:empty))>.przelaczniki]:hidden">
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

        <div className="flex items-center gap-2">
          <span className="text-[13px]">{stanZapisu}</span>
          <div className="relative">
            <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={() => setTest((t) => ({ ...t, otwarty: !t.otwarty, wynik: undefined }))} disabled={!temat.trim()} title={temat.trim() ? undefined : "Najpierw nadaj temat w kroku 3"}>
              <Send size={14} /> Wyślij test
            </button>
            {test.otwarty ? (
              <form
                className="absolute right-0 top-[calc(100%+8px)] z-40 w-[340px] space-y-3 rounded-[10px] border border-[var(--color-linia)] bg-white p-4 shadow-[var(--cien-uniesiony)]"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setTest((t) => ({ ...t, trwa: true, wynik: undefined }));
                  // test idzie z ZAPISANEJ treści, więc najpierw zapis
                  if (brudny && !(await zapisz())) {
                    setTest((t) => ({ ...t, trwa: false, wynik: { ok: false, tekst: "Najpierw zapisz treść — zapis się nie udał." } }));
                    return;
                  }
                  try {
                    const w = await wyslijTestZEdytoraAkcja(tenantId, campaignId, test.adres);
                    setTest((t) => ({ ...t, trwa: false, wynik: w.ok ? { ok: true, tekst: w.komunikat } : { ok: false, tekst: w.blad } }));
                  } catch {
                    setTest((t) => ({ ...t, trwa: false, wynik: { ok: false, tekst: "Brak połączenia z serwerem." } }));
                  }
                }}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-[14px]">Wysyłka testowa</h3>
                  <button type="button" onClick={() => setTest((t) => ({ ...t, otwarty: false }))} aria-label="Zamknij" className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-tekst-3)] hover:bg-[var(--color-powierzchnia-2)]">
                    <X size={15} />
                  </button>
                </div>
                <input type="email" required autoFocus value={test.adres} onChange={(e) => setTest((t) => ({ ...t, adres: e.target.value }))} placeholder="twoj@adres.pl" className="pole" aria-label="Adres testowy" />
                <p className="text-[12px] leading-[17px] text-[var(--color-tekst-3)]">
                  {brudny ? "Najpierw zapiszemy zmiany. " : ""}Test idzie tą samą ścieżką co wysyłka: ten sam nadawca, stopka z wypisem i kolejka.
                </p>
                {test.wynik ? (
                  <p role="status" className={`rounded-md px-2.5 py-2 text-[12px] leading-[17px] ${test.wynik.ok ? "bg-[var(--color-ok-tlo)] text-[var(--color-ok)]" : "bg-[var(--color-blad-tlo)] text-[var(--color-blad)]"}`}>
                    {test.wynik.tekst}
                  </p>
                ) : null}
                <button type="submit" className="przycisk w-full" disabled={test.trwa}>
                  {test.trwa ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Wyślij
                </button>
              </form>
            ) : null}
          </div>
          {zapis.blad ? (
            <button type="button" className="przycisk przycisk-maly" onClick={() => void zapisz()} disabled={zapis.trwa}>
              Ponów zapis
            </button>
          ) : !autozapis && !zablokowane ? (
            <button
              type="button"
              className="przycisk przycisk-maly"
              onClick={() => void zapisz()}
              disabled={zapis.trwa || !brudny}
              title="Zapisz (Ctrl+S). Zmieniona treść wraca do szkicu i wymaga ponownej akceptacji klienta."
            >
              Zapisz
            </button>
          ) : null}
          <button
            type="button"
            className="przycisk przycisk-wtorny przycisk-maly"
            onClick={async () => {
              // niezapisana zmiana nie może zginąć przy przejściu dalej: najpierw zapis
              if (brudny && !zablokowane && !(await zapisz(autozapis))) return;
              router.push(`/t/${tenantId}/kampanie/${campaignId}/ustawienia`);
            }}
          >
            Dalej: temat →
          </button>
        </div>
      </div>

      {zapis.blad || zapis.komunikat || zrodlo === "html" || zrodlo === "uszkodzony" || zablokowane ? (
        <div className="space-y-2 border-b border-[var(--color-linia)] bg-[var(--color-app)] px-4 py-2.5 text-[13px]">
          {zablokowane ? (
            <p className="flex items-center gap-2 text-[var(--color-tekst-2)]">
              <Lock size={14} /> Wysyłka już ruszyła ({status}) — treść jest zamrożona: odbiorcy dostali to, co zaakceptował klient. Widzisz podgląd tylko do odczytu.
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
              Zapisany układ bloków nie przeszedł walidacji, więc pokazujemy HTML, który faktycznie wychodzi w mailach. Zapis zastąpi uszkodzony układ.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {tryb === "edycja" ? (
          <aside className="w-[248px] shrink-0 overflow-y-auto border-r border-[var(--color-linia)] bg-[var(--color-panel)]" aria-label="Biblioteka bloków">
            <Biblioteka onDodaj={(t) => dodaj(t)} zablokowane={zablokowane} />
          </aside>
        ) : null}

        <main ref={plotnoRef} className="min-w-0 flex-1 overflow-y-auto bg-[#e9ecf0]" aria-label="Płótno maila">
          {tryb === "podglad" ? (
            <div className="flex min-h-full justify-center px-6 py-8">
              <div className="w-full overflow-hidden rounded-xl border border-[var(--color-linia)] bg-white shadow-[var(--cien-uniesiony)]" style={{ maxWidth: mobile ? 375 : 760 }}>
                <div className="flex items-center gap-2 border-b border-[var(--color-linia)] px-4 py-2.5 text-[12px] text-[var(--color-tekst-3)]">
                  <Eye size={14} /> Tak dostanie to odbiorca — złożone przez silnik wysyłki, ze stopką i wypisem
                </div>
                {podglad.blad ? (
                  <p role="alert" className="p-6 text-[13px] text-[var(--color-blad)]">{podglad.blad}</p>
                ) : podglad.html ? (
                  <iframe title="Podgląd wiadomości" srcDoc={podglad.html} sandbox="" className="block h-[calc(100vh-240px)] min-h-[520px] w-full border-0" />
                ) : (
                  <div className="grid h-[520px] place-items-center text-[var(--color-tekst-3)]">
                    <Loader2 className="animate-spin" />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <ObszarPlotna onKlik={() => { setZaznaczony(null); setMenuPo(null); }}>
              <div className="mx-auto transition-[width] duration-200" style={{ width: szerokoscUrzadzenia }}>
                <div className="mb-2 flex items-center justify-between px-1 text-[12px] text-[var(--color-tekst-3)]">
                  <span>{mobile ? "Telefon · 375 px" : "Komputer · karta 560 px"}</span>
                  <span>{dok.bloki.length ? `${dok.bloki.length} ${dok.bloki.length === 1 ? "blok" : dok.bloki.length < 5 ? "bloki" : "bloków"}` : ""}</span>
                </div>
                <div className={`shadow-[var(--cien-uniesiony)] ${mobile ? "rounded-[28px] border-[6px] border-[#1f2328]" : "rounded-lg bg-white"}`} style={{ background: SILNIK_TLO, padding: mobile ? WCIECIE_BODY : 0 }}>
                  <div className="rounded-lg bg-white" style={{ padding: SILNIK_WCIECIE }}>
                    <div style={{ background: dok.style.tloTresci, color: dok.style.kolorTekstu }} className="relative">
                      {dok.bloki.length === 0 ? (
                        <div className={`flex flex-col items-center gap-4 rounded-lg border-2 border-dashed px-4 py-10 text-center transition-colors ${wskaznik !== null ? "border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)]" : "border-[var(--color-linia-mocna)]"}`}>
                          <div>
                            <div className="text-[15px] font-semibold text-[var(--color-tekst)]">Przeciągnij tu pierwszy blok</div>
                            <p className="mt-1 text-[13px] text-[var(--color-tekst-2)]">albo zacznij od gotowego układu:</p>
                          </div>
                          <div className="w-full text-left">
                            <KartySzablonow kompaktowe onWybierz={(d) => aktualizuj(() => d)} />
                          </div>
                        </div>
                      ) : (
                        dok.bloki.map((b, i) => (
                          <div key={b.id}>
                            {widocznyWskaznik === i ? <Wskaznik nazwa={nazwaPrzeciaganego} /> : null}
                            <BlokNaPlotnie
                              blok={b}
                              indeks={i}
                              liczba={dok.bloki.length}
                              styl={dok.style}
                              mobile={mobile}
                              zaznaczony={zaznaczony === b.id}
                              przeciagany={przeciagany?.zrodlo === "plotno" && przeciagany.id === b.id}
                              onZaznacz={() => setZaznaczony(b.id)}
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
                      {dok.bloki.length > 0 && widocznyWskaznik === dok.bloki.length ? <Wskaznik nazwa={nazwaPrzeciaganego} /> : null}
                    </div>
                    {/* Stopka silnika: odwzorowanie tego, co dokleja zlozWiadomosc. Nieedytowalna. */}
                    <div className="relative mt-8 select-none border-t border-[#e5e5e5] pt-4 text-[12px] leading-[1.6] text-[#8a8a8a]" aria-label="Stopka z wypisem doklejana przez system">
                      <span className="absolute -top-3 right-0 flex items-center gap-1 rounded-full border border-[var(--color-linia)] bg-white px-2 py-0.5 text-[11px] font-medium text-[var(--color-tekst-3)]">
                        <Lock size={11} /> dokleja system
                      </span>
                      <p>Otrzymujesz tę wiadomość, bo wyraziłaś/eś zgodę na komunikację od {nazwaSklepu || "sklepu"}.</p>
                      <p className="underline">Wypisz się jednym kliknięciem</p>
                    </div>
                  </div>
                </div>
              </div>
            </ObszarPlotna>
          )}
        </main>

        {tryb === "edycja" ? (
          <aside className="w-[296px] shrink-0 overflow-y-auto border-l border-[var(--color-linia)] bg-[var(--color-app)]" aria-label="Właściwości">
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
                {uwagiDokumentu.length ? (
                  <section className="border-t border-[var(--color-linia)] px-4 py-4">
                    <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-czeka)]">
                      <AlertTriangle size={14} /> Do poprawy przed wysyłką
                    </h3>
                    <ul className="mt-2 space-y-1.5 text-[12px] leading-[17px] text-[var(--color-tekst-2)]">
                      {uwagiDokumentu.slice(0, 8).map((u, i) => (
                        <li key={i}>{u}</li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </>
            )}
          </aside>
        ) : null}
      </div>

      {toast ? (
        <div role="status" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-[#1f2328] py-2 pl-4 pr-2 text-[13px] text-white shadow-[var(--cien-uniesiony)]">
          {toast}
          <button
            type="button"
            onClick={() => {
              setHistoria(cofnij);
              setToast(null);
            }}
            className="rounded-md px-2.5 py-1 font-semibold text-[#d9c4f2] hover:bg-white/10"
          >
            Cofnij
          </button>
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

      {szablonyOtwarte ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(16,24,40,0.45)] p-6" role="dialog" aria-modal="true" aria-label="Szablony startowe" onClick={() => setSzablonyOtwarte(false)}>
          <div className="w-full max-w-[920px] rounded-xl bg-white shadow-[var(--cien-uniesiony)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-[var(--color-linia)] px-5 py-4">
              <div>
                <h2>Szablony startowe</h2>
                <p className="karta-opis mt-0.5">Szablon zastępuje obecną treść. Zmienisz zdanie — Ctrl+Z przywróci poprzednią wersję.</p>
              </div>
              <button type="button" onClick={() => setSzablonyOtwarte(false)} aria-label="Zamknij" className="grid h-8 w-8 place-items-center rounded-lg text-[var(--color-tekst-3)] hover:bg-[var(--color-powierzchnia-2)]">
                <X size={18} />
              </button>
            </div>
            <div className="p-5">
              <KartySzablonow
                onWybierz={(d) => {
                  aktualizuj(() => d);
                  setZaznaczony(null);
                  setSzablonyOtwarte(false);
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </DndContext>
  );
}
