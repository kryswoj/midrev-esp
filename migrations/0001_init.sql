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
  unique (tenant_id, email)
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  profile_id uuid references profiles(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists events_tenant_type_idx on events (tenant_id, event_type, occurred_at desc);
create index if not exists events_profile_idx on events (profile_id, occurred_at desc);

create table if not exists suppressions (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  reason text not null,
  created_at timestamptz not null default now()
);
