"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { AlertTriangle, ArrowDown, ArrowUp, Check, Copy, Eye, GripVertical, Loader2, Monitor, PenLine, Plus, Redo2, Smartphone, Trash2, Undo2 } from "lucide-react";
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
} from "../../../../../../../../domain/email/bloki";
import { renderujDokument } from "../../../../../../../../usecases/tresc/render-blokow";
import type { StatusAutomatyzacji } from "../../../../../../../../domain/automatyzacje/statusy";
import { podgladWiadomosciFlowAkcja, zapiszNaglowekWiadomosciAkcja, zapiszWiadomoscFlowAkcja } from "../../../../akcje";
// TEN SAM edytor co w kampaniach: biblioteka blokow, widok bloku na plotnie i panel
// wlasciwosci sa importowane z kreatora kampanii, nie kopiowane. Wlasna jest tylko
// powloka (pasek, zapis do wiadomosci automatyzacji), bo powloka kampanii jest
// przypieta do identyfikatora kampanii i jej akcji.
import { Biblioteka, IKONY_BLOKOW, NAZWY_BLOKOW } from "../../../../../kampanie/[campaignId]/tresc/edytor/biblioteka";
import { WidokBloku } from "../../../../../kampanie/[campaignId]/tresc/edytor/bloki-plotna";
import { StyleGlobalne, WlasciwosciBloku } from "../../../../../kampanie/[campaignId]/tresc/edytor/panel-wlasciwosci";

type Widok = "desktop" | "mobile";
type Tryb = "edycja" | "podglad";
type Przeciagany = { zrodlo: "paleta"; typ: TypBloku } | { zrodlo: "plotno"; id: string; typ: TypBloku };

const SZEROKOSC_URZADZENIA: Record<Widok, number> = { desktop: SILNIK_SZEROKOSC_KARTY + 2 * SILNIK_WCIECIE, mobile: 375 + 12 };
const WCIECIE_BODY = 24;

function godzina(iso: string): string {
  return new Date(iso).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
}

