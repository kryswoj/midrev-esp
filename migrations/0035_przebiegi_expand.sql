-- Ponowne wejscie do automatyzacji, etap EXPAND (plan 3.4, AD-41, AD-46).
--
-- Problem: `flow_participants UNIQUE (tenant_id, flow_id, profile_id)` (0019) pozwala na jedno
-- wejscie osoby na cale zycie flow, a `messages UNIQUE (tenant_id, source_type, source_id,
-- profile_id)` (0005) sprawia, ze drugi przebieg tej samej osoby przez ten sam krok zostalby
-- po cichu oznaczony `pominieto` (sciezka bez maili).
--
-- Rozwiazanie: przebieg (wiersz flow_participants) jest jednostka idempotencji.
--  - wejscie: unikalnosc (tenant, flow, profil, entry_key); entry_key = 'raz' albo 'e:<id zdarzenia>';
--  - wiadomosc journey: unikalnosc (tenant, zrodlo, profil, journey_run_id); kampanie maja
--    osobna unikalnosc czesciowa z dokladnie dotychczasowa semantyka (NULLS NOT DISTINCT).
--
-- Ta migracja jest ZGODNA ZE STARYM KODEM (deploy.sh nie cofa migracji; przy rollbacku stary
-- kod dziala na tym schemacie):
--  - stare unikalnosci ZOSTAJA (stary kod ma `on conflict` na nich); zdejmuje je dopiero 0036
--    w kolejnym wydaniu, najwczesniej 7 dni pozniej (migrations-pending/0036_przebiegi_contract.sql);
--  - nowe kolumny maja wartosci domyslne albo sa nullable, wiec INSERT starego kodu przechodzi;
--  - brak CHECK "wiadomosc journey ma przebieg": stary kod w trakcie deployu (panel dziala
--    podczas migracji) wstawia wiadomosci bez journey_run_id, a usuniecie uczestnika zeruje
--    przebieg (SET NULL). Luki po starym kodzie uzupelnia ponownie 0036;
--  - dopoki stoja stare unikalnosci, ponowne wejscie inne niz "raz" jest WYLACZONE w kodzie
--    (`ponowneWejscieDostepne`: flaga srodowiska + sprawdzenie, ze stare constrainty zniknely).
--
-- Oprocz tego: znacznik skanu wyzwalaczy per flow, zdenormalizowana metryka wyzwalacza
-- i funkcja `filtr_data` jezyka filtrow (AD-42).

-- ---------------------------------------------------------------------------
-- 1. Klucz wejscia i referencja do zdarzenia wyzwalajacego.
--    Kolumna NOT NULL ze stala domyslna: w PG >= 11 bez przepisywania tabeli.
-- ---------------------------------------------------------------------------
alter table flow_participants
  add column entry_key text not null default 'raz' check (char_length(entry_key) between 1 and 300),
  -- klucz partycji `metric_events` (occurred_at) do odczytu zdarzenia przy renderze maila
  add column trigger_event_occurred_at timestamptz;

create unique index flow_participants_wejscie_uq
  on flow_participants (tenant_id, flow_id, profile_id, entry_key);

-- ---------------------------------------------------------------------------
-- 2. Przebieg w wiadomosci.
--    ON DELETE SET NULL: usuniecie profilu kasuje kaskadowo jego przebiegi (0019), a historia
--    wiadomosci ma zostac (messages -> profiles tez jest SET NULL, 0005).
-- ---------------------------------------------------------------------------
alter table messages add column journey_run_id uuid;
alter table messages add constraint messages_przebieg_fk
  foreign key (tenant_id, journey_run_id) references flow_participants (tenant_id, id)
  on delete set null (journey_run_id);

-- Sekcja miedzy znacznikami jest wykonywana takze przez test (tests/flow-ponowne-wejscie.test.ts)
-- na wiadomosciach w starym ksztalcie (bez przebiegu), dlatego dotyka wylacznie takich wierszy.
-- >>> BACKFILL PRZEBIEGOW
-- Backfill (jednorazowy wyjatek od AD-22: dopisanie TOZSAMOSCI wiadomosci, nie jej stanu).
-- Zakres: wylacznie wiadomosci journey bez przebiegu (lista kontrolna pkt 7). Stara unikalnosc
-- uczestnika (flow, profil) gwarantuje, ze dopasowanie jest jednoznaczne.
update messages m
   set journey_run_id = p.id
  from journeys j
  join flow_participants p on p.tenant_id = j.tenant_id and p.flow_id = j.flow_id
 where m.source_type = 'journey'
   and m.journey_run_id is null
   and m.profile_id is not null
   and j.tenant_id = m.tenant_id and j.id = m.source_id
   and p.profile_id = m.profile_id;

-- Odczyt zwrotny ZAPISANYCH wierszy (lista kontrolna pkt 3 i 4): liczymy wynik, nie proby.
do $$
declare
  luki int;
  sieroty int;
  zly_przebieg int;
  zdublowane int;
