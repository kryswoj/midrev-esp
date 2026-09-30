-- Gotowosc do pierwszego wdrozenia produkcyjnego (28.09.2026): wysylka przez Amazon SES
-- SMTP z news.midrev.pl, osobna domena sledzenia, healthcheck, stopka z danymi nadawcy.
--
-- Migracja wylacznie DOKLADA kolumny i jedna tabele. Nie rusza istniejacych wierszy poza
-- wartoscia domyslna nowej kolumny NOT NULL (relay_mode = 'wlasny_serwer', czyli dokladnie
-- dotychczasowe zachowanie), wiec jest bezpieczna na bazie z danymi. Kolumny z wartoscia
-- domyslna stala Postgres dodaje bez przepisywania tabeli.

-- ---------------------------------------------------------------------------
-- 1. Tryb przekaznika i domena koperty (Return-Path) serwera SMTP tenanta.
-- ---------------------------------------------------------------------------
-- 'wlasny_serwer' - serwer klienta sam wysyla poczte dalej: SPF oceniamy dla adresow IP
--                   serwera, z ktorym laczy sie panel (dotychczasowy model).
-- 'przekaznik'    - ESP/relay (Amazon SES, Brevo, Mailgun): host, z ktorym rozmawiamy
--                   po SMTP, NIE jest serwerem, ktory oddaje poczte odbiorcy, a koperte
--                   przepisuje dostawca na wlasna domene MAIL FROM. SPF oceniamy na tej
--                   domenie (envelope_domain), bez porownywania IP hosta SMTP.
alter table tenant_smtp_configs
  add column relay_mode text not null default 'wlasny_serwer'
    check (relay_mode in ('wlasny_serwer', 'przekaznik')),
  -- domena koperty SMTP (custom MAIL FROM u SES, np. bounce.news.midrev.pl). Walidacja
  -- "rowna domenie nadawcy albo jej subdomena" jest w kodzie (serwer.ts), bo zalezy od
  -- adresu nadawcy z tej samej konfiguracji
  add column envelope_domain text
    check (envelope_domain is null or (
      envelope_domain = lower(envelope_domain)
      and length(envelope_domain) <= 253
      and envelope_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$'
    ));

-- przekaznik bez domeny koperty nie ma na czym sprawdzic SPF: weryfikacja domeny nie
-- ma prawa przejsc "przy okazji"
alter table tenant_smtp_configs add constraint tenant_smtp_configs_przekaznik_koperta_check
  check (relay_mode <> 'przekaznik' or envelope_domain is not null);

-- ---------------------------------------------------------------------------
-- 2. Identyfikator wiadomosci nadany przez dostawce.
-- ---------------------------------------------------------------------------
-- SES nadpisuje Message-ID swoim (<id@eu-central-1.amazonses.com>) i podaje id w
-- odpowiedzi na DATA ("250 Ok <id>"). Odbicie przekazane przez SES niesie wlasnie ten
-- Message-ID, nie nasz, wiec bez tej kolumny dopasowanie spadalo na sam adres odbiorcy.
-- provider_id (0005) zostaje naszym Message-ID; to jest osobne pole, nie nadpisanie.
alter table messages
  add column provider_message_id text
    check (provider_message_id is null or (length(provider_message_id) between 1 and 500 and provider_message_id !~ '\s'));

-- wyszukiwanie zawsze w obrebie tenanta (AD-2): indeks zaczyna sie od tenant_id
create index messages_provider_message_id_idx on messages (tenant_id, provider_message_id)
  where provider_message_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Dane nadawcy do stopki maila (adres pocztowy firmy, NIP).
-- ---------------------------------------------------------------------------
-- Adres pocztowy nadawcy w stopce: wymog CAN-SPAM, zalecenie Gmail/Yahoo dla nadawcow
-- masowych i UŚUDE (identyfikacja uslugodawcy). Lista kontrolna kampanii blokuje wysylke
-- bez adresu (lista-kontrolna.ts). Wszystko opcjonalne na poziomie bazy: istniejace
-- konta nie maja tych danych i nie wolno ich zmyslac.
alter table tenants
  add column sender_company_name text
    check (sender_company_name is null or (length(btrim(sender_company_name)) between 1 and 200 and sender_company_name !~ '[\r\n]')),
  add column sender_postal_address text
    check (sender_postal_address is null or length(btrim(sender_postal_address)) between 5 and 500),
  -- NIP zapisany bez spacji i myslnikow, opcjonalnie z prefiksem kraju (PL1234567890);
  -- kod normalizuje wpis czlowieka przed zapisem
  add column sender_tax_id text
    check (sender_tax_id is null or sender_tax_id ~ '^[A-Z]{0,2}[0-9]{5,20}$');

-- ---------------------------------------------------------------------------
-- 4. Heartbeat workera (healthcheck /api/zdrowie).
-- ---------------------------------------------------------------------------
-- Jeden wiersz na proces workera. Czas z zegara BAZY (now() w zapytaniu workera), bo
-- healthcheck porownuje go z now() tej samej bazy - rozjazd zegarow serwerow nie udaje
-- martwego workera. Wiersz nie nalezy do zadnego tenanta: to stan infrastruktury.
create table worker_heartbeats (
  worker_id text primary key check (worker_id ~ '^worker-[0-9a-f]{8}$'),
  started_at timestamptz not null,
  last_seen_at timestamptz not null,
  -- moment SIGTERM/SIGINT: proces konczy biezaca partie i wychodzi
  stopping_at timestamptz
);

-- ---------------------------------------------------------------------------
-- 5. Nowe klucze dopasowania odbic w rejestrze raportow.
-- ---------------------------------------------------------------------------
-- 'naglowek'    - nasz X-MidRev-Message-Id w kopii naglowkow oryginalu (najpewniejsze:
--                 przekaznik go nie przepisuje),
-- 'id_dostawcy' - Message-ID nadany przez dostawce = messages.provider_message_id.
-- Istniejace wiersze maja 'message_id' albo 'adres', wiec nowy check je przepuszcza.
alter table bounce_reports drop constraint bounce_reports_matched_by_check;
alter table bounce_reports add constraint bounce_reports_matched_by_check
  check (matched_by is null or matched_by in ('naglowek', 'id_dostawcy', 'message_id', 'adres'));
