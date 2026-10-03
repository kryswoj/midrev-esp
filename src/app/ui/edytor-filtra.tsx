"use client";

import { useId } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  BEZ_WARTOSCI,
  ETYKIETY_LICZNIKA,
  ETYKIETY_OPERATOROW,
  ETYKIETY_TYPOW,
  OPERATORY,
  OPERATORY_LICZNIKA,
  POLA_STANDARDOWE_PROFILU,
  TYPY_POL,
  bladWartosci,
  schematWarunku,
  type Filtr,
  type TypPola,
  type Warunek,
} from "../../domain/filtry";

/**
 * EdytorFiltra (E4b 4.11, AD-42): JEDEN komponent dla kazdego miejsca, w ktorym operator
 * uklada warunki: filtr wyzwalacza, filtr profilu flow, dodatkowe filtry maila, warunek
 * Tak/Nie, split po zdarzeniu (i, w kolejnym etapie, segmenty).
 *
 * Zasady z audytu UX (02.10, kanwa P1 4-5):
 *  - warunek czyta sie jak zdanie: „[Pole] [operator] [wartość]”, „Zrobił [metryka] [ani razu]
 *    [od wejścia do automatyzacji]”;
 *  - pole wybierane z katalogu wlasciwosci (co naprawde przychodzi w zdarzeniach i profilach),
 *    typ podstawia sie sam; wpis reczny tylko jako „Inne pole…”;
 *  - „+ LUB” w grupie, „+ I” nowa grupa; bledy po polsku przy polu, nigdy sciezka Zoda;
 *  - niedokonczony warunek to stan roboczy (graf go nie zapisuje, blokuje tylko wlaczenie).
 */

export interface PoleZKatalogu {
  klucz: string;
  typ: TypPola;
  przyklady: string[];
}

export interface KatalogFiltra {
  zdarzenie: PoleZKatalogu[];
  profil: PoleZKatalogu[];
  flowy: { id: string; nazwa: string }[];
}

export interface MetrykaFiltra {
  integracja: string;
  nazwa: string;
  etykieta: string;
}

export type RodzajWarunku = "zdarzenie" | "profil" | "metryka" | "flow";

const NAZWY_RODZAJOW: Record<RodzajWarunku, string> = {
  zdarzenie: "Właściwość zdarzenia",
  profil: "Właściwość profilu",
  metryka: "Co osoba zrobiła",
  flow: "Udział w automatyzacji",
};

const POLA_STANDARDOWE: Record<(typeof POLA_STANDARDOWE_PROFILU)[number], string> = {
  email: "E-mail",
  first_name: "Imię",
  last_name: "Nazwisko",
  phone_number: "Telefon",
};

/** Klucz "kazde zrodlo" w liscie metryk (warunek bez integracji). */
const KAZDE = "*";

function domyslnaWartosc(typ: TypPola, operator: string): unknown {
  if (BEZ_WARTOSCI.has(operator)) return undefined;
  if (typ === "number") return operator === "miedzy" ? [0, 100] : 0;
  if (typ === "date") return operator === "w_ostatnich_dniach" ? 30 : operator === "miedzy" ? ["2026-01-01", "2026-12-31"] : "";
  if (typ === "string" && (operator === "jest_w" || operator === "nie_jest_w")) return [""];
  if (typ === "boolean") return undefined;
  return "";
}

function nowyWarunek(rodzaj: RodzajWarunku, metryki: MetrykaFiltra[], wFlow: boolean): Warunek {
  switch (rodzaj) {
    case "zdarzenie":
      return { typ: "wlasciwosc_zdarzenia", pole: "", typPola: "string", operator: "rowna", wartosc: "" };
    case "profil":
      return { typ: "wlasciwosc_profilu", pole: { rodzaj: "wlasna", nazwa: "" }, typPola: "string", operator: "rowna", wartosc: "" };
    case "metryka": {
      const zakup = metryki.some((m) => m.nazwa === "Placed Order");
      return {
        typ: "metryka_profilu",
        metryka: zakup ? { nazwa: "Placed Order" } : { integracja: metryki[0]?.integracja, nazwa: metryki[0]?.nazwa ?? "" },
        operator: "rowna",
        wartosc: 0,
        okno: wFlow ? { od: "startu_flow" } : { od: "ostatnich_dni", dni: 30 },
      } as Warunek;
    }
    case "flow":
      return { typ: "byl_w_flow", flow: wFlow ? "biezacy" : "", jest: false, okno: { od: "ostatnich_dni", dni: 30 } } as Warunek;
  }
}

