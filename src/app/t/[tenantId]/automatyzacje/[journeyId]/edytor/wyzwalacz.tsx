"use client";

import { Plus, Trash2 } from "lucide-react";
import {
  kluczMetryki,
  etykietaMetryki,
  zdarzenieV1,
  type PonowneWejscie,
  type ZrodloWyzwalacza,
} from "../../../../../../domain/automatyzacje/graf";
import {
  BEZ_WARTOSCI,
  ETYKIETY_OPERATOROW,
  ETYKIETY_TYPOW,
  OPERATORY,
  TYPY_POL,
  bladWartosci,
  type Filtr,
  type TypPola,
  type Warunek,
} from "../../../../../../domain/filtry";

/**
 * Minimalny UI wyzwalacza (E4a): metryka albo lista, prosty edytor filtra wyzwalacza
 * (grupy laczone "i", warunki w grupie "lub", jak w Klaviyo) i wybor ponownego wejscia.
 * Pelny EdytorFiltra (katalog wlasciwosci, filtr profilu, splity) to E4b (4.11).
 */

export interface MetrykaDoWyboru {
  integracja: string;
  nazwa: string;
  canTrigger: boolean;
  etykieta: string;
}

type WarunekZdarzenia = Extract<Warunek, { typ: "wlasciwosc_zdarzenia" }>;

function domyslnaWartosc(typ: TypPola, operator: string): WarunekZdarzenia["wartosc"] {
  if (BEZ_WARTOSCI.has(operator)) return undefined;
  if (typ === "number") return operator === "miedzy" ? [0, 100] : 0;
  if (typ === "date") return operator === "w_ostatnich_dniach" ? 30 : operator === "miedzy" ? ["2026-01-01", "2026-12-31"] : "2026-01-01";
  if (typ === "string" && (operator === "jest_w" || operator === "nie_jest_w")) return [""];
  return "";
}

function nowyWarunek(): WarunekZdarzenia {
  return { typ: "wlasciwosc_zdarzenia", pole: "", typPola: "string", operator: "rowna", wartosc: "" };
}

function PoleWartosci({ w, onZmiana }: { w: WarunekZdarzenia; onZmiana: (x: WarunekZdarzenia["wartosc"]) => void }) {
  if (BEZ_WARTOSCI.has(w.operator)) return null;
  const x = w.wartosc;
  if (w.operator === "miedzy") {
    const [a, b] = (Array.isArray(x) ? x : ["", ""]) as (string | number)[];
    const typ = w.typPola === "number" ? "number" : "text";
    const konw = (v: string) => (w.typPola === "number" ? Number(v) : v);
    return (
      <div className="grid grid-cols-2 gap-1.5">
        <input className="pole" type={typ} aria-label="od" value={String(a ?? "")} onChange={(e) => onZmiana([konw(e.target.value), b] as WarunekZdarzenia["wartosc"])} />
        <input className="pole" type={typ} aria-label="do" value={String(b ?? "")} onChange={(e) => onZmiana([a, konw(e.target.value)] as WarunekZdarzenia["wartosc"])} />
      </div>
    );
  }
  if (w.operator === "jest_w" || w.operator === "nie_jest_w") {
    return (
      <input
        className="pole"
        aria-label="wartości po przecinku"
        placeholder="wartości po przecinku"
        value={Array.isArray(x) ? x.join(", ") : ""}
        onChange={(e) => onZmiana(e.target.value.split(",").map((v) => v.trim()).filter((v, i, t) => v || t.length === 1))}
      />
    );
  }
  if (w.typPola === "number" || w.operator === "w_ostatnich_dniach") {
    return <input className="pole" type="number" aria-label="wartość" value={typeof x === "number" ? x : 0} onChange={(e) => onZmiana(Number(e.target.value))} />;
  }
  if (w.typPola === "list") {
    return <input className="pole" aria-label="element listy" placeholder="element listy" value={typeof x === "string" || typeof x === "number" ? String(x) : ""} onChange={(e) => onZmiana(e.target.value)} />;
  }
  return <input className="pole" aria-label="wartość" placeholder={w.typPola === "date" ? "RRRR-MM-DD" : "wartość (wielkość liter ma znaczenie)"} value={typeof x === "string" ? x : ""} onChange={(e) => onZmiana(e.target.value)} />;
}