function BlokNaPlotnie({ blok, indeks, liczba, styl, mobile, zaznaczony, przeciagany, onZaznacz, onZmiana, onUsun, onDuplikuj, onPrzesun, trwaPrzeciaganie }: {
  blok: Blok; indeks: number; liczba: number; styl: StyleMaila; mobile: boolean; zaznaczony: boolean; przeciagany: boolean;
  onZaznacz: () => void; onZmiana: (z: Partial<Blok>, k?: string) => void; onUsun: () => void; onDuplikuj: () => void; onPrzesun: (k: -1 | 1) => void; trwaPrzeciaganie: boolean;
}) {
  const drop = useDroppable({ id: `blok:${blok.id}`, data: { id: blok.id } });
  const drag = useDraggable({ id: `plotno:${blok.id}`, data: { zrodlo: "plotno", id: blok.id, typ: blok.typ } });
  const Ikona = IKONY_BLOKOW[blok.typ];
  const akcja = "grid h-8 w-8 place-items-center rounded-md text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-tekst)] disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div
      ref={(n) => { drop.setNodeRef(n); drag.setNodeRef(n); }}
      data-blok={blok.id}
      tabIndex={0}
      role="group"
      aria-label={`${NAZWY_BLOKOW[blok.typ]}, blok ${indeks + 1} z ${liczba}${zaznaczony ? ", zaznaczony" : ""}`}
      onClick={(e) => { e.stopPropagation(); onZaznacz(); }}
      onFocus={(e) => { if (e.target === e.currentTarget) onZaznacz(); }}
      className={`group/blok relative outline-offset-[-1px] transition-[outline-color,opacity] ${zaznaczony && !trwaPrzeciaganie ? "z-10 outline outline-2 outline-[var(--color-akcent)]" : "outline outline-1 outline-transparent hover:outline-[var(--color-akcent-ramka)]"} ${przeciagany ? "opacity-35" : ""}`}
      style={{ padding: `${blok.gora}px ${blok.boki}px ${blok.dol}px`, background: blok.tlo || undefined }}
    >
      <span className={`pointer-events-none absolute left-[-1px] top-0 z-20 flex -translate-y-full items-center gap-1 rounded-t-md px-1.5 py-0.5 text-[11px] font-medium leading-4 ${trwaPrzeciaganie ? "!hidden" : zaznaczony ? "bg-[var(--color-akcent)] text-white" : "hidden bg-[var(--color-akcent-ramka)] text-[var(--color-akcent)] group-hover/blok:flex"}`}>
        <Ikona size={12} aria-hidden="true" />{NAZWY_BLOKOW[blok.typ]}
      </span>
      <div className={`absolute right-[-1px] top-0 z-20 -translate-y-full items-center gap-0.5 rounded-t-md border border-b-0 border-[var(--color-linia)] bg-white px-0.5 pt-0.5 ${trwaPrzeciaganie ? "hidden" : zaznaczony ? "flex" : "hidden group-hover/blok:flex"}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" ref={drag.setActivatorNodeRef} {...drag.listeners} {...drag.attributes} aria-label="Przeciągnij, żeby zmienić kolejność" className={`${akcja} cursor-grab active:cursor-grabbing`}><GripVertical size={15} /></button>
        <button type="button" className={akcja} onClick={() => onPrzesun(-1)} disabled={indeks === 0} aria-label="Przesuń w górę"><ArrowUp size={15} /></button>
        <button type="button" className={akcja} onClick={() => onPrzesun(1)} disabled={indeks === liczba - 1} aria-label="Przesuń w dół"><ArrowDown size={15} /></button>
        <button type="button" className={akcja} onClick={onDuplikuj} aria-label="Duplikuj blok"><Copy size={15} /></button>
        <span className="mx-0.5 h-4 w-px bg-[var(--color-linia)]" aria-hidden="true" />
        <button type="button" className={`${akcja} hover:!bg-[var(--color-blad-tlo)] hover:!text-[var(--color-blad)]`} onClick={onUsun} aria-label="Usuń blok"><Trash2 size={15} /></button>
      </div>
      <WidokBloku blok={blok} styl={styl} mobile={mobile} tylkoDoOdczytu={false} onZmiana={onZmiana} />
    </div>
  );
}

function Wskaznik({ nazwa }: { nazwa: string }) {
  const { setNodeRef } = useDroppable({ id: "wskaznik" });
  return (
    <div ref={setNodeRef} className="py-1" aria-hidden="true">
      <div className="flex h-12 items-center justify-center gap-2 rounded-md border-2 border-dashed border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)] text-[12px] font-medium text-[var(--color-akcent)]"><Plus size={14} /> {nazwa}</div>
    </div>
  );
}

function ObszarPlotna({ children, onKlik }: { children: React.ReactNode; onKlik: () => void }) {
  const { setNodeRef } = useDroppable({ id: "plotno" });
  return <div ref={setNodeRef} onClick={onKlik} className="min-h-full px-3 py-8">{children}</div>;
}

export function EdytorWiadomosci({ tenantId, flowId, emailId, flowName, nazwaStartowa, tematStartowy, dokumentStartowy, zrodlo, nazwaSklepu, flowStatus, wersjaStartowa }: {
  tenantId: string; flowId: string; emailId: string; flowName: string; nazwaStartowa: string; tematStartowy: string;
  dokumentStartowy: DokumentMaila; zrodlo: ZrodloDokumentu; nazwaSklepu: string; flowStatus: StatusAutomatyzacji; wersjaStartowa: number;
}) {
  // Wersja wiadomosci znana tej karcie (0026). Temat i tresc ida przez JEDNA kolejke, wiec
  // karta nie wchodzi w konflikt sama ze soba; inna karta albo osoba - tak (review #6).
  const wersja = useRef(wersjaStartowa);
  const [konflikt, setKonflikt] = useState(false);
  const [historia, setHistoria] = useState<Historia>(() => nowaHistoria(dokumentStartowy));
  const dok = historia.biezacy;
  const [zapisanyJson, setZapisanyJson] = useState(() => JSON.stringify(dokumentStartowy));
  const dokJson = useMemo(() => JSON.stringify(dok), [dok]);
  const ostatnioWyslany = useRef<string>(JSON.stringify(dokumentStartowy));
  const brudny = dokJson !== zapisanyJson || dokJson !== ostatnioWyslany.current;
  const [temat, setTemat] = useState(tematStartowy);
  const [nazwa, setNazwa] = useState(nazwaStartowa);
  const [zaznaczony, setZaznaczony] = useState<string | null>(null);
  const [widok, setWidok] = useState<Widok>("desktop");
  const [tryb, setTryb] = useState<Tryb>("edycja");
  const [zapis, setZapis] = useState<{ trwa: boolean; blad?: string; kiedy?: string }>({ trwa: false });
  const [przeciagany, setPrzeciagany] = useState<Przeciagany | null>(null);
  const [wskaznik, setWskaznik] = useState<number | null>(null);
  const [podglad, setPodglad] = useState<{ html?: string; trwa: boolean; blad?: string }>({ trwa: false });
  const [uwagiSerwera, setUwagiSerwera] = useState<string[]>([]);
  const plotnoRef = useRef<HTMLDivElement>(null);
  const mobile = widok === "mobile";

  const aktualizuj = useCallback((fn: (d: DokumentMaila) => DokumentMaila, klucz: string | null = null) => {
    setHistoria((h) => zapiszWHistorii(h, fn(h.biezacy), klucz));
    setZapis((z) => (z.blad ? { ...z, blad: undefined } : z));
  }, []);
  const dodaj = useCallback((typ: TypBloku, indeks?: number) => {
    const blok = nowyBlok(typ);
    aktualizuj((d) => { const po = zaznaczony ? d.bloki.findIndex((b) => b.id === zaznaczony) : -1; return wstawBlok(d, blok, indeks ?? (po >= 0 ? po + 1 : d.bloki.length)); });
    setZaznaczony(blok.id);
  }, [aktualizuj, zaznaczony]);
  const usun = useCallback((id: string) => { aktualizuj((d) => usunBlok(d, id)); setZaznaczony((z) => (z === id ? null : z)); }, [aktualizuj]);
  const duplikuj = useCallback((id: string) => {
    const zrodlowy = historia.biezacy.bloki.find((b) => b.id === id);
    if (!zrodlowy) return;
    const kopia = kopiaBloku(zrodlowy);
    aktualizuj((d) => { const i = d.bloki.findIndex((b) => b.id === id); return i === -1 ? d : wstawBlok(d, kopia, i + 1); });
    setZaznaczony(kopia.id);
  }, [aktualizuj, historia.biezacy]);
  const przesun = useCallback((id: string, k: -1 | 1) => aktualizuj((d) => przesunBlok(d, id, k)), [aktualizuj]);
  const zmien = useCallback((id: string, zmiany: Partial<Blok>, klucz?: string) => aktualizuj((d) => zmienBlok(d, id, zmiany), klucz ? `${id}:${klucz}` : null), [aktualizuj]);
  const zmienStyl = useCallback((z: Partial<StyleMaila>, klucz?: string) => aktualizuj((d) => ({ ...d, style: { ...d.style, ...z } }), klucz ? `styl:${klucz}` : null), [aktualizuj]);

  // zapis: kolejka, zeby odpowiedzi nie wracaly w odwrotnej kolejnosci
  const kolejka = useRef<Promise<unknown>>(Promise.resolve());
  const odrzucony = useRef<string | null>(null);
  const zapiszDokument = useCallback((dokument: DokumentMaila): Promise<boolean> => {
    const json = JSON.stringify(dokument);
    ostatnioWyslany.current = json;
    const zadanie = kolejka.current.then(async () => {
      setZapis((s) => ({ ...s, trwa: true, blad: undefined }));
      try {
        const w = await zapiszWiadomoscFlowAkcja(tenantId, flowId, emailId, json, wersja.current);
        if (!w.ok) { odrzucony.current = json; if ("konflikt" in w && w.konflikt) setKonflikt(true); setZapis({ trwa: false, blad: w.blad }); return false; }
        wersja.current = w.wersja;
        odrzucony.current = null;
        setZapisanyJson(json);
        setUwagiSerwera(w.uwagi);
        setZapis({ trwa: false, kiedy: w.zapisanoO });
        return true;
      } catch {
        odrzucony.current = json;
        setZapis({ trwa: false, blad: "Brak połączenia z serwerem: zmiany NIE zostały zapisane." });
        return false;
      }
    });
    kolejka.current = zadanie.catch(() => false);
    return zadanie;
  }, [emailId, flowId, tenantId]);
  const zapisz = useCallback(() => zapiszDokument(historia.biezacy), [historia.biezacy, zapiszDokument]);

  // autozapis 1,5 s po zmianie (jak w kampaniach); tresc wiadomosci automatyzacji nie ma
  // akceptacji klienta, wiec zapis zawsze automatyczny, takze przy wlaczonym flow
  useEffect(() => {
    if (konflikt || !brudny || zapis.trwa || dokJson === odrzucony.current) return;
    const t = setTimeout(() => void zapisz(), 1500);
    return () => clearTimeout(t);
  }, [konflikt, brudny, zapis.trwa, zapis.blad, dokJson, zapisz]);

  // temat i nazwa: zapis 800 ms po ostatniej zmianie. Zmiany AKUMULOWANE w refie: temat
  // i nazwa zmienione w <800 ms ida razem (review: timer wysylal tylko ostatnia zmiane).
  const naglowekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const naglowekCzeka = useRef<{ temat?: string; nazwa?: string }>({});
  const [naglowekZapis, setNaglowekZapis] = useState<string | null>(null);
  const wypchnijNaglowek = useCallback(async () => {
    if (naglowekTimer.current) clearTimeout(naglowekTimer.current);
    naglowekTimer.current = null;
    const z = naglowekCzeka.current;
    naglowekCzeka.current = {};
    if (!Object.keys(z).length) return;
    const zadanie = kolejka.current.then(async () => {
      try {
        const w = await zapiszNaglowekWiadomosciAkcja(tenantId, flowId, emailId, z, wersja.current);
        if (w.ok) wersja.current = w.wersja;
        else if ("konflikt" in w && w.konflikt) setKonflikt(true);
        setNaglowekZapis(w.ok ? null : w.blad);
      } catch {
        naglowekCzeka.current = { ...z, ...naglowekCzeka.current };
        setNaglowekZapis("Brak połączenia z serwerem: temat NIE został zapisany.");
      }
    });
    kolejka.current = zadanie.catch(() => undefined);
    await zadanie;
  }, [emailId, flowId, tenantId]);
  const zmienNaglowek = useCallback((z: { temat?: string; nazwa?: string }) => {
    if (z.temat !== undefined) setTemat(z.temat);
    if (z.nazwa !== undefined) setNazwa(z.nazwa);
    naglowekCzeka.current = { ...naglowekCzeka.current, ...z };
    if (naglowekTimer.current) clearTimeout(naglowekTimer.current);
    naglowekTimer.current = setTimeout(() => void wypchnijNaglowek(), 800);
  }, [wypchnijNaglowek]);
  // wyjscie na kanwe z czekajacym tematem: dopisz przed odmontowaniem
  useEffect(() => () => { void wypchnijNaglowek(); }, [wypchnijNaglowek]);

  useEffect(() => {
    if (!brudny) return;
    const przed = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", przed);
    return () => window.removeEventListener("beforeunload", przed);
  }, [brudny]);

  useEffect(() => {
    const obsluz = (e: KeyboardEvent) => {
      const cel = e.target as HTMLElement | null;
      const wPolu = Boolean(cel?.closest("input, textarea, select"));
      const wTekscie = Boolean(cel?.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "s") { e.preventDefault(); void zapisz(); return; }
      if (tryb !== "edycja") return;
      if (mod && (k === "z" || k === "y") && !wPolu) { e.preventDefault(); setHistoria((h) => (k === "y" || e.shiftKey ? ponow(h) : cofnij(h))); return; }
      if (wPolu || wTekscie) return;
      if (zaznaczony && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); usun(zaznaczony); }
      else if (zaznaczony && mod && k === "d") { e.preventDefault(); duplikuj(zaznaczony); }
      else if (e.key === "Escape") setZaznaczony(null);
    };
    window.addEventListener("keydown", obsluz);
    return () => window.removeEventListener("keydown", obsluz);
  }, [duplikuj, tryb, usun, zapisz, zaznaczony]);

  useEffect(() => {
    if (tryb !== "podglad") return;
    let aktualne = true;
    setPodglad((p) => ({ ...p, trwa: true, blad: undefined }));
    podgladWiadomosciFlowAkcja(tenantId, flowId, JSON.stringify(dok))
      .then((w) => { if (aktualne) setPodglad(w.ok ? { trwa: false, html: w.html } : { trwa: false, blad: w.blad }); })
      .catch(() => aktualne && setPodglad({ trwa: false, blad: "Nie udało się złożyć podglądu." }));
    return () => { aktualne = false; };
  }, [tryb, dok, tenantId, flowId]);

  // przeciaganie: pozycja z zywego ukladu, jak w edytorze kampanii
  const sensory = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const kolizje: CollisionDetection = useCallback((args) => {
    const trafione = pointerWithin(args);
    const miejsce = trafione.filter((c) => c.id === "wskaznik");
    if (miejsce.length) return miejsce;
    const bloki = trafione.filter((c) => String(c.id).startsWith("blok:"));
    return bloki.length ? bloki : trafione;
  }, []);
  const kursorY = useRef<number | null>(null);
  useEffect(() => {
    if (!przeciagany) { kursorY.current = null; return; }
    const ruch = (ev: PointerEvent) => { kursorY.current = ev.clientY; };
    window.addEventListener("pointermove", ruch, true);
    return () => window.removeEventListener("pointermove", ruch, true);
  }, [przeciagany]);
  const wskaznikRef = useRef<number | null>(null);
  wskaznikRef.current = wskaznik;
  const policzWskaznik = (e: DragMoveEvent): number | null => {
    if (!e.over) return null;
    const y = kursorY.current ?? (e.active.rect.current.translated?.top ?? 0) + (e.active.rect.current.translated?.height ?? 0) / 2;
    const bloki = Array.from(plotnoRef.current?.querySelectorAll<HTMLElement>("[data-blok]") ?? []);
    if (!bloki.length) return 0;
    for (let i = 0; i < bloki.length; i++) {
      const r = bloki[i].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return y < r.top + r.height / 2 ? i : i + 1;
    }
    if (y < bloki[0].getBoundingClientRect().top) return 0;
    if (y > bloki[bloki.length - 1].getBoundingClientRect().bottom) return bloki.length;
    return wskaznikRef.current ?? bloki.findIndex((el) => el.getBoundingClientRect().top > y);
  };
  const naStart = (e: DragStartEvent) => { const d = e.active.data.current as Przeciagany | undefined; if (d) setPrzeciagany(d); if (d?.zrodlo === "plotno") setZaznaczony(d.id); };
  const naRuch = (e: DragMoveEvent) => setWskaznik(policzWskaznik(e));
  const naKoniec = (e: DragEndEvent) => {
    const d = e.active.data.current as Przeciagany | undefined;
    const cel = e.over ? policzWskaznik(e as unknown as DragMoveEvent) : null;
    setPrzeciagany(null); setWskaznik(null);
    if (!d || cel === null) return;
    if (d.zrodlo === "paleta") dodaj(d.typ, cel);
    else { const z = dok.bloki.findIndex((b) => b.id === d.id); const na = cel > z ? cel - 1 : cel; if (z !== -1 && na !== z) aktualizuj((dd) => przeniesBlok(dd, z, na)); }
  };
  const indeksPrzeciaganego = przeciagany?.zrodlo === "plotno" ? dok.bloki.findIndex((b) => b.id === przeciagany.id) : -1;
  const widocznyWskaznik = wskaznik !== null && !(indeksPrzeciaganego !== -1 && (wskaznik === indeksPrzeciaganego || wskaznik === indeksPrzeciaganego + 1)) ? wskaznik : null;
  const nazwaPrzeciaganego = przeciagany ? `Upuść tutaj: ${NAZWY_BLOKOW[przeciagany.typ]}` : "";

  const uwagiDokumentu = useMemo(() => renderujDokument(dok, { dynamiczne: true }).uwagi, [dok]);
  const blokZaznaczony = dok.bloki.find((b) => b.id === zaznaczony) ?? null;
  const uwagiBloku = useMemo(() => (blokZaznaczony ? renderujDokument({ ...dok, bloki: [blokZaznaczony] }, { dynamiczne: true }).uwagi : []), [blokZaznaczony, dok]);

  const stanZapisu = zapis.trwa ? <span className="flex items-center gap-1.5 text-[var(--color-tekst-2)]"><Loader2 size={14} className="animate-spin" /> Zapisuję…</span>
    : zapis.blad ? <button type="button" onClick={() => void zapisz()} className="flex items-center gap-1.5 font-medium text-[var(--color-blad)]" role="alert"><AlertTriangle size={14} /> Nie zapisano. Ponów</button>
    : brudny ? <span className="flex items-center gap-1.5 text-[var(--color-czeka)]"><span className="h-2 w-2 rounded-full bg-[var(--color-czeka)]" /> Niezapisane zmiany</span>
    : zapis.kiedy ? <span className="flex items-center gap-1.5 text-[var(--color-tekst-2)]"><Check size={14} className="text-[var(--color-ok)]" /> Zapisano o {godzina(zapis.kiedy)}</span>
    : <span className="flex items-center gap-1.5 text-[var(--color-tekst-3)]"><Check size={14} className="text-[var(--color-ok)]" /> Wszystko zapisane</span>;
  const przyciskPaska = "grid h-8 w-8 place-items-center rounded-lg text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-tekst)] disabled:opacity-35 disabled:hover:bg-transparent";
  const segment = (aktywny: boolean) => `flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors ${aktywny ? "bg-white text-[var(--color-tekst)] shadow-[var(--cien-karta)]" : "text-[var(--color-tekst-2)] hover:text-[var(--color-tekst)]"}`;

  return (
    <DndContext id={`edytor-flow-${emailId}`} sensors={sensory} collisionDetection={kolizje} autoScroll={{ threshold: { x: 0, y: 0.08 }, acceleration: 6 }} onDragStart={naStart} onDragMove={naRuch} onDragEnd={naKoniec} onDragCancel={() => { setPrzeciagany(null); setWskaznik(null); }}>
      <header className="flex min-h-[60px] flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-linia)] bg-[var(--color-app)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <Link href={`/t/${tenantId}/automatyzacje`} className="font-medium text-[var(--color-tekst-2)] hover:text-[var(--color-akcent)]">Automatyzacje</Link>
          <span aria-hidden="true" className="text-[var(--color-tekst-3)]">/</span>
          <Link href={`/t/${tenantId}/automatyzacje/${flowId}/edytor`} className="max-w-[200px] truncate font-medium text-[var(--color-tekst-2)] hover:text-[var(--color-akcent)]">{flowName}</Link>
          <span aria-hidden="true" className="text-[var(--color-tekst-3)]">/</span>
          <input aria-label="Nazwa robocza wiadomości" value={nazwa} maxLength={200} onChange={(e) => zmienNaglowek({ nazwa: e.target.value })} className="h-8 w-[180px] rounded-md border border-transparent bg-transparent px-2 text-[16px] font-[650] hover:border-[var(--color-linia)] focus:border-[var(--color-linia-mocna)] focus:bg-white focus:outline-none" />
        </div>
        <label className="flex min-w-[260px] flex-1 items-center gap-2 text-[13px]">
          <span className="etykieta whitespace-nowrap">Temat</span>
          <input aria-label="Temat wiadomości" value={temat} maxLength={250} placeholder="to zobaczy odbiorca" onChange={(e) => zmienNaglowek({ temat: e.target.value })} className="pole !min-h-9 max-w-[420px]" />
          {naglowekZapis ? <span className="text-[12px] text-[var(--color-blad)]">{naglowekZapis}</span> : null}
        </label>
        <div className="flex items-center gap-2">
          <span className="text-[13px]">{stanZapisu}</span>
          <Link href={`/t/${tenantId}/automatyzacje/${flowId}/edytor`} className="przycisk przycisk-wtorny przycisk-maly">Wróć na kanwę</Link>
        </div>
      </header>
      <div className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-linia)] bg-[var(--color-app)] px-3 py-1.5">
        <div className="flex items-center gap-0.5">
          <button type="button" className={przyciskPaska} onClick={() => setHistoria(cofnij)} disabled={tryb !== "edycja" || !historia.przeszlosc.length} aria-label="Cofnij (Ctrl+Z)"><Undo2 size={17} /></button>
          <button type="button" className={przyciskPaska} onClick={() => setHistoria(ponow)} disabled={tryb !== "edycja" || !historia.przyszlosc.length} aria-label="Ponów"><Redo2 size={17} /></button>
        </div>
        <div className="mx-auto flex items-center gap-2 [&:has(#edytor-formatowanie:not(:empty))>.przelaczniki]:hidden">
          <div id="edytor-formatowanie" className="flex empty:hidden" />
          <div className="przelaczniki flex items-center gap-2">
            <div role="radiogroup" aria-label="Tryb" className="flex rounded-lg bg-[var(--color-powierzchnia-2)] p-0.5">
              <button type="button" role="radio" aria-checked={tryb === "edycja"} className={segment(tryb === "edycja")} onClick={() => setTryb("edycja")}><PenLine size={14} /> Edycja</button>
              <button type="button" role="radio" aria-checked={tryb === "podglad"} className={segment(tryb === "podglad")} onClick={() => setTryb("podglad")}><Eye size={14} /> Podgląd</button>
            </div>
            <div role="radiogroup" aria-label="Urządzenie" className="flex rounded-lg bg-[var(--color-powierzchnia-2)] p-0.5">
              <button type="button" role="radio" aria-checked={!mobile} className={segment(!mobile)} onClick={() => setWidok("desktop")} aria-label="Komputer"><Monitor size={15} /></button>
              <button type="button" role="radio" aria-checked={mobile} className={segment(mobile)} onClick={() => setWidok("mobile")} aria-label="Telefon"><Smartphone size={15} /></button>
            </div>
          </div>
        </div>
        {flowStatus !== "szkic" ? <span className="text-[12px] text-[var(--color-czeka)]">Zmiany zapisują się w szkicu. Ludzie dostaną nową treść dopiero po „Opublikuj zmiany” na kanwie; do tego czasu idzie wersja opublikowana.</span> : null}
      </div>
      {konflikt ? (
        <div role="alert" className="flex items-center gap-3 border-b border-[var(--color-blad-ramka)] bg-[var(--color-blad-tlo)] px-4 py-2 text-[13px] text-[var(--color-blad)]">
          <AlertTriangle size={14} />
          <span className="flex-1">Ktoś w międzyczasie zmienił tę wiadomość. Twoich ostatnich zmian NIE zapisano, żeby nie nadpisać cudzych. Odśwież stronę.</span>
          <button type="button" className="przycisk przycisk-maly" onClick={() => window.location.reload()}>Odśwież</button>
        </div>
      ) : null}
      {zapis.blad || zrodlo === "html" || zrodlo === "uszkodzony" ? (
        <div className="space-y-1 border-b border-[var(--color-linia)] bg-[var(--color-app)] px-4 py-2 text-[13px]">
          {zapis.blad ? <p role="alert" className="text-[var(--color-blad)]">{zapis.blad}</p> : null}
          {zrodlo === "html" ? <p className="text-[var(--color-tekst-2)]">Ta wiadomość powstała przed edytorem bloków. Jej HTML jest teraz blokiem „Własny HTML”.</p> : null}
          {zrodlo === "uszkodzony" ? <p className="text-[var(--color-czeka)]">Zapisany układ bloków nie przeszedł walidacji, więc pokazujemy HTML, który faktycznie wychodzi. Zapis zastąpi uszkodzony układ.</p> : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {tryb === "edycja" ? <aside className="w-[248px] shrink-0 overflow-y-auto border-r border-[var(--color-linia)] bg-[var(--color-panel)]" aria-label="Biblioteka bloków"><Biblioteka onDodaj={(t) => dodaj(t)} zablokowane={false} dynamiczne /></aside> : null}
        <main ref={plotnoRef} className="min-w-0 flex-1 overflow-y-auto bg-[#e9ecf0]" aria-label="Płótno maila">
          {tryb === "podglad" ? (
            <div className="flex min-h-full justify-center px-6 py-8">
              <div className="w-full overflow-hidden rounded-xl border border-[var(--color-linia)] bg-white shadow-[var(--cien-uniesiony)]" style={{ maxWidth: mobile ? 375 : 760 }}>
                <div className="flex items-center gap-2 border-b border-[var(--color-linia)] px-4 py-2.5 text-[12px] text-[var(--color-tekst-3)]"><Eye size={14} /> Tak dostanie to odbiorca: złożone przez silnik wysyłki, ze stopką i wypisem</div>
                {podglad.blad ? <p role="alert" className="p-6 text-[13px] text-[var(--color-blad)]">{podglad.blad}</p>
                  : podglad.html ? <iframe title="Podgląd wiadomości" srcDoc={podglad.html} sandbox="" className="block h-[calc(100vh-240px)] min-h-[520px] w-full border-0" />
                  : <div className="grid h-[520px] place-items-center text-[var(--color-tekst-3)]"><Loader2 className="animate-spin" /></div>}
              </div>
            </div>
          ) : (
            <ObszarPlotna onKlik={() => setZaznaczony(null)}>
              <div className="mx-auto transition-[width] duration-200" style={{ width: SZEROKOSC_URZADZENIA[widok] }}>
                <div className="mb-2 flex items-center justify-between px-1 text-[12px] text-[var(--color-tekst-3)]"><span>{mobile ? "Telefon · 375 px" : "Komputer · karta 560 px"}</span><span>{dok.bloki.length ? `${dok.bloki.length} ${dok.bloki.length === 1 ? "blok" : dok.bloki.length < 5 ? "bloki" : "bloków"}` : ""}</span></div>
                <div className={`shadow-[var(--cien-uniesiony)] ${mobile ? "rounded-[28px] border-[6px] border-[#1f2328]" : "rounded-lg bg-white"}`} style={{ background: SILNIK_TLO, padding: mobile ? WCIECIE_BODY : 0 }}>
                  <div className="rounded-lg bg-white" style={{ padding: SILNIK_WCIECIE }}>
                    <div style={{ background: dok.style.tloTresci, color: dok.style.kolorTekstu }} className="relative">
                      {dok.bloki.length === 0 ? (
                        <div className={`flex flex-col items-center gap-4 rounded-lg border-2 border-dashed px-4 py-10 text-center transition-colors ${wskaznik !== null ? "border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)]" : "border-[var(--color-linia-mocna)]"}`}>
                          <div><div className="text-[15px] font-semibold text-[var(--color-tekst)]">Przeciągnij tu pierwszy blok</div><p className="mt-1 text-[13px] text-[var(--color-tekst-2)]">albo zacznij od gotowego układu:</p></div>
                          <div className="grid w-full grid-cols-2 gap-2 text-left">
                            {SZABLONY.map((s) => <button key={s.id} type="button" onClick={(e) => { e.stopPropagation(); aktualizuj(() => s.zbuduj()); }} className="rounded-[10px] border border-[var(--color-linia)] bg-white px-3 py-2.5 text-left hover:border-[var(--color-akcent-ramka)]"><div className="text-[13px] font-semibold">{s.nazwa}</div><div className="text-[12px] text-[var(--color-tekst-3)]">{s.opis}</div></button>)}
                          </div>
                        </div>
                      ) : dok.bloki.map((b, i) => (
                        <div key={b.id}>
                          {widocznyWskaznik === i ? <Wskaznik nazwa={nazwaPrzeciaganego} /> : null}
                          <BlokNaPlotnie blok={b} indeks={i} liczba={dok.bloki.length} styl={dok.style} mobile={mobile} zaznaczony={zaznaczony === b.id} przeciagany={przeciagany?.zrodlo === "plotno" && przeciagany.id === b.id} onZaznacz={() => setZaznaczony(b.id)} onZmiana={(z, k) => zmien(b.id, z, k)} onUsun={() => usun(b.id)} onDuplikuj={() => duplikuj(b.id)} onPrzesun={(k) => przesun(b.id, k)} trwaPrzeciaganie={przeciagany !== null} />
                        </div>
                      ))}
                      {dok.bloki.length > 0 && widocznyWskaznik === dok.bloki.length ? <Wskaznik nazwa={nazwaPrzeciaganego} /> : null}
                    </div>
                    <div className="relative mt-8 select-none border-t border-[#e5e5e5] pt-4 text-[12px] leading-[1.6] text-[#8a8a8a]" aria-label="Stopka z wypisem doklejana przez system">
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
            {przeciagany ? <div className="pusty-stan"><h2 className="text-[14px]">Upuść blok na płótnie</h2></div>
              : blokZaznaczony ? <WlasciwosciBloku key={blokZaznaczony.id} blok={blokZaznaczony} styl={dok.style} uwagi={uwagiBloku} zmien={(z, k) => zmien(blokZaznaczony.id, z, k)} />
              : <>
                  <StyleGlobalne styl={dok.style} zmien={zmienStyl} />
                  {uwagiDokumentu.length || uwagiSerwera.length ? (
                    <section className="border-t border-[var(--color-linia)] px-4 py-4">
                      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-czeka)]"><AlertTriangle size={14} /> Do poprawy przed wysyłką</h3>
                      <ul className="mt-2 space-y-1.5 text-[12px] leading-[17px] text-[var(--color-tekst-2)]">{[...new Set([...uwagiDokumentu, ...uwagiSerwera])].slice(0, 8).map((u, i) => <li key={i}>{u}</li>)}</ul>
                    </section>
                  ) : null}
                </>}
          </aside>
        ) : null}
      </div>
      <DragOverlay dropAnimation={null}>
        {przeciagany ? <div className="flex w-max items-center gap-2 whitespace-nowrap rounded-lg border border-[var(--color-akcent-ramka)] bg-white px-3 py-2 text-[13px] font-medium text-[var(--color-akcent)] shadow-[var(--cien-uniesiony)]">{(() => { const I = IKONY_BLOKOW[przeciagany.typ]; return <I size={16} />; })()}{NAZWY_BLOKOW[przeciagany.typ]}</div> : null}
      </DragOverlay>
    </DndContext>
  );
}
