import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import type { DostawcaWysylki, Wiadomosc } from "../src/domain/email/port";
import { oglosZamykanie, zresetujZamykanieDlaTestow } from "../src/jobs/zamykanie";
import { wyslijPartie } from "../src/usecases/wysylka/wyslij-kampanie";

/**
 * Graceful shutdown workera (audyt 28.09, P1-3). Na SIGTERM worker przestaje zajmować
 * zadania, wysyłka kończy BIEŻĄCĄ wiadomość, a resztę zajętej partii oddaje do queued
 * (dostawca nie był dla niej wołany, więc nie ma ryzyka podwójnej wysyłki, AD-26),
 * zamyka pule i wychodzi w ≤ 30 s.
 */

const KATALOG = join(import.meta.dirname, "..");

describe("Zamykanie w środku partii wysyłki", () => {
  let tenantId: string;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name = 'ZAMYKANIE partia'");
    tenantId = (await pool.query("insert into tenants (name) values ('ZAMYKANIE partia') returning id")).rows[0].id;
  });

  afterEach(() => zresetujZamykanieDlaTestow());

  afterAll(async () => {
    await getPool().query("delete from tenants where id = $1", [tenantId]);
    await closePool();
  });

  it("SIGTERM po pierwszej wiadomości: 1 wysłana, reszta z powrotem w queued bez zużycia prób i limitu", async () => {
    const pool = getPool();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { rows } = await pool.query(
        `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
         values ($1, null, 'test', $2, $3, 'Temat', '<p>x</p>', $4, $5) returning id`,
        [tenantId, randomUUID(), `zamykanie-${i}@example.test`, randomBytes(18).toString("base64url"), randomBytes(18).toString("base64url")],
      );
      ids.push(rows[0].id);
    }
    const wyslane: Wiadomosc[] = [];
    let zamknieto = false;
    const dostawca: DostawcaWysylki = {
      nazwa: "atrapa-zamykanie",
      async wyslij(w) {
        wyslane.push(w);
        // sygnał przychodzi W TRAKCIE rozmowy z dostawcą o pierwszej wiadomości
        oglosZamykanie();
        return { providerId: `<${w.idempotencyKey}@atrapa>`, providerMessageId: `atrapa-${w.idempotencyKey}` };
      },
      async zamknij() {
        zamknieto = true;
      },
    };

    const wynik = await wyslijPartie(tenantId, { limit: 5, dostawca });
    expect(wynik).toMatchObject({ wyslane: 1, powodZatrzymania: "zamykanie" });
    expect(wyslane).toHaveLength(1);
    // pula SMTP zamknięta także przy przerwanej partii
    expect(zamknieto).toBe(true);

    const { rows } = await pool.query(
      "select id, current_state, claimed_at, attempts, provider_message_id from messages where tenant_id = $1 order by created_at",
      [tenantId],
    );
    const stany = rows.map((r) => r.current_state);
    expect(stany.filter((s) => s === "sent")).toHaveLength(1);
    expect(stany.filter((s) => s === "queued")).toHaveLength(4);
    for (const r of rows.filter((r) => r.current_state === "queued")) {
      expect(r.claimed_at).toBeNull();
      expect(r.attempts).toBe(0);
    }
    // ID dostawcy z odpowiedzi zapisane przy wysłanej
    expect(rows.find((r) => r.current_state === "sent")?.provider_message_id).toMatch(/^atrapa-/);
    // limit dobowy: zarezerwowana wyłącznie wysłana wiadomość
    const { rows: uzycie } = await pool.query("select used from tenant_send_usage where tenant_id = $1 and day = current_date", [tenantId]);
    expect(uzycie[0]?.used).toBe(1);

    // po „restarcie" (flaga zdjęta) reszta wychodzi, a pierwsza NIE drugi raz
    zresetujZamykanieDlaTestow();
    const drugi = await wyslijPartie(tenantId, { limit: 5, dostawca: { ...dostawca, async wyslij(w) { wyslane.push(w); return { providerId: `<${w.idempotencyKey}@atrapa>` }; } } });
    expect(drugi.wyslane).toBe(4);
    expect(new Set(wyslane.map((w) => w.idempotencyKey)).size).toBe(5);
    expect(wyslane).toHaveLength(5);
  });

  it("zamykany proces nie zajmuje nowej partii (nic nie przechodzi w claimed)", async () => {
    const pool = getPool();
    await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
       values ($1, null, 'test', $2, 'zamykanie-x@example.test', 'Temat', '<p>x</p>', $3, $4)`,
      [tenantId, randomUUID(), randomBytes(18).toString("base64url"), randomBytes(18).toString("base64url")],
    );
    oglosZamykanie();
    const wynik = await wyslijPartie(tenantId, { limit: 5, dostawca: { nazwa: "x", async wyslij() { throw new Error("nie wolno wołać"); } } });
    expect(wynik.powodZatrzymania).toBe("zamykanie");
    const { rows } = await pool.query("select count(*)::int as ile from messages where tenant_id = $1 and current_state = 'claimed'", [tenantId]);
    expect(rows[0].ile).toBe(0);
  });
});

describe("Proces workera: SIGTERM → czyste wyjście w ≤ 30 s", () => {
  it("wychodzi z kodem 0, oznacza heartbeat jako zamykany i nie zostawia zadania w running", async () => {
    const start = new Date();
    const dziecko = spawn(process.execPath, ["--import", "tsx", join("src", "jobs", "worker.ts")], {
      cwd: KATALOG,
      env: { ...process.env, MIDREV_SANDBOX: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    dziecko.stdout.on("data", (d) => (log += d.toString()));
    dziecko.stderr.on("data", (d) => (log += d.toString()));
    const koniec = new Promise<{ kod: number | null; ms: number }>((r) => {
      let t0 = 0;
      dziecko.on("exit", (kod) => r({ kod, ms: t0 ? Date.now() - t0 : -1 }));
      const czekaj = setInterval(() => {
        if (/\] gotowy/.test(log) && !t0) {
          clearInterval(czekaj);
          t0 = Date.now();
          dziecko.kill("SIGTERM");
        }
      }, 50);
      setTimeout(() => clearInterval(czekaj), 45_000);
    });
    const { kod, ms } = await koniec;
    const workerId = /\[(worker-[0-9a-f]{8})\]/.exec(log)?.[1];
    try {
      expect(log, log.slice(-2000)).toMatch(/SIGTERM: zamykanie/);
      expect(log).toMatch(/zamknięty czysto/);
      expect(kod).toBe(0);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(30_000);
      expect(workerId).toBeTruthy();
      const pool = getPool();
      const { rows: hb } = await pool.query("select stopping_at from worker_heartbeats where worker_id = $1", [workerId]);
      expect(hb[0]?.stopping_at).not.toBeNull();
      const { rows: biegnace } = await pool.query("select count(*)::int as ile from jobs where status = 'running' and locked_by = $1", [workerId]);
      expect(biegnace[0].ile).toBe(0);
    } finally {
      // sprzątanie: zadania cykliczne zaplanowane przez ten proces nie mają zostać w kolejce testów
      const pool = getPool();
      await pool.query(
        "delete from jobs where created_at >= $1 and status = 'pending' and kind in ('automatyzacje_tik', 'rekoncyliacja', 'reputacja', 'odbicia_imap', 'odbicia')",
        [start],
      );
      if (workerId) await pool.query("delete from worker_heartbeats where worker_id = $1", [workerId]);
      await closePool();
    }
  }, 60_000);
});
