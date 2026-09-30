import type { Pool, PoolClient } from "pg";
import { getPool } from "../../adapters/db/pool";
import {
  predykatWyzwalaniaSql,
  type IntegracjaMetryki,
  type ParametrySkanu,
  type ZapisaneZdarzenie,
  type ZrodloZdarzenia,
} from "../../domain/zdarzenia/kontrakt";

/**
 * Odczyt strumienia `metric_events`. Każde zapytanie ma predykat tenant_id (AD-2),
 * identyfikatory z zewnątrz są szukane w granicach tenanta (AD-40).
 */

type Db = Pool | PoolClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Wiersz {
  id: string;
  tenant_id: string;
  metric_id: string;
  profile_id: string | null;
  occurred_at: Date;
  recorded_at: Date;
  ingested_at: Date;
  unique_id: string;
  value_minor: string | null;
  value_currency: string | null;
  properties: Record<string, unknown>;
  source: ZrodloZdarzenia;
  backfill: boolean;
  message_id: string | null;
}

const KOLUMNY = `e.id, e.tenant_id, e.metric_id, e.profile_id, e.occurred_at, e.recorded_at, e.ingested_at,
  e.unique_id, e.value_minor::text as value_minor, e.value_currency, e.properties, e.source, e.backfill, e.message_id`;

function naZdarzenie(w: Wiersz): ZapisaneZdarzenie {
  return {
    id: w.id,
    tenantId: w.tenant_id,
    metricId: w.metric_id,
    profileId: w.profile_id,
    occurredAt: w.occurred_at,
    recordedAt: w.recorded_at,
    ingestedAt: w.ingested_at,
    uniqueId: w.unique_id,
    valueMinor: w.value_minor,
    valueCurrency: w.value_currency,
    properties: w.properties,
    source: w.source,
    backfill: w.backfill,
    messageId: w.message_id,
  };
}

/**
 * Skan wejść dla silnika automatyzacji (kontrakt A-B, plan 2.6): zdarzenia metryki
 * zapisane po `recordedPo`, z czasem od `occurredOd` (przycina partycje), WYŁĄCZNIE
 * spełniające regułę wyzwalania. Kolejność (recorded_at, id), limit domyślnie 1000.
 */
export async function zdarzeniaDoSkanu(db: Db, p: ParametrySkanu): Promise<ZapisaneZdarzenie[]> {
  if (!UUID.test(p.metricId)) return [];
  const limit = Math.min(Math.max(1, Math.floor(p.limit ?? 1000)), 10_000);
  const { rows } = await db.query<Wiersz>(
    `select ${KOLUMNY}
       from metric_events e
      where e.tenant_id = $1 and e.metric_id = $2
        and e.recorded_at > $3 and e.occurred_at >= $4
        and ${predykatWyzwalaniaSql("e")}
      order by e.recorded_at, e.id
      limit $5`,
    [p.tenantId, p.metricId, p.recordedPo, p.occurredOd, limit],
  );
  return rows.map(naZdarzenie);
}

/** Jedno zdarzenie po kluczu (tenant, occurred_at, id); cudze albo brak = null. */
export async function zdarzeniePoId(db: Db, tenantId: string, id: string, occurredAt: Date): Promise<ZapisaneZdarzenie | null> {
  if (!UUID.test(id) || Number.isNaN(occurredAt.getTime())) return null;
  const { rows } = await db.query<Wiersz>(
    `select ${KOLUMNY} from metric_events e where e.tenant_id = $1 and e.occurred_at = $2 and e.id = $3`,
    [tenantId, occurredAt, id],
  );
  return rows[0] ? naZdarzenie(rows[0]) : null;
}

// ── Oś czasu profilu (E6 / 6.4, MVP) ────────────────────────────────────────────

export const MAKS_METRYK_FILTRA = 5;
export const ROZMIAR_STRONY_OSI = 50;

export interface WpisOsi {
  id: string;
  occurredAt: Date;
  metricId: string;
  nazwa: string;
  integracja: IntegracjaMetryki;
  source: ZrodloZdarzenia;
  valueMinor: string | null;
  valueCurrency: string | null;
  /** liczba właściwości top-level (pełne properties ładowane leniwie) */
  wlasciwosci: number;
}

export interface KursorOsi {
  occurredAt: string;
  id: string;
}

function dzienAlboNull(d: string | null | undefined): string | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return Number.isNaN(new Date(`${d}T00:00:00Z`).getTime()) ? null : d;
}

