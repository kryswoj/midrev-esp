-- E1 / Story 1.1: metryki jako byt i jeden strumien zdarzen (plan metryki-i-profil
-- 2026-09-30, sekcja 1.2; AD-36, AD-37, AD-38, AD-39, AD-45, AD-46).
--
-- Co tu jest:
--   1. `tenants.timezone` i `tenants.currency` (dzien w strefie tenanta, waluta domyslna
--      `$value` ze zdarzen API),
--   2. `metrics`: metryka = (tenant, integracja, nazwa), tworzona w locie przy pierwszym
--      zdarzeniu (use-case zapiszZdarzenie), limit 200 na tenanta pilnowany w kodzie,
--   3. `metric_events`: jeden strumien zdarzen, partycje MIESIECZNE po `occurred_at`,
--      BEZ partycji DEFAULT (AD-45: pulapka `jobs_default` z audytu 28.09 P1-8 - nie da sie
--      zalozyc partycji na zakres, ktory ma wiersze w default). Brak partycji = blad
--      zapisu, a zapiszZdarzenie zaklada brakujaca i ponawia raz,
--   4. `event_keys`: deduplikacja AD-38 POZA partycjami. W tabeli partycjonowanej kazdy
--      UNIQUE musi zawierac klucz partycji, a realny przypadek to n8n ponawiajacy zadanie
--      z tym samym unique_id i NOWYM czasem - dedup z occurred_at by go nie zlapal,
--   5. `raw_events.channel` dopuszcza `api` i `client` (faza 1 ingestu API, AD-4),
--   6. funkcja zakladania partycji (jedna implementacja dla migracji, workera i zapisu).
--
-- Izolacja tenantow: kazdy klucz obcy jest ZLOZONY przez tenant_id (wzorzec z 0001/0018),
-- wiec baza nie pozwoli zapisac zdarzenia tenanta A na metryce albo profilu tenanta B.
--
-- AD-46 (expand/contract): same nowe obiekty + poszerzenie CHECK na raw_events. Stary kod
-- (wydanie przed tym) dziala na tej bazie bez zmian.

-- 1. Strefa i waluta tenanta ----------------------------------------------------------
alter table tenants
  add column timezone text not null default 'Europe/Warsaw',
  add column currency char(3) not null default 'PLN' check (currency ~ '^[A-Z]{3}$');

-- 2. Metryki ---------------------------------------------------------------------------
create table metrics (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- nazwa jak w Klaviyo (EN dla wbudowanych), etykieta PL tylko w UI (AD-37)
  name text not null check (char_length(name) between 1 and 127),
  integration_key text not null check (integration_key in ('midrev', 'api', 'woocommerce', 'stripe', 'shopify')),
  integration_category text not null check (integration_category in ('Internal', 'API', 'eCommerce', 'Payments')),
  builtin boolean not null default false,
  -- false: metryka nie moze wyzwalac flow (Opened/Clicked Email jak w Klaviyo, techniczne)
  can_trigger boolean not null default true,
  -- techniczne (rodo.*, customer.*): ukryte na listach
  hidden boolean not null default false,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, integration_key, name)
);

-- 3. Strumien zdarzen ------------------------------------------------------------------
create table metric_events (
  id uuid not null default uuidv7(),
  tenant_id uuid not null,
  metric_id uuid not null,
  -- NULL: gosc bez adresu (zamowienie Woo bez e-maila) albo profil usuniety
  profile_id uuid,
  -- czas ZE ZRODLA (AD-10), bez defaultu; precyzja sekunda (AD-39)
  occurred_at timestamptz not null
    check (occurred_at = date_trunc('second', occurred_at)),
  -- zapis wiersza w strumieniu: kursor skanu wejsc silnika automatyzacji
  recorded_at timestamptz not null default clock_timestamp(),
  -- dotarcie zdarzenia do systemu (API: raw_events.received_at); od niego liczy sie
  -- regula 4 h, zeby opoznienie workera nie zamienialo swiezego zdarzenia w backfill
  ingested_at timestamptz not null,
  unique_id text not null check (char_length(unique_id) between 1 and 255),
  value_minor bigint,
  value_currency char(3) check (value_currency ~ '^[A-Z]{3}$'),
  properties jsonb not null default '{}'::jsonb check (jsonb_typeof(properties) = 'object'),
  source text not null check (source in ('api', 'client', 'webhook', 'system', 'import')),
  -- true = zapis do statystyk tak, wyzwolenie flow nie (AD-39); wyliczane przy zapisie
  backfill boolean not null default false,
  message_id uuid,
  primary key (tenant_id, occurred_at, id),
  foreign key (tenant_id, metric_id) references metrics (tenant_id, id) on delete cascade,
  foreign key (tenant_id, profile_id) references profiles (tenant_id, id) on delete set null (profile_id),
  foreign key (tenant_id, message_id) references messages (tenant_id, id) on delete set null (message_id)
) partition by range (occurred_at);

