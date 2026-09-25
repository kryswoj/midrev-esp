-- BLOK B z PLAN-DOWIEZIENIA-2026-09-22.md, pozycje B1, B2 i B5: trzy obietnice, ktore
-- interfejs juz sklada, a silnika pod nimi nie ma.
--
-- B1 dispatcher zaplanowanych kampanii: `scheduled_at` lezy w bazie od 0004 i panel je
--    pokazuje, ale ZADEN proces tej kolumny nie czyta. Operator planuje wysylke na wtorek
--    10:00 i we wtorek nie dzieje sie nic.
-- B2 wstrzymanie i odwolanie wysylki w trakcie: dzis nie ma tego wcale, a to jedyny ratunek
--    po zauwazeniu bledu w wyslanej polowie kampanii.
-- B5 progi skarg z automatycznym wstrzymaniem tenanta: jest tylko plaski limit dobowy 500,
--    ktory nie mowi nic o tym, czy to, co wysylamy, w ogole dochodzi.
--
-- Zasada, ktora ta migracja utrzymuje: KAZDY stan, od ktorego zalezy "czy ten mail ma
-- wyjsc", jest kolumna w bazie sprawdzana w tej samej instrukcji, ktora wiadomosc zajmuje.
-- Stan trzymany w pamieci procesu nie przezyje restartu workera, a stan sprawdzany osobnym
-- SELECT-em przed UPDATE-em przepuszcza wyscig dwoch workerow — a podwojna wysylka jest
-- nieodwracalna (NFR15).

-- ---------------------------------------------------------------------------
-- B2. Wstrzymanie kampanii.
-- ---------------------------------------------------------------------------

-- 'paused' to stan POSREDNI miedzy 'sending' a decyzja czlowieka: wysylka stoi, kampania
-- nie jest ani wyslana, ani odwolana. Bez osobnego stanu wstrzymanie musialoby udawac
-- 'cancelled' (klamstwo: kampanie da sie wznowic) albo zostac w 'sending' z flaga obok
-- (dwa zrodla prawdy o tym samym; przy wyscigu rozjezdzaja sie po cichu).
--
-- 'scheduled' zostaje w slowniku NIEUZYWANY i tak ma byc: plan wysylki to `scheduled_at`
-- przy statusie 'approved' (dokladnie warunek z B1), bo osobny status 'scheduled' gubilby
-- informacje o tym, czy kampania ma zywa akceptacje klienta — a to jest bramka, ktorej
-- harmonogram NIE wolno omijac (FR41).
alter table campaigns drop constraint campaigns_status_check;
alter table campaigns add constraint campaigns_status_check
  check (status in ('draft', 'awaiting_approval', 'approved', 'scheduled',
                    'sending', 'paused', 'sent', 'cancelled'));

alter table campaigns
  -- chwila wstrzymania i chwila odwolania. Nie `updated_at`: ten rusza sie przy kazdym
  -- zapisie tresci i nie odpowie na pytanie "od kiedy ta wysylka stoi".
  add column paused_at timestamptz,
  add column cancelled_at timestamptz,
  -- jednorazowy znacznik alertu o przeterminowanym planie (patrz nizej, B1). Atomowy
  -- `update ... where schedule_missed_alert_at is null returning id` sprawia, ze przy
  -- dwoch workerach alert idzie DOKLADNIE raz, a nie co minute z kazdego procesu.
  add column schedule_missed_alert_at timestamptz;

-- ---------------------------------------------------------------------------
-- B1. Dispatcher zaplanowanych kampanii.
-- ---------------------------------------------------------------------------

-- Dispatcher chodzi co minute w KAZDYM workerze, wiec to zapytanie wykonuje sie czesciej
-- niz cokolwiek innego w systemie. Partial po statusie: kampanii w 'approved' z terminem
-- jest garstka, a caly zbior kampanii rosnie w nieskonczonosc.
create index campaigns_zaplanowane_idx on campaigns (scheduled_at)
  where status = 'approved' and scheduled_at is not null;

-- ---------------------------------------------------------------------------
-- B5. Wstrzymanie CALEGO tenanta po przekroczeniu progow reputacji.
--
-- Powod, dla ktorego to jest stan tenanta, a nie kampanii: pula IP jest wspolna
-- (SES-BYOD-SPEC sekcja 9), wiec jeden nadawca ze skargami psuje dostarczalnosc
-- wszystkim pozostalym. Wstrzymanie ma zatrzymac WSZYSTKO, co ten tenant wysyla —
-- kampanie, automatyzacje i testy — a nie jedna kampanie, ktora akurat zwrocila uwage.
-- ---------------------------------------------------------------------------

alter table tenants
  -- null = wysylka dozwolona. Data, nie boolean: przy rozmowie z klientem i przy wniosku
  -- do AWS pierwsze pytanie brzmi "od kiedy", a boolean na to nie odpowiada.
  add column sending_paused_at timestamptz,
  -- powod w brzmieniu, ktore zobaczy operator na ekranie kampanii, razem z liczbami.
  -- Przycisk zablokowany bez widocznego powodu jest w tym panelu zakazany (DESIGN.md).
  add column sending_pause_reason text,
  -- znacznik ostatniego alertu "przekroczony prog przegladu" (ponizej progu wstrzymania).
  -- Bez niego alert szedlby po KAZDEJ partii, czyli kilkaset razy dziennie, i po tygodniu
  -- nikt by go nie czytal — czyli tyle samo, co brak alertu.
  add column reputation_alert_at timestamptz;