function rodzajWarunku(w: Warunek): RodzajWarunku {
  return w.typ === "wlasciwosc_zdarzenia" ? "zdarzenie" : w.typ === "wlasciwosc_profilu" ? "profil" : w.typ === "metryka_profilu" ? "metryka" : "flow";
}

/** Komunikat przy niepoprawnym warunku (po polsku), albo null. */
export function bladWarunku(w: Warunek): string | null {
  if (w.typ === "wlasciwosc_zdarzenia" && !w.pole.trim()) return "Wybierz albo wpisz właściwość zdarzenia.";
  if (w.typ === "wlasciwosc_profilu" && !w.pole.nazwa.trim()) return "Wybierz albo wpisz właściwość profilu.";
  if (w.typ === "metryka_profilu" && !w.metryka.nazwa) return "Wybierz metrykę.";
  if (w.typ === "byl_w_flow" && !w.flow) return "Wybierz automatyzację.";
  if (w.typ === "wlasciwosc_zdarzenia" || w.typ === "wlasciwosc_profilu") {
    const b = bladWartosci(w.typPola, w.operator, w.wartosc);
    if (b) return b;
  }
  const r = schematWarunku.safeParse(w);
  if (!r.success) return r.error.issues[0]?.message && !/expected|Invalid/i.test(r.error.issues[0].message) ? r.error.issues[0].message : "Uzupełnij warunek albo go usuń.";
  return null;
}

// ── Wartosc warunku po wlasciwosci ──────────────────────────────────────────

function PoleWartosci({ typ, operator, wartosc, przyklady, onZmiana }: { typ: TypPola; operator: string; wartosc: unknown; przyklady: string[]; onZmiana: (x: unknown) => void }) {
  const lista = useId();
  if (BEZ_WARTOSCI.has(operator)) return null;
  if (operator === "miedzy") {
    const [a, b] = (Array.isArray(wartosc) ? wartosc : ["", ""]) as (string | number)[];
    const num = typ === "number";
    const konw = (v: string) => (num ? Number(v) : v);
    return (
      <span className="flex items-center gap-1.5">
        <input className="pole !w-24" type={num ? "number" : "text"} placeholder={num ? "od" : "RRRR-MM-DD"} aria-label="od" value={String(a ?? "")} onChange={(e) => onZmiana([konw(e.target.value), b])} />
        <span className="text-[12px] text-[var(--color-tekst-3)]">i</span>
        <input className="pole !w-24" type={num ? "number" : "text"} placeholder={num ? "do" : "RRRR-MM-DD"} aria-label="do" value={String(b ?? "")} onChange={(e) => onZmiana([a, konw(e.target.value)])} />
      </span>
    );
  }
  if (operator === "jest_w" || operator === "nie_jest_w") {
    return <input className="pole" aria-label="wartości po przecinku" placeholder="wartości po przecinku" value={Array.isArray(wartosc) ? wartosc.join(", ") : ""} onChange={(e) => onZmiana(e.target.value.split(",").map((v) => v.trim()).filter((v, i, t) => v || t.length === 1))} />;
  }
  if (typ === "number" || operator === "w_ostatnich_dniach") {
    return (
      <span className="flex items-center gap-1.5">
        <input className="pole !w-24" type="number" aria-label="wartość" value={typeof wartosc === "number" ? wartosc : 0} onChange={(e) => onZmiana(Number(e.target.value))} />
        {operator === "w_ostatnich_dniach" ? <span className="text-[13px] text-[var(--color-tekst-2)]">dniach</span> : null}
      </span>
    );
  }
  return (
    <>
      <input
        className="pole"
        aria-label="wartość"
        list={przyklady.length ? lista : undefined}
        placeholder={typ === "date" ? "RRRR-MM-DD" : typ === "list" ? "element listy" : "wartość"}
        value={typeof wartosc === "string" || typeof wartosc === "number" ? String(wartosc) : ""}
        onChange={(e) => onZmiana(e.target.value)}
      />
      {przyklady.length ? <datalist id={lista}>{przyklady.map((p) => <option key={p} value={p} />)}</datalist> : null}
    </>
  );
}

// ── Wybor pola z katalogu ───────────────────────────────────────────────────

