-- BLOK A z PLAN-DOWIEZIENIA-2026-09-22.md: piec decyzji schematu, ktorych dopisanie
-- PO pierwszej prawdziwej wysylce wymaga przeliczenia historii wstecz, a danych
-- zrodlowych juz wtedy nie ma. Sekcje odpowiadaja A1-A5 z planu.
--
-- Trzy zasady, ktore ta migracja egzekwuje w bazie, a nie w komentarzu do kodu:
--   AD-10: data zdarzenia pochodzi ZE ZRODLA i jest podawana jawnie. Kazdy `default now()`
--          na kolumnie "kiedy to sie stalo" to cicha falszywka przy imporcie i przy
--          webhooku, ktory dotarl z opoznieniem. 0002 zdjelo taki default z `events`;
--          tutaj robimy to samo z `message_events` i nie powtarzamy bledu w nowej tabeli.
--   AD-22: `message_events` zostaje STRUMIENIEM STANU z unikalnoscia (message_id, event_type).
--          Nie ruszamy tej unikalnosci. Zdarzenia powtarzalne dostaja wlasna tabele.
--   Izolacja tenantow: kazdy klucz obcy siegajacy przez tenanta jest ZLOZONY i zaczyna sie
--          od tenant_id (wzorzec z 0001 i 0005). Pojedyncze `references ... (id)` przepuscilo
--          w tym repo realny rozjazd miedzy tenantami.

-- ---------------------------------------------------------------------------
-- A3. Pola diagnostyczne przy wyslanej wiadomosci.
--
-- Powod: przy pierwszym problemie z dostarczalnoscia jedyne pytanie brzmi "ktore maile,
-- z ktorego IP, z ktorej puli i z ktorej domeny". Bez tych kolumn odpowiedzi nie ma i nie
-- da sie jej odtworzyc wstecz, bo dostawca nie trzyma naszego mapowania. Kolumny kosztuja
-- zero przy jednym dostawcy i jednej domenie, a sa jedynym sposobem na rozbicie problemu
-- po pasmach reputacji, gdy dostawcow albo domen zrobi sie wiecej.
-- ---------------------------------------------------------------------------

-- 0005 nie dalo sending_domains pary (tenant_id, id), wiec nie da sie na nia zlozyc
-- klucza obcego. Dokladamy unikalnosc tutaj, tym samym ruchem co 0007 dla `orders`.
alter table sending_domains add constraint sending_domains_tenant_id_unique unique (tenant_id, id);

alter table messages
  -- nazwa dostawcy UZYTEGO FAKTYCZNIE, nie skonfigurowanego dzis. Po zmianie dostawcy
  -- historia musi mowic, ktory mail poszedl ktoredy; `config().` tego nie pamieta.
  add column provider text,
  -- pula IP i konkretne IP nadania. Odpowiednik Klaviyo `IpPool` / `Sending Ip Address`
  -- (KLAVIYO-MODULY 4.7). Przy wspolnej puli to jedyny sposob, zeby powiedziec, czy
  -- problem dotyczy naszego nadawcy, czy sasiada z tej samej puli.
  add column ip_pool text,
  add column sending_ip inet,
  -- domena wysylkowa UZYTA przy tej wiadomosci. Nullable, bo wiadomosci sprzed tej
  -- migracji i wiadomosci z adaptera SMTP (Mailpit) nie maja wiersza w sending_domains.
  add column sending_domain_id uuid,
  -- moment przekazania do dostawcy, osobny od daty zdarzenia `sent` (Klaviyo: Handoff Time).
  -- Roznica miedzy handoff a delivered to jedyna miara opoznienia po stronie dostawcy.
  add column handed_off_at timestamptz;

-- FK zlozony: domena wysylkowa tenanta A nie moze trafic na wiadomosc tenanta B.
-- `on delete set null (sending_domain_id)` w formie kolumnowej (PG15+), bo zwykle
-- `set null` wyzerowaloby cala krotke FK razem z tenant_id i wywalilo sie o not null.
alter table messages
  add constraint messages_sending_domain_fk
  foreign key (tenant_id, sending_domain_id) references sending_domains (tenant_id, id)
  on delete set null (sending_domain_id);

