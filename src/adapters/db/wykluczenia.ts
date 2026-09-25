import type { Pool, PoolClient } from "pg";
import { getPool } from "./pool";
import { hashAdresu, hasheAdresow, znormalizujAdres } from "../hash-adresu";

/**
 * JEDNO miejsce, ktore odpowiada, czy adres jest na globalnej liscie wykluczen
 * (odbicia, skargi; wspolna dla wszystkich tenantow). Trafienie ALBO po adresie,
 * ALBO po kluczowanym haszu (0022): po anonimizacji RODO wiersz nie ma adresu, a
 * blokada ma przezyc powrot tej samej osoby. Kazdy odczyt `suppressions` w kodzie
 * idzie tedy - rozne definicje w roznych ekranach rozjezdzalyby sie z bramka wysylki.
 */
export async function jestWykluczonyGlobalnie(
  email: string,
  wykonawca: Pool | PoolClient = getPool(),
): Promise<boolean> {
  const { rows } = await wykonawca.query<{ jest: boolean }>(
    `select exists (
       select 1 from suppressions s
        where lower(btrim(s.email)) = lower(btrim($1)) or s.email_hash = $2
     ) as jest`,
    [email, hashAdresu(email)],
  );
  return rows[0].jest;
}

/**
 * Wersja zbiorcza: zwraca ZNORMALIZOWANE adresy z podanej listy, ktore sa wykluczone.
 * Do ekranow i liczenia odbiorcow, gdzie sprawdzenie per adres byloby N zapytaniami.
 */
export async function wykluczoneGlobalnie(
  emaile: Array<string | null | undefined>,
  wykonawca: Pool | PoolClient = getPool(),
): Promise<Set<string>> {
  const adresy = emaile.filter((e): e is string => typeof e === "string" && e.length > 0);
  if (!adresy.length) return new Set();
  const znormalizowane = adresy.map(znormalizujAdres);
  const hasze = hasheAdresow(adresy);
  const haszDoAdresu = new Map(hasze.map((h, i) => [h, znormalizowane[i]]));
  const { rows } = await wykonawca.query<{ klucz: string; email_hash: string | null }>(
    `select lower(btrim(s.email)) as klucz, s.email_hash from suppressions s
      where lower(btrim(s.email)) = any($1::text[]) or s.email_hash = any($2::text[])`,
    [znormalizowane, hasze],
  );
  const wynik = new Set<string>();
  for (const r of rows) {
    const zHasza = r.email_hash ? haszDoAdresu.get(r.email_hash) : undefined;
    if (zHasza) wynik.add(zHasza);
    else if (znormalizowane.includes(r.klucz)) wynik.add(r.klucz);
  }
  return wynik;
}
