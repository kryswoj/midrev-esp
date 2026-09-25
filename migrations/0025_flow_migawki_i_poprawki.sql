-- Poprawki automatyzacji po review (0019 zostaje nietknieta).
--
-- 1. Migawka tresci maili w wersji (flow_versions.emails). Do tej pory silnik wysylal
--    temat i HTML prosto z `journeys`, czyli z tego, co operator WLASNIE edytuje: wyczyszczony
--    temat w wlaczonej automatyzacji przerywal ludziom sciezke po 800 ms, a polgotowa tresc
--    szla do klientow po 1,5 s. Po tej migracji `journeys` to szkic wiadomosci, a wysylka idzie
--    z migawki wersji, po ktorej biegnie uczestnik. Zmiana tresci dociera do ludzi dopiero
--    po "Opublikuj", przez te sama bramke co zmiana grafu.
-- 2. Nowy rodzaj przejscia 'pominieto': krok e-mail, ktorego ta osoba nie dostala, bo
--    wiadomosc z tego kroku juz kiedys do niej wyszla (unikalnosc AD-26). Do tej pory
--    zapisywal sie jako 'wyslano', czyli sciezka osoby klamala.
-- 3. Indeks pod liczniki kanwy (tenant, flow, status).
-- 4. Sprzatanie po 0019: zdublowane przejscia 'wejscie' z migracji i updated_at
--    zmigrowanych wierszy (0019 ustawila je na chwile migracji, nie na date zrodla).

-- ---------------------------------------------------------------------------
-- 1. Migawka tresci w wersji.
--    Sekcja miedzy znacznikami jest wykonywana takze przez test na wierszach, ktore
--    wstawila sekcja danych 0019, dlatego dotyka tylko wersji bez migawki ('{}').
--    Migawka dla istniejacych wersji to biezaca tresc maili: dokladnie to, co silnik
--    wysylal do tej pory, wiec wlaczone automatyzacje nie zmieniaja zachowania.
-- ---------------------------------------------------------------------------
alter table flow_versions add column emails jsonb not null default '{}'::jsonb;

-- >>> MIGAWKI WERSJI
update flow_versions v
   set emails = coalesce((
     select jsonb_object_agg(j.id::text, jsonb_build_object(
              'subject', coalesce(j.subject, ''),
              'html', coalesce(j.content->>'html', '')))
       from journeys j
      where j.tenant_id = v.tenant_id and j.flow_id = v.flow_id
        and exists (select 1 from jsonb_array_elements(v.definition->'wezly') w
                     where w->>'typ' = 'email' and w->>'emailId' = j.id::text)
   ), '{}'::jsonb)
 where v.emails = '{}'::jsonb;

-- odczyt zwrotny: kazdy wezel e-mail kazdej wersji ma migawke
do $$
declare
  bez int;
begin
  select count(*) into bez
    from flow_versions v, jsonb_array_elements(v.definition->'wezly') w
   where w->>'typ' = 'email' and not (v.emails ? (w->>'emailId'));
  if bez > 0 then
    raise exception '0025: % wezlow e-mail bez migawki tresci - migracja wycofana', bez;
  end if;
end $$;
-- <<< MIGAWKI WERSJI

-- ---------------------------------------------------------------------------
-- 2. Rodzaj przejscia 'pominieto'.
-- ---------------------------------------------------------------------------
alter table flow_transitions drop constraint flow_transitions_kind_check;
alter table flow_transitions add constraint flow_transitions_kind_check check (kind in (
  'wejscie', 'przejscie', 'wyslano', 'pominieto', 'warunek', 'podzial', 'oczekiwanie',
  'profil', 'wyjscie', 'koniec', 'przerwanie'
));

-- ---------------------------------------------------------------------------
-- 3. Indeks pod liczniki kanwy i listy automatyzacji.
-- ---------------------------------------------------------------------------
create index flow_participants_flow_status_idx on flow_participants (tenant_id, flow_id, status);

-- ---------------------------------------------------------------------------
-- 4. Sprzatanie po 0019.
-- ---------------------------------------------------------------------------
-- (a) 0019 dopisywala przejscie 'wejscie' kazdemu uczestnikowi z migracji; ponowne
--     wykonanie sekcji danych dublowalo je. Zostaje najstarszy wpis per uczestnik.
delete from flow_transitions t
 where t.kind = 'wejscie' and t.detail->>'migracja' = '0019'
   and exists (
     select 1 from flow_transitions t2
      where t2.tenant_id = t.tenant_id and t2.participant_id = t.participant_id
        and t2.kind = 'wejscie' and t2.detail->>'migracja' = '0019'
        and (t2.occurred_at, t2.id) < (t.occurred_at, t.id)
   );

-- (b) updated_at zmigrowanych wierszy = data utworzenia zrodla, nie chwila migracji.
update journeys j set updated_at = j.created_at
 where j.flow_id = j.id and j.node_id = 'email' and j.updated_at > j.created_at
   and not exists (select 1 from flows f where f.tenant_id = j.tenant_id and f.id = j.flow_id and f.draft_version > 1);
update flows f set updated_at = f.created_at
 where f.draft_version = 1 and f.updated_at > f.created_at
   and exists (select 1 from journeys j where j.tenant_id = f.tenant_id and j.id = f.id);
