import type { Pool, PoolClient } from "pg";
import { getPool } from "../../adapters/db/pool";
import {
  KATEGORIA_INTEGRACJI,
  METRYKI_WBUDOWANE,
  type IntegracjaMetryki,
  type KluczMetryki,
  type Metryka,
} from "../../domain/zdarzenia/kontrakt";
import { MAKS_METRYK_NA_TENANTA, sprawdzNazweMetryki } from "../../domain/zdarzenia/limity";

/**
 * Metryki (AD-37): (tenant, integracja, nazwa), tworzone w locie przy pierwszym zdarzeniu.
 * Każde zapytanie ma predykat tenant_id (AD-2); metryka innego tenanta = null (AD-40).
 */

type Db = Pool | PoolClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Metryka odrzucona, bo tenant ma już 200 metryk (błąd deterministyczny, bez ponawiania). */
export class LimitMetryk extends Error {
  constructor(public readonly tenantId: string) {
    super(`tenant ma już ${MAKS_METRYK_NA_TENANTA} metryk - nowa metryka odrzucona`);
  }
}

interface WierszMetryki {
  id: string;
  tenant_id: string;
  integration_key: IntegracjaMetryki;
  name: string;
  builtin: boolean;
  can_trigger: boolean;
  hidden: boolean;
  first_seen_at: Date | null;
  last_seen_at: Date | null;
}

const KOLUMNY = "id, tenant_id, integration_key, name, builtin, can_trigger, hidden, first_seen_at, last_seen_at";

function naMetryke(w: WierszMetryki): Metryka {
  return {
    id: w.id,
    tenantId: w.tenant_id,
    integracja: w.integration_key,
    nazwa: w.name,
    wbudowana: w.builtin,
    mozeWyzwalac: w.can_trigger,
    ukryta: w.hidden,
    pierwszeZdarzenie: w.first_seen_at,
    ostatnieZdarzenie: w.last_seen_at,
  };
}

export interface OpcjeMetryki {
  /** utwórz, jeśli nie istnieje (w locie) */
  utworz?: boolean;
  wbudowana?: boolean;
  mozeWyzwalac?: boolean;
  ukryta?: boolean;
}

/**
 * Metryka po kluczu naturalnym. Z `utworz` zakłada ją, pilnując limitu 200 na tenanta:
 * licznik pod `pg_advisory_xact_lock(tenant)` TYLKO przy tworzeniu nowej (istniejąca
 * metryka nie płaci za blokadę). Tworzenie wymaga transakcji: przy `Pool` zakładamy
 * własną krótką transakcję.
 */
export async function metrykaPoKluczu(
  db: Db,
  tenantId: string,
  klucz: KluczMetryki,
  opcje: OpcjeMetryki = {},
): Promise<Metryka | null> {
  const nazwa = klucz.nazwa.trim();
  const blad = sprawdzNazweMetryki(nazwa);
  if (blad) throw new Error(blad);
  if (!(klucz.integracja in KATEGORIA_INTEGRACJI)) throw new Error(`nieznana integracja metryki: ${klucz.integracja}`);
  const { rows } = await db.query<WierszMetryki>(
    `select ${KOLUMNY} from metrics where tenant_id = $1 and integration_key = $2 and name = $3`,
    [tenantId, klucz.integracja, nazwa],
  );
  if (rows[0]) return naMetryke(rows[0]);
  if (!opcje.utworz) return null;

  if ("totalCount" in db) {
    // Pool: własna transakcja na czas blokady i wstawienia
    const klient = await db.connect();
    try {
      await klient.query("begin");
      const m = await utworzMetryke(klient, tenantId, { ...klucz, nazwa }, opcje);
      await klient.query("commit");
      return m;
    } catch (b) {
      await klient.query("rollback").catch(() => {});
      throw b;
    } finally {
      klient.release();
    }
  }
  return utworzMetryke(db, tenantId, { ...klucz, nazwa }, opcje);
}

async function utworzMetryke(
  klient: PoolClient,
  tenantId: string,
  klucz: KluczMetryki,
  opcje: OpcjeMetryki,
): Promise<Metryka> {
  await klient.query("select pg_advisory_xact_lock(hashtextextended('metrics:limit:' || $1::text, 0))", [tenantId]);
  // po blokadzie jeszcze raz: równoległa transakcja mogła ją właśnie założyć
  const { rows: juz } = await klient.query<WierszMetryki>(
    `select ${KOLUMNY} from metrics where tenant_id = $1 and integration_key = $2 and name = $3`,
    [tenantId, klucz.integracja, klucz.nazwa],
  );
  if (juz[0]) return naMetryke(juz[0]);
  // metryka wbudowana (ten sam klucz co w kontrakcie) dostaje swoje flagi, nawet gdy
  // wołający ich nie podał: „Placed Order” z Woo zawsze może wyzwalać, „rodo.*” nigdy
  const wbudowana = Object.values(METRYKI_WBUDOWANE).find(
    (d) => d.integracja === klucz.integracja && d.nazwa === klucz.nazwa,
  );
  const { rows: ile } = await klient.query<{ n: number }>(
    "select count(*)::int as n from metrics where tenant_id = $1",
    [tenantId],
  );
  if (ile[0].n >= MAKS_METRYK_NA_TENANTA) throw new LimitMetryk(tenantId);
  const { rows } = await klient.query<WierszMetryki>(
    `insert into metrics (tenant_id, name, integration_key, integration_category, builtin, can_trigger, hidden)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (tenant_id, integration_key, name) do nothing
     returning ${KOLUMNY}`,
    [
      tenantId,
      klucz.nazwa,
      klucz.integracja,
      KATEGORIA_INTEGRACJI[klucz.integracja],
      opcje.wbudowana ?? Boolean(wbudowana),
      opcje.mozeWyzwalac ?? wbudowana?.mozeWyzwalac ?? true,
      opcje.ukryta ?? wbudowana?.ukryta ?? false,
    ],
  );
  if (rows[0]) return naMetryke(rows[0]);
  // konflikt mimo blokady (inna ścieżka bez blokady, np. funkcja backfillu): odczyt
  const { rows: po } = await klient.query<WierszMetryki>(
    `select ${KOLUMNY} from metrics where tenant_id = $1 and integration_key = $2 and name = $3`,
    [tenantId, klucz.integracja, klucz.nazwa],
  );
  return naMetryke(po[0]);
}

/** Metryka po id w granicach tenanta; cudza albo śmieciowy id = null (AD-40). */
export async function metrykaPoId(db: Db, tenantId: string, metricId: string): Promise<Metryka | null> {
  if (!UUID.test(metricId)) return null;
  const { rows } = await db.query<WierszMetryki>(
    `select ${KOLUMNY} from metrics where tenant_id = $1 and id = $2`,
    [tenantId, metricId],
  );
  return rows[0] ? naMetryke(rows[0]) : null;
}

/** Metryki tenanta do list wyboru (wyzwalacz, filtr osi). Ukryte techniczne tylko na żądanie. */
export async function metrykiTenanta(
  tenantId: string,
  opcje: { takzeUkryte?: boolean } = {},
  db: Db = getPool(),
): Promise<Metryka[]> {
  const { rows } = await db.query<WierszMetryki>(
    `select ${KOLUMNY} from metrics
      where tenant_id = $1 and ($2::boolean or not hidden)
      order by integration_key, name`,
    [tenantId, opcje.takzeUkryte === true],
  );
  return rows.map(naMetryke);
}
