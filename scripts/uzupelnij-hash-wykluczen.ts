// Jednorazowe wypelnienie `suppressions.email_hash` dla wierszy sprzed migracji 0022.
// Bezpieczne do wielokrotnego uruchomienia: dotyka tylko wierszy bez hasza i z
// prawdziwym adresem (zaslepki po anonimizacji maja hasz od poczatku).
// Uzycie: node --env-file=.env --import tsx scripts/uzupelnij-hash-wykluczen.ts
import { getPool, closePool } from "../src/adapters/db/pool";
import { config } from "../src/config";
import { hashAdresu, kluczPochodnyOdSekretow } from "../src/adapters/hash-adresu";

// Hasz liczony kluczem, ktory za chwile sie zmieni (zerowy SECRETS_KEY z sandboxa
// albo brak wlasnego SUPPRESSION_HASH_KEY), to zaslepki do wyrzucenia - odmawiamy.
if (kluczPochodnyOdSekretow()) {
  console.error("odmowa: ustaw SUPPRESSION_HASH_KEY (openssl rand -hex 32) zanim policzysz hasze - klucz pochodny od SECRETS_KEY nie przezyje rotacji");
  process.exit(2);
}
if (/^0+$/.test(config().SUPPRESSION_HASH_KEY ?? "")) {
  console.error("odmowa: SUPPRESSION_HASH_KEY z samych zer");
  process.exit(2);
}

const pool = getPool();
const { rows } = await pool.query<{ id: string; email: string }>(
  "select id, email from suppressions where email_hash is null and email not like 'anonimizowano:%'",
);
let uzupelnione = 0;
for (const w of rows) {
  const { rowCount } = await pool.query(
    "update suppressions set email_hash = $2 where id = $1 and email_hash is null",
    [w.id, hashAdresu(w.email)],
  );
  uzupelnione += rowCount ?? 0;
}
// kontrola: hasz JEDNEGO znanego wiersza odczytany z bazy zgadza sie z policzonym teraz
if (rows.length) {
  const { rows: [kontrola] } = await pool.query<{ email: string; email_hash: string }>(
    "select email, email_hash from suppressions where id = $1",
    [rows[0].id],
  );
  if (kontrola.email_hash !== hashAdresu(kontrola.email)) {
    console.error(`KONTROLA NIE PRZESZLA: hasz w bazie dla wiersza ${rows[0].id} rozni sie od policzonego`);
    await closePool();
    process.exit(1);
  }
}
// licznik z odczytu zwrotnego, nie z liczby prob
const { rows: [stan] } = await pool.query<{ bez: number; z: number }>(
  "select count(*) filter (where email_hash is null)::int as bez, count(*) filter (where email_hash is not null)::int as z from suppressions",
);
console.log(`do uzupelnienia: ${rows.length}, uzupelnione w tym przebiegu: ${uzupelnione}, w bazie z haszem: ${stan.z}, bez hasza: ${stan.bez}`);
await closePool();
