"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  AlertTriangle,
  BarChart3,
  Check,
  Loader2,
  Maximize,
  Minus,
  Pause,
  PenLine,
  Play,
  Plus,
  Power,
  Redo2,
  Undo2,
  X,
} from "lucide-react";
import {
  NAZWY_WEZLOW,
  cofnijGraf,
  nowaHistoriaGrafu,
  noweIdWezla,
  osiagalne,
  ostrzezeniaGrafu,
  ponowGraf,
  porty,
  usunWezel,
  wstawWezel,
  zapiszGraf,
  zmienWezel,
  zwalidujGraf,
  type BladGrafu,
  type Graf,
  type HistoriaGrafu,
  type Slot,
  type Wezel,
} from "../../../../../../domain/automatyzacje/graf";
import { sciezkaSvg, ulozGraf } from "../../../../../../domain/automatyzacje/uklad";
import { STATUSY, type StatusAutomatyzacji } from "../../../../../../domain/automatyzacje/statusy";
import type { StatystykiAutomatyzacji } from "../../../../../../usecases/automatyzacje/journeye";
import { opublikujAkcja, statystykiAkcja, utworzWiadomoscAkcja, zapiszNaglowekWiadomosciAkcja, zapiszSzkicAkcja, zmienNazweAkcja, zmienStatusAkcja } from "../../akcje";
import { BibliotekaKrokow, IKONY_WEZLOW, KAFELEK, KATEGORIE, type TypDoDodania } from "./biblioteka-krokow";
import { KartaWezla, PanelWezla, wysokoscWezla, type StatWezla, type Tryb } from "./wezly";

/**
 * Kanwa automatyzacji (jak flow builder Klaviyo): wyzwalacz na gorze, sciezka w dol,
 * galezie warunku obok siebie, "+" w kazdej szczelinie, biblioteka krokow po lewej,
 * konfiguracja zaznaczonego kroku po prawej.
 *
 * Graf jest JEDYNYM zrodlem prawdy (historia cofnij/ponow). Uklad liczy `ulozGraf`
 * z domeny, a kanwa tylko go rysuje. Szkic zapisuje sie sam 1,5 s po zmianie (jak
 * w edytorze kampanii); wlaczenie/publikacja czeka na domkniecie zapisu, bo bramke
 * liczy serwer na tym, co lezy w bazie.
 */

interface Emaile {
  [id: string]: { nazwa: string; temat: string; maTresc: boolean; wersja: number };
}

export interface DaneStartowe {
  name: string;
  status: StatusAutomatyzacji;
  graf: Graf;
  emaile: Emaile;
  listy: { id: string; name: string }[];
  segmenty: { id: string; name: string }[];
  bramka: BladGrafu[];
  niepublikowane: boolean;
  liveVersion: number | null;
  draftVersion: number;
}

type Stat = Omit<StatystykiAutomatyzacji, "przebiegAt"> & { przebiegAt: string | null };

const ZOOMY = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5];

function godzina(iso: string): string {
  return new Date(iso).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
}

function nowyWezel(typ: TypDoDodania, g: Graf, dane: { emailId?: string; listId?: string }): Wezel {
  const id = noweIdWezla(typ, g);
  switch (typ) {
    case "email":
      return { id, typ, emailId: dane.emailId ?? "", links: { next: null } };
    case "opoznienie":
      return { id, typ, ilosc: 1, jednostka: "dni", links: { next: null } };
    case "czekaj_do":
      return { id, typ, dni: [1, 2, 3, 4, 5], godzina: "09:00", links: { next: null } };
    case "warunek":
      return { id, typ, regula: { rodzaj: "kupil_od_wejscia" }, links: { next_if_true: null, next_if_false: null } };
    case "ab_split":
      return { id, typ, procentA: 50, links: { a: null, b: null } };
    case "profil":
      return { id, typ, akcja: { rodzaj: "dodaj_do_listy", listId: dane.listId ?? "" }, links: { next: null } };
  }
}

// ── Szczelina "+" miedzy krokami ────────────────────────────────────────────

function Szczelina({
  slot,
  x,
  y,
  otwarta,
  przeciaganie,
  onOtworz,
  onWybierz,
  blokady,
}: {
  slot: Slot;
  x: number;
  y: number;
  otwarta: boolean;
  przeciaganie: boolean;
  onOtworz: (s: Slot | null) => void;
  onWybierz: (typ: TypDoDodania | "koniec") => void;
  blokady: Partial<Record<TypDoDodania, string>>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `slot:${slot.po}:${slot.port}`, data: { slot } });
  return (
    <div ref={setNodeRef} data-slot={`${slot.po}:${slot.port}`} className="absolute z-20" style={{ left: x, top: y, transform: "translate(-50%, -50%)" }} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label="Dodaj krok w tym miejscu"
        aria-expanded={otwarta}
        onClick={() => onOtworz(otwarta ? null : slot)}
        className={`grid place-items-center rounded-full border bg-white text-[var(--color-tekst-2)] shadow-[var(--cien-karta)] transition-[width,height,border-color,color,background] ${
          przeciaganie
            ? `h-11 w-11 border-2 border-dashed ${isOver ? "border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]" : "border-[var(--color-akcent-ramka)]"}`
            : otwarta
              ? "h-7 w-7 border-[var(--color-akcent)] bg-[var(--color-akcent)] text-white"
              : "h-7 w-7 border-[var(--color-linia-mocna)] hover:border-[var(--color-akcent)] hover:text-[var(--color-akcent)]"
        }`}
      >
        <Plus size={przeciaganie ? 18 : 14} strokeWidth={2.25} />
      </button>
      {otwarta ? (
        <div role="menu" className="absolute left-1/2 top-9 z-40 w-[268px] -translate-x-1/2 rounded-[10px] border border-[var(--color-linia)] bg-white p-1.5 shadow-[var(--cien-uniesiony)]">
          {KATEGORIE.map((k) => (
            <div key={k.tytul}>
              <div className="etykieta px-2 pb-0.5 pt-1.5">{k.tytul}</div>
              {k.kroki.map((s) => {
                const I = IKONY_WEZLOW[s.typ];
                const blokada = blokady[s.typ];
                return (
                  <button key={s.typ} type="button" role="menuitem" disabled={Boolean(blokada)} title={blokada} onClick={() => onWybierz(s.typ)} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-[var(--color-akcent-tlo)] hover:text-[var(--color-akcent)] disabled:cursor-not-allowed disabled:opacity-40">
                    <span className={`grid h-7 w-7 place-items-center rounded-md ${KAFELEK[s.typ]}`}><I size={14} /></span>
                    <span className="min-w-0"><span className="block">{NAZWY_WEZLOW[s.typ]}</span><span className="block truncate text-[11px] font-normal text-[var(--color-tekst-3)]">{blokada ?? s.opis}</span></span>
                  </button>
                );
              })}
            </div>
          ))}
          <div className="mt-1 border-t border-[var(--color-linia-0)] pt-1">
            <button type="button" role="menuitem" onClick={() => onWybierz("koniec")} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] font-medium text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)]">
              <span className={`grid h-7 w-7 place-items-center rounded-md ${KAFELEK.koniec}`}><IKONY_WEZLOW.koniec size={14} /></span>
              Zakończ ścieżkę tutaj
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Kanwa ───────────────────────────────────────────────────────────────────