-- Kazde zdarzenie od dostawcy przychodzi z jego wlasnym identyfikatorem i musi trafic
-- w nasza wiadomosc. Bez tego indeksu handler webhooka robi seq scan po najwiekszej
-- tabeli systemu przy kazdym zdarzeniu. Indeks NIE jest unikalny: przy dwoch dostawcach
-- identyfikatory moga sie teoretycznie zderzyc, a unikalnosc wywalilaby wtedy zapis
-- wysylki, czyli rzecz nieodwracalna, z powodu kolizji w polu diagnostycznym.
create index messages_provider_id_idx on messages (provider_id) where provider_id is not null;

-- ---------------------------------------------------------------------------
-- A2. Klasyfikacja odbic: dropped kontra bounced, hard kontra soft, decyzja o wykluczeniu.
--
-- Powod (KLAVIYO-MODULY 3.2 i 4.6): to sa TRZY rozne liczby wymagajace trzech roznych
-- reakcji. `dropped` to nasz wlasny system albo dostawca odmawiajacy przed oddaniem maila
-- serwerowi odbiorcy - to jest blad konfiguracji albo higieny listy. `bounced` to
-- odpowiedz serwera odbiorcy - hard oznacza martwy adres, soft chwilowy problem skrzynki.
-- Jeden wspolny bounce_rate miesza te trzy przyczyny i zabija diagnostyke.
--
-- Podzial stanow, ktory od teraz obowiazuje:
--   suppressed - NASZA bramka canSendTo odmowila, nic nie poszlo do dostawcy
--   dropped    - dostawca odmowil przed oddaniem serwerowi odbiorcy (5xx przy handoffie,
--                adres na liscie supresji dostawcy, walidacja adresu, Bad content)
--   bounced    - odbilo sie od serwera odbiorcy; bounce_class rozstrzyga hard/soft
--   complained - petla zwrotna (FBL) od dostawcy skrzynki
--   failed     - awaria bez rozstrzygnietej klasy (wyczerpane proby, blad nieznany)
-- ---------------------------------------------------------------------------

alter table message_events drop constraint message_events_event_type_check;
alter table message_events add constraint message_events_event_type_check
  check (event_type in
    ('queued', 'sending', 'sent', 'delivered', 'bounced', 'complained',
     'dropped', 'failed', 'suppressed', 'held'));

alter table message_events
  -- twarde kontra miekkie. 'undetermined' jest osobna wartoscia, nie synonimem soft:
  -- SES zwraca Undetermined/Undetermined i potraktowanie tego jak soft kazaloby nam
  -- ponawiac wysylke na adres, o ktorym nic nie wiemy.
  add column bounce_class text check (bounce_class in ('hard', 'soft', 'undetermined')),
  -- kategoria w brzmieniu, ktore ma sens dla czlowieka czytajacego raport. Wartosci
  -- wziete z zywego Klaviyo (KLAVIYO-MODULY 3.2, probka 50 odrzucen): Invalid Address 22,
  -- Content 13, Unclassified 6, External Error 5, Mailbox Unavailable 4.
  add column bounce_category text check (bounce_category in
    ('invalid_address', 'mailbox_unavailable', 'mailbox_full', 'message_too_large',
     'content', 'spam_block', 'external_error', 'suppressed_by_provider', 'unclassified')),
  -- kod SMTP w postaci, w jakiej przyszedl: rozszerzony (5.1.1) albo podstawowy (550).
  -- Text, nie int: 5.1.1 nie jest liczba, a zapis "551" gubi roznice miedzy 5.5.1 a 551.
  add column smtp_code text,
  -- surowy powod od dostawcy (diagnosticCode / tresc odpowiedzi SMTP). Trzymamy w calosci,
  -- bo po incydencie potrzebna jest odpowiedz "co dokladnie odpisal serwer", a nie nasza
  -- interpretacja sprzed trzech wersji klasyfikatora.
  add column provider_reason text,
  -- DECYZJA o wykluczeniu adresu zapisana w samym zdarzeniu (odpowiednik
  -- $extra.$bounce_delivery_info.add_exclusion z Klaviyo). Dzieki temu audyt supresji to
  -- przejrzenie zdarzen, a nie zestawianie dwoch niezaleznych logow, ktore sie rozjezdzaja.
  add column add_exclusion boolean,
  -- czy to odbicie wchodzi do NASZEGO licznika bounce rate. SES wprost wylacza z niego
  -- Permanent/OnAccountSuppressionList i Permanent/OnTenantSuppressionList; wliczenie ich
  -- zawyzyloby metryke i wstrzymaloby tenanta bez powodu. Tak samo Complaint/not-spam,
  -- ktore wedlug IANA NIE jest skarga.
  add column counts_to_rate boolean;

