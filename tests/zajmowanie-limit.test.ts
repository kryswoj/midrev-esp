// Regresja poprawki 763ec70 (zajmowanie partii i zadań respektuje LIMIT), sprawdzona na
// PRAWDZIWYCH funkcjach produkcyjnych pod wrogim planem zapytania.
//
// Błąd: `update ... where (id, ..) in (select ... for update skip locked limit n)` przy planie
// „Nested Loop Semi Join” wykonuje podzapytanie na nowo dla każdego wiersza zewnętrznego
// i zajmuje WIĘCEJ niż n wierszy. Plan zależy od statystyk, więc w zwykłym przebiegu błąd
// wychodził „losowo” (harmonogram, wysylka-triaz-a). Tu wymuszamy ten plan ustawieniami
// planera w połączeniach puli (options w adresie bazy, zanim pula powstanie), więc test jest
// deterministyczny: stary kształt zapytania zajmuje wszystko, kod produkcyjny dokładnie n.
const WROGI_PLAN = [
  "enable_hashjoin=off",
  "enable_mergejoin=off",
  "enable_material=off",
  "enable_hashagg=off",
  "enable_sort=off",
  "enable_indexscan=off",
  "enable_bitmapscan=off",
];
{
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options", WROGI_PLAN.map((o) => `-c ${o}`).join(" "));
  process.env.DATABASE_URL = url.toString();
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import type { DostawcaWysylki } from "../src/domain/email/port";
import { zajmijZadanie } from "../src/jobs/kolejka";
import { wyslijPartie } from "../src/usecases/wysylka/wyslij-kampanie";

const PREFIKS = "ZAJLIM ";

class DostawcaAtrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  wyslane: string[] = [];
  async wyslij(w: { do: string; idempotencyKey: string }) {
    this.wyslane.push(w.do);
    return { providerId: `atrapa-${w.idempotencyKey}` };
  }
}

describe("Zajmowanie z LIMIT pod planem Nested Loop Semi Join", () => {
  let tenantId = "";

  beforeAll(async () => {
    const pool = getPool();
    const { rows } = await pool.query("select current_setting('enable_hashagg') as h, current_setting('enable_hashjoin') as j");
    expect(rows[0]).toEqual({ h: "off", j: "off" });
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantId = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "tenant"])).rows[0].id;
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  it("dowód, że plan jest wrogi: stary kształt `in (select ... skip locked limit 1)` zajmuje więcej niż 1", async () => {
    const klient = await getPool().connect();
    try {
      await klient.query("begin");
      await klient.query("insert into jobs (tenant_id, kind) select $1, 'zajlim_dowod' from generate_series(1, 5)", [tenantId]);
      const stary = `update jobs set status = 'running', locked_by = 'dowod'
                      where (id, created_at) in (select id, created_at from jobs where status = 'pending' and kind = 'zajlim_dowod'
                                                  order by run_after for update skip locked limit 1)`;
      const plan = (await klient.query(`explain ${stary}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan).toContain("Nested Loop Semi Join");
      const r = await klient.query(stary);
      expect(r.rowCount).toBeGreaterThan(1);
    } finally {
      await klient.query("rollback");
      klient.release();
    }
  });

  it("kolejka: zajmijZadanie zajmuje dokładnie jedno zadanie", async () => {
    const pool = getPool();
    await pool.query("insert into jobs (tenant_id, kind) select $1, 'zajlim_test' from generate_series(1, 5)", [tenantId]);
    const worker = `zajlim-${Date.now()}`;
    const z = await zajmijZadanie(worker);
    expect(z).not.toBeNull();
    const { rows } = await pool.query("select id, tenant_id, created_at from jobs where locked_by = $1 and status = 'running'", [worker]);
    try {
      expect(rows).toHaveLength(1);
    } finally {
      // zadanie innego pliku testów (kolejka jest globalna) wraca, jakby nikt go nie ruszał
      await pool.query(
        "update jobs set status = 'pending', locked_by = null, locked_at = null, attempts = attempts - 1 where locked_by = $1 and tenant_id <> $2",
        [worker, tenantId],
      );
    }
  });

  it("wysyłka: wyslijPartie z limitem 1 zajmuje i wysyła jedną wiadomość, reszta zostaje queued", async () => {
    const pool = getPool();
    await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
       select $1, null, 'test', gen_random_uuid(), 'zajlim-' || g || '@example.test', 'Limit', '<p>x</p>', gen_random_uuid()::text, gen_random_uuid()::text
         from generate_series(1, 5) g`,
      [tenantId],
    );
    const d = new DostawcaAtrapa();
    const w = await wyslijPartie(tenantId, { dostawca: d, limit: 1 });
    expect(w.wyslane).toBe(1);
    expect(d.wyslane).toHaveLength(1);
    const { rows } = await pool.query(
      "select current_state, count(*)::int as n from messages where tenant_id = $1 group by current_state order by current_state",
      [tenantId],
    );
    expect(rows).toEqual([{ current_state: "queued", n: 4 }, { current_state: "sent", n: 1 }]);
  });
});
