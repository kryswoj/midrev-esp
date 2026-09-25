import { getPool } from "../../adapters/db/pool";
import { wykluczoneGlobalnie } from "../../adapters/db/wykluczenia";
import { skompiluj } from "../../adapters/db/segmenty";
import type { Regula } from "../../domain/segmenty";
import { wierszCsv } from "../import-klaviyo/csv";
import { normalizujEmail } from "../import-klaviyo/wiersz";

/**
 * Czlonkowie list (FR23, audyt #2). Kazde zapytanie z jawnym tenant_id (AD-2); FK zlozone
 * w list_members z 0004 pilnuja, ze lista i profil naleza do tego samego tenanta.
 *
 * Stan zgody czlonka to OSTATNI wpis w rejestrze (AD-16), liczony tym samym oknem co
 * policz-odbiorcow.ts, zeby liczba "ze zgoda" na ekranie listy zgadzala sie z liczba
 * odbiorcow kampanii do tej listy.
 */

export interface Lista {
  id: string;
  name: string;
  description: string | null;
  created_at: Date;
}

export interface StatystykiListy {
  czlonkow: number;
  zeZgoda: number;
  bezZgody: number;
  wykluczonych: number;
  bezAdresu: number;
}

export interface CzlonekListy {
  profile_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  added_at: Date;
  source: string;
  zgoda: "granted" | "withdrawn" | "brak";
  zgoda_at: Date | null;
  wykluczony: boolean;
}

export async function listaTenanta(tenantId: string, listId: string): Promise<Lista | null> {
  const { rows } = await getPool().query<Lista>(
    "select id, name, description, created_at from lists where tenant_id = $1 and id = $2",
    [tenantId, listId],
  );
  return rows[0] ?? null;
}

// Jedno CTE klasyfikujace czlonka: adres, zgoda, wykluczenia. Uzywane przez statystyki,
// tabele i eksport, zeby trzy ekrany nie mialy trzech definicji "ze zgoda".
const CZLONKOWIE_CTE = `
  with czlonek as (
    select m.profile_id, m.added_at, m.source, p.email, p.first_name, p.last_name,
           lower(btrim(p.email)) as klucz
      from list_members m
      join profiles p on p.tenant_id = m.tenant_id and p.id = m.profile_id
     where m.tenant_id = $1 and m.list_id = $2
  ),
  zgoda as (
    select distinct on (c.profile_id) c.profile_id, c.state, c.occurred_at
      from consents c
     where c.tenant_id = $1 and c.channel = 'email'
       and c.profile_id in (select profile_id from czlonek)
     order by c.profile_id, c.occurred_at desc, c.id desc
  ),
  lokalne as (
    select distinct on (lower(btrim(t.email))) lower(btrim(t.email)) as klucz, t.action
      from tenant_suppressions t
     where t.tenant_id = $1
       and lower(btrim(t.email)) in (select klucz from czlonek where klucz is not null)
     order by lower(btrim(t.email)), t.occurred_at desc, t.id desc
  ),
  ocena as (
    select k.*,
           coalesce(z.state, 'brak') as zgoda,
           z.occurred_at as zgoda_at,
           (k.email is null) as bez_adresu,
           -- wykluczenie SKLEPU liczone w SQL; wykluczenie GLOBALNE doklada kod przez
           -- wspolna funkcje (adres albo hasz po anonimizacji), patrz dopelnijGlobalne
           coalesce((select l.action = 'suppressed' from lokalne l where l.klucz = k.klucz), false) as wykluczony
      from czlonek k
      left join zgoda z on z.profile_id = k.profile_id
  )`;

/**
 * Doklada wykluczenie globalne (po adresie ALBO haszu, 0022) do wierszy z SQL. W SQL
 * nie da sie policzyc kluczowanego HMAC-a bez wpuszczania klucza do bazy, wiec ta czesc
 * idzie przez adapters/db/wykluczenia.ts - jedno zrodlo prawdy, to samo co bramka.
 */
