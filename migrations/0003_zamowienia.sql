-- Epik 1 / Story 1.7 - zamowienia i przebiegi importu.
--
-- Zamowienia sa osobna tabela, a nie tylko zdarzeniem w `events`, bo na nich stoi
-- atrybucja przychodu (AD-14) i raport dla klienta. Kwoty w jednostkach minorowych
-- (AD-11): grosze jako liczba calkowita plus kod waluty, zero liczb zmiennoprzecinkowych.

alter table profiles add column first_name text;
alter table profiles add column last_name text;

create table orders (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  store_id uuid not null,
  profile_id uuid,
  -- identyfikator w sklepie zrodlowym; unikalny w obrebie sklepu, nie tenanta
  external_id text not null,
  number text,
  status text not null,
  total_minor bigint not null check (total_minor >= 0),
  currency char(3) not null,
  -- data zlozenia zamowienia ZE ZRODLA, obowiazkowa (AD-10)
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb,
  unique (tenant_id, store_id, external_id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade,
  foreign key (tenant_id, profile_id) references profiles (tenant_id, id)
    on delete set null (profile_id)
);

create index orders_tenant_time_idx on orders (tenant_id, occurred_at desc);
create index orders_profile_idx on orders (profile_id, occurred_at desc);
create index orders_store_idx on orders (tenant_id, store_id, occurred_at desc);

-- Przebieg importu. Osobna tabela, bo licznik ma pokazywac FAKTYCZNY wynik odczytany
-- z bazy, a nie liczbe prob (NFR2), a skutki uboczne maja byc znane PRZED startem (NFR6).
create table import_runs (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  store_id uuid not null,
  status text not null check (status in ('planned', 'running', 'done', 'failed')) default 'planned',
  -- co zapowiedzielismy przed startem: ile zamowien, ile NOWYCH profili powstanie
  planned jsonb not null default '{}'::jsonb,
  -- co faktycznie powstalo, liczone odczytem zwrotnym z bazy po zapisie
  counters jsonb not null default '{}'::jsonb,
  range_from timestamptz,
  range_to timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade
);

create index import_runs_store_idx on import_runs (tenant_id, store_id, created_at desc);
