-- Skrzynka zwrotna (odbicia i skargi) dla wlasnego serwera SMTP klienta.
--
-- Powod (audyt 24.09, #3): przy wysylce przez SMTP klienta zaden endpoint nie przyjmowal
-- odbic ani skarg. Serwer odbiorcy odsyla raport DSN (RFC 3464) na adres z MAIL FROM,
-- czyli do skrzynki nadawcy klienta. Panel czyta te skrzynke przez IMAP co 5 minut,
-- parsuje raporty i zapisuje je tym samym torem co webhook dostawcy
-- (zapiszZgloszenieDostawcy): klasyfikacja hard/soft, wykluczenie adresu, wskazniki B5.
--
-- Haslo IMAP: zaszyfrowane po stronie aplikacji (AES-256-GCM, SECRETS_KEY), dokladnie
-- jak haslo SMTP w 0017. Jawne haslo nigdy nie trafia do bazy, logow ani do przegladarki.

alter table tenant_smtp_configs
  add column bounce_imap_host text check (bounce_imap_host is null or (length(bounce_imap_host) between 1 and 253 and bounce_imap_host !~ '\s')),
  add column bounce_imap_port int check (bounce_imap_port is null or bounce_imap_port between 1 and 65535),
  -- 'none' dopuszczalne wylacznie dla jawnego serwera deweloperskiego (pilnuje kod, jak przy SMTP)
  add column bounce_imap_security text check (bounce_imap_security is null or bounce_imap_security in ('none', 'starttls', 'tls')),
  add column bounce_imap_username text check (bounce_imap_username is null or length(bounce_imap_username) between 1 and 320),
  add column bounce_imap_password_encrypted bytea,
  add column bounce_imap_mailbox text not null default 'INBOX' check (length(bounce_imap_mailbox) between 1 and 200 and bounce_imap_mailbox !~ '[\r\n"]'),
  -- kazda zmiana polaczenia zeruje te kolumne: odczyt nie rusza na niesprawdzonej skrzynce
  add column bounce_connection_verified_at timestamptz,
  add column bounce_last_tested_at timestamptz,
  add column bounce_last_test_error text,
  -- ostatni przebieg workera: kiedy i z jakim bledem (null = bez bledu)
  add column bounce_last_checked_at timestamptz,
  add column bounce_last_error text,
  -- kursor IMAP: UIDVALIDITY skrzynki i najwyzszy przetworzony UID. Zmiana UIDVALIDITY
  -- (skrzynka odtworzona) zeruje kursor - wtedy czytamy od nowa tylko nieprzeczytane
  add column bounce_uidvalidity bigint,
  add column bounce_last_uid bigint,
  add column bounce_updated_at timestamptz,
  -- komplet albo nic: host bez portu albo hasla bez uzytkownika to blad zapisu, nie stan
  add constraint tenant_smtp_configs_bounce_komplet_check check (
    (bounce_imap_host is null and bounce_imap_port is null and bounce_imap_security is null
       and bounce_imap_username is null and bounce_imap_password_encrypted is null)
    or (bounce_imap_host is not null and bounce_imap_port is not null and bounce_imap_security is not null
       and bounce_imap_username is not null)
  );

-- Kazdy przeczytany raport ze skrzynki: co przyszlo, do czego dopasowane, co z tym
-- zrobiono. Unikalnosc (tenant, UIDVALIDITY, UID) daje idempotencje przebiegu: crash
-- miedzy zapisem a oznaczeniem maila jako przeczytanego nie przetworzy raportu dwa razy
-- (samo zdarzenie i tak jest unikalne per (message_id, event_type), to druga warstwa).
-- Data `received_at` pochodzi ZE ZRODLA (naglowek Date raportu), nie z chwili odczytu.
create table bounce_reports (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  imap_uidvalidity bigint not null,
  imap_uid bigint not null,
  -- Message-ID ORYGINALNEJ wiadomosci wyciagniety z raportu (jesli byl)
  original_message_id text,
  matched_message_id uuid,
  -- 'message_id' | 'adres' | null: po czym dopasowano
  matched_by text check (matched_by is null or matched_by in ('message_id', 'adres')),
  recipient text,
  kind text not null check (kind in ('dsn', 'arf', 'heurystyka', 'nie_odbicie')),
  -- co z tym zrobiono, po polsku dla panelu: 'zapisane' | 'brak_wiadomosci' | 'pominiete' | 'nie_odbicie' | 'blad'
  outcome text not null,
  -- typ zapisanego zdarzenia (bounced/complained/delivered/dropped) i klasa
  event_type text,
  bounce_class text,
  smtp_code text,
  subject text,
  received_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, imap_uidvalidity, imap_uid),
  foreign key (tenant_id, matched_message_id) references messages (tenant_id, id) on delete set null (matched_message_id)
);

create index bounce_reports_tenant_received_idx on bounce_reports (tenant_id, received_at desc);
