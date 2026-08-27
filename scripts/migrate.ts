import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPool, closePool } from "../src/db.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

async function main() {
  const pool = getPool();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    console.log(`Applying ${file}...`);
    await pool.query(sql);
  }

  console.log(`Applied ${files.length} migration(s).`);
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
