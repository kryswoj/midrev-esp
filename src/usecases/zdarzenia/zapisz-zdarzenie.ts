import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import {
  czyBackfill,
  type WejscieZdarzenia,
  type WynikZapisuZdarzenia,
  type ZrodloZdarzenia,
} from "../../domain/zdarzenia/kontrakt";
import { MAKS_UNIQUE_ID, naMinor, sprawdzCzas, sprawdzWlasciwosci } from "../../domain/zdarzenia/limity";
import { metrykaPoKluczu } from "./metryki";
import { toBrakPartycji } from "./partycje";

/**
 * JEDYNY zapis do strumienia `metric_events` (AD-36). Wołany w transakcji zapisu
 * źródłowego (popup, zamówienie, API), więc wiersz strumienia i zapis źródła wchodzą
 * razem albo wcale.
 *
 * Kolejność (plan 1.2):
 *   1. limity (400 właściwości, 100 KB na napis, czas 1990 … +1 rok, unique_id ≤ 255),
 *   2. metryka w locie (limit 200 na tenanta, `metryki.ts`),
 *   3. deduplikacja AD-38: `event_keys` z `on conflict do nothing`; brak wiersza =
 *      duplikat, zwracamy istniejące zdarzenie (cichy sukces). Klucz NIE zawiera czasu,
 *      więc retry n8n z tym samym unique_id i nowym `time` trafia w ten sam klucz,
 *   4. insert do strumienia; miesiąc bez partycji = założenie W TEJ transakcji i JEDNO
 *      ponowienie. Osobne połączenie tu nie działa: nowa partycja dostaje klucze obce do
 *      metrics/profiles, a ta transakcja zwykle trzyma już blokady wierszy tych tabel
 *      (profil z popupu, metryka w locie) - drugie połączenie czekałoby na nas samych.
 *      Wołający, którzy mogą (worker API, import), zakładają partycję PRZED transakcją
 *      (`zapewnijPartycjeMiesiaca`), więc ta ścieżka jest rzadka,
 *   5. odczyt ZWROTNY zapisanego `occurred_at` (lista kontrolna pkt 3): baza ma trzymać
 *      czas ze źródła, a nie coś, co po drodze zmieniła strefa albo rzutowanie,
 *   6. `metrics.first/last_seen_at` bez gorącego wiersza: update tylko, gdy czas przesuwa
 *      się o ≥ 1 min albo cofa pierwsze wystąpienie.
 *
 * Deduplikację przez `event_keys` dostają źródła zewnętrzne (api, client, webhook, import),
 * także bez profilu (gość). Zdarzenia systemowe deduplikują tabele źródłowe.
 *
 * `lustro`: na czas przejścia (wydanie N) zdarzenia starych typów lądują TEŻ w tabeli
 * `events` z tym samym `id` i czasem, żeby obecny silnik automatyzacji, licznik popupów
 * i widoki czytające `events` działały, dopóki nie przejdą na strumień (kontrakt A-B, §5).
 */

/** Błąd deterministyczny (złe dane): ponawianie niczego nie zmieni. */
export class BladZdarzenia extends Error {
  constructor(
    message: string,
    public readonly wskaznik: string = "",
  ) {
    super(message);
  }
}

const ZEWNETRZNE: ReadonlySet<ZrodloZdarzenia> = new Set(["api", "client", "webhook", "import"]);

export interface OpcjeZapisu {
  /** lustro w starej tabeli `events` (typ i payload w starym kształcie) */
  lustro?: { eventType: string; payload: Record<string, unknown> };
}

