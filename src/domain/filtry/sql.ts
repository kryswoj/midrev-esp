import { parsujDate, type Filtr, type PoleStandardoweProfilu, type Warunek, type WarunekFlow, type WarunekMetryki } from "./typy";

/**
 * Kompilacja filtra do fragmentu WHERE w SQL. Semantyka 1:1 z `ewaluacja.ts` (test
 * parytetu). Zasady bezpieczenstwa (AD-42):
 *  - kazda wartosc i KAZDY klucz JSON idzie jako parametr (`properties -> $n::text`),
 *    nic z definicji nie jest sklejane w tekst zapytania;
 *  - wyrazenia kolumn (`zrodlo`) podaje wolajacy kod, nigdy uzytkownik;
 *  - fragment NIE zawiera predykatu tenanta: produkcyjne zapytanie buduje wylacznie
 *    `zapytanieFiltrowane`, ktore sklada `alias.tenant_id = $1` samo.
 *
 * Daty przechodza przez funkcje `filtr_data(text)` z migracji 0035 (ten sam wzorzec co
 * `WZORZEC_DATY`, zly zapis albo 31 lutego = null zamiast bledu calego zapytania).
 */

export interface ZrodloSql {
  /** wyrazenie jsonb z properties zdarzenia, np. `e.properties` */
  zdarzenie?: string;
  profil?: {
    /** wyrazenie jsonb z properties profilu, np. `p.properties` */
    properties: string;
    /** wyrazenia kolumn standardowych (text) */
    kolumny: Record<PoleStandardoweProfilu, string>;
    /**
     * Wyrazenia `id` i `tenant_id` profilu (uuid): wymagane przez warunki po historii
     * (`metryka_profilu`, `byl_w_flow`), ktore sa skorelowanymi podzapytaniami. Predykat
     * tenanta podzapytania pochodzi z WIERSZA profilu, ktory zewnetrzne zapytanie juz
     * zawezilo do tenanta (`zapytanieFiltrowane`), wiec nie da sie go pominac.
     */
    id?: string;
    tenantId?: string;
  };
}

/** Kontekst automatyzacji w SQL (te same wartosci co `KontekstFlow` w TS), zawsze jako parametry. */
export interface KontekstFlowSql {
  flowId: string;
  /** entered_at przebiegu: tekst znacznika czasu prosto z bazy (bez utraty mikrosekund) */
  start: string;
  zdarzenieWyzwalajaceId: string | null;
  uczestnikId: string | null;
}

export class Parametry {
  readonly wartosci: unknown[];
  constructor(poczatkowe: unknown[] = []) {
    this.wartosci = [...poczatkowe];
  }
  /** Dodaje wartosc i zwraca placeholder z rzutowaniem, np. `$3::text`. */
  dodaj(v: unknown, typ: "text" | "float8" | "text[]" | "jsonb" | "timestamptz" | "int" | "uuid"): string {
    this.wartosci.push(v);
    return `$${this.wartosci.length}::${typ}`;
  }
}

function wyrazeniePola(w: Extract<Warunek, { typ: "wlasciwosc_zdarzenia" | "wlasciwosc_profilu" }>, z: ZrodloSql, p: Parametry): string {
  if (w.typ === "wlasciwosc_zdarzenia") {
    if (!z.zdarzenie) throw new Error("filtr: warunek na zdarzeniu bez źródła zdarzenia");
    return `(${z.zdarzenie} -> ${p.dodaj(w.pole, "text")})`;
  }
  if (!z.profil) throw new Error("filtr: warunek na profilu bez źródła profilu");
  if (w.pole.rodzaj === "standard") return `to_jsonb(${z.profil.kolumny[w.pole.nazwa]})`;
  return `(${z.profil.properties} -> ${p.dodaj(w.pole.nazwa, "text")})`;
}

function iso(s: unknown): string {
  const t = parsujDate(s);
  if (t === null) throw new Error("filtr: niepoprawna data w definicji");
  return new Date(t).toISOString();
}

const OPERATORY_SQL: Record<Exclude<WarunekMetryki["operator"], "miedzy">, string> = {
  rowna: "=", rozna: "<>", wieksza: ">", wieksza_rowna: ">=", mniejsza: "<", mniejsza_rowna: "<=",
};

function profilHistorii(z: ZrodloSql): { id: string; tenantId: string } {
  if (!z.profil?.id || !z.profil.tenantId) throw new Error("filtr: warunek po historii profilu bez id profilu w źródle");
  return { id: z.profil.id, tenantId: z.profil.tenantId };
}

