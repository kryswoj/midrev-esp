import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPool, closePool } from "../src/adapters/db/pool";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

/**
 * Blokada doradcza na CAŁY przebieg migratora (audyt 28.09, P2-1; pakiet deploy). Dwa
 * równoległe `migrate` (dwa deploye, deploy + ręczne uruchomienie) wcześniej ścigały się
 * o ten sam plik i drugi kończył się błędem w połowie wdrożenia. Teraz drugi czeka, a po
 * zwolnieniu blokady czyta schema_migrations od nowa i nie ma już nic do zrobienia.
 * Klucz INNY niż w tests/global-setup.ts (7150415001): tamten trzyma swoją blokadę na
 * osobnym połączeniu przez cały czas działania migratora-dziecka, ten sam klucz dałby
 * zakleszczenie między procesami.
 */
const BLOKADA_MIGRATORA = "7150415029";
/** Ile najwyżej czekamy na drugi migrator, zanim uznamy, że wisi. */
const CZEKANIE_NA_BLOKADE = "10min";

async function ensureMigrationsTable(pool: ReturnType<typeof getPool>) {
  await pool.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function main() {
  const pool = getPool();
  // jedna sesja trzyma blokadę od początku do końca przebiegu (zwalniana w finally)
  const blokada = await pool.connect();
  try {
    await blokada.query(`set lock_timeout = '${CZEKANIE_NA_BLOKADE}'`);
    const { rows: wolna } = await blokada.query("select pg_try_advisory_lock($1::bigint) as mam", [BLOKADA_MIGRATORA]);
    if (!wolna[0].mam) {
      console.log("Inny migrator trzyma blokadę — czekam, aż skończy...");
      await blokada.query("select pg_advisory_lock($1::bigint)", [BLOKADA_MIGRATORA]);
    }
    await migruj(pool);
  } finally {
    await blokada.query("select pg_advisory_unlock($1::bigint)", [BLOKADA_MIGRATORA]).catch(() => {});
    blokada.release();
  }
  await closePool();
}

async function migruj(pool: ReturnType<typeof getPool>) {
  await ensureMigrationsTable(pool);

  // odczyt PO wzięciu blokady: drugi migrator widzi to, co zastosował pierwszy
  const applied = await pool.query<{ filename: string; checksum: string }>(
    "select filename, checksum from schema_migrations",
  );
  const appliedByFile = new Map(applied.rows.map((r) => [r.filename, r.checksum]));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let appliedCount = 0;

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const previousChecksum = appliedByFile.get(file);

    if (previousChecksum) {
      if (previousChecksum !== checksum) {
        throw new Error(
          `${file} was already applied with a different checksum — ` +
            `edit a NEW migration file instead of changing an applied one.`,
        );
      }
      continue;
    }

    console.log(`Applying ${file}...`);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        "insert into schema_migrations (filename, checksum) values ($1, $2)",
        [file, checksum],
      );
      await client.query("commit");
      appliedCount += 1;
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`Applied ${appliedCount} new migration(s), ${files.length} total.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
