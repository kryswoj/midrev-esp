-- Epik 1 / Story 1.1 - naprawa fundamentu i tabele pod ingest.
--
-- Powod istnienia tego pliku: 0001 laczy dwa bledy, ktorych nie wolno naprawic edycja
-- (AD-12, migracje sa append-only i pilnowane suma kontrolna):
--   1. `occurred_at ... default now()` sprawia, ze zapis bez jawnej daty zdarzenia dostaje
--      date importu. To dokladnie ten blad, ktory kiedys po cichu sfalszowal raporty
--      przychodu w innym projekcie. AD-10 wymaga daty ze zrodla, wiec default musi zniknac.
--   2. `gen_random_uuid()` daje UUID v4, czyli losowe. Przy milionie wierszy miesiecznie
--      niszczy to lokalnosc indeksu. AD-15 wymaga wersji 7, natywnej od Postgresa 18.
--
-- Ten plik byl przepisywany w miejscu po dwoch rundach review Codeksa, PRZED jakimkolwiek
-- realnym uzyciem i przy skasowanym wolumenie sandboxa. Od pierwszego prawdziwego wdrozenia
-- obowiazuje AD-12 bez wyjatkow: kazda zmiana schematu to nowy plik.
--
-- Zadnego `if not exists` przy nowych obiektach: w migracji append-only to ukrywa rozjazd
-- schematu, bo tabela w zlym ksztalcie przepuscilaby migracje i zapisala ja jako zastosowana.

-- 1. Data zdarzenia musi byc podana jawnie (AD-10, NFR3), a data zapisu jest osobna
--    kolumna ustawiana przez baze. Dwie daty, nie jedna: bez tego nie da sie odroznic
--    "kiedy to sie stalo" od "kiedy to zapisalismy" przy imporcie historii.
alter table events alter column occurred_at drop default;
alter table events add column recorded_at timestamptz not null default now();

-- 2. Klucze glowne w UUID v7 (AD-15). Istniejace wiersze zostaja bez zmian - to tylko
--    domyslna wartosc dla nowych zapisow.
alter table tenants      alter column id set default uuidv7();
alter table profiles     alter column id set default uuidv7();
alter table events       alter column id set default uuidv7();
alter table suppressions alter column id set default uuidv7();

-- 3. Sklepy podpiete do tenanta (AD-8). Poswiadczenia trzymane jako szyfrogram (AD-13),
--    dlatego bytea, a nie text: zeby nikogo nie kusilo zapisanie ich jawnie.
create table stores (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  platform text not null check (platform in ('woocommerce', 'shopify', 'shoper')),
  base_url text not null,
  credentials_encrypted bytea not null,
  -- co ta platforma potrafi u tego konkretnego sklepu (AD-8, AD-29). Interfejs nie moze
  -- oferowac funkcji opartej na zdarzeniu, ktorego dana platforma nie dostarcza.
  capabilities jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'connected', 'error')),
  last_error text,
  created_at timestamptz not null default now(),
  -- para (tenant_id, id) pod zlozone klucze obce - ten sam wzorzec, ktorym 0001
  -- zablokowalo mieszanie danych miedzy tenantami
  unique (tenant_id, id),
  unique (tenant_id, platform, base_url)
);

create index stores_tenant_idx on stores (tenant_id, status);