const INNE = "__inne__";

function WyborPola({ wartosc, pola, standard, onZmiana }: {
  wartosc: string;
  pola: PoleZKatalogu[];
  standard?: boolean;
  onZmiana: (pole: string, typ: TypPola | null) => void;
}) {
  const znane = new Set([...pola.map((p) => p.klucz), ...(standard ? Object.keys(POLA_STANDARDOWE).map((k) => `std:${k}`) : [])]);
  const reczne = wartosc !== "" && !znane.has(wartosc);
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1.5">
      <select
        className="pole"
        aria-label="pole"
        value={reczne ? INNE : wartosc}
        onChange={(e) => {
          const v = e.target.value;
          if (v === INNE) return onZmiana(" ", null);
          const p = pola.find((x) => x.klucz === v);
          onZmiana(v, v.startsWith("std:") ? "string" : p?.typ ?? null);
        }}
      >
        <option value="" disabled>wybierz pole…</option>
        {standard ? (
          <optgroup label="Dane kontaktowe">
            {Object.entries(POLA_STANDARDOWE).map(([k, n]) => <option key={k} value={`std:${k}`}>{n}</option>)}
          </optgroup>
        ) : null}
        {pola.length ? (
          <optgroup label={standard ? "Właściwości profilu" : "Właściwości zdarzenia"}>
            {pola.map((p) => <option key={p.klucz} value={p.klucz}>{p.klucz} · {ETYKIETY_TYPOW[p.typ]}</option>)}
          </optgroup>
        ) : null}
        <option value={INNE}>Inne pole…</option>
      </select>
      {reczne ? (
        <input className="pole" autoFocus aria-label="nazwa pola" placeholder="nazwa pola, np. ProductID" maxLength={255} value={wartosc.trimStart()} onChange={(e) => onZmiana(e.target.value || " ", null)} />
      ) : null}
    </span>
  );
}

// ── Jeden warunek ───────────────────────────────────────────────────────────