export function obetnijDoSekundy(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

export async function zapiszZdarzenie(
  klient: PoolClient,
  w: WejscieZdarzenia,
  opcje: OpcjeZapisu = {},
): Promise<WynikZapisuZdarzenia> {
  // 1. limity
  if (!(w.occurredAt instanceof Date) || Number.isNaN(w.occurredAt.getTime())) {
    throw new BladZdarzenia("niepoprawny czas zdarzenia", "/data/attributes/time");
  }
  const occurredAt = obetnijDoSekundy(w.occurredAt);
  const ingestedAt = w.ingestedAt ?? new Date();
  const bladCzasu = sprawdzCzas(occurredAt, ingestedAt.getTime());
  if (bladCzasu) throw new BladZdarzenia(bladCzasu, "/data/attributes/time");
  const properties = w.properties ?? {};
  const naruszenie = sprawdzWlasciwosci(properties);
  if (naruszenie) throw new BladZdarzenia(naruszenie.opis, `/data/attributes/properties${naruszenie.wskaznik}`);
  const uniqueId = (w.uniqueId ?? "").trim() || String(Math.floor(occurredAt.getTime() / 1000));
  if (uniqueId.length > MAKS_UNIQUE_ID) throw new BladZdarzenia("unique_id dłuższe niż 255 znaków", "/data/attributes/unique_id");

  // 2. metryka w locie
  const metryka = await metrykaPoKluczu(klient, w.tenantId, w.metryka, {
    utworz: true,
    wbudowana: w.metryka.wbudowana,
    mozeWyzwalac: w.metryka.mozeWyzwalac,
    ukryta: w.metryka.ukryta,
  });
  if (!metryka) throw new Error("metryka nie powstała");

  // kwota: jawna w minor albo `$value` z właściwości wg wykładnika waluty
  let waluta = w.valueCurrency ? w.valueCurrency.toUpperCase() : null;
  let valueMinor: bigint | null = null;
  if (w.valueMinor !== undefined && w.valueMinor !== null) {
    valueMinor = BigInt(w.valueMinor);
  } else if (properties.$value !== undefined && properties.$value !== null) {
    if (!waluta) waluta = await walutaTenanta(klient, w.tenantId);
    valueMinor = naMinor(properties.$value, waluta);
  }
  if (valueMinor !== null && !waluta) waluta = await walutaTenanta(klient, w.tenantId);
  if (valueMinor === null) waluta = null;
  if (waluta !== null && !/^[A-Z]{3}$/.test(waluta)) {
    throw new BladZdarzenia("waluta musi być kodem ISO 4217", "/data/attributes/value_currency");
  }

  const backfill = czyBackfill({ flaga: w.backfill === true, source: w.source, occurredAt, ingestedAt });
  const id = w.id ?? uuidv7();

  // 3. deduplikacja AD-38
  if (ZEWNETRZNE.has(w.source)) {
    const klucz = await klient.query(
      `insert into event_keys (tenant_id, metric_id, profile_id, unique_id, event_id, occurred_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict on constraint event_keys_klucz do nothing
       returning event_id`,
      [w.tenantId, metryka.id, w.profileId, uniqueId, id, occurredAt],
    );
    if (!klucz.rowCount) {
      // klucz ma FK do zdarzenia (0030), więc istniejący klucz = istniejące zdarzenie
      const { rows } = await klient.query<{ event_id: string; occurred_at: Date; backfill: boolean }>(
        `select k.event_id, k.occurred_at, e.backfill
           from event_keys k
           join metric_events e on e.tenant_id = k.tenant_id and e.occurred_at = k.occurred_at and e.id = k.event_id
          where k.tenant_id = $1 and k.metric_id = $2 and k.profile_id is not distinct from $3 and k.unique_id = $4`,
        [w.tenantId, metryka.id, w.profileId, uniqueId],
      );
      if (!rows[0]) throw new Error("klucz deduplikacji bez zdarzenia (równoległy zapis wycofany) - ponów");
      return { id: rows[0].event_id, occurredAt: rows[0].occurred_at, metricId: metryka.id, duplikat: true, backfill: rows[0].backfill };
    }
  }

  // 4. zapis do strumienia (z jednym ponowieniem po założeniu brakującej partycji)
  const parametry = [
    id,
    w.tenantId,
    metryka.id,
    w.profileId,
    occurredAt,
    ingestedAt,
    uniqueId,
    valueMinor === null ? null : valueMinor.toString(),
    waluta,
    JSON.stringify(properties),
    w.source,
    backfill,
    w.messageId ?? null,
  ];
  const sql = `insert into metric_events (id, tenant_id, metric_id, profile_id, occurred_at, ingested_at,
                 unique_id, value_minor, value_currency, properties, source, backfill, message_id)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
               returning occurred_at, backfill`;
  let zapisane;
  await klient.query("savepoint zapis_zdarzenia");
  try {
    zapisane = await klient.query<{ occurred_at: Date; backfill: boolean }>(sql, parametry);
    await klient.query("release savepoint zapis_zdarzenia");
  } catch (blad) {
    await klient.query("rollback to savepoint zapis_zdarzenia");
    if (!toBrakPartycji(blad)) throw blad;
    await zalozPartycjeWTransakcji(klient, occurredAt);
    zapisane = await klient.query<{ occurred_at: Date; backfill: boolean }>(sql, parametry);
  }

  // 5. odczyt zwrotny czasu zdarzenia
  const zapisanyCzas = zapisane.rows[0]?.occurred_at;
  if (!zapisanyCzas || zapisanyCzas.getTime() !== occurredAt.getTime()) {
    throw new Error(
      `zapisany czas zdarzenia ${zapisanyCzas?.toISOString() ?? "brak"} różni się od źródła ${occurredAt.toISOString()} - transakcja wycofana`,
    );
  }

  // 6. pierwsze/ostatnie wystąpienie metryki (bez gorącego wiersza przy każdym zdarzeniu)
  await klient.query(
    `update metrics set last_seen_at = greatest(coalesce(last_seen_at, $3), $3),
                        first_seen_at = least(coalesce(first_seen_at, $3), $3)
      where tenant_id = $1 and id = $2
        and (last_seen_at is null or first_seen_at is null
             or last_seen_at < $3::timestamptz - interval '1 minute' or first_seen_at > $3)`,
    [w.tenantId, metryka.id, occurredAt],
  );

  if (opcje.lustro) {
    await klient.query(
      `insert into events (id, tenant_id, profile_id, event_type, payload, occurred_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, w.tenantId, w.profileId, opcje.lustro.eventType, JSON.stringify(opcje.lustro.payload), occurredAt],
    );
  }

  return { id, occurredAt, metricId: metryka.id, duplikat: false, backfill: zapisane.rows[0].backfill };
}

async function walutaTenanta(klient: PoolClient, tenantId: string): Promise<string> {
  const { rows } = await klient.query<{ currency: string }>("select currency from tenants where id = $1", [tenantId]);
  return rows[0]?.currency ?? "PLN";
}

/**
 * Partycja zakładana w TEJ transakcji (patrz punkt 4). Krótki limit blokady, po nim
 * przywrócenie poprzedniego ustawienia transakcji. Silna blokada strumienia trzymana jest
 * do końca tej transakcji: dotyczy tylko miesiąca, którego jeszcze nie było.
 */
async function zalozPartycjeWTransakcji(klient: PoolClient, kiedy: Date): Promise<void> {
  const { rows } = await klient.query<{ lt: string }>("select current_setting('lock_timeout') as lt");
  await klient.query("savepoint partycja_zdarzenia");
  try {
    await klient.query("set local lock_timeout = '5s'");
    await klient.query("select metric_events_zapewnij_partycje($1, $1)", [kiedy]);
    await klient.query("release savepoint partycja_zdarzenia");
  } catch (blad) {
    await klient.query("rollback to savepoint partycja_zdarzenia");
    throw blad;
  } finally {
    await klient.query("select set_config('lock_timeout', $1, true)", [rows[0].lt]);
  }
}
