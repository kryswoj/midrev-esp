import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { closePool, getPool } from "../src/adapters/db/pool";
import { UUID_ZERO } from "../src/domain/automatyzacje/wyzwalanie";
import { katalogMetrykTabela, zrodloZdarzenMetricEvents } from "../src/usecases/automatyzacje/zrodlo-zdarzen";

// Adapter wyzwalaczy na strumieniu A (metric_events + metrics) sprawdzony na tabelach
// w ksztalcie z kontraktu A↔B (src/domain/zdarzenia/kontrakt.ts). Tabele zyja we wlasnym
// schemacie w transakcji wycofywanej na koncu: test dziala przed i po scaleniu migracji A.

const T = "01a00000-0000-7000-8000-0000000000a1";
const OBCY = "01a00000-0000-7000-8000-0000000000a2";
const P = "01a00000-0000-7000-8000-0000000000b1";

describe("zrodloZdarzenMetricEvents / katalogMetrykTabela (kontrakt A↔B)", () => {
  let k: pg.PoolClient;
  const id = (n: number) => `01a0eeee-0000-7000-8000-${String(n).padStart(12, "0")}`;

  beforeAll(async () => {
    k = await getPool().connect();
    await k.query("begin");
    await k.query("create schema kontrakt_b_test");
    await k.query("set local search_path = kontrakt_b_test, public");
    await k.query(`create table metrics (
      id uuid primary key, tenant_id uuid not null, name text not null, integration_key text not null,
      can_trigger boolean not null default true, hidden boolean not null default false)`);
    await k.query(`create table metric_events (
      id uuid not null, tenant_id uuid not null, metric_id uuid not null, profile_id uuid,
      occurred_at timestamptz not null, recorded_at timestamptz not null, ingested_at timestamptz not null,
      unique_id text not null default '', value_minor bigint, value_currency char(3),
      properties jsonb not null default '{}', source text not null, backfill boolean not null default false,
      message_id uuid, primary key (tenant_id, occurred_at, id))`);
    await k.query(
      `insert into metrics (id, tenant_id, name, integration_key, can_trigger, hidden) values
        ($1, $3, 'Quiz Ukończony', 'api', true, false),
        ($2, $3, 'Opened Email', 'midrev', false, false),
        ('01a0dddd-0000-7000-8000-000000000003', $3, 'rodo.eksport', 'midrev', false, true),
        ('01a0dddd-0000-7000-8000-000000000004', $4, 'Quiz Ukończony', 'api', true, false)`,
      ["01a0dddd-0000-7000-8000-000000000001", "01a0dddd-0000-7000-8000-000000000002", T, OBCY],
    );
    const ev = (n: number, o: { tenant?: string; metric?: string; profile?: string | null; minOccurred: number; minIngested?: number; minRecorded: number; source?: string; backfill?: boolean; props?: object; value?: number | null }) =>
      k.query(
        `insert into metric_events (id, tenant_id, metric_id, profile_id, occurred_at, recorded_at, ingested_at, source, backfill, properties, value_minor)
         values ($1, $2, $3, $4, date_trunc('second', now()) - make_interval(mins => $5), now() - make_interval(mins => $6), now() - make_interval(mins => $7), $8, $9, $10, $11)`,
        [id(n), o.tenant ?? T, o.metric ?? "01a0dddd-0000-7000-8000-000000000001", o.profile === undefined ? P : o.profile,
         o.minOccurred, o.minRecorded, o.minIngested ?? o.minRecorded, o.source ?? "api", o.backfill ?? false, JSON.stringify(o.props ?? {}), o.value ?? null],
      );
    await ev(1, { minOccurred: 10, minRecorded: 9, props: { ProductID: "1", OrderId: "01a0cccc-0000-7000-8000-000000000001" }, value: 19900 }); // wchodzi
    await ev(2, { minOccurred: 8, minRecorded: 7, backfill: true });                   // backfill
    await ev(3, { minOccurred: 8, minRecorded: 6, source: "import" });                 // import
    await ev(4, { minOccurred: 300, minRecorded: 5, minIngested: 5 });                 // dotarlo 4 h 55 min po fakcie
    await ev(5, { minOccurred: 300, minRecorded: 4, minIngested: 290 });               // worker zapisal pozno, dotarlo swiezo: wchodzi
    await ev(6, { minOccurred: 5, minRecorded: 3, profile: null });                    // gosc bez profilu
    await ev(7, { minOccurred: 5, minRecorded: 3, tenant: OBCY, metric: "01a0dddd-0000-7000-8000-000000000004" }); // inny tenant
    await ev(8, { minOccurred: 5, minRecorded: 2, metric: "01a0dddd-0000-7000-8000-000000000002" }); // inna metryka
    await ev(9, { minOccurred: 2, minRecorded: 1 });                                   // wchodzi
  });

  afterAll(async () => {
    await k.query("rollback");
    k.release();
    await closePool();
  });

  const zapytanie = (limit: number, kursor = { recordedAt: "2000-01-01T00:00:00Z", id: UUID_ZERO }) => ({
    tenantId: T,
    metryka: { integracja: "api", nazwa: "Quiz Ukończony" },
    zaszlePo: "2000-01-01T00:00:00Z",
    limit,
    zakres: { rodzaj: "nowe" as const, kursor, nieWczesniejNiz: "2000-01-01T00:00:00Z" },
  });

  it("zwraca tylko zdarzenia, które mogą wyzwolić (predykat z kontraktu), tego tenanta i tej metryki, w porządku (recorded_at, id)", async () => {
    const r = await zrodloZdarzenMetricEvents.kandydaci(k, zapytanie(100));
    expect(r.map((e) => e.id)).toEqual([id(1), id(5), id(9)]);
    expect(r[0].context).toEqual({ orderId: "01a0cccc-0000-7000-8000-000000000001", totalMinor: 19900 });
    expect(r[0].properties).toEqual({ ProductID: "1", OrderId: "01a0cccc-0000-7000-8000-000000000001" });
    expect(r[1].ingestedAtMs).toBeGreaterThan(r[1].occurredAtMs);
  });

  it("kursor (recorded_at, id) posuwa się naprzód przy limicie; zakładka czyta przed kursorem", async () => {
    const a = await zrodloZdarzenMetricEvents.kandydaci(k, zapytanie(2));
    expect(a.map((e) => e.id)).toEqual([id(1), id(5)]);
    const b = await zrodloZdarzenMetricEvents.kandydaci(k, zapytanie(2, { recordedAt: a[1].recordedAt, id: a[1].id }));
    expect(b.map((e) => e.id)).toEqual([id(9)]);
    const z = await zrodloZdarzenMetricEvents.kandydaci(k, {
      ...zapytanie(10),
      zakres: { rodzaj: "zakladka", od: "2000-01-01T00:00:00Z", kursor: { recordedAt: a[1].recordedAt, id: a[1].id } },
    });
    expect(z.map((e) => e.id)).toEqual([id(1), id(5)]);
  });

  it("właściwości zdarzenia do szablonu: w granicach tenanta, z kluczem partycji i bez", async () => {
    const [e] = await zrodloZdarzenMetricEvents.kandydaci(k, zapytanie(1));
    expect(await zrodloZdarzenMetricEvents.pobierzWlasciwosci(k, T, e.id, e.occurredAt)).toEqual(e.properties);
    expect(await zrodloZdarzenMetricEvents.pobierzWlasciwosci(k, T, e.id, null)).toEqual(e.properties);
    expect(await zrodloZdarzenMetricEvents.pobierzWlasciwosci(k, OBCY, e.id, null)).toBeNull();
    expect(await zrodloZdarzenMetricEvents.pobierzWlasciwosci(k, T, "nie-uuid", null)).toBeNull();
  });

  it("katalog: bez ukrytych, otwarcia nie mogą wyzwalać; id metryki tylko we własnym tenancie", async () => {
    const lista = await katalogMetrykTabela.lista(k, T);
    expect(lista.map((m) => `${m.integracja}|${m.nazwa}|${m.canTrigger}`).sort()).toEqual(["api|Quiz Ukończony|true", "midrev|Opened Email|false"]);
    expect(await zrodloZdarzenMetricEvents.idMetryki(k, T, { integracja: "api", nazwa: "Quiz Ukończony" })).toBe("01a0dddd-0000-7000-8000-000000000001");
    expect(await zrodloZdarzenMetricEvents.idMetryki(k, T, { integracja: "api", nazwa: "Nie ma" })).toBeNull();
  });
});
