-- Atrybucja z pojeciem ZRODLA: kampania albo automatyzacja (journey).
--
-- Powod: 0007 dalo `attributions.campaign_id not null`, a przeliczenie bralo pod uwage
-- wylacznie wiadomosci `source_type = 'campaign'`. Zamowienie po kliknieciu w mail
-- z automatyzacji nie mialo gdzie trafic, wiec rozbicia "kampanie kontra automatyzacje"
-- (glowny argument agencji, pierwszy ekran w Klaviyo) nie dalo sie policzyc wcale.
--
-- Model po tej migracji:
--   source_type + source_id  - kanoniczne zrodlo przychodu, zawsze wypelnione;
--   campaign_id / journey_id - te same wartosci rozpisane na kolumny z kluczem obcym,
--                              dokladnie jedna niepusta (CHECK). Zostaja, bo FK nie da sie
--                              zalozyc na polimorficzne source_id, a `campaign_id` czytaja
--                              dzisiejsze raporty kampanii.
--
-- Izolacja tenantow: wszystkie klucze obce z attributions (i z attribution_runs) staja sie
-- ZLOZONE przez tenant_id. 0007 zostawilo trzy pojedyncze FK (run_id, click_id, rule_id),
-- czyli dokladnie ten wzorzec, ktory w tym repo przepuscil juz rozjazd miedzy tenantami.
--
-- Spojnosc lancucha klik -> wiadomosc -> zrodlo, wymuszona w bazie, nie w kodzie:
--   FK (tenant_id, click_id, message_id) do clicks: klik nalezy do TEJ wiadomosci;
--   FK (tenant_id, message_id, source_type, source_id) do messages: zrodlo atrybucji
--   jest zrodlem tej wiadomosci. Atrybucja nie moze twierdzic, ze klik w mail z kampanii
--   X zarobil dla kampanii Y albo dla automatyzacji.

-- ---------------------------------------------------------------------------
-- 1. Pary (tenant_id, id) pod zlozone klucze obce. 0007 ich nie dalo.
-- ---------------------------------------------------------------------------
-- clicks: trojka z message_id, zeby FK z atrybucji wiazal klik z konkretna wiadomoscia.
alter table clicks add constraint clicks_tenant_id_message_unique unique (tenant_id, id, message_id);
alter table attribution_runs add constraint attribution_runs_tenant_id_unique unique (tenant_id, id);
alter table attribution_rules add constraint attribution_rules_tenant_id_unique unique (tenant_id, id);
-- Czworke (tenant_id, id, source_type, source_id) na messages dalo juz 0014
-- (messages_tozsamosc_zrodla_unique) - FK nizej wskazuje na nia, nie dublujemy indeksu.

-- ---------------------------------------------------------------------------
-- 2. Nowe kolumny i uzupelnienie istniejacych wierszy.
-- ---------------------------------------------------------------------------
alter table attributions
  add column source_type text,
  add column source_id uuid,
  add column journey_id uuid,
  alter column campaign_id drop not null;

-- Wszystkie dotychczasowe wiersze powstaly z zapytania z `m2.source_type = 'campaign'`
-- i `campaign_id = m.source_id`. Zrodlo bierzemy jednak Z WIADOMOSCI, a nie z zalozenia:
-- jesli kiedys trafil tu wiersz sprzeczny z wiadomoscia, blok ponizej zatrzyma migracje
-- zamiast po cichu przepisac falszywe przypisanie do nowego modelu.
update attributions a
   set source_type = m.source_type,
       source_id = m.source_id
  from messages m
 where m.tenant_id = a.tenant_id
   and m.id = a.message_id;

do $$
declare
  bez_zrodla int;
  sprzeczne int;
begin
  select count(*) into bez_zrodla from attributions where source_type is null or source_id is null;
  select count(*) into sprzeczne from attributions
   where source_type is distinct from 'campaign' or source_id is distinct from campaign_id;
  if bez_zrodla > 0 or sprzeczne > 0 then
    raise exception '0018: % wierszy atrybucji bez wiadomosci, % sprzecznych z campaign_id - wymagana reczna analiza',
      bez_zrodla, sprzeczne;
  end if;
end $$;

alter table attributions
  alter column source_type set not null,
  alter column source_id set not null;

-- ---------------------------------------------------------------------------
-- 3. Dokladnie jedno zrodlo i zgodnosc kolumn rozpisanych z kanonicznymi.
--    'test' swiadomie poza zbiorem: wiadomosc testowa nie zarabia.
--    Jawne `is not null` przy kazdej kolumnie zrodla: samo `journey_id = source_id` przy
--    journey_id NULL daje NULL, a CHECK traktuje NULL jak "przepuszczam". Wiersz bez
--    zadnej kolumny FK przeszedlby wtedy walidacje (zlapal to test, nie review).
-- ---------------------------------------------------------------------------
alter table attributions add constraint attributions_source_check check (
  (source_type = 'campaign' and campaign_id is not null and campaign_id = source_id and journey_id is null)
  or
  (source_type = 'journey' and journey_id is not null and journey_id = source_id and campaign_id is null)
);

-- ---------------------------------------------------------------------------
-- 4. Klucze obce zlozone przez tenant_id.
--    Kampania / automatyzacja: bez kaskady. Aplikacja nie usuwa ani kampanii, ani
--    automatyzacji, a gdyby kiedys zaczela, historia przychodu nie moze zniknac po cichu
--    razem z nimi (AD-28: liczba pokazana wczoraj ma byc do odtworzenia). NO ACTION
--    jest sprawdzane na koncu polecenia, wiec kaskadowe usuniecie calego tenanta dziala.
-- ---------------------------------------------------------------------------
alter table attributions
  add constraint attributions_campaign_fk
    foreign key (tenant_id, campaign_id) references campaigns (tenant_id, id),
  add constraint attributions_journey_fk
    foreign key (tenant_id, journey_id) references journeys (tenant_id, id);

alter table attributions drop constraint attributions_tenant_id_message_id_fkey;
alter table attributions add constraint attributions_message_source_fk
  foreign key (tenant_id, message_id, source_type, source_id)
  references messages (tenant_id, id, source_type, source_id) on delete cascade;

alter table attributions drop constraint attributions_run_id_fkey;
alter table attributions add constraint attributions_run_fk
  foreign key (tenant_id, run_id) references attribution_runs (tenant_id, id) on delete cascade;

alter table attributions drop constraint attributions_click_id_fkey;
alter table attributions add constraint attributions_click_fk
  foreign key (tenant_id, click_id, message_id) references clicks (tenant_id, id, message_id);

alter table attribution_runs drop constraint attribution_runs_rule_id_fkey;
alter table attribution_runs add constraint attribution_runs_rule_fk
  foreign key (tenant_id, rule_id) references attribution_rules (tenant_id, id);

-- ---------------------------------------------------------------------------
-- 5. Indeksy pod raport per zrodlo.
--    Raport zawsze pyta o JEDEN przebieg (najnowszy zakonczony), wiec run_id idzie
--    zaraz po tenant_id; amount_minor w INCLUDE daje sume bez siegania do tabeli.
--    Indeks po journey_id obsluguje FK (i raport pojedynczej automatyzacji).
-- ---------------------------------------------------------------------------
create index attributions_source_idx
  on attributions (tenant_id, run_id, source_type, source_id) include (amount_minor);
create index attributions_journey_idx
  on attributions (tenant_id, journey_id, run_id) where journey_id is not null;
create index attributions_click_idx on attributions (tenant_id, click_id);