async function dopelnijGlobalne<T extends { email: string | null; wykluczony: boolean }>(wiersze: T[]): Promise<T[]> {
  const doSprawdzenia = wiersze.filter((w) => !w.wykluczony && w.email).map((w) => w.email as string);
  if (!doSprawdzenia.length) return wiersze;
  const globalne = new Set<string>();
  for (let i = 0; i < doSprawdzenia.length; i += 5000) {
    for (const k of await wykluczoneGlobalnie(doSprawdzenia.slice(i, i + 5000))) globalne.add(k);
  }
  for (const w of wiersze) {
    if (!w.wykluczony && w.email && globalne.has(w.email.trim().toLowerCase())) w.wykluczony = true;
  }
  return wiersze;
}

export async function statystykiListy(tenantId: string, listId: string): Promise<StatystykiListy> {
  // klasyfikacja per czlonek, a nie COUNT w SQL: wykluczenie globalne po haszu dochodzi
  // dopiero w kodzie, wiec liczby musza powstac po tym dopelnieniu
  const { rows } = await getPool().query<{ email: string | null; zgoda: string; wykluczony: boolean; bez_adresu: boolean }>(
    `${CZLONKOWIE_CTE} select email, zgoda, wykluczony, bez_adresu from ocena`,
    [tenantId, listId],
  );
  await dopelnijGlobalne(rows);
  const s: StatystykiListy = { czlonkow: rows.length, zeZgoda: 0, bezZgody: 0, wykluczonych: 0, bezAdresu: 0 };
  for (const r of rows) {
    if (r.bez_adresu) s.bezAdresu += 1;
    else if (r.wykluczony) s.wykluczonych += 1;
    else if (r.zgoda === "granted") s.zeZgoda += 1;
    else s.bezZgody += 1;
  }
  return s;
}

