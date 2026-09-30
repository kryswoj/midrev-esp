// globalSetup vitest: przed pierwszym plikiem testow zaklada baze testowa (jesli jej nie ma)
// i puszcza na niej WSZYSTKIE migracje tym samym migratorem co dev (scripts/migrate.ts,
// z ochrona checksum). Zero recznych krokow: nowa migracja w migrations/ wchodzi sama.
//
// TEST_DB_RESET=1 npm test  - kasuje i zaklada baze testowa od zera (np. gdy ktos
// poprawil niezacommitowana migracje i checksum przestal sie zgadzac). Dziala wylacznie
// na bazie *_test, tym samym zabezpieczeniem co reszta.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import pg from "pg";
import { adresBazyTestowej, KATALOG_PROJEKTU, nazwaBazy, wymagajBazyTestowej } from "./baza-testowa";
import { utrzymajPartycje } from "../src/jobs/partycje";

/** Klucz blokady doradczej: dwa rownolegle `npm test` nie migruja naraz tej samej bazy. */
const BLOKADA_MIGRACJI = 7_150_415_001;

function adresSerwisowy(adres: string): string {
  const url = new URL(adres);
  url.pathname = "/postgres";
  return url.toString();
}

async function zapewnijBaze(adres: string, nazwa: string, reset: boolean) {
  // DROP DATABASE tylko na lokalnym sandboksie (review Codeksa r2): sama nazwa *_test nie
  // chroni przed zdalnym klonem o tej samej nazwie
  if (reset && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(adres).hostname)) {
    throw new Error(`[testy] TEST_DB_RESET=1 działa wyłącznie na lokalnej bazie, a TEST_DATABASE_URL wskazuje host ${new URL(adres).hostname}`);
  }
  // nazwa idzie do DDL bez parametru ($1 nie dziala w CREATE DATABASE), wiec dopuszczamy
  // wylacznie bezpieczny identyfikator - to samo, co przepuscil wymagajBazyTestowej
  if (!/^[a-z0-9_]+_test$/.test(nazwa)) throw new Error(`[testy] niedozwolona nazwa bazy testowej: ${nazwa}`);
  const klient = new pg.Client({ connectionString: adresSerwisowy(adres) });
  await klient.connect();
  try {
    if (reset) {
      console.log(`[testy] TEST_DB_RESET=1: kasuje baze ${nazwa} i zakladam od zera`);
      await klient.query(`drop database if exists "${nazwa}" with (force)`);
    }
    const { rowCount } = await klient.query("select 1 from pg_database where datname = $1", [nazwa]);
    if (!rowCount) {
      try {
        await klient.query(`create database "${nazwa}"`);
        console.log(`[testy] zalozona baza ${nazwa}`);
      } catch (blad: any) {
        // rownolegly przebieg zalozyl ja w tej samej chwili - to nie blad
        if (blad?.code !== "42P04") throw blad;
      }
    }
  } finally {
    await klient.end();
  }
}

function migruj(adres: string) {
  const wynik = spawnSync(process.execPath, ["--import", "tsx", join("scripts", "migrate.ts")], {
    cwd: KATALOG_PROJEKTU,
    env: { ...process.env, DATABASE_URL: adres },
    encoding: "utf-8",
  });
  const wyjscie = `${wynik.stdout ?? ""}${wynik.stderr ?? ""}`.trim();
  if (wynik.status !== 0) {
    throw new Error(
      `[testy] migracje bazy testowej nie przeszly (kod ${wynik.status}).\n${wyjscie}\n` +
        `Jesli to rozjazd checksum po edycji niezacommitowanej migracji: TEST_DB_RESET=1 npm test`,
    );
  }
  const podsumowanie = wyjscie.split("\n").filter((l) => l.startsWith("Applying") || l.startsWith("Applied"));
  for (const linia of podsumowanie) console.log(`[testy] migracje: ${linia}`);
}

export default async function globalSetup() {
  const adres = wymagajBazyTestowej(adresBazyTestowej(), "globalSetup");
  const nazwa = nazwaBazy(adres);
  process.env.DATABASE_URL = adres;
  // migrator woła config(); bez flagi sandboxa guard produkcyjny odmówiłby startu
  process.env.MIDREV_SANDBOX = "1";

  await zapewnijBaze(adres, nazwa, process.env.TEST_DB_RESET === "1");

  // blokada trzymana na osobnym polaczeniu przez caly czas migracji w procesie potomnym
  const blokada = new pg.Client({ connectionString: adres });
  await blokada.connect();
  try {
    await blokada.query("select pg_advisory_lock($1)", [BLOKADA_MIGRACJI]);
    migruj(adres);
    // Partycje kolejki jak w workerze: w bazie testowej nikt ich nie utrzymywał, więc
    // dzisiejsze zadania lądowały w jobs_default (i czerwony migration-0002). Ta sama
    // funkcja co worker, łącznie z przeniesieniem zalegających wierszy z default.
    const pula = new pg.Pool({ connectionString: adres, max: 2 });
    try {
      const w = await utrzymajPartycje({ pool: pula });
      if (w.bledy.length) throw new Error(`[testy] utrzymanie partycji: ${w.bledy.join(" | ")}`);
      if (w.zalozone || w.przeniesione) console.log(`[testy] partycje: założone ${w.zalozone}, przeniesione z default ${w.przeniesione}`);
    } finally {
      await pula.end();
    }
  } finally {
    await blokada.query("select pg_advisory_unlock($1)", [BLOKADA_MIGRACJI]).catch(() => {});
    await blokada.end();
  }
}