-- Pola klasyfikacji naleza wylacznie do zdarzen o negatywnym wyniku. Bez tego nic nie
-- powstrzyma zapisu bounce_class przy 'delivered', a raport policzylby to jako odbicie.
-- Walidowany normalnie: wiersze sprzed migracji maja tu same NULL-e i przechodza.
alter table message_events add constraint message_events_klasyfikacja_zakres_check check (
  event_type in ('bounced', 'dropped', 'complained', 'failed', 'suppressed')
  or (bounce_class is null and bounce_category is null and smtp_code is null
      and provider_reason is null and add_exclusion is null and counts_to_rate is null)
);

-- Odbicie MUSI byc sklasyfikowane w chwili zapisu, a nie "kiedys, jak bedzie czas".
-- O to chodzi w calym bloku A: klasyfikacja doklejana po fakcie nie istnieje, bo surowej
-- odpowiedzi dostawcy juz wtedy nie ma.
-- NOT VALID swiadomie: wiersze sprzed tej migracji powstaly, zanim klasyfikacja istniala,
-- i nie da sie ich uzupelnic uczciwie. Nowe zapisy sa sprawdzane w pelni.
alter table message_events add constraint message_events_odbicie_sklasyfikowane_check check (
  event_type <> 'bounced'
  or (bounce_class is not null and add_exclusion is not null and counts_to_rate is not null)
) not valid;

-- AD-10 dla strumienia stanu. 0005 dalo `occurred_at ... default now()`, czyli dokladnie
-- ten sam blad, ktory 0002 naprawialo w `events`: webhook dostawcy, ktory dotarl z
-- godzinnym opoznieniem, dostawalby date ZAPISU zamiast daty zdarzenia u dostawcy.
-- Od teraz kazdy zapis podaje date jawnie, a data zapisu to osobna kolumna.
alter table message_events alter column occurred_at drop default;
alter table message_events add column recorded_at timestamptz not null default now();

-- Liczenie bounce rate i complaint rate na oknie kroczacym per tenant. Partial, bo
-- predykat raportu filtruje wylacznie zdarzenia negatywne; 'sent' i 'delivered' maja
-- wlasne indeksy i nie obciazaja tego.
create index message_events_odbicia_idx
  on message_events (tenant_id, occurred_at)
  where event_type in ('bounced', 'dropped', 'complained');

-- ---------------------------------------------------------------------------
-- A1 + A4. Zdarzenia powtarzalne: otwarcia, klikniecia, opoznienia dostarczenia.
--
-- Istota problemu: message_events ma unique (message_id, event_type) i to jest decyzja
-- AD-22, ktorej NIE RUSZAMY - dzieki niej worker wysylki i webhook dostawcy nie moga sie
-- nawzajem nadpisac przy wyscigu. Ale otwarcie i klikniecie z definicji przychodza wiele
-- razy dla jednej wiadomosci, a DeliveryDelay potrafi przyjsc kilka razy z rzedu.
-- Wrzucenie ich do message_events skonczyloby sie albo bledem unikalnosci, albo - gorzej -
-- cichym `do nothing`, czyli zgubieniem wszystkich otwarc poza pierwszym.
--
-- Dlatego: osobna tabela append-only BEZ unikalnosci po (message_id, kind), z wlasna
-- idempotencja po identyfikatorze zdarzenia u dostawcy.
-- ---------------------------------------------------------------------------

-- Para (tenant_id, id) juz jest unikalna na messages, ale FK zaangazowania ma wymuszac
-- TAKZE zgodnosc zdenormalizowanego zrodla (kampania / journey). Zrodlo wiadomosci jest
-- niezmienne (AD-26), wiec denormalizacja nie moze sie rozjechac - baza tego pilnuje.
alter table messages add constraint messages_tozsamosc_zrodla_unique
  unique (tenant_id, id, source_type, source_id);