function kompilujMetryke(w: WarunekMetryki, z: ZrodloSql, p: Parametry, teraz: Date, k: KontekstFlowSql | null): string {
  const pr = profilHistorii(z);
  const warunki = [
    `me.tenant_id = ${pr.tenantId}`,
    `me.profile_id = ${pr.id}`,
    `mm.name = ${p.dodaj(w.metryka.nazwa, "text")}`,
  ];
  if (w.metryka.integracja !== undefined) warunki.push(`mm.integration_key = ${p.dodaj(w.metryka.integracja, "text")}`);
  if (w.okno.od === "startu_flow") {
    if (!k) throw new Error("filtr: „od startu automatyzacji” poza automatyzacją");
    warunki.push(`me.occurred_at >= ${p.dodaj(k.start, "timestamptz")}`);
    if (k.zdarzenieWyzwalajaceId) warunki.push(`me.id <> ${p.dodaj(k.zdarzenieWyzwalajaceId, "uuid")}`);
  } else if (w.okno.od === "ostatnich_dni") {
    warunki.push(`me.occurred_at >= ${p.dodaj(teraz.toISOString(), "timestamptz")} - make_interval(days => ${p.dodaj(w.okno.dni, "int")})`);
  }
  for (const g of w.gdzie ?? []) warunki.push(kompilujWarunek(g, { zdarzenie: "me.properties" }, p, teraz, k));
  const licznik = `(select count(*) from metric_events me join metrics mm on mm.tenant_id = me.tenant_id and mm.id = me.metric_id where ${warunki.join(" and ")})`;
  if (w.operator === "miedzy") {
    const [a, b] = w.wartosc as [number, number];
    return `(${licznik} between ${p.dodaj(a, "int")} and ${p.dodaj(b, "int")})`;
  }
  return `(${licznik} ${OPERATORY_SQL[w.operator]} ${p.dodaj(w.wartosc, "int")})`;
}

function kompilujFlow(w: WarunekFlow, z: ZrodloSql, p: Parametry, teraz: Date, k: KontekstFlowSql | null): string {
  const pr = profilHistorii(z);
  let flowId: string;
  if (w.flow === "biezacy") {
    if (!k) throw new Error("filtr: „ta automatyzacja” poza automatyzacją");
    flowId = k.flowId;
  } else flowId = w.flow;
  const warunki = [`fp.tenant_id = ${pr.tenantId}`, `fp.profile_id = ${pr.id}`, `fp.flow_id = ${p.dodaj(flowId, "uuid")}`];
  if (w.okno.od === "ostatnich_dni") warunki.push(`fp.entered_at >= ${p.dodaj(teraz.toISOString(), "timestamptz")} - make_interval(days => ${p.dodaj(w.okno.dni, "int")})`);
  if (k?.uczestnikId) warunki.push(`fp.id <> ${p.dodaj(k.uczestnikId, "uuid")}`);
  return `(${w.jest ? "" : "not "}exists (select 1 from flow_participants fp where ${warunki.join(" and ")}))`;
}

