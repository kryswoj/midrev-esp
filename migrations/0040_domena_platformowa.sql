-- Wysyłka platformowa (01.10.2026): tenant NIE konfiguruje serwera. Wszyscy wysyłają przez
-- konto SES platformy (eu-north-1), a klient przechodzi trzykrokowy kreator „Podłącz
-- domenę": adres → rekordy do skopiowania → automatyczne sprawdzanie.
--
-- Numer 0040: 0036 jest zarezerwowana (migrations-pending/0036 re-entry contract), 0037-0039
-- rezerwuje plan metryki-i-profil (03-PLAN.md, 7.5: rollupy, smart sending, drop events).
--
-- Migracja WYŁĄCZNIE dokłada kolumny z wartością domyślną stałą i nowe tabele (expand,
-- AD-46). Istniejące wiersze bez zmian: sending_domains.managed_by = 'klient' to dokładnie
-- dotychczasowe zachowanie, a tenant z wierszem w tenant_smtp_configs dalej wysyła przez
-- własny serwer (tryb wynika z obecności konfiguracji, nie z nowej kolumny). Stary kod
-- działa na tej bazie bez zmian.
--
-- Izolacja tenantów: każdy klucz obcy przez tenanta jest ZŁOŻONY (wzorzec 0005/0017).
-- Domena platformowa jest dodatkowo UNIKALNA GLOBALNIE: tożsamość SES jest jedna na konto
-- AWS, więc dwa sklepy nie mogą „mieć" tej samej domeny.

-- 1. Domena zarządzana przez platformę (tożsamość w SES platformy) -------------------
alter table sending_domains
  -- 'klient'    domena pod własny serwer klienta (dotychczasowy model, 0017)
  -- 'platforma' tożsamość założona przez nas w SES; rekordy DNS pochodzą z odpowiedzi SES
  add column managed_by text not null default 'klient' check (managed_by in ('klient', 'platforma')),
  -- strefa DNS, w której klient wpisuje rekordy (np. sklep.pl dla news.sklep.pl); od niej
  -- liczą się nazwy względne w tabeli rekordów
  add column zone_apex text check (zone_apex is null or (zone_apex = lower(zone_apex) and length(zone_apex) <= 253 and zone_apex !~ '\s')),
  -- dostawca DNS rozpoznany po NS (klucz z domain/email/dostawcy-dns.ts) albo null
  add column dns_provider text check (dns_provider is null or dns_provider ~ '^[a-z0-9_-]{1,40}$'),
  -- odczyt stanu tożsamości SES (GetEmailIdentity), czas z naszego zegara przy odczycie
  add column ses_status text check (ses_status is null or ses_status in ('PENDING', 'SUCCESS', 'FAILED', 'TEMPORARY_FAILURE', 'NOT_STARTED')),
  add column ses_dkim_status text check (ses_dkim_status is null or ses_dkim_status in ('PENDING', 'SUCCESS', 'FAILED', 'TEMPORARY_FAILURE', 'NOT_STARTED')),
  add column ses_mail_from_status text check (ses_mail_from_status is null or ses_mail_from_status in ('PENDING', 'SUCCESS', 'FAILED', 'TEMPORARY_FAILURE', 'NOT_STARTED')),
  add column ses_verified_for_sending boolean not null default false,
  add column ses_dkim_tokens text[] not null default '{}',
  add column ses_signing_zone text check (ses_signing_zone is null or ses_signing_zone ~ '^[a-z0-9.-]{1,253}$'),
  add column ses_mail_from_domain text check (ses_mail_from_domain is null or (ses_mail_from_domain = lower(ses_mail_from_domain) and length(ses_mail_from_domain) <= 253)),
  add column ses_error_type text check (ses_error_type is null or length(ses_error_type) <= 100),
  add column ses_polled_at timestamptz,
  -- rekord DMARC, który proponujemy dla subdomeny (null = dziedziczony z domeny głównej wystarcza)
  add column dmarc_proposal text check (dmarc_proposal is null or (length(dmarc_proposal) <= 500 and dmarc_proposal ~ '^v=DMARC1;')),
  -- harmonogram pollera (handlery-domeny.ts): kiedy sprawdzić następnym razem
  add column next_check_at timestamptz,
  -- powiadomienie „domena gotowa" wysłane (panel + e-mail) — raz na przejście w verified
  add column ready_notified_at timestamptz;

