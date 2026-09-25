import type pg from "pg";
import { getPool } from "./pool";

// Repozytoria: jedyne miejsce z SQL (AD-18). Każda funkcja przyjmuje tenantId jako
// pierwszy argument (AD-2) i żadne zapytanie nie istnieje bez predykatu tenant_id.

export type Klient = pg.Pool | pg.PoolClient;

export interface Tenant {
  id: string;
  name: string;
  created_at: Date;
}

export async function listaTenantow(): Promise<Tenant[]> {
  const { rows } = await getPool().query<Tenant>(
    "select id, name, created_at from tenants order by created_at desc",
  );
  return rows;
}

export async function utworzTenanta(nazwa: string): Promise<Tenant> {
  const { rows } = await getPool().query<Tenant>(
    "insert into tenants (name) values ($1) returning id, name, created_at",
    [nazwa],
  );
  return rows[0];
}

/**
 * Tenant + membership tworcy w JEDNEJ transakcji. Rozdzielone operacje przy
 * awarii miedzy insertami zostawialyby tenanta, ktorego tworca-client nie widzi
 * (znalezisko z review), a ponowienie tworzyloby drugiego. clientUserId = null
 * dla admin/operator - oni maja dostep globalny z roli i membership nic by dla
 * nich nie znaczyl (0006).
 */
export async function utworzTenantaZDostepem(
  nazwa: string,
  clientUserId: string | null,
): Promise<Tenant> {
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const { rows } = await klient.query<Tenant>(
      "insert into tenants (name) values ($1) returning id, name, created_at",
      [nazwa],
    );
    if (clientUserId) {
      await klient.query(
        "insert into memberships (user_id, tenant_id, role) values ($1, $2, 'client')",
        [clientUserId, rows[0].id],
      );
    }
    await klient.query("commit");
    return rows[0];
  } catch (blad) {
    await klient.query("rollback");
    throw blad;
  } finally {
    klient.release();
  }
}

export async function tenant(tenantId: string): Promise<Tenant | null> {
  const { rows } = await getPool().query<Tenant>(
    "select id, name, created_at from tenants where id = $1",
    [tenantId],
  );
  return rows[0] ?? null;
}

export interface Sklep {
  id: string;
  tenant_id: string;
  platform: string;
  base_url: string;
  capabilities: Record<string, boolean>;
  status: string;
  last_error: string | null;
  created_at: Date;
}

export async function sklepyTenanta(tenantId: string): Promise<Sklep[]> {
  const { rows } = await getPool().query<Sklep>(
    `select id, tenant_id, platform, base_url, capabilities, status, last_error, created_at
       from stores where tenant_id = $1 order by created_at desc`,
    [tenantId],
  );
  return rows;
}

export async function sklep(tenantId: string, storeId: string): Promise<Sklep | null> {
  const { rows } = await getPool().query<Sklep>(
    `select id, tenant_id, platform, base_url, capabilities, status, last_error, created_at
       from stores where tenant_id = $1 and id = $2`,
    [tenantId, storeId],
  );
  return rows[0] ?? null;
}

export async function poswiadczeniaSklepu(tenantId: string, storeId: string): Promise<Buffer | null> {
  const { rows } = await getPool().query<{ credentials_encrypted: Buffer }>(
    "select credentials_encrypted from stores where tenant_id = $1 and id = $2",
    [tenantId, storeId],
  );
  return rows[0]?.credentials_encrypted ?? null;
}

export async function zapiszSklep(
  tenantId: string,
  dane: {
    platform: string;
    baseUrl: string;
    credentialsEncrypted: Buffer;
    capabilities: Record<string, boolean>;
    status: string;
  },
): Promise<Sklep> {
  const { rows } = await getPool().query<Sklep>(
    `insert into stores (tenant_id, platform, base_url, credentials_encrypted, capabilities, status)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id, platform, base_url) do update
       set credentials_encrypted = excluded.credentials_encrypted,
           capabilities = excluded.capabilities,
           status = excluded.status,
           last_error = null
     returning id, tenant_id, platform, base_url, capabilities, status, last_error, created_at`,
    [tenantId, dane.platform, dane.baseUrl, dane.credentialsEncrypted, dane.capabilities, dane.status],
  );
  return rows[0];
}

export interface WierszProfilu {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: Date;
  zamowien: number;
  wydal_minor: string | null;
  ostatnie: Date | null;
}

export async function profileTenanta(tenantId: string, limit = 50): Promise<WierszProfilu[]> {
  const { rows } = await getPool().query<WierszProfilu>(
    `select p.id, p.email, p.first_name, p.last_name, p.created_at,
            count(o.id)::int as zamowien,
            coalesce(sum(o.total_minor) filter (where o.status in ('completed','processing')), 0)::text as wydal_minor,
            max(o.occurred_at) as ostatnie
       from profiles p
       left join orders o on o.tenant_id = p.tenant_id and o.profile_id = p.id
      where p.tenant_id = $1
      group by p.id
      order by max(o.occurred_at) desc nulls last, p.created_at desc
      limit $2`,
    [tenantId, limit],
  );
  return rows;
}

