import { getPool } from "../../adapters/db/pool";
import { parsujDate, POLA_STANDARDOWE_PROFILU, type TypPola } from "../../domain/filtry";

/**
 * Katalog wlasciwosci do EdytorFiltra (E4b 4.11; zalazek katalogu z planu 1.4): pola, ktore
 * NAPRAWDE przychodza w zdarzeniach danej metryki (probka ostatnich 500 zdarzen z 90 dni)
 * i w profilach (probka 1000 ostatnio zmienionych), z typem wykrytym z danych i kilkoma
 * przykladowymi wartosciami. Operator wybiera pole z listy zamiast zgadywac nazwe; typ
 * podstawia sie sam. Tylko odczyt, wylacznie w granicach tenanta.
 */

export interface PoleKatalogu {
  klucz: string;
  typ: TypPola;
  /** ile razy pole wystapilo w probce */
  wystapien: number;
  przyklady: string[];
}

export interface KatalogWlasciwosci {
  zdarzenie: PoleKatalogu[];
  profil: PoleKatalogu[];
  /** automatyzacje tenanta (warunek "byl w automatyzacji") */
  flowy: { id: string; nazwa: string }[];
}

const TYPY_JSON: Record<string, TypPola> = { string: "string", number: "number", boolean: "boolean", array: "list" };

function zbierz(rows: { klucz: string; typ: string; n: number; przyklady: string[] | null }[]): PoleKatalogu[] {
  const pola = new Map<string, PoleKatalogu & { glosy: number }>();
  for (const r of rows) {
    const typJson = TYPY_JSON[r.typ];
    if (!typJson) continue; // obiekty i null: nie do filtrowania (Klaviyo filtruje tylko top-level)
    const przyklady = (r.przyklady ?? []).filter((x) => x !== null && x !== "").slice(0, 5);
    const typ: TypPola = typJson === "string" && przyklady.length > 0 && przyklady.every((x) => parsujDate(x) !== null) ? "date" : typJson;
    const juz = pola.get(r.klucz);
    if (!juz || r.n > juz.glosy) pola.set(r.klucz, { klucz: r.klucz, typ, wystapien: (juz?.wystapien ?? 0) + Number(r.n), przyklady, glosy: Number(r.n) });
    else juz.wystapien += Number(r.n);
  }
  return [...pola.values()].sort((a, b) => b.wystapien - a.wystapien || a.klucz.localeCompare(b.klucz)).map(({ glosy: _g, ...p }) => p);
}

export async function katalogWlasciwosci(tenantId: string, metryka: { integracja?: string; nazwa: string } | null): Promise<KatalogWlasciwosci> {
  const pool = getPool();
  const zdarzenie = metryka
    ? (await pool.query(
        `with ev as (
           select e.properties from metric_events e
             join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
            where e.tenant_id = $1 and m.name = $2 and ($3::text is null or m.integration_key = $3)
              and e.occurred_at >= now() - interval '90 days'
            order by e.occurred_at desc limit 500
         )
         select k.key as klucz, jsonb_typeof(k.value) as typ, count(*)::int as n,
                (array_agg(distinct left(k.value #>> '{}', 80)) filter (where jsonb_typeof(k.value) in ('string', 'number', 'boolean')))[1:6] as przyklady
           from ev, jsonb_each(case when jsonb_typeof(ev.properties) = 'object' then ev.properties else '{}'::jsonb end) k
          where left(k.key, 1) <> '$'
          group by k.key, jsonb_typeof(k.value)
          order by n desc limit 300`,
        [tenantId, metryka.nazwa, metryka.integracja ?? null],
      )).rows
    : [];
  const { rows: profil } = await pool.query(
    `with pr as (
       select properties from profiles where tenant_id = $1 and properties <> '{}'::jsonb
        order by updated_at desc nulls last limit 1000
     )
     select k.key as klucz, jsonb_typeof(k.value) as typ, count(*)::int as n,
            (array_agg(distinct left(k.value #>> '{}', 80)) filter (where jsonb_typeof(k.value) in ('string', 'number', 'boolean')))[1:6] as przyklady
       from pr, jsonb_each(case when jsonb_typeof(pr.properties) = 'object' then pr.properties else '{}'::jsonb end) k
      group by k.key, jsonb_typeof(k.value)
      order by n desc limit 300`,
    [tenantId],
  );
  const { rows: flowy } = await pool.query("select id, name from flows where tenant_id = $1 order by name limit 200", [tenantId]);
  const standard = new Set<string>(POLA_STANDARDOWE_PROFILU);
  return {
    zdarzenie: zbierz(zdarzenie),
    profil: zbierz(profil).filter((p) => !standard.has(p.klucz)),
    flowy: flowy.map((f) => ({ id: f.id, nazwa: f.name })),
  };
}