export function EdytorFiltraWyzwalacza({ filtr, onZmiana }: { filtr: Filtr | undefined; onZmiana: (f: Filtr | undefined) => void }) {
  const grupy = filtr?.grupy ?? [];
  const ustaw = (nowe: Filtr["grupy"]) => onZmiana(nowe.length ? { grupy: nowe } : undefined);
  const zmienWarunek = (gi: number, wi: number, zmiany: Partial<WarunekZdarzenia>) =>
    ustaw(grupy.map((g, i) => (i !== gi ? g : { warunki: g.warunki.map((w, j) => (j !== wi ? w : ({ ...w, ...zmiany } as Warunek))) })));
  const usunWarunek = (gi: number, wi: number) =>
    ustaw(grupy.map((g, i) => (i !== gi ? g : { warunki: g.warunki.filter((_, j) => j !== wi) })).filter((g) => g.warunki.length));

  return (
    <div className="space-y-2">
      {grupy.map((g, gi) => (
        <div key={gi}>
          {gi > 0 ? <div className="my-1.5 text-center text-[11px] font-semibold uppercase tracking-wide text-[var(--color-tekst-3)]">i</div> : null}
          <div className="space-y-2 rounded-md border border-[var(--color-linia)] p-2">
            {g.warunki.map((w0, wi) => {
              const w = w0 as WarunekZdarzenia;
              const blad = w.pole.trim() ? bladWartosci(w.typPola, w.operator, w.wartosc) : "Podaj nazwę pola zdarzenia.";
              return (
                <div key={wi}>
                  {wi > 0 ? <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-tekst-3)]">lub</div> : null}
                  <div className="grid grid-cols-[1fr_auto] gap-1.5">
                    <input className="pole" aria-label="pole zdarzenia" placeholder="pole, np. ProductID" maxLength={255} value={w.pole} onChange={(e) => zmienWarunek(gi, wi, { pole: e.target.value })} />
                    <button type="button" aria-label="Usuń warunek" title="Usuń warunek" onClick={() => usunWarunek(gi, wi)} className="grid h-9 w-9 place-items-center rounded-md text-[var(--color-tekst-3)] hover:bg-[var(--color-blad-tlo)] hover:text-[var(--color-blad)]"><Trash2 size={14} /></button>
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                    <select className="pole" aria-label="typ pola" value={w.typPola} onChange={(e) => {
                      const typPola = e.target.value as TypPola;
                      const operator = OPERATORY[typPola][0];
                      zmienWarunek(gi, wi, { typPola, operator, wartosc: domyslnaWartosc(typPola, operator) });
                    }}>
                      {TYPY_POL.map((t) => <option key={t} value={t}>{ETYKIETY_TYPOW[t]}</option>)}
                    </select>
                    <select className="pole" aria-label="operator" value={w.operator} onChange={(e) => zmienWarunek(gi, wi, { operator: e.target.value, wartosc: domyslnaWartosc(w.typPola, e.target.value) })}>
                      {OPERATORY[w.typPola].map((o) => <option key={o} value={o}>{ETYKIETY_OPERATOROW[o]}</option>)}
                    </select>
                  </div>
                  <div className="mt-1.5"><PoleWartosci w={w} onZmiana={(wartosc) => zmienWarunek(gi, wi, { wartosc })} /></div>
                  {blad ? <p className="mt-1 text-[12px] leading-4 text-[var(--color-blad)]">{blad}</p> : null}
                </div>
              );
            })}
            <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={() => ustaw(grupy.map((x, i) => (i === gi ? { warunki: [...x.warunki, nowyWarunek()] } : x)))}>
              <Plus size={13} /> lub
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={() => ustaw([...grupy, { warunki: [nowyWarunek()] }])}>
        <Plus size={13} /> {grupy.length ? "i (kolejny warunek)" : "Dodaj filtr wyzwalacza"}
      </button>
    </div>
  );
}

export function PanelZrodla({
  zrodlo,
  metryki,
  listy,
  grafV2Dostepny = false,
  onZmiana,
}: {
  zrodlo: ZrodloWyzwalacza;
  metryki: MetrykaDoWyboru[];
  listy: { id: string; name: string }[];
  /** false: tylko metryki wbudowane v1 i bez filtra (zapis w v1, bezpieczny rollback kodu) */
  grafV2Dostepny?: boolean;
  onZmiana: (z: ZrodloWyzwalacza) => void;
}) {
  const wybrana = zrodlo.rodzaj === "metryka" ? kluczMetryki(zrodlo.metryka) : "";
  // biezaca metryka zawsze na liscie (np. wbudowana, ktorej katalog jeszcze nie zna)
  const opcje = zrodlo.rodzaj === "metryka" && !metryki.some((m) => kluczMetryki(m) === wybrana)
    // spoza katalogu: wbudowana v1 jest poprawna, kazda inna (usunieta, cudza) jawnie niedostepna
    ? [...metryki, { ...zrodlo.metryka, canTrigger: zdarzenieV1(zrodlo.metryka) !== null, etykieta: `${etykietaMetryki(zrodlo.metryka)}${zdarzenieV1(zrodlo.metryka) ? "" : " (nie ma w koncie)"}` }]
    : metryki;
  return (
    <>
      <label className="block">
        <span className="etykieta mb-1 block">Rodzaj</span>
        <select className="pole" value={zrodlo.rodzaj} onChange={(e) => {
          if (e.target.value === "lista") onZmiana({ rodzaj: "lista", ...(listy[0] ? { listId: listy[0].id } : {}) });
          else {
            const m = metryki.find((x) => x.canTrigger) ?? { integracja: "midrev", nazwa: "Submitted Form" };
            onZmiana({ rodzaj: "metryka", metryka: { integracja: m.integracja, nazwa: m.nazwa } });
          }
        }}>
          <option value="metryka">Metryka (zdarzenie)</option>
          <option value="lista">Dołączenie do listy</option>
        </select>
      </label>
      {zrodlo.rodzaj === "metryka" ? (
        <>
          <label className="block">
            <span className="etykieta mb-1 block">Metryka</span>
            <select className="pole" value={wybrana} onChange={(e) => {
              const m = opcje.find((x) => kluczMetryki(x) === e.target.value);
              if (m) onZmiana({ ...zrodlo, metryka: { integracja: m.integracja, nazwa: m.nazwa } });
            }}>
              {opcje.map((m) => (
                <option key={kluczMetryki(m)} value={kluczMetryki(m)} disabled={!m.canTrigger || (!grafV2Dostepny && !zdarzenieV1(m))}>
                  {m.etykieta}{m.etykieta !== m.nazwa ? ` (${m.nazwa})` : ""}{m.canTrigger ? (!grafV2Dostepny && !zdarzenieV1(m) ? " — po włączeniu nowych automatyzacji" : "") : " — nie może uruchamiać"}
                </option>
              ))}
            </select>
          </label>
          <div>
            <span className="etykieta mb-1 block">Filtr wyzwalacza</span>
            {!grafV2Dostepny && !zrodlo.filtr ? (
              <p className="text-[12px] leading-4 text-[var(--color-tekst-3)]">Filtr wyzwalacza będzie dostępny po włączeniu nowych automatyzacji.</p>
            ) : (
            <EdytorFiltraWyzwalacza filtr={zrodlo.filtr} onZmiana={(filtr) => onZmiana(filtr ? { ...zrodlo, filtr } : { rodzaj: "metryka", metryka: zrodlo.metryka })} />
            )}
            {grafV2Dostepny || zrodlo.filtr ? <p className="mt-1.5 text-[12px] leading-4 text-[var(--color-tekst-3)]">Tylko zdarzenia spełniające filtr uruchamiają automatyzację. Tekst porównujemy dokładnie, z wielkością liter.</p> : null}
          </div>
        </>
      ) : (
        <>
          <label className="block">
            <span className="etykieta mb-1 block">Lista</span>
            {listy.length ? (
              <select className="pole" value={zrodlo.listId ?? ""} onChange={(e) => onZmiana({ ...zrodlo, listId: e.target.value })}>
                {listy.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            ) : <p className="text-[13px] text-[var(--color-tekst-2)]">Nie ma jeszcze żadnej listy.</p>}
          </label>
          <label className="flex items-start gap-2.5 rounded-md border border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] px-3 py-2.5 text-[13px] leading-5">
            <input type="checkbox" className="mt-1 accent-[var(--color-akcent)]" checked={zrodlo.takzeMasowe === true} onChange={(e) => onZmiana({ ...zrodlo, takzeMasowe: e.target.checked })} />
            <span>
              Także dodania masowe (import, cały segment)
              <span className="block text-[12px] text-[var(--color-czeka)]">Import tysięcy adresów na tę listę uruchomi automatyzację dla każdego z nich naraz. Domyślnie wchodzą tylko osoby dodane pojedynczo: ręcznie albo formularzem.</span>
            </span>
          </label>
        </>
      )}
      <p className="text-[12px] leading-4 text-[var(--color-tekst-3)]">Nie uruchamiają automatyzacji: zdarzenia sprzed jej włączenia, import historii, zdarzenia oznaczone jako uzupełnienie (backfill) i te, które dotarły do nas ponad 4 godziny po fakcie. Liczą się w statystykach, maili nie wysyłają.</p>
    </>
  );
}

export function WyborPonownegoWejscia({
  wartosc,
  dostepne,
  onZmiana,
}: {
  wartosc: PonowneWejscie;
  dostepne: boolean;
  onZmiana: (p: PonowneWejscie) => void;
}) {
  const opcja = (tryb: PonowneWejscie["tryb"], tytul: string, opis: string) => (
    <label className={`flex items-start gap-2.5 text-[13px] leading-5 ${tryb !== "raz" && !dostepne ? "opacity-60" : ""}`}>
      <input
        type="radio"
        name="ponowne-wejscie"
        className="mt-1 accent-[var(--color-akcent)]"
        checked={wartosc.tryb === tryb}
        disabled={tryb !== "raz" && !dostepne && wartosc.tryb !== tryb}
        onChange={() => onZmiana(tryb === "po" ? { tryb: "po", ilosc: 30, jednostka: "dni" } : { tryb })}
      />
      <span>{tytul}<span className="block text-[12px] text-[var(--color-tekst-3)]">{opis}</span></span>
    </label>
  );
  return (
    <div className="space-y-2">
      {opcja("raz", "Tylko raz", "Osoba przechodzi tę automatyzację najwyżej raz w życiu.")}
      {opcja("zawsze", "Za każdym razem", "Każde zdarzenie to nowy przebieg (np. dwa zamówienia = dwa podziękowania).")}
      {opcja("po", "Ponownie po upływie czasu", "Kolejne wejście dopiero, gdy od poprzedniego minął wskazany czas.")}
      {wartosc.tryb === "po" ? (
        <div className="grid grid-cols-[1fr_120px] gap-2 pl-6">
          <input type="number" min={1} max={100000} className="pole" aria-label="ile" value={wartosc.ilosc} onChange={(e) => onZmiana({ ...wartosc, ilosc: Math.max(1, Math.min(100000, Math.trunc(Number(e.target.value) || 1))) })} />
          <select className="pole" aria-label="jednostka" value={wartosc.jednostka} onChange={(e) => onZmiana({ ...wartosc, jednostka: e.target.value as "minuty" | "godziny" | "dni" })}>
            <option value="minuty">minut</option>
            <option value="godziny">godzin</option>
            <option value="dni">dni</option>
          </select>
        </div>
      ) : null}
      {!dostepne ? <p className="text-[12px] leading-4 text-[var(--color-czeka)]">Ponowne wejście włączymy po najbliższej aktualizacji systemu. Do tego czasu każda osoba wchodzi raz.</p> : null}
    </div>
  );
}