export interface WierszZamowienia {
  id: string;
  external_id: string;
  number: string | null;
  status: string;
  total_minor: string;
  currency: string;
  occurred_at: Date;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}

export async function zamowieniaTenanta(tenantId: string, limit = 50): Promise<WierszZamowienia[]> {
  const { rows } = await getPool().query<WierszZamowienia>(
    `select o.id, o.external_id, o.number, o.status, o.total_minor::text, o.currency, o.occurred_at,
            p.email, p.first_name, p.last_name
       from orders o
       left join profiles p on p.tenant_id = o.tenant_id and p.id = o.profile_id
      where o.tenant_id = $1
      order by o.occurred_at desc
      limit $2`,
    [tenantId, limit],
  );
  return rows;
}

export async function podsumowanieTenanta(tenantId: string) {
  const { rows } = await getPool().query(
    `select
       (select count(*)::int from profiles where tenant_id = $1) as profile,
       (select count(*)::int from orders where tenant_id = $1) as zamowienia,
       (select coalesce(sum(total_minor), 0)::text from orders
         where tenant_id = $1 and status in ('completed','processing')) as przychod_minor,
       (select count(*)::int from stores where tenant_id = $1) as sklepy,
       (select min(occurred_at) from orders where tenant_id = $1) as najstarsze,
       (select max(occurred_at) from orders where tenant_id = $1) as najnowsze`,
    [tenantId],
  );
  return rows[0];
}

export async function przebiegiImportu(tenantId: string, limit = 10) {
  const { rows } = await getPool().query(
    `select id, store_id, status, planned, counters, range_from, range_to,
            started_at, finished_at, last_error, created_at
       from import_runs where tenant_id = $1 order by created_at desc limit $2`,
    [tenantId, limit],
  );
  return rows;
}

export async function zadaniaWKolejce(tenantId: string, limit = 20) {
  const { rows } = await getPool().query(
    `select id, kind, status, run_after, attempts, last_error, created_at
       from jobs where tenant_id = $1 order by created_at desc limit $2`,
    [tenantId, limit],
  );
  return rows;
}

// --- Listy, segmenty, kampanie, zgody i wykluczenia (Epik 2 i szkielet Epiku 4) ---

export async function listyTenanta(tenantId: string) {
  const { rows } = await getPool().query(
    `select l.id, l.name, l.description, l.created_at,
            (select count(*)::int from list_members m
              where m.tenant_id = l.tenant_id and m.list_id = l.id) as czlonkow
       from lists l where l.tenant_id = $1 order by l.created_at desc`,
    [tenantId],
  );
  return rows;
}

export async function utworzListe(tenantId: string, nazwa: string, opis: string | null) {
  const { rows } = await getPool().query(
    `insert into lists (tenant_id, name, description) values ($1, $2, $3)
     on conflict (tenant_id, name) do update set description = excluded.description
     returning id`,
    [tenantId, nazwa, opis],
  );
  return rows[0].id as string;
}

export async function segmentyTenanta(tenantId: string) {
  const { rows } = await getPool().query(
    "select id, name, rules, created_at from segments where tenant_id = $1 order by created_at desc",
    [tenantId],
  );
  return rows;
}

/**
 * Zapis segmentu: reguły PRZECHODZĄ PRZEZ SCHEMAT (nieznany typ, pusta wartość z
 * formularza = błąd z nazwą, nie segment obejmujący całą bazę - audyt #12), a duplikat
 * nazwy jest ODRZUCANY: wcześniejsze `on conflict do update` podmieniało reguły segmentu,
 * na który już wskazywały kampanie (review S2).
 */
export async function utworzSegment(tenantId: string, nazwa: string, reguly: unknown) {
  const { parsujReguly } = await import("../../domain/segmenty");
  const sprawdzone = parsujReguly(reguly);
  const { rows } = await getPool().query(
    `insert into segments (tenant_id, name, rules) values ($1, $2, $3)
     on conflict (tenant_id, name) do nothing returning id`,
    [tenantId, nazwa, JSON.stringify(sprawdzone)],
  );
  if (!rows[0]) throw new Error(`Segment o nazwie „${nazwa}” już istnieje - wybierz inną nazwę`);
  return rows[0].id as string;
}

export async function kampanieTenanta(tenantId: string) {
  const { rows } = await getPool().query(
    `select id, name, subject, status, scheduled_at, created_at, updated_at
       from campaigns where tenant_id = $1 order by created_at desc`,
    [tenantId],
  );
  return rows;
}

export async function utworzKampanie(tenantId: string, nazwa: string, temat: string | null) {
  const { rows } = await getPool().query(
    "insert into campaigns (tenant_id, name, subject) values ($1, $2, $3) returning id",
    [tenantId, nazwa, temat],
  );
  return rows[0].id as string;
}