create table message_engagement (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null,
  message_id uuid not null,
  -- zrodlo wiadomosci przepisane z messages. Powod jest wylacznie wydajnosciowy:
  -- raport kampanii ma czytac zaangazowanie po jednym indeksie, a nie laczyc sie
  -- z messages i skanowac cale zaangazowanie tenanta. Zgodnosc wymusza FK nizej.
  source_type text not null check (source_type in ('campaign', 'journey', 'test')),
  source_id uuid not null,
  kind text not null check (kind in ('open', 'click', 'delivery_delay')),
  -- 'wlasne' = nasz pixel i nasz redirect (AD-33), 'dostawca' = event publishing SES.
  -- Docelowo wszystko jest 'wlasne', bo natywny tracking SES psuje atrybucje z 0007/0008.
  -- Ale okres przejsciowy musi byc rozroznialny, inaczej otwarcia policza sie dwa razy
  -- i nikt nie bedzie wiedzial dlaczego.
  source text not null check (source in ('wlasne', 'dostawca')),

  -- --- A1: otwarcie maszynowe i klik bota, rozroznialne OD PIERWSZEGO ZAPISU ---
  -- true  = zdarzenie wygenerowala maszyna (skaner prywatnosci Apple MPP, proxy obrazkow,
  --         skaner bezpieczenstwa bramki pocztowej),
  -- false = mamy podstawy uznac je za ludzkie,
  -- NULL  = NIE WIEMY. To nie jest synonim "czlowiek" i raport nie ma prawa go tak czytac.
  -- Jedna kolumna na oba rodzaje zamiast osobnych machine_open i bot_click: `kind` juz
  -- mowi, czy to otwarcie, czy klik, wiec dwie kolumny znaczylyby, ze jedna z nich jest
  -- zawsze NULL, a filtr postawiony na tej nieodpowiedniej po cichu zwracalby pustke.
  automat boolean,
  -- dlaczego tak uznalismy. Bez tego za pol roku nie da sie odroznic decyzji dostawcy od
  -- naszej heurystyki, ani poprawic heurystyki bez przeliczania wszystkiego wstecz.
  automat_powod text check (automat_powod in
    ('apple_mpp', 'proxy_obrazkow', 'skaner_bezpieczenstwa', 'klient_automatyczny',
     'dostawca_oznaczyl', 'brak_przeslanek')),

  -- --- kontekst techniczny ---
  url text,
  ip inet,
  user_agent text,
  -- rodzaj opoznienia z DeliveryDelay. SpamDetected i IPFailure to sygnaly o REPUTACJI,
  -- nie o skrzynce odbiorcy, i maja isc alertem - dlatego osobna kolumna, nie payload.
  delay_type text,
  -- identyfikator zdarzenia u dostawcy (SNS MessageId / feedbackId). Podstawa idempotencji:
  -- SNS gwarantuje dostarczenie CO NAJMNIEJ raz, wiec bez tego powtorzone powiadomienie
  -- dolozyloby drugie otwarcie tej samej osoby.
  provider_event_id text,

  -- AD-10: data zdarzenia ze zrodla, jawnie, BEZ default. Otwarcie sprzed godziny, ktore
  -- dotarlo do nas teraz, ma date otwarcia, nie date zapisu. Data zapisu jest osobno.
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),

  -- url tylko przy klikach, delay_type tylko przy opoznieniach: inaczej tabela po pol roku
  -- znaczy co innego, niz mowi jej nazwa kolumny.
  constraint message_engagement_url_check check (url is null or kind = 'click'),
  constraint message_engagement_delay_check check (delay_type is null or kind = 'delivery_delay'),
  -- powod bez werdyktu jest bez sensu w obie strony
  constraint message_engagement_automat_check check ((automat is null) = (automat_powod is null)),

  -- FK zlozony po (tenant_id, message_id) ORAZ po zrodle: jednoczesnie odcina rozjazd
  -- miedzy tenantami i gwarantuje, ze zdenormalizowane source_type/source_id zgadzaja sie
  -- z wiadomoscia. Kaskada usuwa zaangazowanie razem z wiadomoscia.
  foreign key (tenant_id, message_id, source_type, source_id)
    references messages (tenant_id, id, source_type, source_id) on delete cascade
);

-- Os czasu jednej wiadomosci (ekran profilu, diagnostyka pojedynczej sprawy).
create index message_engagement_msg_idx
  on message_engagement (tenant_id, message_id, occurred_at desc);