function WierszWarunku({ w, rodzaje, katalog, metryki, wFlow, onZmiana, onUsun }: {
  w: Warunek;
  rodzaje: RodzajWarunku[];
  katalog: KatalogFiltra | null;
  metryki: MetrykaFiltra[];
  wFlow: boolean;
  onZmiana: (w: Warunek) => void;
  onUsun: () => void;
}) {
  const rodzaj = rodzajWarunku(w);
  const blad = bladWarunku(w);
  const idBledu = useId();
  let tresc: React.ReactNode = null;

  if (w.typ === "wlasciwosc_zdarzenia" || w.typ === "wlasciwosc_profilu") {
    const profilowe = w.typ === "wlasciwosc_profilu";
    const pola = (profilowe ? katalog?.profil : katalog?.zdarzenie) ?? [];
    const kluczPola = profilowe ? (w.pole.rodzaj === "standard" ? `std:${w.pole.nazwa}` : w.pole.nazwa) : w.pole;
    const zKatalogu = pola.find((p) => p.klucz === kluczPola);
    const reczne = kluczPola.trim() !== "" && !zKatalogu && !kluczPola.startsWith("std:");
    const zmienPole = (pole: string, typ: TypPola | null) => {
      const typPola = typ ?? w.typPola;
      const operator = (OPERATORY[typPola] as readonly string[]).includes(w.operator) ? w.operator : OPERATORY[typPola][0];
      const wartosc = typPola === w.typPola && operator === w.operator ? w.wartosc : domyslnaWartosc(typPola, operator);
      if (profilowe) {
        const p = pole.startsWith("std:") ? { rodzaj: "standard" as const, nazwa: pole.slice(4) as (typeof POLA_STANDARDOWE_PROFILU)[number] } : { rodzaj: "wlasna" as const, nazwa: pole };
        onZmiana({ ...w, pole: p, typPola, operator, wartosc } as Warunek);
      } else onZmiana({ ...w, pole, typPola, operator, wartosc } as Warunek);
    };
    tresc = (
      <>
        <WyborPola wartosc={kluczPola} pola={pola} standard={profilowe} onZmiana={zmienPole} />
        <span className="flex w-full flex-wrap items-center gap-1.5">
          {reczne ? (
            <select className="pole !w-auto" aria-label="typ pola" value={w.typPola} onChange={(e) => {
              const typPola = e.target.value as TypPola;
              const operator = OPERATORY[typPola][0];
              onZmiana({ ...w, typPola, operator, wartosc: domyslnaWartosc(typPola, operator) } as Warunek);
            }}>
              {TYPY_POL.map((t) => <option key={t} value={t}>{ETYKIETY_TYPOW[t]}</option>)}
            </select>
          ) : null}
          <select className="pole !w-auto" aria-label="operator" value={w.operator} onChange={(e) => onZmiana({ ...w, operator: e.target.value, wartosc: domyslnaWartosc(w.typPola, e.target.value) } as Warunek)}>
            {OPERATORY[w.typPola].map((o) => <option key={o} value={o}>{ETYKIETY_OPERATOROW[o]}</option>)}
          </select>
          <span className="min-w-[96px] flex-1">
            <PoleWartosci typ={w.typPola} operator={w.operator} wartosc={w.wartosc} przyklady={zKatalogu?.przyklady ?? []} onZmiana={(wartosc) => onZmiana({ ...w, wartosc } as Warunek)} />
          </span>
        </span>
      </>
    );
  } else if (w.typ === "metryka_profilu") {
    const klucz = w.metryka.integracja ? `${w.metryka.integracja}|${w.metryka.nazwa}` : `${KAZDE}|${w.metryka.nazwa}`;
    const nazwy = [...new Set(metryki.map((m) => m.nazwa))];
    const opcje = [...metryki.map((m) => ({ klucz: `${m.integracja}|${m.nazwa}`, etykieta: m.etykieta === m.nazwa ? `${m.nazwa} (${m.integracja})` : `${m.etykieta} (${m.integracja})` }))];
    for (const n of nazwy) if (metryki.filter((m) => m.nazwa === n).length > 1 || n === "Placed Order") opcje.unshift({ klucz: `${KAZDE}|${n}`, etykieta: `${n} (każde źródło)` });
    if (!opcje.some((o) => o.klucz === klucz) && w.metryka.nazwa) opcje.push({ klucz, etykieta: `${w.metryka.nazwa}${w.metryka.integracja ? ` (${w.metryka.integracja})` : " (każde źródło)"}` });
    const pojedyncza = !Array.isArray(w.wartosc);
    tresc = (
      <>
        <select className="pole" aria-label="metryka" value={klucz} onChange={(e) => {
          const [integracja, ...reszta] = e.target.value.split("|");
          onZmiana({ ...w, metryka: integracja === KAZDE ? { nazwa: reszta.join("|") } : { integracja, nazwa: reszta.join("|") } });
        }}>
          {opcje.map((o) => <option key={o.klucz} value={o.klucz}>{o.etykieta}</option>)}
        </select>
        <span className="flex w-full flex-wrap items-center gap-1.5">
          <select className="pole !w-auto" aria-label="ile razy" value={w.operator === "rowna" && w.wartosc === 0 ? "zero" : w.operator} onChange={(e) => {
            const v = e.target.value;
            if (v === "zero") onZmiana({ ...w, operator: "rowna", wartosc: 0 });
            else onZmiana({ ...w, operator: v as typeof w.operator, wartosc: v === "miedzy" ? [1, 3] : pojedyncza ? Math.max(1, w.wartosc as number) : 1 });
          }}>
            <option value="zero">ani razu</option>
            {OPERATORY_LICZNIKA.map((o) => <option key={o} value={o}>{ETYKIETY_LICZNIKA[o]}</option>)}
          </select>
          {!(w.operator === "rowna" && w.wartosc === 0) ? (
            w.operator === "miedzy" ? (
              <span className="flex items-center gap-1.5">
                <input className="pole !w-16" type="number" min={0} aria-label="od" value={(w.wartosc as number[])[0]} onChange={(e) => onZmiana({ ...w, wartosc: [Math.max(0, Math.trunc(Number(e.target.value) || 0)), (w.wartosc as number[])[1]] })} />
                <span className="text-[12px] text-[var(--color-tekst-3)]">do</span>
                <input className="pole !w-16" type="number" min={0} aria-label="do" value={(w.wartosc as number[])[1]} onChange={(e) => onZmiana({ ...w, wartosc: [(w.wartosc as number[])[0], Math.max(0, Math.trunc(Number(e.target.value) || 0))] })} />
              </span>
            ) : <input className="pole !w-16" type="number" min={0} aria-label="liczba razy" value={w.wartosc as number} onChange={(e) => onZmiana({ ...w, wartosc: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })} />
          ) : null}
          {!(w.operator === "rowna" && w.wartosc === 0) ? <span className="text-[13px] text-[var(--color-tekst-2)]">razy</span> : null}
          <select className="pole !w-auto" aria-label="okno czasu" value={w.okno.od} onChange={(e) => {
            const od = e.target.value;
            onZmiana({ ...w, okno: od === "ostatnich_dni" ? { od, dni: 30 } : ({ od } as typeof w.okno) });
          }}>
            {wFlow ? <option value="startu_flow">od wejścia do automatyzacji</option> : null}
            <option value="ostatnich_dni">w ostatnich…</option>
            <option value="zawsze">kiedykolwiek</option>
          </select>
          {w.okno.od === "ostatnich_dni" ? (
            <span className="flex items-center gap-1.5">
              <input className="pole !w-20" type="number" min={1} max={3650} aria-label="liczba dni" value={w.okno.dni} onChange={(e) => onZmiana({ ...w, okno: { od: "ostatnich_dni", dni: Math.max(1, Math.min(3650, Math.trunc(Number(e.target.value) || 1))) } })} />
              <span className="text-[13px] text-[var(--color-tekst-2)]">dniach</span>
            </span>
          ) : null}
        </span>
        {(w.gdzie ?? []).map((g, gi) => (
          <span key={gi} className="flex w-full items-start gap-1.5 border-l-2 border-[var(--color-linia)] pl-2">
            <span className="pt-2 text-[12px] font-medium text-[var(--color-tekst-3)]">{gi ? "i" : "gdzie"}</span>
            <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              <WierszWarunku
                w={g as Warunek}
                rodzaje={["zdarzenie"]}
                katalog={null}
                metryki={[]}
                wFlow={wFlow}
                onZmiana={(nowy) => onZmiana({ ...w, gdzie: (w.gdzie ?? []).map((x, i) => (i === gi ? (nowy as typeof x) : x)) })}
                onUsun={() => { const reszta = (w.gdzie ?? []).filter((_, i) => i !== gi); const { gdzie: _g, ...bez } = w; onZmiana(reszta.length ? { ...bez, gdzie: reszta } : bez); }}
              />
            </span>
          </span>
        ))}
        {(w.gdzie?.length ?? 0) < 10 ? (
          <button type="button" className="text-[12px] font-medium text-[var(--color-akcent)] hover:underline" onClick={() => onZmiana({ ...w, gdzie: [...(w.gdzie ?? []), nowyWarunek("zdarzenie", [], wFlow) as never] })}>
            + gdzie (właściwość zdarzenia)
          </button>
        ) : null}
      </>
    );
  } else {
    const flowy = katalog?.flowy ?? [];
    tresc = (
      <span className="flex w-full flex-wrap items-center gap-1.5">
        <select className="pole !w-auto" aria-label="był albo nie był" value={w.jest ? "tak" : "nie"} onChange={(e) => onZmiana({ ...w, jest: e.target.value === "tak" })}>
          <option value="nie">nie był</option>
          <option value="tak">był</option>
        </select>
        <select className="pole min-w-0 flex-1" aria-label="automatyzacja" value={w.flow} onChange={(e) => onZmiana({ ...w, flow: e.target.value })}>
          {wFlow ? <option value="biezacy">w tej automatyzacji</option> : <option value="" disabled>wybierz automatyzację…</option>}
          {flowy.map((f) => <option key={f.id} value={f.id}>w „{f.nazwa}”</option>)}
        </select>
        <select className="pole !w-auto" aria-label="okno czasu" value={w.okno.od} onChange={(e) => onZmiana({ ...w, okno: e.target.value === "zawsze" ? { od: "zawsze" } : { od: "ostatnich_dni", dni: 30 } })}>
          <option value="ostatnich_dni">w ostatnich…</option>
          <option value="zawsze">kiedykolwiek</option>
        </select>
        {w.okno.od === "ostatnich_dni" ? (
          <span className="flex items-center gap-1.5">
            <input className="pole !w-20" type="number" min={1} max={3650} aria-label="liczba dni" value={w.okno.dni} onChange={(e) => onZmiana({ ...w, okno: { od: "ostatnich_dni", dni: Math.max(1, Math.min(3650, Math.trunc(Number(e.target.value) || 1))) } })} />
            <span className="text-[13px] text-[var(--color-tekst-2)]">dniach</span>
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <div className="w-full" data-niepoprawne={blad ? true : undefined}>
      <div className="flex items-start gap-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {rodzaje.length > 1 ? (
            <select className="pole !h-auto !min-h-0 !w-auto !border-transparent !bg-[var(--color-powierzchnia-2)] !py-1 !pl-2 text-[12px] font-medium text-[var(--color-tekst-2)]" aria-label="rodzaj warunku" value={rodzaj} onChange={(e) => onZmiana(nowyWarunek(e.target.value as RodzajWarunku, metryki, wFlow))}>
              {rodzaje.map((r) => <option key={r} value={r}>{NAZWY_RODZAJOW[r]}</option>)}
            </select>
          ) : null}
          {tresc}
        </div>
        <button type="button" aria-label="Usuń warunek" title="Usuń warunek" onClick={onUsun} className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-[var(--color-tekst-3)] hover:bg-[var(--color-blad-tlo)] hover:text-[var(--color-blad)]"><Trash2 size={14} /></button>
      </div>
      {blad ? <p id={idBledu} className="mt-1 text-[12px] leading-4 text-[var(--color-blad)]">{blad} <span className="text-[var(--color-tekst-3)]">Niedokończony warunek nie jest zapisywany.</span></p> : null}
    </div>
  );
}

// ── Caly filtr ──────────────────────────────────────────────────────────────

export function EdytorFiltra({
  filtr,
  onZmiana,
  rodzaje,
  katalog,
  metryki = [],
  wFlow = true,
  pusty,
  etykietaDodaj = "Dodaj warunek",
}: {
  filtr: Filtr | undefined;
  onZmiana: (f: Filtr | undefined) => void;
  /** dozwolone rodzaje warunkow (pierwszy = domyslny dla nowego) */
  rodzaje: RodzajWarunku[];
  katalog: KatalogFiltra | null;
  metryki?: MetrykaFiltra[];
  /** liczony w automatyzacji: dostepne "od wejscia" i "ta automatyzacja" */
  wFlow?: boolean;
  /** tekst, gdy filtr jest pusty */
  pusty?: string;
  etykietaDodaj?: string;
}) {
  const grupy = filtr?.grupy ?? [];
  const ustaw = (nowe: Filtr["grupy"]) => onZmiana(nowe.length ? { grupy: nowe } : undefined);
  const nowy = () => nowyWarunek(rodzaje[0], metryki, wFlow);
  return (
    <div className="space-y-2" data-edytor-filtra>
      {!grupy.length && pusty ? <p className="text-[12px] leading-4 text-[var(--color-tekst-3)]">{pusty}</p> : null}
      {grupy.map((g, gi) => (
        <div key={gi}>
          {gi > 0 ? (
            <div className="my-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-tekst-3)]">
              <span className="h-px flex-1 bg-[var(--color-linia)]" />i<span className="h-px flex-1 bg-[var(--color-linia)]" />
            </div>
          ) : null}
          <div className="space-y-2 rounded-lg border border-[var(--color-linia)] bg-white p-2.5">
            {g.warunki.map((w, wi) => (
              <div key={wi}>
                {wi > 0 ? <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-akcent)]">lub</div> : null}
                <WierszWarunku
                  w={w}
                  rodzaje={rodzaje}
                  katalog={katalog}
                  metryki={metryki}
                  wFlow={wFlow}
                  onZmiana={(nowyW) => ustaw(grupy.map((x, i) => (i !== gi ? x : { warunki: x.warunki.map((y, j) => (j === wi ? nowyW : y)) })))}
                  onUsun={() => ustaw(grupy.map((x, i) => (i !== gi ? x : { warunki: x.warunki.filter((_, j) => j !== wi) })).filter((x) => x.warunki.length))}
                />
              </div>
            ))}
            <button type="button" className="text-[12px] font-semibold text-[var(--color-akcent)] hover:underline" onClick={() => ustaw(grupy.map((x, i) => (i === gi ? { warunki: [...x.warunki, nowy()] } : x)))}>
              + LUB
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={() => ustaw([...grupy, { warunki: [nowy()] }])}>
        <Plus size={13} /> {grupy.length ? "I (kolejny warunek)" : etykietaDodaj}
      </button>
    </div>
  );
}