-- 4. Surowy log zdarzen przychodzacych (AD-4). Pierwsza faza ingestu zapisuje tu payload
--    i odpowiada 200; przetworzeniem zajmuje sie kolejka. Bez tego bledne przetworzenie
--    oznacza utrate zdarzenia, ktorego zaden sklep nie przysle drugi raz (NFR14).
create table raw_events (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- identyfikator sklepu jako kolumna, nie pole w JSON: baza ma wymuszac, ze zdarzenie
  -- tenanta A dotyczy sklepu tenanta A. Identyfikator wlascicielski w samym payloadzie
  -- omija caly wzorzec zlozonych kluczy obcych z 0001.
  store_id uuid,
  source text not null,
  -- ksztalt: platform : tenant_id : entity : external_id : source_version (AD-24).
  -- Klucz opisuje BYT, nie kanal, wiec to samo zamowienie przyslane webhookiem i
  -- zaciagniete importem historycznym daje ten sam klucz i nie zostanie policzone dwa razy.
  -- Unikalnosc jest per tenant i zrodlo, bo baza nie ma prawa ufac, ze tekst klucza
  -- faktycznie zawiera identyfikator tenanta.
  idempotency_key text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  process_error text,
  -- Sklep wchodzi do unikalnosci, bo dwa sklepy tego samego tenanta na tej samej
  -- platformie moga miec zamowienie o tym samym numerze zewnetrznym. Bez tego drugie
  -- z nich zostaloby po cichu uznane za duplikat i zgubione.
  -- NULLS NOT DISTINCT, bo zdarzenia niezwiazane ze sklepem (np. webhook dostawcy
  -- wysylki) maja store_id puste, a dwa NULL-e musza tu byc traktowane jak ta sama wartosc.
  unique nulls not distinct (tenant_id, store_id, source, idempotency_key),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade
);

create index raw_events_unprocessed_idx
  on raw_events (tenant_id, received_at)
  where processed_at is null;

-- 5. Kolejka zadan (AD-5, AD-31).
--
--    Partycjonowana po `created_at`, a NIE po `run_after`: `run_after` zmienia sie przy
--    ponowieniu z odstepem, a klucz partycjonowania musi byc niezmienny. Inaczej ponowienie
--    przenosi wiersz miedzy partycjami i zmienia jego tozsamosc, wiec worker trzymajacy
--    sam identyfikator nie ma czym domknac zadania.
create table jobs (
  id uuid not null default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  store_id uuid,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null check (status in ('pending', 'running', 'done', 'failed')) default 'pending',
  run_after timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 5,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  primary key (id, created_at),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade
) partition by range (created_at);

-- Partycje na dzis i jutro zakladane od razu. Partycja domyslna istnieje wylacznie jako
-- siatka bezpieczenstwa: wiersz w niej oznacza, ze zabraklo partycji dziennej, czyli awarie
-- utrzymania. Zaladowanie do niej wierszy blokuje pozniejsze utworzenie partycji na ten
-- sam zakres, wiec jej zawartosc jest alarmem, a nie normalnym stanem.
create table jobs_default partition of jobs default;

do $$
declare
  d date;
  nazwa text;
begin
  foreach d in array array[current_date, current_date + 1] loop
    nazwa := 'jobs_' || to_char(d, 'YYYY_MM_DD');
    execute format(
      'create table %I partition of jobs for values from (%L) to (%L)',
      nazwa, d::timestamptz, (d + 1)::timestamptz
    );
    -- kolejka to tabela o duzym obrocie wierszy; domyslny autovacuum reaguje na niej
    -- za pozno (AD-31, NFR26). Kazda partycja musi dostac te ustawienia osobno,
    -- bo reloptions nie dziedzicza sie z tabeli partycjonowanej.
    execute format(
      'alter table %I set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01)',
      nazwa
    );
  end loop;
end $$;

-- Zajmowanie zadan jest GLOBALNE (worker obsluguje wszystkich tenantow), dlatego indeks
-- nie zaczyna sie od tenant_id. Gdyby kiedys pojawily sie workery dedykowane tenantowi,
-- ten indeks trzeba bedzie zmienic na (tenant_id, run_after, id).
create index jobs_claim_idx on jobs (run_after, id) where status = 'pending';

-- WARUNEK OPERACYJNY wynikajacy z partycjonowania po dacie utworzenia: partycji NIE WOLNO
-- odlaczac po samym wieku. Zadanie utworzone dzis, a odlozone o dwa tygodnie, siedzi
-- w dzisiejszej partycji i zniknie razem z nia, zanim stanie sie wykonywalne.
-- Zadanie utrzymaniowe (Story 1.3) moze odlaczyc partycje dopiero wtedy, gdy nie ma w niej
-- zadan w stanie pending ani running. Ten indeks sluzy wlasnie tej kontroli.
create index jobs_aktywne_idx on jobs (run_after) where status in ('pending', 'running');
create index jobs_stuck_idx on jobs (locked_at) where status = 'running';

alter table raw_events   set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
alter table jobs_default set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
