-- Automatyzacje jako GRAF (flow builder), zamiast "wyzwalacz + opoznienie + jeden mail".
--
-- Model po tej migracji (wzorzec z Klaviyo: plaska lista wezlow z krawedziami w `links`):
--
--   flows              - automatyzacja: nazwa, status (szkic / wlaczony / wstrzymany),
--                        definicja ROBOCZA (draft) i definicja OPUBLIKOWANA (live).
--   flow_versions      - kazda opublikowana definicja, niezmienna. Osoba w toku biegnie
--                        po wersji, z ktora weszla; edycja szkicu nie przestawia jej w pol
--                        kroku, a publikacja nowej wersji dotyczy wylacznie nowych wejsc.
--   flow_participants  - stan osoby w automatyzacji: w ktorym wezle jest, od kiedy, kiedy
--                        ma sie wznowic (opoznienie), na ktorej wersji. Jedno wejscie na
--                        osobe i automatyzacje (unique) - to jest zabezpieczenie przed
--                        podwojnym wejsciem, wymuszone w bazie, nie w kodzie.
--   flow_transitions   - append-only historia kazdego przejscia ("sciezka osoby").
--   journeys           - ZMIENIA ROLE: z "automatyzacji" staje sie "wiadomoscia e-mail
--                        w automatyzacji" (jeden wiersz = jeden wezel e-mail). Zostaje
--                        zrodlem messages (source_type 'journey', source_id = journeys.id),
--                        celem klucza obcego attributions.journey_id i joina na profilu.
--                        Dzieki temu silnik wysylki, atrybucja i raport per wiadomosc
--                        (raportAutomatyzacji) dzialaja bez zmian, a unikalnosc AD-26
--                        (tenant, source_type, source_id, profile_id) znaczy dokladnie:
--                        "jedna osoba dostaje jeden mail z tego kroku".
--
-- Zgodnosc wstecz: kazdy istniejacy journey (wyzwalacz + opoznienie + mail) staje sie
-- flow o TYM SAMYM id (adresy, historia wiadomosci i przychodu zostaja) z grafem:
-- wyzwalacz -> [opoznienie, gdy > 0] -> e-mail -> koniec. Wiersz journeys zostaje
-- wezlem e-mail tego flow (flow_id = id, node_id = 'email'). Rejestr journey_runs
-- przepisuje sie na zakonczonych uczestnikow, wiec nikt nie dostanie powitania drugi raz.
--
-- Izolacja tenantow: kazdy klucz obcy jest zlozony przez tenant_id (ten sam wzorzec, ktory
-- w 0001 i 0018 zamknal wyciek cross-tenant). Daty zdarzen (entered_at, node_since,
-- occurred_at przejsc) nie maja `default now()`: date podaje zrodlo (AD-10).

