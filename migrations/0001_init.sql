-- Epik A2 — CDP core: tenants, profiles, events
-- Model wg clients/midrev/research/wlasny-esp/PLAN-SAAS-ARCHITEKTURA-2026-08-27.md sekcja 2

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email text,
  phone text,
  created_at timestamptz not null default now(),
  -- (tenant_id, id) osobno, żeby events mogło robić FK złożony i wymusić,
  -- że profil przypięty do eventu faktycznie należy do tego samego tenanta
  unique (tenant_id, id)
);

-- Unikalność e-maila per tenant, case-insensitive, tylko gdy e-mail jest podany —
-- zwykły `unique (tenant_id, email)` przepuściłby "a@x.com" i "A@x.com" jako różne
-- profile w tym samym tenancie.
create unique index if not exists profiles_tenant_email_lower_idx
  on profiles (tenant_id, lower(btrim(email)))
  where email is not null;

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  profile_id uuid,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  -- FK złożony na (tenant_id, profile_id) zamiast samego profile_id: bez tego
  -- baza pozwoliłaby zapisać event tenanta A na profilu tenanta B (cichy
  -- cross-tenant data mix). MATCH SIMPLE (domyślny) przepuszcza profile_id = null
  -- (eventy jeszcze nieprzypisane do profilu), ale gdy profile_id jest podany,
  -- musi należeć do tego samego tenant_id.
  -- "on delete set null (profile_id)" (PG15+) zeruje TYLKO profile_id — bez tej
  -- kolumnowej formy Postgres zerowałby całą krotkę FK (czyli też tenant_id),
  -- co uderzyłoby o "not null" i wywaliło błąd zamiast po prostu odpiąć profil.
  foreign key (tenant_id, profile_id) references profiles (tenant_id, id)
    on delete set null (profile_id)
);

create index if not exists events_tenant_type_idx on events (tenant_id, event_type, occurred_at desc);
create index if not exists events_profile_idx on events (profile_id, occurred_at desc);

-- Suppression list jest CELOWO globalna (nie per tenant) — decyzja z
-- PLAN-SAAS-ARCHITEKTURA-2026-08-27.md sekcja 3: hard bounce/complaint na jednym
-- tenancie ma blokować wysyłkę na ten adres wszędzie, żeby jeden tenant nie
-- bombardował martwego/spamtrap adresu, na którym spalił się już inny. To nie jest
-- lista "wypisań" per sklep (ta należy do innego modułu — Epik B3/C) — to twarda
-- ochrona reputacji całej platformy.
create table if not exists suppressions (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists suppressions_email_lower_idx
  on suppressions (lower(btrim(email)));
