import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { utrzymajPartycje } from "../src/jobs/partycje";

/**
 * Pułapka jobs_default (audyt 28.09, P1-8): Postgres nie pozwala założyć partycji na
 * zakres, dla którego partycja domyślna ma już wiersze. Worker wyłączony dłużej niż
 * zapas partycji = zadania w jobs_default, a po powrocie `create table … partition of`
 * rzucał na starcie i worker restartował się w kółko.
 *
 * Test odtwarza to wprost: zadanie z datą, dla której nie ma partycji (daleko w
 * przeszłości i w przyszłości), ląduje w jobs_default; utrzymanie ma założyć partycje,
 * PRZENIEŚĆ wiersze bez zmiany tożsamości (id, created_at) i nie rzucić.
 */

const DNI = [-400, 45];

describe("Utrzymanie partycji: zadania zalegające w jobs_default", () => {
  let tenantId: string;
  const nazwy: string[] = [];

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name = 'PARTYCJE default'");
    tenantId = (await pool.query("insert into tenants (name) values ('PARTYCJE default') returning id")).rows[0].id;
    for (const d of DNI) {
      const { rows } = await pool.query("select 'jobs_' || to_char(current_date + $1::int, 'YYYY_MM_DD') as n", [d]);
      nazwy.push(rows[0].n);
      // gdyby poprzedni przebieg zostawił partycję (awaria sprzątania), zaczynamy od zera
      if ((await pool.query("select to_regclass($1) as r", [rows[0].n])).rows[0].r) {
        await pool.query(`alter table jobs detach partition ${rows[0].n}`);
        await pool.query(`drop table ${rows[0].n}`);
      }
    }
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from jobs where tenant_id = $1", [tenantId]);
    for (const n of nazwy) {
      if ((await pool.query("select to_regclass($1) as r", [n])).rows[0].r) {
        await pool.query(`alter table jobs detach partition ${n}`);
        await pool.query(`drop table ${n}`);
      }
    }
    await pool.query("delete from tenants where id = $1", [tenantId]);
    await closePool();
  });

  it("wiersze z default trafiają do nowych partycji dziennych, tożsamość zadania bez zmian, bez wyjątku", async () => {
    const pool = getPool();
    const wstawione: { id: string; token: string; partycja: string }[] = [];
    for (const d of DNI) {
      const { rows } = await pool.query(
        `insert into jobs (tenant_id, kind, created_at, run_after)
         values ($1, 'kontrola_zgodnosci', (current_date + $2::int)::timestamptz + interval '3 hours', now())
         returning id, created_at::text as token, tableoid::regclass::text as partycja`,
        [tenantId, d],
      );
      wstawione.push(rows[0]);
    }
    // warunek wyjściowy: bez partycji dziennej zadanie siedzi w default (to jest awaria)
    expect(wstawione.every((w) => w.partycja === "jobs_default")).toBe(true);

    const wynik = await utrzymajPartycje({ dniWprzod: 14, retencjaDni: 14 });
    expect(wynik.bledy).toEqual([]);
    expect(wynik.przeniesione).toBeGreaterThanOrEqual(2);

    for (const [i, w] of wstawione.entries()) {
      const { rows } = await pool.query(
        "select tableoid::regclass::text as partycja, status from jobs where id = $1 and created_at = $2::timestamptz",
        [w.id, w.token],
      );
      // to samo zadanie (ten sam klucz), teraz we właściwej partycji dziennej
      expect(rows).toHaveLength(1);
      expect(rows[0].partycja).toBe(nazwy[i]);
      expect(rows[0].status).toBe("pending");
    }
    const { rows: wDefault } = await pool.query("select count(*)::int as ile from jobs_default where tenant_id = $1", [tenantId]);
    expect(wDefault[0].ile).toBe(0);

    // nowa partycja ma zaostrzony autovacuum jak pozostałe
    const { rows: opcje } = await pool.query("select reloptions from pg_class where relname = $1", [nazwy[1]]);
    expect((opcje[0].reloptions ?? []).join(",")).toContain("autovacuum_vacuum_scale_factor=0.02");

    // stara partycja z AKTYWNYM zadaniem nie jest usuwana przez retencję
    const drugi = await utrzymajPartycje({ dniWprzod: 14, retencjaDni: 14 });
    expect(drugi.bledy).toEqual([]);
    expect((await pool.query("select to_regclass($1) as r", [nazwy[0]])).rows[0].r).not.toBeNull();
  });

  it("zapas partycji do przodu to co najmniej 14 dni (panel może kolejkować bez workera)", async () => {
    await utrzymajPartycje();
    const { rows } = await getPool().query(
      "select count(*)::int as ile from generate_series(0, 14) i where to_regclass('jobs_' || to_char(current_date + i, 'YYYY_MM_DD')) is not null",
    );
    expect(rows[0].ile).toBe(15);
  });
});
