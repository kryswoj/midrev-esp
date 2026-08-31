import { getPool } from "./pool";

// Repozytorium kont i sesji (AD-18: SQL tylko w adapters/db). Tabele users i
// sessions sa globalne, nie tenantowe - to wlasnie z nich WYNIKA tenant (AD-21),
// wiec regula "tenantId pierwszym argumentem" zaczyna obowiazywac dopiero
// warstwe wyzej, w use-case'ach dzialajacych na danych tenanta.

export type Rola = "admin" | "operator" | "client";

export interface Uzytkownik {
  id: string;
  email: string;
  display_name: string;
  role: Rola;
  password_hash: string;
}

export async function uzytkownikPoEmailu(email: string): Promise<Uzytkownik | null> {
  const { rows } = await getPool().query<Uzytkownik>(
    `select id, email, display_name, role, password_hash
       from users where lower(btrim(email)) = lower(btrim($1))`,
    [email],
  );
  return rows[0] ?? null;
}

export async function utworzUzytkownika(
  email: string,
  passwordHash: string,
  displayName: string,
  rola: Rola,
): Promise<{ id: string }> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into users (email, password_hash, display_name, role)
     values (btrim($1), $2, $3, $4) returning id`,
    [email, passwordHash, displayName, rola],
  );
  return rows[0];
}

export async function utworzSesje(userId: string, tokenHash: string, wygasa: Date): Promise<void> {
  await getPool().query(
    "insert into sessions (user_id, token_hash, expires_at) values ($1, $2, $3)",
    [userId, tokenHash, wygasa],
  );
}

export interface WierszSesji {
  user_id: string;
  email: string;
  display_name: string;
  role: Rola;
}

/** Sesja po hashu tokenu, wylacznie niewygasla. Waznosc egzekwuje baza, nie kod. */
export async function sesjaZUzytkownikiem(tokenHash: string): Promise<WierszSesji | null> {
  const { rows } = await getPool().query<WierszSesji>(
    `select u.id as user_id, u.email, u.display_name, u.role
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function usunSesjePoHashu(tokenHash: string): Promise<void> {
  await getPool().query("delete from sessions where token_hash = $1", [tokenHash]);
}

/** Sprzatanie przy okazji logowania, zeby tabela nie rosla bez ograniczen. */
export async function usunWygasleSesjeUzytkownika(userId: string): Promise<void> {
  await getPool().query("delete from sessions where user_id = $1 and expires_at <= now()", [
    userId,
  ]);
}

/**
 * Tenanty widoczne dla uzytkownika (AD-21). admin i operator dostaja wszystkie,
 * client wylacznie te ze swoich membershipow. To JEDYNE zrodlo listy tenantow
 * w sesji - identyfikator tenanta z zadania nigdy nie poszerza tej listy.
 */
export async function tenantyDlaUzytkownika(userId: string, rola: Rola): Promise<string[]> {
  if (rola === "admin" || rola === "operator") {
    const { rows } = await getPool().query<{ id: string }>(
      "select id from tenants order by created_at",
    );
    return rows.map((w) => w.id);
  }
  const { rows } = await getPool().query<{ tenant_id: string }>(
    "select tenant_id from memberships where user_id = $1",
    [userId],
  );
  return rows.map((w) => w.tenant_id);
}

// membership przyjmuje wylacznie role client (check w 0006): admin i operator
// maja dostep globalny i membership nic by dla nich nie znaczyl
export async function nadajDostep(
  userId: string,
  tenantId: string,
  rola: "client",
): Promise<void> {
  await getPool().query(
    `insert into memberships (user_id, tenant_id, role) values ($1, $2, $3)
     on conflict (user_id, tenant_id) do update set role = excluded.role`,
    [userId, tenantId, rola],
  );
}