export function kompilujWarunek(w: Warunek, z: ZrodloSql, p: Parametry, teraz: Date, k: KontekstFlowSql | null = null): string {
  if (w.typ === "metryka_profilu") return kompilujMetryke(w, z, p, teraz, k);
  if (w.typ === "byl_w_flow") return kompilujFlow(w, z, p, teraz, k);
  const v = wyrazeniePola(w, z, p);
  const ustawione = `(${v} is not null and jsonb_typeof(${v}) <> 'null')`;
  if (w.operator === "ustawione") return ustawione;
  if (w.operator === "nieustawione") return `(not ${ustawione})`;
  const x = w.wartosc as unknown;
  switch (w.typPola) {
    case "string": {
      const t = `(${v} #>> '{}')`;
      const jest = `coalesce(jsonb_typeof(${v}) = 'string', false)`;
      switch (w.operator) {
        case "rowna": return `(${jest} and ${t} = ${p.dodaj(x, "text")})`;
        case "rozna": return `(${jest} and ${t} <> ${p.dodaj(x, "text")})`;
        case "zawiera": return `(${jest} and strpos(${t}, ${p.dodaj(x, "text")}) > 0)`;
        case "nie_zawiera": return `(${jest} and strpos(${t}, ${p.dodaj(x, "text")}) = 0)`;
        case "zaczyna_sie": return `(${jest} and starts_with(${t}, ${p.dodaj(x, "text")}))`;
        case "jest_w": return `(${jest} and ${t} = any(${p.dodaj(x, "text[]")}))`;
        case "nie_jest_w": return `(${jest} and not (${t} = any(${p.dodaj(x, "text[]")})))`;
      }
      break;
    }
    case "number": {
      // |x| < 1e300 jak w TS; rzutowanie przez numeric (jsonb -> float8 bez ryzyka przepelnienia)
      // zagniezdzony CASE, nie AND: Postgres nie gwarantuje kolejnosci AND, a rzutowanie
      // tekstu JSON na numeric rzuciloby bledem cale zapytanie
      const n = `(case when jsonb_typeof(${v}) = 'number' then case when abs((${v})::numeric) < 1e300 then (${v})::numeric::float8 end end)`;
      const op = (znak: string) => `coalesce(${n} ${znak} ${p.dodaj(x, "float8")}, false)`;
      switch (w.operator) {
        case "rowna": return op("=");
        case "rozna": return op("<>");
        case "wieksza": return op(">");
        case "wieksza_rowna": return op(">=");
        case "mniejsza": return op("<");
        case "mniejsza_rowna": return op("<=");
        case "miedzy": {
          const [a, b] = x as number[];
          return `coalesce(${n} >= ${p.dodaj(a, "float8")} and ${n} <= ${p.dodaj(b, "float8")}, false)`;
        }
      }
      break;
    }
    case "boolean": {
      if (w.operator === "prawda") return `coalesce(${v} = 'true'::jsonb, false)`;
      if (w.operator === "falsz") return `coalesce(${v} = 'false'::jsonb, false)`;
      break;
    }
    case "date": {
      const d = `filtr_data(case when jsonb_typeof(${v}) = 'string' then ${v} #>> '{}' end)`;
      switch (w.operator) {
        case "przed": return `coalesce(${d} < ${p.dodaj(iso(x), "timestamptz")}, false)`;
        case "po": return `coalesce(${d} > ${p.dodaj(iso(x), "timestamptz")}, false)`;
        case "miedzy": {
          const [a, b] = x as string[];
          return `coalesce(${d} >= ${p.dodaj(iso(a), "timestamptz")} and ${d} <= ${p.dodaj(iso(b), "timestamptz")}, false)`;
        }
        case "w_ostatnich_dniach": {
          const t = p.dodaj(teraz.toISOString(), "timestamptz");
          return `coalesce(${d} >= ${t} - make_interval(days => ${p.dodaj(x, "int")}) and ${d} <= ${t}, false)`;
        }
      }
      break;
    }
    case "list": {
      const jest = `coalesce(jsonb_typeof(${v}) = 'array', false)`;
      // porownanie element po elemencie (NIE operator @>: dla list zagniezdzonych `[["a"]] @> ["a"]`
      // jest prawdziwe, a w TS nie; test parytetu to lapie)
      const el = () => `exists (select 1 from jsonb_array_elements(case when ${jest} then ${v} else '[]'::jsonb end) e(x) where e.x = ${p.dodaj(JSON.stringify(x), "jsonb")})`;
      switch (w.operator) {
        case "zawiera": return `(${jest} and ${el()})`;
        case "nie_zawiera": return `(${jest} and not ${el()})`;
        case "pusta": return `(${jest} and jsonb_array_length(case when ${jest} then ${v} else '[]'::jsonb end) = 0)`;
        case "niepusta": return `(${jest} and jsonb_array_length(case when ${jest} then ${v} else '[]'::jsonb end) > 0)`;
      }
      break;
    }
  }
  throw new Error(`filtr: nieobsługiwany operator ${w.operator} dla typu ${w.typPola}`);
}

/** Grupy AND, warunki OR; pusty filtr = `true`. */
export function kompilujFiltr(f: Filtr | null | undefined, z: ZrodloSql, p: Parametry, teraz: Date, k: KontekstFlowSql | null = null): string {
  if (!f || !f.grupy.length) return "true";
  return f.grupy.map((g) => `(${g.warunki.map((w) => kompilujWarunek(w, z, p, teraz, k)).join(" or ")})`).join(" and ");
}

/**
 * Jedyna produkcyjna droga do zapytania z filtrem (AD-2, AD-42): predykat tenanta sklada
 * helper, strukturalnie, jako pierwszy parametr - wolajacy nie moze go pominac ani podmienic.
 * `zrodloSql` to stala klauzula FROM z kodu (np. `metric_events e`), `alias` wskazuje tabele
 * z kolumna tenant_id. `kompilujFiltr` zwraca sam fragment i jest do uzytku wewnetrznego
 * (ten helper, testy parytetu).
 */
export function zapytanieFiltrowane(opcje: {
  kolumny: string;
  zrodloSql: string;
  alias: string;
  tenantId: string;
  filtr: Filtr | null | undefined;
  zrodlo: ZrodloSql;
  teraz: Date;
  koniec?: string;
  kontekst?: KontekstFlowSql | null;
  /** zawezenie do jednego wiersza (`alias.id = $n`), np. jednego profilu w silniku */
  idWiersza?: string;
}): { sql: string; parametry: unknown[] } {
  if (!/^[a-z_][a-z0-9_]*$/.test(opcje.alias)) throw new Error(`filtr: niedozwolony alias ${opcje.alias}`);
  const p = new Parametry([opcje.tenantId]);
  const jeden = opcje.idWiersza !== undefined ? ` and ${opcje.alias}.id = ${p.dodaj(opcje.idWiersza, "uuid")}` : "";
  const filtr = kompilujFiltr(opcje.filtr, opcje.zrodlo, p, opcje.teraz, opcje.kontekst ?? null);
  return {
    sql: `select ${opcje.kolumny} from ${opcje.zrodloSql} where ${opcje.alias}.tenant_id = $1::uuid${jeden} and (${filtr})${opcje.koniec ? ` ${opcje.koniec}` : ""}`,
    parametry: p.wartosci,
  };
}
