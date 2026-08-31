// Ustawia haslo istniejacego konta. Uzycie: npm run --silent ... albo tsx scripts/ustaw-haslo.ts email haslo
import { getPool, closePool } from "../src/adapters/db/pool";
import { zahaszujHaslo } from "../src/usecases/auth/hasla";

const [email, haslo] = process.argv.slice(2);
if (!email || !haslo) {
  console.error("uzycie: ustaw-haslo.ts <email> <haslo>");
  process.exit(1);
}
const hash = await zahaszujHaslo(haslo);
const { rowCount } = await getPool().query(
  "update users set password_hash = $2 where lower(btrim(email)) = lower(btrim($1))",
  [email, hash],
);
console.log(rowCount ? "haslo ustawione" : "brak takiego konta");
await closePool();
