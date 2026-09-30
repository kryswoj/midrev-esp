-- E2 / Story 2.1: klucze API per tenant (plan 2.2; AD-21, AD-40).
--
-- Klucz prywatny: `mrv_pk_` + 32 losowe bajty w base62, pokazany RAZ przy utworzeniu.
-- W bazie tylko HMAC-SHA256 kluczem-pieprzem ze srodowiska (API_KEY_PEPPER). Hash, a nie
-- szyfrowanie z AD-13: klucza nigdy nie odtwarzamy, a przy tej entropii bcrypt/argon nic
-- nie dodaja, tylko spowolnilyby kazde zadanie. Wyciek zrzutu bazy nie daje kluczy.
--
-- Tenant pochodzi WYLACZNIE z rekordu klucza (AD-40): zadanie nie ma jak wskazac innego.
--
-- `site_keys` (klucz publiczny skryptu na strone, odpowiednik company_id Klaviyo) zakladamy
-- tu razem, zeby E7 nie potrzebowal osobnej migracji; w MVP nieuzywane.

create table api_keys (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- poczatek klucza widoczny w UI i logach ('mrv_pk_3f9aX'), nigdy caly klucz
  prefix text not null check (prefix ~ '^mrv_pk_[A-Za-z0-9]{4,8}$'),
  secret_hash bytea not null unique check (octet_length(secret_hash) = 32),
  scopes text[] not null check (
    cardinality(scopes) >= 1
    and scopes <@ array['events:write', 'profiles:read', 'profiles:write',
                        'subscriptions:write', 'lists:write', 'metrics:read']::text[]),
  -- klauzula przypisywana zgodom z API subskrypcji (E3.4)
  consent_wording text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- aktualizowane najwyzej raz na minute (nie kazde zadanie pisze do bazy)
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references users(id) on delete set null,
  expires_at timestamptz,
  unique (tenant_id, id)
);
create index api_keys_tenant_idx on api_keys (tenant_id, created_at desc);

create table site_keys (
  id text primary key check (id ~ '^[A-Za-z0-9]{6,10}$'),
  tenant_id uuid not null references tenants(id) on delete cascade,
  allowed_origins text[] not null default '{}',
  require_cookie_consent boolean not null default true,
  identify_from_links boolean not null default true,
  -- domeny, do ktorych przekierowanie /r wolno doklejac token _mx (D5, poza MVP)
  link_domains text[] not null default '{}',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (tenant_id, id)
);
