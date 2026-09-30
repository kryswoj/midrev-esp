import { getPool } from "../../adapters/db/pool";
import { hashKluczaApi, kluczZNaglowka, wygenerujKluczApi } from "../../adapters/klucze-api";

/**
 * Klucze API tenanta (E2 / 2.1). Tenant pochodzi WYŁĄCZNIE z rekordu klucza (AD-40):
 * żądanie nie ma jak wskazać innego tenanta. Każda mutacja z panelu ma jawny predykat
 * tenant_id (AD-2), więc id klucza z formularza nie unieważni cudzego klucza.
 */

export const ZAKRESY = ["events:write", "profiles:read", "profiles:write", "subscriptions:write", "lists:write", "metrics:read"] as const;
export type Zakres = (typeof ZAKRESY)[number];

/** Zakresy w języku panelu. */
export const OPISY_ZAKRESOW: Record<Zakres, string> = {
  "events:write": "Zapis zdarzeń (POST /api/events)",
  "profiles:read": "Odczyt profili",
  "profiles:write": "Zapis profili",
  "subscriptions:write": "Zapis zgód (subskrypcje)",
  "lists:write": "Zapis na listy",
  "metrics:read": "Odczyt metryk",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface KluczApi {
  id: string;
  nazwa: string;
  prefiks: string;
  zakresy: Zakres[];
  utworzono: Date;
  ostatnieUzycie: Date | null;
  uniewazniono: Date | null;
  wygasa: Date | null;
}

export class BladKlucza extends Error {}

export async function kluczeTenanta(tenantId: string): Promise<KluczApi[]> {
  const { rows } = await getPool().query(
    `select id, name, prefix, scopes, created_at, last_used_at, revoked_at, expires_at
       from api_keys where tenant_id = $1 order by created_at desc`,
    [tenantId],
  );
  return rows.map((r) => ({
    id: r.id,
    nazwa: r.name,
    prefiks: r.prefix,
    zakresy: r.scopes,
    utworzono: r.created_at,
    ostatnieUzycie: r.last_used_at,
    uniewazniono: r.revoked_at,
    wygasa: r.expires_at,
  }));
}

/**
 * Nowy klucz. Jawny klucz wraca WYŁĄCZNIE stąd (do jednorazowego pokazania w panelu);
 * w bazie zostaje hash. Wołający nie loguje wyniku.
 */
export async function utworzKlucz(
  tenantId: string,
  dane: { nazwa: string; zakresy: string[]; aktorId: string | null },
): Promise<{ id: string; jawny: string; prefiks: string }> {
  const nazwa = dane.nazwa.trim();
  if (nazwa.length < 1 || nazwa.length > 80) throw new BladKlucza("Nazwa klucza ma od 1 do 80 znaków");
  const zakresy = [...new Set(dane.zakresy)];
  if (zakresy.length === 0) throw new BladKlucza("Wybierz co najmniej jeden zakres");
  if (!zakresy.every((z): z is Zakres => (ZAKRESY as readonly string[]).includes(z))) {
    throw new BladKlucza("Nieznany zakres klucza");
  }
  const nowy = wygenerujKluczApi();
  const { rows } = await getPool().query<{ id: string }>(
    `insert into api_keys (tenant_id, name, prefix, secret_hash, scopes, created_by)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [tenantId, nazwa, nowy.prefiks, nowy.hash, zakresy, dane.aktorId && UUID.test(dane.aktorId) ? dane.aktorId : null],
  );
  return { id: rows[0].id, jawny: nowy.jawny, prefiks: nowy.prefiks };
}

/** Unieważnienie (nieodwracalne). false = klucz nie istnieje w TYM tenancie albo już unieważniony. */
export async function uniewaznijKlucz(tenantId: string, kluczId: string, aktorId: string | null): Promise<boolean> {
  if (!UUID.test(kluczId)) return false;
  const { rowCount } = await getPool().query(
    `update api_keys set revoked_at = now(), revoked_by = $3
      where tenant_id = $1 and id = $2 and revoked_at is null`,
    [tenantId, kluczId, aktorId && UUID.test(aktorId) ? aktorId : null],
  );
  return (rowCount ?? 0) > 0;
}

export type WynikUwierzytelnienia =
  | { ok: true; kluczId: string; tenantId: string; zakresy: Zakres[]; prefiks: string }
  | { ok: false; powod: "brak" | "nieznany" | "uniewazniony" | "wygasly" };

/**
 * Klucz z nagłówka → kontekst tenanta. `last_used_at` najwyżej raz na minutę (warunek
 * w UPDATE), więc burst 350/s nie pisze 350 razy do tego samego wiersza.
 */
export async function uwierzytelnij(naglowekAuthorization: string | null): Promise<WynikUwierzytelnienia> {
  const jawny = kluczZNaglowka(naglowekAuthorization);
  if (!jawny) return { ok: false, powod: "brak" };
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    scopes: Zakres[];
    prefix: string;
    revoked_at: Date | null;
    wygasl: boolean;
  }>(
    `select id, tenant_id, scopes, prefix, revoked_at, (expires_at is not null and expires_at <= now()) as wygasl
       from api_keys where secret_hash = $1`,
    [hashKluczaApi(jawny)],
  );
  const k = rows[0];
  if (!k) return { ok: false, powod: "nieznany" };
  if (k.revoked_at) return { ok: false, powod: "uniewazniony" };
  if (k.wygasl) return { ok: false, powod: "wygasly" };
  await pool.query(
    `update api_keys set last_used_at = now()
      where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
    [k.id],
  );
  return { ok: true, kluczId: k.id, tenantId: k.tenant_id, zakresy: k.scopes, prefiks: k.prefix };
}
