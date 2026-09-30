import { spawn } from "node:child_process";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adresBazyTestowej } from "./baza-testowa";

/**
 * Dwa migratory naraz (deploy + ręczne uruchomienie) na PUSTEJ bazie. Bez blokady
 * doradczej oba próbowały zastosować 0001 i drugi padał w połowie wdrożenia. Z blokadą
 * drugi czeka, po zwolnieniu czyta schema_migrations od nowa i kończy z „0 new".
 * Osobna, tymczasowa baza *_test: główna baza testów zostaje nietknięta.
 */
const KATALOG = join(import.meta.dirname, "..");
const NAZWA = "midrev_esp_migrator_rownolegly_test";

function adresSerwisowy() {
  const u = new URL(adresBazyTestowej());
  u.pathname = "/postgres";
  return u.toString();
}
function adresTymczasowej() {
  const u = new URL(adresBazyTestowej());
  u.pathname = `/${NAZWA}`;
  return u.toString();
}

async function serwis(sql: string) {
  const k = new pg.Client({ connectionString: adresSerwisowy() });
  await k.connect();
  try {
    await k.query(sql);
  } finally {
    await k.end();
  }
}

function migrator(): Promise<{ kod: number | null; log: string }> {
  return new Promise((r) => {
    const d = spawn(process.execPath, ["--import", "tsx", join("scripts", "migrate.ts")], {
      cwd: KATALOG,
      env: { ...process.env, DATABASE_URL: adresTymczasowej(), MIDREV_SANDBOX: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    d.stdout.on("data", (x) => (log += x.toString()));
    d.stderr.on("data", (x) => (log += x.toString()));
    d.on("exit", (kod) => r({ kod, log }));
  });
}

// DROP/CREATE DATABASE wyłącznie na lokalnym sandboksie (review Codeksa r3), tak jak
// TEST_DB_RESET w global-setup: zdalna baza testowa = test pominięty, nie skasowany serwer
const LOKALNA = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(adresBazyTestowej()).hostname);

describe.skipIf(!LOKALNA)("Migrator: blokada doradcza na cały przebieg", () => {
  beforeAll(async () => {
    await serwis(`drop database if exists "${NAZWA}" with (force)`);
    await serwis(`create database "${NAZWA}"`);
  });
  afterAll(async () => {
    await serwis(`drop database if exists "${NAZWA}" with (force)`);
  });

  it("dwa równoległe przebiegi: oba kończą się sukcesem, każda migracja zastosowana dokładnie raz", async () => {
    const [a, b] = await Promise.all([migrator(), migrator()]);
    expect(a.kod, a.log).toBe(0);
    expect(b.kod, b.log).toBe(0);
    const zastosowane = [a.log, b.log].map((l) => Number(/Applied (\d+) new migration/.exec(l)?.[1] ?? -1)).sort((x, y) => x - y);
    // jeden zrobił wszystko, drugi nic — nie „po połowie" i nie z błędem
    expect(zastosowane[0]).toBe(0);
    expect(zastosowane[1]).toBeGreaterThanOrEqual(29);
    const k = new pg.Client({ connectionString: adresTymczasowej() });
    await k.connect();
    try {
      const { rows } = await k.query("select count(*)::int as ile, count(distinct filename)::int as rozne from schema_migrations");
      expect(rows[0].ile).toBe(zastosowane[1]);
      expect(rows[0].rozne).toBe(rows[0].ile);
      // blokada zwolniona po przebiegu
      const { rows: blok } = await k.query("select count(*)::int as ile from pg_locks where locktype = 'advisory' and objid = 7150415029 % 4294967296");
      expect(blok[0].ile).toBe(0);
    } finally {
      await k.end();
    }
  }, 120_000);
});
