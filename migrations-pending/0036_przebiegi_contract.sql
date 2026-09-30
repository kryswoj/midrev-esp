-- Ponowne wejscie do automatyzacji, etap CONTRACT (plan 3.4, AD-41, AD-46).
--
-- NIE JEST AKTYWNA MIGRACJA. Plik lezy poza migrations/, bo:
--  - idzie w OSOBNYM wydaniu (N+1), najwczesniej 7 dni po wydaniu z 0035, i tylko jesli
--    wydanie N stalo bez rollbacku (po tej migracji stary kod sprzed 0035 nie dziala:
--    jego `on conflict (tenant_id, flow_id, profile_id)` i `on conflict (tenant_id,
--    source_type, source_id, profile_id)` nie maja juz constraintu);
--  - przed przeniesieniem do migrations/ sprawdz pg_depend (ponizej) i nazwy constraintow
--    na produkcji (SELECT, bez zmian).
--
-- Po tej migracji mozna ustawic MIDREV_PONOWNE_WEJSCIE=1 (kod sam sprawdza, czy stare
-- constrainty zniknely, i bez tego nie wlaczy trybow "zawsze" / "po X").
--
-- Kontrola przed przeniesieniem (tylko odczyt):
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid in ('flow_participants'::regclass, 'messages'::regclass) and contype = 'u';
--   select classid::regclass, objid, deptype from pg_depend
--    where refobjid in (select oid from pg_constraint where conname in (
--      'flow_participants_tenant_id_flow_id_profile_id_key',
--      'messages_tenant_id_source_type_source_id_profile_id_key'));

-- 1. Wiadomosci journey wstawione przez stary kod w trakcie deployu wydania N (bez
--    journey_run_id): ta sama regula co backfill 0035, tylko dla luk.
update messages m
   set journey_run_id = p.id
  from journeys j
  join flow_participants p on p.tenant_id = j.tenant_id and p.flow_id = j.flow_id and p.entry_key = 'raz'
 where m.source_type = 'journey'
   and m.journey_run_id is null
   and m.profile_id is not null
   and j.tenant_id = m.tenant_id and j.id = m.source_id
   and p.profile_id = m.profile_id;

-- Odczyt zwrotny: luka = wiadomosc osoby, ktorej przebieg ISTNIEJE, a nie jest przypiety.
-- Wiadomosci bez zadnego uczestnika (usuniety profil albo flow, SET NULL) sa dozwolone:
-- wypadaja z unikalnosci czesciowej i nie blokuja niczego.
do $$
declare
  luki int;
  wiele_wejsc int;
begin
  select count(*) into luki
    from messages m
    join journeys j on j.tenant_id = m.tenant_id and j.id = m.source_id
    join flow_participants p on p.tenant_id = j.tenant_id and p.flow_id = j.flow_id and p.profile_id = m.profile_id
   where m.source_type = 'journey' and m.journey_run_id is null;
  -- do tej chwili stara unikalnosc pilnowala jednego wejscia na (flow, profil)
  select count(*) into wiele_wejsc from (
    select 1 from flow_participants group by tenant_id, flow_id, profile_id having count(*) > 1) x;
  if luki > 0 or wiele_wejsc > 0 then
    raise exception '0036: wiadomosci journey bez przypietego przebiegu: %, osoby z wieloma wejsciami przed zdjeciem unikalnosci: % - migracja wycofana',
      luki, wiele_wejsc;
  end if;
end $$;

-- 2. Zdjecie starych unikalnosci. Od teraz wiazace sa:
--    flow_participants_wejscie_uq (tenant, flow, profil, entry_key),
--    messages_przebieg_uq (tenant, zrodlo, profil, journey_run_id) dla automatyzacji
--    i messages_zrodlo_uq (tenant, source_type, source_id, profil) NULLS NOT DISTINCT dla reszty.
alter table flow_participants drop constraint flow_participants_tenant_id_flow_id_profile_id_key;
alter table messages drop constraint messages_tenant_id_source_type_source_id_profile_id_key;

-- 3. Indeks pod regule "po X" i sciezke osoby (zastepuje prefiks zdjetej unikalnosci).
create index flow_participants_osoba_wejscia_idx on flow_participants (tenant_id, flow_id, profile_id, entered_at desc);
