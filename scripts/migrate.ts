import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPool, closePool } from "../src/adapters/db/pool";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

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
  await ensureMigrationsTable(pool);

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
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