-- domena platformowa ma strefę: bez niej nie da się policzyć nazw rekordów
alter table sending_domains add constraint sending_domains_platforma_strefa_check
  check (managed_by <> 'platforma' or zone_apex is not null);

-- jedna tożsamość SES na konto AWS = jedna domena platformowa na całą platformę
create unique index sending_domains_platforma_domena_uniq on sending_domains (domain) where managed_by = 'platforma';
-- poller: domeny platformowe do sprawdzenia
create index sending_domains_platforma_next_idx on sending_domains (next_check_at) where managed_by = 'platforma';

-- 2. Nadawca wysyłki platformowej (jeden na tenanta) ---------------------------------
create table tenant_platform_senders (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  sending_domain_id uuid not null,
  from_name text not null check (length(btrim(from_name)) between 1 and 200 and from_name !~ '[\r\n]'),
  from_email text not null check (from_email = lower(from_email) and from_email ~ '^[^@\s<>,;"]+@[^@\s<>,;"]+$'),
  reply_to text check (reply_to is null or reply_to ~ '^[^@\s<>,;"]+@[^@\s<>,;"]+$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- usunięcie domeny zabiera nadawcę: bez domeny nie ma z czego wysyłać
  foreign key (tenant_id, sending_domain_id) references sending_domains (tenant_id, id) on delete cascade
);

-- 3. Zasoby SES tenanta i pierwszy mail testowy -------------------------------------
alter table tenants
  -- configuration set tenanta w SES: po nim zdarzenie SNS jest przypisywane do tenanta.
  -- UNIQUE: dwa tenanty z tym samym zestawem = zdarzenia jednego w statystykach drugiego
  add column ses_configuration_set text unique check (ses_configuration_set is null or ses_configuration_set ~ '^[A-Za-z0-9_-]{1,64}$'),
  add column ses_tenant_name text unique check (ses_tenant_name is null or ses_tenant_name ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- krok onboardingu „Pierwszy mail testowy": data UDANEGO przyjęcia testu przez serwer
  add column first_test_email_at timestamptz;

-- 4. Link „Wyślij instrukcję informatykowi" -----------------------------------------
-- Publiczna strona z rekordami DNS, tylko odczyt, 14 dni. W bazie WYŁĄCZNIE SHA-256
-- tokenu (wzorzec sessions z 0006 i campaign_approvals z 0005): zrzut bazy nie daje linków.
create table dns_instruction_links (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  sending_domain_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  foreign key (tenant_id, sending_domain_id) references sending_domains (tenant_id, id) on delete cascade
);
create index dns_instruction_links_domena_idx on dns_instruction_links (tenant_id, sending_domain_id);

-- 5. Wiadomości SNS ze zdarzeniami SES ----------------------------------------------
-- Idempotencja po MessageId SNS (dostarczenie at-least-once). Bez adresów e-mail: tylko
-- identyfikatory i wynik, więc wiersz nie jest daną osobową do anonimizacji.
-- tenant_id null = zdarzenie nieprzypisane (nieznany zestaw, wiadomość innego tenanta).
create table ses_sns_messages (
  sns_message_id text primary key check (length(sns_message_id) between 1 and 100),
  topic_arn text not null check (length(topic_arn) <= 300),
  type text not null check (type in ('Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation')),
  event_type text check (event_type is null or length(event_type) <= 40),
  ses_message_id text check (ses_message_id is null or length(ses_message_id) <= 500),
  tenant_id uuid references tenants(id) on delete set null,
  message_id uuid,
  -- co z tym zrobiono: zapisane | duplikat_zdarzenia | brak_wiadomosci | nieznany_zestaw |
  -- tenant_niezgodny | pominiete | potwierdzono | wypisano | nie_jest_skarga
  outcome text not null check (length(outcome) <= 40),
  sns_timestamp timestamptz not null,
  received_at timestamptz not null default now()
);
create index ses_sns_messages_tenant_idx on ses_sns_messages (tenant_id, received_at desc);