export interface StronaOsi {
  wpisy: WpisOsi[];
  nastepna: KursorOsi | null;
}

/**
 * Oś czasu profilu ze strumienia: filtr do 5 metryk, zakres dat, kursor po
 * (occurred_at, id) malejąco, strony po 50. Properties NIE są czytane tutaj (mogą mieć
 * megabajty); rozwinięcie wpisu idzie przez `wlasciwosciZdarzenia`.
 */
export async function osProfilu(
  tenantId: string,
  profileId: string,
  /** `odDnia`/`doDnia`: RRRR-MM-DD, dzień w strefie tenanta (tenants.timezone), `doDnia` włącznie */
  opcje: { metryki?: string[]; odDnia?: string | null; doDnia?: string | null; kursor?: KursorOsi | null; limit?: number } = {},
  db: Db = getPool(),
): Promise<StronaOsi> {
  if (!UUID.test(profileId)) return { wpisy: [], nastepna: null };
  const metryki = (opcje.metryki ?? []).filter((m) => UUID.test(m)).slice(0, MAKS_METRYK_FILTRA);
  const limit = Math.min(Math.max(1, Math.floor(opcje.limit ?? ROZMIAR_STRONY_OSI)), 200);
  const kursor =
    opcje.kursor && UUID.test(opcje.kursor.id) && !Number.isNaN(new Date(opcje.kursor.occurredAt).getTime())
      ? opcje.kursor
      : null;
  const { rows } = await db.query<{
    id: string;
    occurred_at: Date;
    occurred_txt: string;
    metric_id: string;
    name: string;
    integration_key: IntegracjaMetryki;
    source: ZrodloZdarzenia;
    value_minor: string | null;
    value_currency: string | null;
    wlasciwosci: number;
  }>(
    `select e.id, e.occurred_at, e.occurred_at::text as occurred_txt, e.metric_id, m.name, m.integration_key, e.source,
            e.value_minor::text as value_minor, e.value_currency,
            (select count(*)::int from jsonb_object_keys(e.properties)) as wlasciwosci
       from metric_events e
       join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
      where e.tenant_id = $1 and e.profile_id = $2
        and (cardinality($3::uuid[]) = 0 or e.metric_id = any($3::uuid[]))
        and ($4::date is null or e.occurred_at >= ($4::date)::timestamp at time zone (select t.timezone from tenants t where t.id = $1))
        and ($5::date is null or e.occurred_at < ($5::date + 1)::timestamp at time zone (select t.timezone from tenants t where t.id = $1))
        and ($6::timestamptz is null or (e.occurred_at, e.id) < ($6::timestamptz, $7::uuid))
      order by e.occurred_at desc, e.id desc
      limit $8`,
    [tenantId, profileId, metryki, dzienAlboNull(opcje.odDnia), dzienAlboNull(opcje.doDnia), kursor?.occurredAt ?? null, kursor?.id ?? null, limit + 1],
  );
  const wiecej = rows.length > limit;
  const strona = rows.slice(0, limit);
  const ostatni = strona[strona.length - 1];
  return {
    wpisy: strona.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      metricId: r.metric_id,
      nazwa: r.name,
      integracja: r.integration_key,
      source: r.source,
      valueMinor: r.value_minor,
      valueCurrency: r.value_currency,
      wlasciwosci: r.wlasciwosci,
    })),
    nastepna: wiecej && ostatni ? { occurredAt: ostatni.occurred_txt, id: ostatni.id } : null,
  };
}

/**
 * Pełne properties jednego zdarzenia z osi, wyłącznie gdy zdarzenie należy do TEGO
 * profilu w TYM tenancie (AD-40): id zdarzenia z przeglądarki nie może otworzyć cudzych
 * danych nawet przy poprawnym tenancie.
 */
export async function wlasciwosciZdarzenia(
  tenantId: string,
  profileId: string,
  id: string,
  occurredAt: string,
  db: Db = getPool(),
): Promise<Record<string, unknown> | null> {
  if (!UUID.test(profileId) || !UUID.test(id) || Number.isNaN(new Date(occurredAt).getTime())) return null;
  const { rows } = await db.query<{ properties: Record<string, unknown> }>(
    `select properties from metric_events
      where tenant_id = $1 and occurred_at = $2::timestamptz and id = $3 and profile_id = $4`,
    [tenantId, occurredAt, id, profileId],
  );
  return rows[0]?.properties ?? null;
}
