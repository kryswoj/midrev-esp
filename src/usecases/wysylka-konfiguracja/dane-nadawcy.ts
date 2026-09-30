import type { Pool, PoolClient } from "pg";
import { getPool } from "../../adapters/db/pool";

/**
 * Dane nadawcy do stopki maila (0029): nazwa firmy, adres pocztowy, NIP.
 *
 * Adres pocztowy w stopce każdej wiadomości marketingowej: CAN-SPAM go wymaga, Gmail i
 * Yahoo zalecają nadawcom masowym, a polska ustawa o świadczeniu usług drogą
 * elektroniczną wymaga danych identyfikujących usługodawcę. Lista kontrolna kampanii
 * blokuje wysyłkę bez adresu (lista-kontrolna.ts). Wartości wyłącznie z formularza
 * operatora — nigdy zgadywane ani uzupełniane domyślnymi.
 */
export interface DaneNadawcy {
  firma: string | null;
  adres: string | null;
  nip: string | null;
}

type Wynik = { ok: true } | { ok: false; blad: string };

/** NIP bez spacji i myślników, prefiks kraju wielkimi literami; `undefined` = niepoprawny, `null` = pusty. */
export function normalizujNip(surowy: string): string | null | undefined {
  const n = surowy.replace(/[\s-]+/g, "").toUpperCase();
  if (!n) return null;
  if (!/^[A-Z]{0,2}[0-9]{5,20}$/.test(n)) return undefined;
  // polski NIP (10 cyfr, z prefiksem PL albo bez): suma kontrolna łapie literówkę
  const cyfry = n.replace(/^PL/, "");
  if ((n.startsWith("PL") || /^[0-9]{10}$/.test(n)) && /^[0-9]{10}$/.test(cyfry)) {
    const wagi = [6, 5, 7, 2, 3, 4, 5, 6, 7];
    const suma = wagi.reduce((s, w, i) => s + w * Number(cyfry[i]), 0);
    if (suma % 11 === 10 || suma % 11 !== Number(cyfry[9])) return undefined;
  }
  return n;
}

export async function odczytajDaneNadawcy(tenantId: string, przez: Pool | PoolClient = getPool()): Promise<DaneNadawcy> {
  const { rows } = await przez.query(
    "select sender_company_name, sender_postal_address, sender_tax_id from tenants where id = $1",
    [tenantId],
  );
  const w = rows[0];
  return { firma: w?.sender_company_name ?? null, adres: w?.sender_postal_address ?? null, nip: w?.sender_tax_id ?? null };
}

export async function zapiszDaneNadawcy(
  tenantId: string,
  dane: { firma: string; adres: string; nip: string },
): Promise<Wynik> {
  const firma = dane.firma.replace(/[\r\n\x00]+/g, " ").replace(/\s+/g, " ").trim() || null;
  if (firma && firma.length > 200) return { ok: false, blad: "Nazwa firmy może mieć najwyżej 200 znaków." };
  // adres: linie zachowane (ulica / kod i miasto), puste linie i nadmiar spacji usunięte
  const adres =
    dane.adres
      .replace(/\x00/g, "")
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n") || null;
  if (adres && (adres.length < 5 || adres.length > 500)) return { ok: false, blad: "Adres pocztowy ma mieć od 5 do 500 znaków, np. ul. Przykładowa 1, 00-001 Warszawa." };
  const nip = normalizujNip(dane.nip);
  if (nip === undefined) return { ok: false, blad: "NIP jest niepoprawny (sprawdź cyfry; dopuszczalny prefiks kraju, np. PL)." };

  const { rowCount } = await getPool().query(
    `update tenants set sender_company_name = $2, sender_postal_address = $3, sender_tax_id = $4 where id = $1`,
    [tenantId, firma, adres, nip],
  );
  if (!rowCount) return { ok: false, blad: "Nie ma takiego konta." };
  // odczyt zwrotny: zapis ma być tym, co wysłaliśmy
  const z = await odczytajDaneNadawcy(tenantId);
  if (z.firma !== firma || z.adres !== adres || z.nip !== nip) {
    return { ok: false, blad: "Zapis danych nadawcy nie zgadza się z odczytem z bazy." };
  }
  return { ok: true };
}