-- Metryki per kampania BEZ skanowania calosci: otwarcia i kliki jednej kampanii leza
-- w tym indeksie obok siebie, wiec raport czyta zakres, a nie tabele.
create index message_engagement_zrodlo_idx
  on message_engagement (tenant_id, source_type, source_id, kind, occurred_at desc);

-- Idempotencja powiadomien od dostawcy. Partial, bo zdarzenia z wlasnego pixela i
-- redirectu nie maja identyfikatora dostawcy i NIE moga byc deduplikowane - dwa realne
-- otwarcia tej samej osoby to dwa wiersze i tak ma byc.
create unique index message_engagement_dostawca_idx
  on message_engagement (tenant_id, source, provider_event_id)
  where provider_event_id is not null;

-- ---------------------------------------------------------------------------
-- A5. Zgody osobno na sledzenie otwarc i sledzenie klikniec.
--
-- Swiadomie BEZ nowej tabeli: rejestr zgod z 0004 jest append-only (AD-16) i juz niesie
-- wszystko, czego potrzeba - zrodlo, brzmienie klauzuli, date zdarzenia i date zapisu.
-- Rownolegly system zgod oznaczalby dwa miejsca do sprawdzenia przy zadaniu "pokazcie,
-- na co ta osoba sie zgodzila", czyli gwarantowany rozjazd.
--
-- Z modelu Klaviyo bierzemy trzy rzeczy: osobna zgode per cel, `valid_until` (zgoda
-- wygasajaca - wymog przy double opt-in i w czesci rynkow UE) oraz pojecie `can_receive`,
-- czyli WYLICZANY stan "wolno teraz", ktory laczy zgode, wygasniecie i wykluczenia.
-- `can_receive` zostaje wyliczeniem w kodzie (src/usecases/wysylka/zgody.ts), nie kolumna:
-- kolumna klamalaby w chwili, w ktorej ktos trafi na wykluczenie.
-- ---------------------------------------------------------------------------

alter table consents drop constraint consents_channel_check;
alter table consents add constraint consents_channel_check
  check (channel in ('email', 'sms', 'email_open_tracking', 'email_click_tracking'));

alter table consents
  -- zgoda wygasajaca. NULL = bezterminowa. Wpis po terminie NIE jest usuwany ani
  -- zmieniany (rejestr jest append-only) - przestaje po prostu uprawniac.
  add column valid_until timestamptz,
  -- doprecyzowanie zrodla w brzmieniu Klaviyo (method_detail): nazwa formularza, numer
  -- zamowienia, nazwa pliku importu. `source` mowi KANALEM, to mowi KTORYM konkretnie.
  add column method_detail text;

-- Domyslna polityka sledzenia per tenant. Dwa rynki, dwie odpowiedzi: przy 'dozwolone'
-- sledzenie dziala, dopoki ktos go jawnie nie wycofa (stan dzisiejszy, zachowany bez
-- zmiany zachowania), przy 'wymaga_zgody' sledzenie wlacza sie WYLACZNIE po jawnej
-- zgodzie (odpowiedz na stanowiska CNIL i Garante). Decyzja nalezy do tenanta, bo to
-- jego administrator danych odpowiada przed swoim organem.
alter table tenants
  add column open_tracking_default text not null default 'dozwolone'
    check (open_tracking_default in ('dozwolone', 'wymaga_zgody')),
  add column click_tracking_default text not null default 'dozwolone'
    check (click_tracking_default in ('dozwolone', 'wymaga_zgody'));

-- Migawka zgody na sledzenie W CHWILI BUDOWY WIADOMOSCI, dokladnie tym samym wzorcem co
-- utrwalony HTML i snapshot linkow (AD-32, 0008). Powod: mail, ktory wyszedl bez pixela,
-- ma zostac bez pixela na zawsze, a wycofanie zgody jutro nie moze wstecznie uniewaznic
-- klikniecia sprzed tygodnia. Pytanie "czy wolno bylo sledzic" ma odpowiedz na wiadomosci,
-- a nie w rejestrze zgod odczytanym miesiac pozniej.
alter table messages
  add column open_tracking_allowed boolean not null default true,
  add column click_tracking_allowed boolean not null default true;