-- ---------------------------------------------------------------------------
-- 1. flows: automatyzacja jako graf z definicja robocza i opublikowana.
-- ---------------------------------------------------------------------------
create table flows (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  -- szkic: nic nie wchodzi i nic nie wychodzi; wlaczony: wejscia i przejscia dzialaja;
  -- wstrzymany: nikt nie wchodzi i NIKT sie nie przesuwa (osoby w toku stoja w miejscu)
  status text not null default 'szkic' check (status in ('szkic', 'wlaczony', 'wstrzymany')),
  -- zdarzenie wyzwalacza zdenormalizowane z definicji LIVE, pod zapytanie o wejscia
  -- i pod liste automatyzacji (null = szkic bez opublikowanej definicji)
  trigger_event text,
  draft jsonb not null,
  draft_version int not null default 1,
  live jsonb,
  live_version int,
  -- moment OSTATNIEGO wlaczenia: flow widzi wylacznie zdarzenia POZNIEJSZE (wlaczenie
  -- po tygodniu przerwy nie ostrzeliwuje ludzi powitaniami sprzed tygodnia)
  active_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create index flows_tenant_status_idx on flows (tenant_id, status);

create table flow_versions (
  tenant_id uuid not null,
  flow_id uuid not null,
  version int not null,
  definition jsonb not null,
  published_at timestamptz not null default now(),
  primary key (flow_id, version),
  unique (tenant_id, flow_id, version),
  foreign key (tenant_id, flow_id) references flows (tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 2. journeys: wiadomosc e-mail jako wezel flow.
--    Nazwa przestaje byc unikalna (to teraz etykieta kroku, np. "Mail 2"), wyzwalacz
--    i opoznienie zostaja jako kolumny historyczne (nullable), nic ich juz nie czyta.
-- ---------------------------------------------------------------------------
alter table journeys
  add column flow_id uuid,
  add column node_id text,
  add column updated_at timestamptz not null default now(),
  alter column trigger_event drop not null,
  drop constraint journeys_tenant_id_name_key,
  add constraint journeys_flow_fk foreign key (tenant_id, flow_id) references flows (tenant_id, id) on delete cascade;
create index journeys_flow_idx on journeys (tenant_id, flow_id);

-- ---------------------------------------------------------------------------
-- 3. Uczestnicy i historia przejsc.
-- ---------------------------------------------------------------------------
create table flow_participants (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null,
  flow_id uuid not null,
  profile_id uuid not null,
  -- wersja definicji, po ktorej ta osoba idzie (niezmienna do konca jej przebiegu)
  version int not null,
  node_id text not null,
  status text not null check (status in ('w_toku', 'zakonczony', 'wyszedl', 'przerwany')),
  -- occurred_at zdarzenia, ktore wprowadzilo osobe (AD-10), nie chwila tika
  entered_at timestamptz not null,
  node_since timestamptz not null,
  -- kiedy najwczesniej wolno ruszyc dalej (opoznienie / czekaj do); null = od razu
  resume_at timestamptz,
  trigger_event_id uuid,
  -- dane przebiegu: id zamowienia z wyzwalacza, id ostatniej wyslanej wiadomosci
  -- (pod warunek "kliknal w poprzedni mail")
  context jsonb not null default '{}'::jsonb,
  exit_reason text,
  finished_at timestamptz,
  unique (tenant_id, id),
  -- jedno wejscie na osobe: podwojne zdarzenie, dwa tiki naraz albo dwa workery
  -- konczą sie tu konfliktem, nie druga sciezka dla tej samej osoby
  unique (tenant_id, flow_id, profile_id),
  foreign key (tenant_id, flow_id) references flows (tenant_id, id) on delete cascade,
  foreign key (tenant_id, profile_id) references profiles (tenant_id, id) on delete cascade,
  foreign key (tenant_id, flow_id, version) references flow_versions (tenant_id, flow_id, version)
);
create index flow_participants_due_idx on flow_participants (tenant_id, resume_at) where status = 'w_toku';
create index flow_participants_node_idx on flow_participants (tenant_id, flow_id, node_id) where status = 'w_toku';
create index flow_participants_profile_idx on flow_participants (tenant_id, profile_id);

create table flow_transitions (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null,
  participant_id uuid not null,
  flow_id uuid not null,
  profile_id uuid not null,
  version int not null,
  from_node text,
  to_node text,
  kind text not null check (kind in (
    'wejscie', 'przejscie', 'wyslano', 'warunek', 'podzial', 'oczekiwanie',
    'profil', 'wyjscie', 'koniec', 'przerwanie'
  )),
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  foreign key (tenant_id, participant_id) references flow_participants (tenant_id, id) on delete cascade,
  foreign key (tenant_id, flow_id) references flows (tenant_id, id) on delete cascade
);
create index flow_transitions_participant_idx on flow_transitions (tenant_id, participant_id, occurred_at);
create index flow_transitions_flow_node_idx on flow_transitions (tenant_id, flow_id, kind, to_node);

-- ---------------------------------------------------------------------------
-- 4. Migracja istniejacych journeyow do grafu. Deterministyczna: stale identyfikatory
--    wezlow ('wyzwalacz', 'opoznienie', 'email', 'koniec'), flow.id = journey.id.
--    Sekcja miedzy znacznikami MIGRACJA DANYCH jest wykonywana takze przez test
--    (tests/automatyzacje.test.ts) na wierszu w starym ksztalcie, dlatego bierze
--    wylacznie journeye jeszcze nieprzypiete do flow (flow_id is null).
-- ---------------------------------------------------------------------------
-- >>> MIGRACJA DANYCH
create temporary table migracja_flow as
select
  j.id, j.tenant_id, j.name, j.active, j.trigger_event, j.created_at,
  coalesce(j.active_since, j.created_at) as granica,
  jsonb_build_object(
    'wersja', 1,
    'start', 'wyzwalacz',
    'ustawienia', jsonb_build_object('wyjsciePoZakupie', false),
    'wezly',
      case when j.delay_minutes > 0 then jsonb_build_array(
        jsonb_build_object('id', 'wyzwalacz', 'typ', 'wyzwalacz', 'zdarzenie', j.trigger_event,
                           'links', jsonb_build_object('next', 'opoznienie')),
        jsonb_build_object('id', 'opoznienie', 'typ', 'opoznienie', 'ilosc', j.delay_minutes, 'jednostka', 'minuty',
                           'links', jsonb_build_object('next', 'email')),
        jsonb_build_object('id', 'email', 'typ', 'email', 'emailId', j.id,
                           'links', jsonb_build_object('next', 'koniec')),
        jsonb_build_object('id', 'koniec', 'typ', 'koniec')
      ) else jsonb_build_array(
        jsonb_build_object('id', 'wyzwalacz', 'typ', 'wyzwalacz', 'zdarzenie', j.trigger_event,
                           'links', jsonb_build_object('next', 'email')),
        jsonb_build_object('id', 'email', 'typ', 'email', 'emailId', j.id,
                           'links', jsonb_build_object('next', 'koniec')),
        jsonb_build_object('id', 'koniec', 'typ', 'koniec')
      ) end
  ) as definicja
from journeys j
where j.flow_id is null;

insert into flows (id, tenant_id, name, status, trigger_event, draft, draft_version, live, live_version, active_since, created_at)
select id, tenant_id, name,
       case when active then 'wlaczony' else 'szkic' end,
       trigger_event,
       definicja, 1,
       definicja, 1,
       granica, created_at
  from migracja_flow;

-- wersja 1 zawsze istnieje (takze dla szkicow): odwoluja sie do niej przepisani uczestnicy
insert into flow_versions (tenant_id, flow_id, version, definition, published_at)
select tenant_id, id, 1, definicja, granica from migracja_flow;

update journeys j set flow_id = j.id, node_id = 'email'
 where j.id in (select id from migracja_flow);

-- journey_runs -> zakonczeni uczestnicy: kto juz dostal mail, nie wejdzie drugi raz.
-- Data wejscia = triggered_at rejestru (occurred_at zdarzenia), nie chwila migracji.
insert into flow_participants (tenant_id, flow_id, profile_id, version, node_id, status,
                               entered_at, node_since, finished_at, context)
select j.tenant_id, jr.journey_id, jr.profile_id, 1, 'koniec', 'zakonczony',
       jr.triggered_at, jr.triggered_at, jr.triggered_at,
       jsonb_build_object('migracja', '0019')
  from journey_runs jr
  join journeys j on j.id = jr.journey_id
 where jr.journey_id in (select id from migracja_flow)
on conflict (tenant_id, flow_id, profile_id) do nothing;

insert into flow_transitions (tenant_id, participant_id, flow_id, profile_id, version, from_node, to_node, kind, detail, occurred_at)
select p.tenant_id, p.id, p.flow_id, p.profile_id, 1, null, 'wyzwalacz', 'wejscie',
       jsonb_build_object('migracja', '0019'), p.entered_at
  from flow_participants p
 where p.context->>'migracja' = '0019';

-- Odczyt zwrotny: kazdy journey jest przypiety do istniejacego flow tego samego tenanta
-- (zmigrowane: flow_id = id; wiadomosci utworzone na kanwie: flow_id = flow, do ktorego naleza).
do $$
declare
  bez_flow int;
  bez_wersji int;
begin
  select count(*) into bez_flow from journeys j
   where j.flow_id is null or not exists (select 1 from flows f where f.tenant_id = j.tenant_id and f.id = j.flow_id);
  select count(*) into bez_wersji from flows f
   where not exists (select 1 from flow_versions v where v.tenant_id = f.tenant_id and v.flow_id = f.id and v.version = 1);
  if bez_flow > 0 or bez_wersji > 0 then
    raise exception '0019: % journeyow bez flow, % flow bez wersji 1 - migracja wycofana', bez_flow, bez_wersji;
  end if;
end $$;

drop table migracja_flow;
-- <<< MIGRACJA DANYCH