-- wykres metryki (index-only scan po profile_id dla unikalnych, plan 1.4)
create index metric_events_metryka_idx on metric_events (tenant_id, metric_id, occurred_at desc) include (profile_id, value_minor);
-- os profilu
create index metric_events_profil_idx on metric_events (tenant_id, profile_id, occurred_at desc);
-- os profilu z filtrem metryk i warunki "metryka_profilu"
create index metric_events_profil_metryka_idx on metric_events (tenant_id, profile_id, metric_id, occurred_at desc);
-- skan wejsc silnika automatyzacji: znacznik per flow po recorded_at (plan 2.6)
create index metric_events_skan_idx on metric_events (tenant_id, metric_id, recorded_at, id);
create index metric_events_wiadomosc_idx on metric_events (tenant_id, message_id) where message_id is not null;

-- 4. Deduplikacja (AD-38) ----------------------------------------------------------------
-- Klucz (tenant, metryka, profil, unique_id); pierwszy zapis wygrywa, duplikat = cichy
-- sukces. Tylko zrodla zewnetrzne (api, client, webhook, import). Profil moze byc pusty
-- (gosc bez adresu): NULLS NOT DISTINCT, zeby retry takiego zdarzenia tez trafial w klucz
-- (review Codeksa R1).
-- Klucz obcy do wiersza strumienia (DEFERRABLE, sprawdzany przy commicie, bo klucz powstaje
-- przed zdarzeniem): klucz nie moze wskazywac zdarzenia, ktorego nie ma (osierocony klucz
-- po bledzie w polowie zapisu zwracalby przy retry nieistniejace event_id).
create table event_keys (
  tenant_id uuid not null,
  metric_id uuid not null,
  profile_id uuid,
  unique_id text not null check (char_length(unique_id) between 1 and 255),
  event_id uuid not null,
  -- klucz partycji zdarzenia: bez niego odczyt istniejacego zdarzenia skanowalby wszystkie partycje
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint event_keys_klucz unique nulls not distinct (tenant_id, metric_id, profile_id, unique_id),
  foreign key (tenant_id, metric_id) references metrics (tenant_id, id) on delete cascade,
  foreign key (tenant_id, profile_id) references profiles (tenant_id, id) on delete cascade,
  foreign key (tenant_id, occurred_at, event_id) references metric_events (tenant_id, occurred_at, id)
    on delete cascade deferrable initially deferred
);
create index event_keys_profil_idx on event_keys (tenant_id, profile_id);

-- 5. Kanal surowych zdarzen --------------------------------------------------------------
alter table raw_events drop constraint raw_events_channel_check,
  add constraint raw_events_channel_check check (channel in ('webhook', 'import', 'api', 'client'));

-- 6. Partycje ----------------------------------------------------------------------------
-- Jedna implementacja zakladania partycji miesiecznych: migracja (zapas), worker (job
-- dobowy) i zapiszZdarzenie (brakujacy miesiac przy imporcie albo starym `time` z API).
-- Granice w UTC, niezaleznie od strefy sesji. Blokada doradcza transakcji: dwie sesje
-- zakladajace ten sam miesiac naraz nie wywroca sie na katalogu.
-- Zakres ograniczony do 1990..2100 (AD-39: time z API w 1990 .. now + 1 rok).
create function metric_events_zapewnij_partycje(p_od timestamptz, p_do timestamptz)
returns integer
language plpgsql
as $$
declare
  miesiac timestamptz;
  koniec timestamptz;
  nazwa text;
  zalozone integer := 0;
begin
  if p_od is null or p_do is null or p_od > p_do then
    raise exception 'metric_events_zapewnij_partycje: niepoprawny zakres % .. %', p_od, p_do;
  end if;
  if p_od < timestamptz '1990-01-01 00:00:00+00' or p_do >= timestamptz '2100-01-01 00:00:00+00' then
    raise exception 'metric_events_zapewnij_partycje: zakres % .. % poza 1990..2100', p_od, p_do;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('metric_events:partycje', 0));
  miesiac := date_trunc('month', p_od at time zone 'UTC') at time zone 'UTC';
  koniec := date_trunc('month', p_do at time zone 'UTC') at time zone 'UTC';
  while miesiac <= koniec loop
    nazwa := 'metric_events_' || to_char(miesiac at time zone 'UTC', 'YYYY_MM');
    if to_regclass(nazwa) is null then
      execute format(
        'create table %I partition of metric_events for values from (%L) to (%L)',
        nazwa, miesiac, (miesiac at time zone 'UTC' + interval '1 month') at time zone 'UTC'
      );
      zalozone := zalozone + 1;
    end if;
    miesiac := (miesiac at time zone 'UTC' + interval '1 month') at time zone 'UTC';
  end loop;
  return zalozone;
end $$;

-- Zapas: od poprzedniego miesiaca do +12 miesiecy (zdarzenia z ostatnich tygodni z API
-- trafiaja w istniejace partycje). Historie (0031, import) obsluguje ta sama funkcja.
select metric_events_zapewnij_partycje(now() - interval '1 month', now() + interval '12 months');