/**
 * Aktualny stan wykluczeń tenanta. Liczony z OSTATNIEGO wpisu dla adresu, bo wpisy są
 * dopisywane, nigdy kasowane (AD-16): historia musi zostać nawet po zdjęciu wykluczenia.
 */
export async function wykluczeniaTenanta(tenantId: string, limit = 50) {
  const { rows } = await getPool().query(
    `select distinct on (lower(btrim(email)))
            email, action, reason, actor, occurred_at
       from tenant_suppressions
      where tenant_id = $1
      order by lower(btrim(email)), occurred_at desc
      limit $2`,
    [tenantId, limit],
  );
  return rows;
}

/**
 * Wykluczenia globalne WIDOCZNE dla danego tenanta. Tabela `suppressions` jest celowo
 * wspólna dla całej platformy (martwy adres jest martwy u każdego), ale pokazywać ją
 * wolno wyłącznie w przecięciu z profilami TEGO tenanta. Wersja bez filtra (audyt
 * 24.09, P1) wyświetlała każdemu sklepowi adresy z odbić pozostałych klientów agencji,
 * także roli `client` — czyli cudze dane osobowe.
 */
export async function wykluczeniaGlobalne(tenantId: string, limit = 50) {
  const { rows } = await getPool().query(
    `select s.email, s.reason, s.created_at
       from suppressions s
      where exists (select 1 from profiles p
                     where p.tenant_id = $1 and lower(btrim(p.email)) = lower(btrim(s.email)))
      order by s.created_at desc
      limit $2`,
    [tenantId, limit],
  );
  return rows;
}

export async function zgodyTenanta(tenantId: string, limit = 50) {
  // "wykluczony" liczony w SQL, nie z pobranej listy wykluczeń: lista jest limitowana,
  // a adres spoza limitu dostawałby czyste "zgoda" mimo faktycznej blokady.
  // Wykluczenie globalne po haszu (0022) dokładane w JS: hasz liczy aplikacja.
  const { wykluczoneGlobalnie } = await import("./wykluczenia");
  const { znormalizujAdres } = await import("../hash-adresu");
  const { rows } = await getPool().query(
    `select distinct on (c.profile_id, c.channel)
            c.profile_id, c.channel, c.state, c.source, c.wording, c.occurred_at,
            p.email, p.first_name, p.last_name,
            (
              exists (select 1 from suppressions s
                       where lower(btrim(s.email)) = lower(btrim(p.email)))
              or coalesce((
                select ts.action = 'suppressed'
                  from tenant_suppressions ts
                 where ts.tenant_id = c.tenant_id
                   and lower(btrim(ts.email)) = lower(btrim(p.email))
                 order by ts.occurred_at desc
                 limit 1
              ), false)
            ) as wykluczony
       from consents c
       join profiles p on p.tenant_id = c.tenant_id and p.id = c.profile_id
      where c.tenant_id = $1
      order by c.profile_id, c.channel, c.occurred_at desc
      limit $2`,
    [tenantId, limit],
  );
  const poHaszu = await wykluczoneGlobalnie(rows.map((r) => r.email));
  for (const r of rows) {
    if (r.email && poHaszu.has(znormalizujAdres(r.email))) r.wykluczony = true;
  }
  return rows;
}

export async function statystykiZgod(tenantId: string) {
  const { rows } = await getPool().query(
    `with ostatnie as (
       select distinct on (profile_id, channel) profile_id, channel, state
         from consents where tenant_id = $1
        order by profile_id, channel, occurred_at desc
     )
     select
       count(*) filter (where o.state = 'granted' and o.channel = 'email')::int as zgody_email,
       count(*) filter (where o.state = 'withdrawn' and o.channel = 'email')::int as wycofane_email,
       (select count(*)::int from profiles where tenant_id = $1) as profile
       from ostatnie o`,
    [tenantId],
  );
  return rows[0];
}

/** Liczniki przy pozycjach nawigacji: operator widzi rozmiar zbioru bez wchodzenia. */
export async function licznikiNawigacji(tenantId: string): Promise<Record<string, number>> {
  const { rows } = await getPool().query(
    `select
       (select count(*)::int from stores where tenant_id = $1) as sklepy,
       (select count(*)::int from profiles where tenant_id = $1) as profile,
       (select count(*)::int from orders where tenant_id = $1) as zamowienia,
       (select count(*)::int from campaigns where tenant_id = $1) as kampanie,
       (select count(*)::int from segments where tenant_id = $1) as segmenty,
       (select count(*)::int from lists where tenant_id = $1) as listy,
       (select count(*)::int from popups where tenant_id = $1) as popupy,
       (select count(*)::int from flows where tenant_id = $1) as automatyzacje,
       (select count(*)::int from (
          select distinct on (lower(btrim(email))) action
            from tenant_suppressions where tenant_id = $1
           order by lower(btrim(email)), occurred_at desc
        ) w where w.action = 'suppressed') as zgody`,
    [tenantId],
  );
  return rows[0] as Record<string, number>;
}