/** Wzorzec ILIKE z odkazonymi metaznakami: "%" w polu wyszukiwania ma szukac procentu. */
function wzorzec(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export async function czlonkowieListy(
  tenantId: string,
  listId: string,
  opcje: { q?: string; limit?: number; offset?: number } = {},
): Promise<{ wiersze: CzlonekListy[]; razem: number }> {
  const q = (opcje.q ?? "").trim().slice(0, 200);
  const limit = Math.min(Math.max(opcje.limit ?? 100, 1), 500);
  const offset = Math.max(opcje.offset ?? 0, 0);
  const filtr = q
    ? `where (email ilike $3 escape '\\' or first_name ilike $3 escape '\\' or last_name ilike $3 escape '\\'
             or (first_name || ' ' || last_name) ilike $3 escape '\\')`
    : "";
  const parametry: unknown[] = q ? [tenantId, listId, wzorzec(q)] : [tenantId, listId];
  const { rows } = await getPool().query<CzlonekListy & { razem: string }>(
    `${CZLONKOWIE_CTE}
     select profile_id, email, first_name, last_name, added_at, source, zgoda, zgoda_at, wykluczony,
            count(*) over () as razem
       from ocena ${filtr}
      order by added_at desc, profile_id desc
      limit $${parametry.length + 1} offset $${parametry.length + 2}`,
    [...parametry, limit, offset],
  );
  await dopelnijGlobalne(rows);
  return { wiersze: rows, razem: rows.length ? Number(rows[0].razem) : 0 };
}

export type WynikDodania =
  | { ok: true; dodano: boolean; profileId: string }
  | { ok: false; blad: string };

/**
 * Dodanie istniejacego profilu po adresie. Celowo NIE tworzy profilu: osoba dodana reka
 * bez zgody i bez zrodla bylaby kartoteka bez podstawy. Nowe osoby wchodza importem
 * albo formularzem, gdzie zrodlo jest znane.
 */
export async function dodajDoListyPoEmailu(tenantId: string, listId: string, surowyEmail: string, aktor: string): Promise<WynikDodania> {
  const adres = normalizujEmail(surowyEmail);
  if (!adres) return { ok: false, blad: "Podaj poprawny adres e-mail." };
  const lista = await listaTenanta(tenantId, listId);
  if (!lista) return { ok: false, blad: "Nie ma takiej listy." };
  const { rows } = await getPool().query(
    "select id from profiles where tenant_id = $1 and lower(btrim(email)) = $2",
    [tenantId, adres.klucz],
  );
  if (!rows[0]) return { ok: false, blad: `Nie ma profilu z adresem ${adres.email}. Zaimportuj go z pliku albo poczekaj na zapis z formularza.` };
  const wynik = await getPool().query(
    `insert into list_members (tenant_id, list_id, profile_id, source) values ($1, $2, $3, $4)
     on conflict (list_id, profile_id) do nothing`,
    // dodanie pojedyncze przez operatora: źródło „reczny" (odpala automatyzację listy)
    [tenantId, listId, rows[0].id, `reczny:${aktor}`],
  );
  return { ok: true, dodano: (wynik.rowCount ?? 0) > 0, profileId: rows[0].id };
}

export async function usunZListy(tenantId: string, listId: string, profileId: string): Promise<boolean> {
  const wynik = await getPool().query(
    "delete from list_members where tenant_id = $1 and list_id = $2 and profile_id = $3",
    [tenantId, listId, profileId],
  );
  return (wynik.rowCount ?? 0) > 0;
}

/**
 * Jednorazowe dodanie osob z segmentu (stan na teraz). Lista NIE sledzi segmentu pozniej:
 * to migawka, a nie subskrypcja - dokladnie roznica lista/segment z ekranu list.
 */
export async function dodajZSegmentu(
  tenantId: string,
  listId: string,
  segmentId: string,
): Promise<{ ok: true; dodano: number; kandydatow: number; nazwaSegmentu: string } | { ok: false; blad: string }> {
  const pool = getPool();
  const lista = await listaTenanta(tenantId, listId);
  if (!lista) return { ok: false, blad: "Nie ma takiej listy." };
  const { rows: seg } = await pool.query("select name, rules from segments where tenant_id = $1 and id = $2", [tenantId, segmentId]);
  if (!seg[0]) return { ok: false, blad: "Nie ma takiego segmentu." };
  const { gdzie, parametry } = skompiluj(seg[0].rules as Regula[], tenantId);
  const { rows } = await pool.query<{ id: string }>(`select pr.id from profiles pr where pr.tenant_id = $1 ${gdzie}`, parametry);
  const ids = rows.map((r) => r.id);
  let dodano = 0;
  for (let i = 0; i < ids.length; i += 5000) {
    const w = await pool.query(
      `insert into list_members (tenant_id, list_id, profile_id, source)
       select $1, $2, u.pid, $3 from unnest($4::uuid[]) as u(pid)
       on conflict (list_id, profile_id) do nothing`,
      [tenantId, listId, `segment:${seg[0].name}`, ids.slice(i, i + 5000)],
    );
    dodano += w.rowCount ?? 0;
  }
  return { ok: true, dodano, kandydatow: ids.length, nazwaSegmentu: seg[0].name };
}

/** Eksport listy do CSV, partiami; kazde pole przechodzi przez poleCsv (ochrona przed formula). */
export async function* eksportujListe(tenantId: string, listId: string): AsyncGenerator<string> {
  yield wierszCsv(["Email", "First Name", "Last Name", "Phone Number", "Email Marketing Consent", "Email Marketing Consent Timestamp", "Suppressed", "Added At", "Source"]);
  const partia = 1000;
  let offset = 0;
  for (;;) {
    const { rows } = await getPool().query(
      `${CZLONKOWIE_CTE}
       select o.email, o.first_name, o.last_name, p.phone, o.zgoda, o.zgoda_at, o.wykluczony, o.added_at, o.source
         from ocena o join profiles p on p.tenant_id = $1 and p.id = o.profile_id
        order by o.added_at, o.profile_id limit $3 offset $4`,
      [tenantId, listId, partia, offset],
    );
    await dopelnijGlobalne(rows);
    for (const r of rows) {
      yield wierszCsv([
        r.email,
        r.first_name,
        r.last_name,
        r.phone,
        r.zgoda === "granted" ? "SUBSCRIBED" : r.zgoda === "withdrawn" ? "UNSUBSCRIBED" : "NEVER_SUBSCRIBED",
        r.zgoda_at ? new Date(r.zgoda_at).toISOString() : "",
        r.wykluczony ? "yes" : "",
        new Date(r.added_at).toISOString(),
        r.source,
      ]);
    }
    if (rows.length < partia) return;
    offset += partia;
  }
}

export async function segmentyDoWyboru(tenantId: string): Promise<{ id: string; name: string }[]> {
  const { rows } = await getPool().query("select id, name from segments where tenant_id = $1 order by name", [tenantId]);
  return rows;
}