begin
  -- luka: przebieg tej osoby w tym flow ISTNIEJE, a wiadomosc nie jest do niego przypieta
  select count(*) into luki
    from messages m
    join journeys j on j.tenant_id = m.tenant_id and j.id = m.source_id
    join flow_participants p on p.tenant_id = j.tenant_id and p.flow_id = j.flow_id and p.profile_id = m.profile_id
   where m.source_type = 'journey' and m.journey_run_id is null;
  -- sierota: wiadomosc bez zadnego uczestnika (usuniety flow albo profil); nie da sie jej
  -- przypiac, ale tez nic nie blokuje (wypada z unikalnosci czesciowej ponizej)
  select count(*) into sieroty
    from messages m
   where m.source_type = 'journey' and m.journey_run_id is null;
  -- przebieg innej osoby, innego flow albo innego tenanta niz wiadomosc
  select count(*) into zly_przebieg
    from messages m
    join flow_participants p on p.tenant_id = m.tenant_id and p.id = m.journey_run_id
    left join journeys j on j.tenant_id = m.tenant_id and j.id = m.source_id
   where m.source_type = 'journey'
     and (p.profile_id is distinct from m.profile_id or p.flow_id is distinct from j.flow_id);
  -- dwie wiadomosci tego samego kroku w jednym przebiegu (nie powinno byc mozliwe)
  select count(*) into zdublowane from (
    select 1 from messages m where m.journey_run_id is not null
     group by m.tenant_id, m.source_type, m.source_id, m.profile_id, m.journey_run_id having count(*) > 1
  ) x;
  if luki > 0 or zly_przebieg > 0 or zdublowane > 0 then
    raise exception '0035: wiadomosci journey z nieprzypietym przebiegiem: %, z cudzym przebiegiem: %, zdublowane w przebiegu: % - migracja wycofana',
      luki, zly_przebieg, zdublowane;
  end if;
  if sieroty > 0 then
    raise notice '0035: % wiadomosci journey bez uczestnika (usuniety flow lub profil) zostaje bez przebiegu', sieroty;
  end if;
end $$;
-- <<< BACKFILL PRZEBIEGOW

-- Dwie unikalnosci czesciowe zamiast jednej po pieciu kolumnach:
--  - kampanie i wysylki testowe: dokladnie dotychczasowa semantyka (NULLS NOT DISTINCT);
--  - automatyzacje: jedna wiadomosc z kroku na PRZEBIEG. Wiadomosc, ktora stracila przebieg
--    (ON DELETE SET NULL po usunieciu uczestnika), wypada z unikalnosci: inaczej dwie takie
--    wiadomosci tej samej osoby z dwoch przebiegow zderzylyby sie przy usuwaniu i blokowaly
--    usuniecie profilu albo tenanta.
create unique index messages_zrodlo_uq
  on messages (tenant_id, source_type, source_id, profile_id) nulls not distinct
  where source_type <> 'journey';
create unique index messages_przebieg_uq
  on messages (tenant_id, source_id, profile_id, journey_run_id)
  where source_type = 'journey' and journey_run_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Metryka wyzwalacza zdenormalizowana z definicji live (plan 3.1), obok trigger_event.
--    Klucz obcy do `metrics` (tabela strumienia A, 0030) dokladamy tylko, gdy tabela juz
--    istnieje. Po scaleniu galezi migracje ida po kolei (0030 przed 0035), wiec na kazdym
--    nowym srodowisku FK powstaje; na bazie, ktora dostala 0035 przed 0030 (tylko robocze
--    bazy testowe strumienia B), FK nie powstanie i trzeba je zalozyc od nowa.
-- ---------------------------------------------------------------------------
alter table flows add column trigger_metric_id uuid;
do $$
begin
  if to_regclass('public.metrics') is not null then
    alter table flows add constraint flows_trigger_metric_fk
      foreign key (tenant_id, trigger_metric_id) references metrics (tenant_id, id)
      on delete set null (trigger_metric_id);
  end if;
end $$;
create index flows_trigger_metric_idx on flows (tenant_id, trigger_metric_id) where trigger_metric_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Znacznik skanu wejsc per flow (plan 2.6): zamiast stalego okna 7 dni tik czyta
--    zdarzenia zarejestrowane po `scanned_to - 15 min`. Zapisywany w TEJ SAMEJ transakcji
--    co wejscia, wiec znacznik i wejscia nie moga sie rozjechac.
-- ---------------------------------------------------------------------------
create table flow_trigger_state (
  tenant_id uuid not null,
  flow_id uuid not null,
  scanned_to timestamptz not null,
  -- tryb nadrabiania: poprzedni skan obcial limit wierszy; nastepny czyta od kursora
  -- (recorded_at, id) = (scanned_to, kursor_id) bez zakladki, zeby zawsze posuwac sie naprzod
  kursor_id uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, flow_id),
  foreign key (tenant_id, flow_id) references flows (tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 5. Data w jezyku filtrow (AD-42). Wzorzec MUSI byc identyczny z WZORZEC_DATY
--    w src/domain/filtry/typy.ts (test parytetu TS/SQL). Zly zapis, 31 lutego itp. = NULL,
--    nie blad: jedno dziwne zdarzenie nie moze wywrocic zapytania o tysiace wierszy.
--    Bez strefy = UTC (tak samo w TS), niezaleznie od TimeZone sesji.
-- ---------------------------------------------------------------------------
create function filtr_data(t text) returns timestamptz
language plpgsql stable parallel safe as $$
declare
  wzorzec constant text := '^([1-9][0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])(?:[T ]([01][0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9])(?:\.([0-9]{1,3}))?)?(Z|[+-](?:[01][0-9]|2[0-3]):?[0-5][0-9])?)?$';
begin
  if t is null or t !~ wzorzec then
    return null;
  end if;
  if t ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' then
    return t::timestamptz;
  end if;
  return (t || '+00')::timestamptz;
exception when others then
  return null;
end $$;