export function Kanwa({
  tenantId,
  flowId,
  start,
  statStart,
  waluta,
  komunikat,
}: {
  tenantId: string;
  flowId: string;
  start: DaneStartowe;
  statStart: Stat;
  waluta: string;
  komunikat: { ton: "ok" | "blad"; tekst: string } | null;
}) {
  const [historia, setHistoria] = useState<HistoriaGrafu>(() => nowaHistoriaGrafu(start.graf));
  const g = historia.biezacy;
  const [nazwa, setNazwa] = useState(start.name);
  const [status, setStatus] = useState<StatusAutomatyzacji>(start.status);
  const [emaile, setEmaile] = useState<Emaile>(start.emaile);
  const [zaznaczony, setZaznaczony] = useState<string | null>(null);
  const [tryb, setTryb] = useState<Tryb>("edycja");
  const [zoom, setZoom] = useState(1);
  const [stat, setStat] = useState<Stat>(statStart);
  const [bramkaSerwera, setBramkaSerwera] = useState<BladGrafu[]>(start.bramka);
  const [niepublikowane, setNiepublikowane] = useState(start.niepublikowane);
  const [liveVersion, setLiveVersion] = useState(start.liveVersion);
  const [menuSlot, setMenuSlot] = useState<Slot | null>(null);
  const [przeciagany, setPrzeciagany] = useState<TypDoDodania | null>(null);
  const [zapis, setZapis] = useState<{ trwa: boolean; blad?: string; kiedy?: string }>({ trwa: false });
  const [zmianaStatusu, setZmianaStatusu] = useState<StatusAutomatyzacji | null>(null);
  const [potwierdzenie, setPotwierdzenie] = useState<"szkic" | null>(null);
  const [toast, setToast] = useState<{ ton: "ok" | "blad" | "uwaga"; tekst: string } | null>(komunikat ? { ton: komunikat.ton, tekst: komunikat.tekst } : null);
  const kanwaRef = useRef<HTMLDivElement>(null);

  // ── slowniki i walidacja (lokalnie, natychmiast) ──
  const slowniki = useMemo(
    () => ({
      listy: Object.fromEntries(start.listy.map((l) => [l.id, l.name])),
      segmenty: Object.fromEntries(start.segmenty.map((s) => [s.id, s.name])),
      emaile: Object.fromEntries(Object.entries(emaile).map(([id, e]) => [id, { nazwa: e.nazwa, temat: e.temat }])),
    }),
    [start.listy, start.segmenty, emaile],
  );
  const bledy = useMemo(() => {
    const lokalne = zwalidujGraf(g, {
      emaile: Object.fromEntries(Object.entries(emaile).map(([id, e]) => [id, { temat: e.temat, maTresc: e.maTresc }])),
      listy: new Set(start.listy.map((l) => l.id)),
      segmenty: new Set(start.segmenty.map((s) => s.id)),
    }).bledy;
    // serwer moze wiedziec wiecej (np. tresc maila zapisana w innej karcie): laczymy bez duplikatow
    const klucze = new Set(lokalne.map((b) => `${b.wezelId}|${b.tresc}`));
    return [...lokalne, ...bramkaSerwera.filter((b) => !klucze.has(`${b.wezelId}|${b.tresc}`))];
  }, [g, emaile, start.listy, start.segmenty, bramkaSerwera]);
  const bledyWezla = useCallback((id: string) => bledy.filter((b) => b.wezelId === id).map((b) => b.tresc), [bledy]);
  const ostrzezenia = useMemo(() => ostrzezeniaGrafu(g), [g]);

  const uklad = useMemo(() => ulozGraf(g, (w) => wysokoscWezla(w, tryb)), [g, tryb]);
  const wezelZaznaczony = zaznaczony ? g.wezly.find((w) => w.id === zaznaczony) ?? null : null;

  const blokady: Partial<Record<TypDoDodania, string>> = useMemo(
    () => (start.listy.length ? {} : { profil: "Najpierw utwórz listę w zakładce Listy." }),
    [start.listy.length],
  );

  const statWezla = useCallback(
    (w: Wezel): StatWezla => ({
      wToku: stat.wToku[w.id] ?? 0,
      weszlo: w.typ === "wyzwalacz" ? stat.wejscia : undefined,
      zakonczeni: stat.zakonczeniPerWezel[w.id] ?? 0,
      email: w.typ === "email" ? stat.emaile[w.emailId] ?? { wyslane: 0, dostarczone: 0, klikniecia: 0, zamowien: 0, przychodMinor: stat.przebiegAt ? 0 : null } : null,
    }),
    [stat],
  );

  // ── operacje na grafie (przez historie) ──
  const aktualizuj = useCallback((fn: (d: Graf) => Graf) => {
    setHistoria((h) => zapiszGraf(h, fn(h.biezacy)));
    setZapis((z) => (z.blad ? { ...z, blad: undefined } : z));
    setBramkaSerwera([]);
  }, []);

  const pierwszySlot = useCallback((): Slot => {
    const w = zaznaczony ? g.wezly.find((x) => x.id === zaznaczony) : undefined;
    if (w && w.typ !== "koniec") return { po: w.id, port: porty(w)[0].port };
    return { po: g.start, port: "next" };
  }, [g, zaznaczony]);

  const dodajKrok = useCallback(
    async (typ: TypDoDodania | "koniec", slot: Slot) => {
      setMenuSlot(null);
      if (typ === "koniec") {
        aktualizuj((d) => {
          const k: Wezel = { id: noweIdWezla("koniec", d), typ: "koniec" };
          const nowy = wstawWezel(d, slot, k);
          const zywe = osiagalne(nowy, nowy.start);
          return { ...nowy, wezly: nowy.wezly.filter((w) => zywe.has(w.id)) };
        });
        return;
      }
      if (blokady[typ]) {
        setToast({ ton: "uwaga", tekst: blokady[typ]! });
        return;
      }
      let emailId: string | undefined;
      if (typ === "email") {
        const numer = Object.keys(emaile).length + 1;
        try {
          const w = await utworzWiadomoscAkcja(tenantId, flowId, `Mail ${numer}`);
          if (!w.ok) {
            setToast({ ton: "blad", tekst: w.blad });
            return;
          }
          emailId = w.id;
          setEmaile((e) => ({ ...e, [w.id]: { nazwa: `Mail ${numer}`, temat: "", maTresc: false, wersja: 1 } }));
          wersjeEmaili.current[w.id] = 1;
        } catch {
          setToast({ ton: "blad", tekst: "Brak połączenia z serwerem: nie udało się utworzyć wiadomości." });
          return;
        }
      }
      // wezel budowany POZA updaterem: React wola updater leniwie, wiec id nadane w nim
      // nie zdazyloby trafic do setZaznaczony (nowy krok nie bylby zaznaczony)
      const w = nowyWezel(typ, g, { emailId, listId: start.listy[0]?.id });
      aktualizuj((d) => wstawWezel(d, slot, w));
      setZaznaczony(w.id);
    },
    [aktualizuj, blokady, emaile, flowId, g, start.listy, tenantId],
  );

  const usunKrok = useCallback(
    (id: string) => {
      const w = g.wezly.find((x) => x.id === id);
      if (!w || w.typ === "wyzwalacz" || w.typ === "koniec") return;
      aktualizuj((d) => usunWezel(d, id));
      setZaznaczony((z) => (z === id ? null : z));
      setToast({ ton: "ok", tekst: `Usunięto krok „${NAZWY_WEZLOW[w.typ]}”. Ctrl+Z cofa.` });
    },
    [aktualizuj, g.wezly],
  );

  const zmienKrok = useCallback((id: string, zmiany: Partial<Wezel>) => aktualizuj((d) => zmienWezel(d, id, zmiany)), [aktualizuj]);

  // ── naglowek wiadomosci (nazwa, temat): optymistycznie + zapis z opoznieniem ──
  // Zmiany zbierane w refie per wiadomosc (temat i nazwa w <800 ms nie gubia sie nawzajem).
  // `wypchnijEmaile` wysyla wszystko, co czeka - wolane przez timer, przed publikacja i
  // przed wlaczeniem, zeby bramka serwera widziala temat, ktory operator wlasnie wpisal.
  const [konflikt, setKonflikt] = useState(false);
  const zmianyEmaili = useRef<Record<string, { nazwa?: string; temat?: string }>>({});
  // wersje wiadomosci znane tej karcie (0026): zapis i publikacja z nieaktualna = odmowa
  const wersjeEmaili = useRef<Record<string, number>>(Object.fromEntries(Object.entries(start.emaile).map(([id, e]) => [id, e.wersja])));
  const zmianyEmailiTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [emaileCzekaja, setEmaileCzekaja] = useState(false);
  const wypchnijEmaile = useCallback(async (): Promise<boolean> => {
    if (zmianyEmailiTimer.current) clearTimeout(zmianyEmailiTimer.current);
    zmianyEmailiTimer.current = null;
    const paczka = zmianyEmaili.current;
    zmianyEmaili.current = {};
    let wszystko = true;
    for (const [id, z] of Object.entries(paczka)) {
      try {
        const w = await zapiszNaglowekWiadomosciAkcja(tenantId, flowId, id, z, wersjeEmaili.current[id]);
        if (!w.ok) {
          wszystko = false;
          if ("konflikt" in w && w.konflikt) setKonflikt(true);
          setToast({ ton: "blad", tekst: w.blad });
        } else {
          wersjeEmaili.current[id] = w.wersja;
          setEmaile((e) => ({ ...e, [id]: { ...e[id], wersja: w.wersja } }));
          setNiepublikowane(w.niepublikowane);
        }
      } catch {
        wszystko = false;
        zmianyEmaili.current[id] = { ...z, ...zmianyEmaili.current[id] };
        setToast({ ton: "blad", tekst: "Brak połączenia z serwerem: temat wiadomości NIE został zapisany." });
      }
    }
    setEmaileCzekaja(Object.keys(zmianyEmaili.current).length > 0);
    return wszystko;
  }, [flowId, tenantId]);
  const zmienEmail = useCallback(
    (emailId: string, zmiany: { nazwa?: string; temat?: string }) => {
      setEmaile((e) => ({ ...e, [emailId]: { ...e[emailId], ...zmiany } }));
      zmianyEmaili.current[emailId] = { ...zmianyEmaili.current[emailId], ...zmiany };
      setEmaileCzekaja(true);
      if (zmianyEmailiTimer.current) clearTimeout(zmianyEmailiTimer.current);
      zmianyEmailiTimer.current = setTimeout(() => void wypchnijEmaile(), 800);
    },
    [wypchnijEmaile],
  );

  // ── nazwa automatyzacji: osobny zapis (duplikat nazwy nie blokuje zapisu grafu) ──
  const nazwaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bladNazwy, setBladNazwy] = useState<string | null>(null);
  const zmienNazwe = useCallback((wartosc: string) => {
    setNazwa(wartosc);
    if (nazwaTimer.current) clearTimeout(nazwaTimer.current);
    nazwaTimer.current = setTimeout(async () => {
      try {
        const w = await zmienNazweAkcja(tenantId, flowId, wartosc);
        setBladNazwy(w.ok ? null : w.blad);
      } catch {
        setBladNazwy("Brak połączenia z serwerem: nazwa NIE została zapisana.");
      }
    }, 800);
  }, [flowId, tenantId]);

  // ── autozapis szkicu (optymistyczna wspolbieznosc: draft_version) ──
  const wersjaSzkicu = useRef(start.draftVersion);
  const zapisanyJson = useRef(JSON.stringify(start.graf));
  const ostatnioWyslany = useRef(zapisanyJson.current);
  const biezacyJson = useMemo(() => JSON.stringify(g), [g]);
  const brudny = biezacyJson !== zapisanyJson.current || biezacyJson !== ostatnioWyslany.current;
  const kolejka = useRef<Promise<unknown>>(Promise.resolve());
  const odrzucony = useRef<string | null>(null);
  const zapiszTeraz = useCallback((): Promise<boolean> => {
    const json = biezacyJson;
    ostatnioWyslany.current = json;
    const zadanie = kolejka.current.then(async () => {
      setZapis((z) => ({ ...z, trwa: true, blad: undefined }));
      try {
        const w = await zapiszSzkicAkcja(tenantId, flowId, json, wersjaSzkicu.current);
        if (!w.ok) {
          odrzucony.current = json;
          if (w.konflikt) setKonflikt(true);
          setZapis({ trwa: false, blad: w.blad });
          return false;
        }
        odrzucony.current = null;
        zapisanyJson.current = json;
        wersjaSzkicu.current = w.draftVersion;
        setBramkaSerwera(w.bramka);
        setNiepublikowane(w.niepublikowane);
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
  }, [biezacyJson, flowId, tenantId]);

  useEffect(() => {
    if (konflikt || !brudny || zapis.trwa || biezacyJson === odrzucony.current) return;
    const t = setTimeout(() => void zapiszTeraz(), 1500);
    return () => clearTimeout(t);
  }, [konflikt, brudny, zapis.trwa, zapis.blad, biezacyJson, zapiszTeraz]);

  useEffect(() => {
    if (!brudny && !emaileCzekaja) return;
    const przed = (e: BeforeUnloadEvent) => {
      // zmiany tematu czekajace na timer: proba dopisania w tle, a przegladarka i tak pyta
      if (Object.keys(zmianyEmaili.current).length) void wypchnijEmaile();
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", przed);
    return () => window.removeEventListener("beforeunload", przed);
  }, [brudny, emaileCzekaja, wypchnijEmaile]);

  // ── statystyki na zywo: liczniki bez przychodu (przychod tylko przy ladowaniu strony) ──
  useEffect(() => {
    let aktywne = true;
    const odswiez = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const s = await statystykiAkcja(tenantId, flowId);
        if (!aktywne || !s) return;
        setStat((poprzednie) => {
          const emaileScalone: Stat["emaile"] = {};
          for (const [id, e] of Object.entries(s.emaile)) {
            const stare = poprzednie.emaile[id];
            emaileScalone[id] = { ...e, zamowien: e.zamowien ?? stare?.zamowien ?? 0, przychodMinor: e.przychodMinor !== undefined ? e.przychodMinor : stare?.przychodMinor ?? (poprzednie.przebiegAt ? 0 : null) };
          }
          return { ...s, emaile: emaileScalone, przebiegAt: poprzednie.przebiegAt };
        });
      } catch {
        /* chwilowy brak polaczenia: zostaja poprzednie liczby */
      }
    };
    const i = setInterval(odswiez, tryb === "analityka" ? 10_000 : 30_000);
    return () => { aktywne = false; clearInterval(i); };
  }, [flowId, tenantId, tryb]);

  // ── status i publikacja ──
  const przygotujPublikacje = useCallback(async (): Promise<boolean> => {
    if (!(await wypchnijEmaile())) return false;
    if (brudny && !(await zapiszTeraz())) {
      setToast({ ton: "blad", tekst: "Najpierw musi się udać zapis szkicu." });
      return false;
    }
    return true;
  }, [brudny, wypchnijEmaile, zapiszTeraz]);

  const zmienStatus = useCallback(
    async (docelowy: StatusAutomatyzacji | "opublikuj") => {
      setPotwierdzenie(null);
      setZmianaStatusu(docelowy === "opublikuj" ? "wlaczony" : docelowy);
      try {
        const publikacja = docelowy === "opublikuj" || (docelowy === "wlaczony" && status === "szkic");
        if (publikacja && !(await przygotujPublikacje())) return;
        const widziane = { draft: wersjaSzkicu.current, emaile: { ...wersjeEmaili.current } };
        const w = docelowy === "opublikuj" ? await opublikujAkcja(tenantId, flowId, widziane) : await zmienStatusAkcja(tenantId, flowId, docelowy, widziane);
        if (!w.ok) {
          if (w.bledy) setBramkaSerwera(w.bledy);
          setToast({ ton: "blad", tekst: w.blad });
          return;
        }
        setStatus(w.status as StatusAutomatyzacji);
        if (publikacja) {
          setNiepublikowane(false);
          setLiveVersion(w.wersja);
        }
        setToast({ ton: "ok", tekst: w.komunikat });
      } catch {
        setToast({ ton: "blad", tekst: "Brak połączenia z serwerem: status NIE został zmieniony." });
      } finally {
        setZmianaStatusu(null);
      }
    },
    [flowId, przygotujPublikacje, status, tenantId],
  );

  // ── klawiatura ──
  useEffect(() => {
    const obsluz = (e: KeyboardEvent) => {
      const cel = e.target as HTMLElement | null;
      if (cel?.closest("input, textarea, select, [contenteditable=true]")) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "s") { e.preventDefault(); void zapiszTeraz(); return; }
      if (mod && (k === "z" || k === "y")) { e.preventDefault(); setHistoria((h) => (k === "y" || e.shiftKey ? ponowGraf(h) : cofnijGraf(h))); return; }
      if (zaznaczony && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); usunKrok(zaznaczony); }
      else if (e.key === "Escape") { setZaznaczony(null); setMenuSlot(null); }
    };
    window.addEventListener("keydown", obsluz);
    return () => window.removeEventListener("keydown", obsluz);
  }, [usunKrok, zapiszTeraz, zaznaczony]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── zoom: przyciski i Ctrl+kolko ──
  const zoomuj = useCallback((kierunek: 1 | -1) => {
    setZoom((z) => {
      const i = ZOOMY.findIndex((x) => Math.abs(x - z) < 0.001);
      const cel = i === -1 ? 1 : ZOOMY[Math.max(0, Math.min(ZOOMY.length - 1, i + kierunek))];
      return cel;
    });
  }, []);
  useEffect(() => {
    const el = kanwaRef.current;
    if (!el) return;
    const kolko = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomuj(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", kolko, { passive: false });
    return () => el.removeEventListener("wheel", kolko);
  }, [zoomuj]);
  const dopasuj = useCallback(() => {
    const el = kanwaRef.current;
    if (!el) return;
    const z = Math.min(1, (el.clientWidth - 48) / uklad.szerokosc, (el.clientHeight - 48) / uklad.wysokosc);
    setZoom(Math.max(0.5, Math.round(z * 100) / 100));
    el.scrollTo({ left: 0, top: 0 });
  }, [uklad.szerokosc, uklad.wysokosc]);

  // przewijanie kanwy przeciaganiem tla (pan)
  const pan = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const naPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-wezel], button, a, input, [role=menu]")) return;
    const el = kanwaRef.current!;
    pan.current = { x: e.clientX, y: e.clientY, sx: el.scrollLeft, sy: el.scrollTop };
  };
  const naPointerMove = (e: React.PointerEvent) => {
    if (!pan.current) return;
    const el = kanwaRef.current!;
    el.scrollLeft = pan.current.sx - (e.clientX - pan.current.x);
    el.scrollTop = pan.current.sy - (e.clientY - pan.current.y);
  };
  const naPointerUp = () => { pan.current = null; };

  // ── przeciaganie z biblioteki na szczeline ──
  const sensory = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const naStart = (e: DragStartEvent) => {
    const d = e.active.data.current as { zrodlo: string; typ: TypDoDodania } | undefined;
    if (d?.zrodlo === "paleta") { setPrzeciagany(d.typ); setMenuSlot(null); }
  };
  const naKoniec = (e: DragEndEvent) => {
    const typ = przeciagany;
    setPrzeciagany(null);
    const slot = (e.over?.data.current as { slot?: Slot } | undefined)?.slot;
    if (typ && slot) void dodajKrok(typ, slot);
  };

  // ── rendering ──
  const stan = STATUSY[status];
  const wToku = Object.values(stat.wToku).reduce((s, n) => s + n, 0);
  const pierwszyBlad = bledy[0]?.tresc ?? null;
  const powodBlokadyWlaczenia = pierwszyBlad ? (bledy.length > 1 ? `${pierwszyBlad} (+${bledy.length - 1})` : pierwszyBlad) : zapis.blad ? "Najpierw musi się udać zapis szkicu." : null;
  const stanZapisu = zapis.trwa ? (
    <span className="flex items-center gap-1.5 text-[var(--color-tekst-2)]"><Loader2 size={14} className="animate-spin" /> Zapisuję…</span>
  ) : zapis.blad ? (
    <button type="button" onClick={() => void zapiszTeraz()} className="flex items-center gap-1.5 font-medium text-[var(--color-blad)]" role="alert"><AlertTriangle size={14} /> Nie zapisano. Ponów</button>
  ) : brudny ? (
    <span className="flex items-center gap-1.5 text-[var(--color-czeka)]"><span className="h-2 w-2 rounded-full bg-[var(--color-czeka)]" /> Niezapisane zmiany</span>
  ) : zapis.kiedy ? (
    <span className="flex items-center gap-1.5 text-[var(--color-tekst-2)]"><Check size={14} className="text-[var(--color-ok)]" /> Zapisano o {godzina(zapis.kiedy)}</span>
  ) : (
    <span className="flex items-center gap-1.5 text-[var(--color-tekst-3)]"><Check size={14} className="text-[var(--color-ok)]" /> Szkic zapisany</span>
  );
  const segment = (aktywny: boolean) => `flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors ${aktywny ? "bg-white text-[var(--color-tekst)] shadow-[var(--cien-karta)]" : "text-[var(--color-tekst-2)] hover:text-[var(--color-tekst)]"}`;
  const trwa = zmianaStatusu !== null;

  return (
    <DndContext id={`kanwa-${flowId}`} sensors={sensory} collisionDetection={pointerWithin} onDragStart={naStart} onDragEnd={naKoniec} onDragCancel={() => setPrzeciagany(null)}>
      <div className="-mx-4 flex h-screen flex-col bg-[var(--color-app)] md:-mx-8">
        {/* Pasek gorny */}
        <header className="flex min-h-[60px] flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-linia)] bg-[var(--color-app)] px-4 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <Link href={`/t/${tenantId}/automatyzacje`} className="text-[13px] font-medium text-[var(--color-tekst-2)] hover:text-[var(--color-akcent)]">Automatyzacje</Link>
            <span aria-hidden="true" className="text-[var(--color-tekst-3)]">/</span>
            <input
              aria-label="Nazwa automatyzacji"
              value={nazwa}
              maxLength={200}
              onChange={(e) => zmienNazwe(e.target.value)}
              className="h-9 min-w-[160px] max-w-[360px] rounded-md border border-transparent bg-transparent px-2 text-[18px] font-[650] leading-[26px] tracking-[-0.012em] hover:border-[var(--color-linia)] focus:border-[var(--color-linia-mocna)] focus:bg-white focus:outline-none"
              style={{ width: `${Math.max(12, Math.min(40, nazwa.length + 2))}ch` }}
            />
            {bladNazwy ? <span role="alert" className="max-w-[28ch] text-[12px] leading-4 text-[var(--color-blad)]">{bladNazwy}</span> : null}
            <span className={`plakietka plakietka-${stan.ton}`}>{stan.etykieta}</span>
            {status !== "szkic" && niepublikowane ? <span className="text-[12px] text-[var(--color-czeka)]">szkic różni się od wersji {liveVersion}</span> : null}
          </div>

          <div className="mx-auto flex items-center gap-2">
            <div role="radiogroup" aria-label="Tryb" className="flex rounded-lg bg-[var(--color-powierzchnia-2)] p-0.5">
              <button type="button" role="radio" aria-checked={tryb === "edycja"} className={segment(tryb === "edycja")} onClick={() => setTryb("edycja")}><PenLine size={14} /> Edycja</button>
              <button type="button" role="radio" aria-checked={tryb === "analityka"} className={segment(tryb === "analityka")} onClick={() => { setTryb("analityka"); setMenuSlot(null); }}><BarChart3 size={14} /> Analityka</button>
            </div>
            <span className="text-[13px]">{stanZapisu}</span>
          </div>

          <div className="flex items-center gap-2">
            {status !== "szkic" && niepublikowane ? (
              <span className="inline-flex items-center gap-2">
                <button type="button" className="przycisk przycisk-maly" disabled={trwa || Boolean(powodBlokadyWlaczenia)} onClick={() => void zmienStatus("opublikuj")} title="Szkic (kroki i treści maili) stanie się nową wersją. Osoby w toku kończą na swojej.">{zmianaStatusu === "wlaczony" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Opublikuj zmiany</button>
                {powodBlokadyWlaczenia ? <span className="max-w-[28ch] text-[12px] leading-[16px] text-[var(--color-tekst-2)]">{powodBlokadyWlaczenia}</span> : null}
              </span>
            ) : null}
            {status === "wlaczony" ? (
              <>
                <button type="button" className="przycisk przycisk-wtorny przycisk-maly" disabled={trwa} onClick={() => void zmienStatus("wstrzymany")}><Pause size={14} /> Wstrzymaj</button>
                <button type="button" className="przycisk przycisk-wtorny przycisk-maly" disabled={trwa} onClick={() => setPotwierdzenie("szkic")}><Power size={14} /> Wyłącz</button>
              </>
            ) : status === "wstrzymany" ? (
              <>
                {/* Wznowienie nie publikuje szkicu i nie zalezy od jego bledow: rusza wersje, ktora juz dziala. */}
                <button type="button" className={`przycisk przycisk-maly ${niepublikowane ? "przycisk-wtorny" : ""}`} disabled={trwa} onClick={() => void zmienStatus("wlaczony")} title={`Wznawia wersję ${liveVersion ?? ""} bez zmian ze szkicu`}>{zmianaStatusu === "wlaczony" && !niepublikowane ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Wznów</button>
                <button type="button" className="przycisk przycisk-wtorny przycisk-maly" disabled={trwa} onClick={() => setPotwierdzenie("szkic")}><Power size={14} /> Wyłącz</button>
              </>
            ) : (
              <span className="inline-flex items-center gap-2">
                <button type="button" className="przycisk przycisk-maly" disabled={trwa || Boolean(powodBlokadyWlaczenia)} onClick={() => void zmienStatus("wlaczony")} title={powodBlokadyWlaczenia ?? undefined}>{zmianaStatusu === "wlaczony" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Włącz</button>
                {powodBlokadyWlaczenia ? <span className="max-w-[30ch] text-[12px] leading-[16px] text-[var(--color-tekst-2)]">{powodBlokadyWlaczenia}</span> : null}
              </span>
            )}
          </div>
        </header>

        {konflikt ? (
          <div role="alert" className="flex items-center gap-3 border-b border-[var(--color-blad-ramka)] bg-[var(--color-blad-tlo)] px-4 py-2 text-[13px] text-[var(--color-blad)]">
            <AlertTriangle size={14} />
            <span className="flex-1">Ktoś w międzyczasie zmienił tę automatyzację. Twoich ostatnich zmian NIE zapisano, żeby nie nadpisać cudzych. Odśwież stronę.</span>
            <button type="button" className="przycisk przycisk-maly" onClick={() => window.location.reload()}>Odśwież</button>
          </div>
        ) : null}
        {toast ? (
          <div role="status" className={`flex items-center gap-2 border-b px-4 py-2 text-[13px] ${toast.ton === "blad" ? "border-[var(--color-blad-ramka)] bg-[var(--color-blad-tlo)] text-[var(--color-blad)]" : toast.ton === "uwaga" ? "border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] text-[var(--color-czeka)]" : "border-[var(--color-ok-ramka)] bg-[var(--color-ok-tlo)] text-[var(--color-ok)]"}`}>
            <span className="flex-1">{toast.tekst}</span>
            <button type="button" onClick={() => setToast(null)} aria-label="Zamknij" className="grid h-6 w-6 place-items-center rounded-md hover:bg-white/60"><X size={14} /></button>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          {tryb === "edycja" ? (
            <aside className="w-[248px] shrink-0 overflow-y-auto border-r border-[var(--color-linia)] bg-[var(--color-panel)]" aria-label="Biblioteka kroków">
              <BibliotekaKrokow onDodaj={(typ) => void dodajKrok(typ, pierwszySlot())} blokady={blokady} />
            </aside>
          ) : null}

          <main
            ref={kanwaRef}
            aria-label="Kanwa automatyzacji"
            className="relative min-w-0 flex-1 cursor-grab overflow-auto active:cursor-grabbing"
            style={{ backgroundColor: "#f6f7f9", backgroundImage: "radial-gradient(#cfd4db 1px, transparent 1.2px)", backgroundSize: "22px 22px" }}
            onClick={() => { setZaznaczony(null); setMenuSlot(null); }}
            onPointerDown={naPointerDown}
            onPointerMove={naPointerMove}
            onPointerUp={naPointerUp}
            onPointerLeave={naPointerUp}
          >
            <div className="flex min-h-full min-w-full justify-center">
             <div className="shrink-0" style={{ width: uklad.szerokosc * zoom, height: uklad.wysokosc * zoom }}>
              <div className="relative" style={{ width: uklad.szerokosc, height: uklad.wysokosc, transform: `scale(${zoom})`, transformOrigin: "0 0" }}>
                <svg className="pointer-events-none absolute inset-0" width={uklad.szerokosc} height={uklad.wysokosc} aria-hidden="true">
                  {uklad.krawedzie.map((k) => (
                    <path key={`${k.od}:${k.port}`} d={sciezkaSvg(k.punkty)} fill="none" stroke="#b8bec8" strokeWidth={1.5} />
                  ))}
                </svg>
                {uklad.krawedzie.map((k) =>
                  k.etykieta && k.etykietaPunkt ? (
                    <span
                      key={`et:${k.od}:${k.port}`}
                      className={`absolute z-10 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[12px] font-semibold ${k.port === "next_if_true" || k.port === "a" ? "border-[var(--color-ok-ramka)] bg-[var(--color-ok-tlo)] text-[var(--color-ok)]" : "border-[var(--color-linia-mocna)] bg-white text-[var(--color-tekst-2)]"}`}
                      style={{ left: k.etykietaPunkt.x, top: k.etykietaPunkt.y, transform: "translate(-50%, -50%)" }}
                    >
                      {k.etykieta}
                      <span className="liczba ml-1 font-medium opacity-75" title="Tyle osób poszło tą gałęzią">· {stat.galezie?.[`${k.od}:${k.do}`] ?? 0}</span>
                    </span>
                  ) : null,
                )}
                {uklad.wezly.map((p) => {
                  const w = g.wezly.find((x) => x.id === p.id)!;
                  const b = bledyWezla(w.id);
                  return (
                    <div key={p.id} className="absolute" style={{ left: p.x, top: p.y, width: p.w, height: p.h }}>
                      <KartaWezla
                        wezel={w}
                        slowniki={slowniki}
                        zaznaczony={zaznaczony === w.id}
                        tryb={tryb}
                        stat={statWezla(w)}
                        blad={b[0] ?? null}
                        waluta={waluta}
                        onZaznacz={() => { setZaznaczony(w.id); setMenuSlot(null); }}
                        onUsun={w.typ === "wyzwalacz" || w.typ === "koniec" ? null : () => usunKrok(w.id)}
                      />
                    </div>
                  );
                })}
                {tryb === "edycja"
                  ? uklad.krawedzie.map((k) => (
                      <Szczelina
                        key={`sl:${k.od}:${k.port}`}
                        slot={{ po: k.od, port: k.port }}
                        x={k.slot.x}
                        y={k.slot.y}
                        otwarta={menuSlot?.po === k.od && menuSlot?.port === k.port}
                        przeciaganie={przeciagany !== null}
                        onOtworz={setMenuSlot}
                        onWybierz={(typ) => void dodajKrok(typ, { po: k.od, port: k.port })}
                        blokady={blokady}
                      />
                    ))
                  : null}
              </div>
             </div>
            </div>

            {/* Sterowanie kanwa (prawy dolny rog, jak w Klaviyo) */}
            <div className="sticky bottom-4 float-right mr-4 flex flex-col items-center gap-1 rounded-lg border border-[var(--color-linia)] bg-white p-1 shadow-[var(--cien-uniesiony)]" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
              <button type="button" onClick={() => setHistoria(cofnijGraf)} disabled={!historia.przeszlosc.length} aria-label="Cofnij (Ctrl+Z)" title="Cofnij (Ctrl+Z)" className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] disabled:opacity-30"><Undo2 size={16} /></button>
              <button type="button" onClick={() => setHistoria(ponowGraf)} disabled={!historia.przyszlosc.length} aria-label="Ponów (Ctrl+Shift+Z)" title="Ponów" className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] disabled:opacity-30"><Redo2 size={16} /></button>
              <span className="my-0.5 h-px w-6 bg-[var(--color-linia)]" />
              <button type="button" onClick={() => zoomuj(1)} aria-label="Powiększ" title="Powiększ (Ctrl + kółko)" className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)]"><Plus size={16} /></button>
              <span className="liczba text-[11px] text-[var(--color-tekst-3)]">{Math.round(zoom * 100)}%</span>
              <button type="button" onClick={() => zoomuj(-1)} aria-label="Pomniejsz" title="Pomniejsz" className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)]"><Minus size={16} /></button>
              <button type="button" onClick={dopasuj} aria-label="Dopasuj do okna" title="Dopasuj do okna" className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)]"><Maximize size={15} /></button>
            </div>
          </main>

          <aside className="w-[312px] shrink-0 overflow-y-auto border-l border-[var(--color-linia)] bg-[var(--color-app)]" aria-label="Właściwości">
            {przeciagany ? (
              <div className="pusty-stan"><h2 className="text-[14px]">Upuść krok na „+”</h2><p className="text-[13px]">Każda szczelina między krokami przyjmie nowy krok.</p></div>
            ) : wezelZaznaczony ? (
              <PanelWezla
                key={wezelZaznaczony.id}
                wezel={wezelZaznaczony}
                slowniki={slowniki}
                listy={start.listy}
                segmenty={start.segmenty}
                emaile={emaile}
                bledy={bledyWezla(wezelZaznaczony.id)}
                ostrzezenia={ostrzezenia.filter((o) => o.wezelId === wezelZaznaczony.id).map((o) => o.tresc)}
                tenantId={tenantId}
                flowId={flowId}
                stat={statWezla(wezelZaznaczony)}
                onZmiana={(z) => zmienKrok(wezelZaznaczony.id, z)}
                onZmianaEmaila={zmienEmail}
                onUsun={wezelZaznaczony.typ === "wyzwalacz" || wezelZaznaczony.typ === "koniec" ? null : () => usunKrok(wezelZaznaczony.id)}
              />
            ) : (
              <div>
                <section className="border-b border-[var(--color-linia-0)] px-4 py-4">
                  <h3 className="mb-3 text-[13px] font-semibold">Ta automatyzacja</h3>
                  <dl className="grid grid-cols-2 gap-2 text-[13px]">
                    <div className="rounded-md bg-[var(--color-powierzchnia-2)] px-3 py-2"><dt className="etykieta">W toku</dt><dd className="liczba text-[16px] font-semibold">{wToku}</dd></div>
                    <div className="rounded-md bg-[var(--color-powierzchnia-2)] px-3 py-2"><dt className="etykieta">Weszło łącznie</dt><dd className="liczba text-[16px] font-semibold">{stat.wejscia}</dd></div>
                    <div className="rounded-md bg-[var(--color-powierzchnia-2)] px-3 py-2"><dt className="etykieta">Zakończyło</dt><dd className="liczba text-[16px] font-semibold">{stat.zakonczyli}</dd></div>
                    <div className="rounded-md bg-[var(--color-powierzchnia-2)] px-3 py-2"><dt className="etykieta">Wyszło wcześniej</dt><dd className="liczba text-[16px] font-semibold">{stat.wyszli + stat.przerwani}</dd></div>
                  </dl>
                  <p className="mt-2 text-[12px] leading-4 text-[var(--color-tekst-3)]">Liczby odświeżają się co 10 s. Przychód w trybie analityki pochodzi z ostatniego przeliczenia atrybucji{stat.przebiegAt ? "" : " (jeszcze go nie było)"}.</p>
                </section>
                <section className="border-b border-[var(--color-linia-0)] px-4 py-4">
                  <h3 className="mb-3 text-[13px] font-semibold">Reguły wyjścia</h3>
                  <label className="flex items-start gap-2.5 text-[13px] leading-5">
                    <input type="checkbox" className="mt-1 accent-[var(--color-akcent)]" checked={g.ustawienia.wyjsciePoZakupie} onChange={(e) => aktualizuj((d) => ({ ...d, ustawienia: { ...d.ustawienia, wyjsciePoZakupie: e.target.checked } }))} />
                    <span>Osoba, która kupi po wejściu, wychodzi z automatyzacji<span className="block text-[12px] text-[var(--color-tekst-3)]">Do win-backu i przypomnień. Wypis ze zgód zawsze kończy ścieżkę na kroku e-mail.</span></span>
                  </label>
                </section>
                {ostrzezenia.length ? (
                  <section className="border-b border-[var(--color-linia-0)] px-4 py-4">
                    <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-czeka)]"><AlertTriangle size={14} /> Uwagi (nie blokują włączenia)</h3>
                    <ul className="space-y-1.5 text-[12px] leading-4 text-[var(--color-tekst-2)]">
                      {ostrzezenia.map((o, i) => <li key={i}><button type="button" className="text-left underline decoration-dotted underline-offset-2 hover:text-[var(--color-akcent)]" onClick={() => o.wezelId && setZaznaczony(o.wezelId)}>{o.tresc}</button></li>)}
                    </ul>
                  </section>
                ) : null}
                <section className="px-4 py-4">
                  <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
                    {bledy.length ? <><AlertTriangle size={14} className="text-[var(--color-czeka)]" /> Do poprawy przed włączeniem</> : <><Check size={14} className="text-[var(--color-ok)]" /> Gotowa do włączenia</>}
                  </h3>
                  {bledy.length ? (
                    <ul className="space-y-1.5 text-[12px] leading-4 text-[var(--color-tekst-2)]">
                      {bledy.slice(0, 8).map((b, i) => (
                        <li key={i}>
                          {b.wezelId ? <button type="button" className="text-left underline decoration-dotted underline-offset-2 hover:text-[var(--color-akcent)]" onClick={() => setZaznaczony(b.wezelId)}>{b.tresc}</button> : b.tresc}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[12px] leading-4 text-[var(--color-tekst-3)]">Każda gałąź kończy się końcem, każdy mail ma temat i treść, graf nie zawraca.</p>
                  )}
                </section>
              </div>
            )}
          </aside>
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {przeciagany ? (
          <div className="flex w-max items-center gap-2 whitespace-nowrap rounded-lg border border-[var(--color-akcent-ramka)] bg-white px-3 py-2 text-[13px] font-medium text-[var(--color-akcent)] shadow-[var(--cien-uniesiony)]">
            {(() => { const I = IKONY_WEZLOW[przeciagany]; return <I size={16} />; })()}
            {NAZWY_WEZLOW[przeciagany]}
          </div>
        ) : null}
      </DragOverlay>

      {potwierdzenie ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(16,24,40,0.45)] p-6" role="dialog" aria-modal="true" aria-label="Wyłączyć automatyzację?" onClick={() => setPotwierdzenie(null)}>
          <div className="w-full max-w-[440px] rounded-xl bg-white p-5 shadow-[var(--cien-uniesiony)]" onClick={(e) => e.stopPropagation()}>
            <h2>Wyłączyć automatyzację?</h2>
            <p className="mt-2 text-[13px] leading-5 text-[var(--color-tekst-2)]">
              {wToku ? <>{wToku} os. w toku zakończy ścieżkę od razu i nie dostanie kolejnych maili. </> : null}
              Wyłączona automatyzacja wraca do szkicu; po ponownym włączeniu reaguje tylko na nowe zdarzenia. Wolisz przerwę bez utraty osób w toku? Użyj „Wstrzymaj”.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={() => setPotwierdzenie(null)}>Anuluj</button>
              <button type="button" className="przycisk przycisk-niebezpieczny przycisk-maly" onClick={() => void zmienStatus("szkic")}>Wyłącz</button>
            </div>
          </div>
        </div>
      ) : null}
    </DndContext>
  );
}
