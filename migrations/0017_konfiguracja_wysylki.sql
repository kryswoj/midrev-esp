-- Modul "Wysylka i domeny": wlasny serwer SMTP klienta i weryfikacja DNS domeny nadawcy.
--
-- Powod: do dzis caly system wysylal z jednego adresu MAIL_FROM z konfiguracji serwera,
-- a tabela sending_domains (0005) nie miala ani ekranu, ani kolumn na wynik weryfikacji.
-- Konto SES jeszcze nie istnieje, wiec pierwsza realna droga wysylki to serwer SMTP
-- klienta. Ta migracja daje jej dwie rzeczy: konfiguracje serwera per tenant (z haslem
-- zaszyfrowanym po stronie aplikacji) i wynik sprawdzenia SPF/DKIM/DMARC per domena,
-- ktory jest podstawa blokady FR45 ("nie wysylamy z niezweryfikowanej domeny").
--
-- Izolacja tenantow: kazdy klucz obcy siegajacy przez tenanta jest ZLOZONY i zaczyna sie
-- od tenant_id (wzorzec z 0005 i 0014). Konfiguracja SMTP tenanta A nie moze wskazac
-- domeny tenanta B - baza odrzuci to niezaleznie od tego, co zrobi kod.

-- ---------------------------------------------------------------------------
-- 1. Wynik weryfikacji DNS na sending_domains.
-- ---------------------------------------------------------------------------

-- 'partial' = czesc rekordow poprawna, czesc nie. Osobny stan od 'pending' (nigdy nie
-- sprawdzona) i od 'failed', bo klient ma zobaczyc "brakuje jednego rekordu", a nie
-- "nic nie dziala". Wysylka i tak jest zablokowana - FR45 wpuszcza tylko 'verified'.
alter table sending_domains drop constraint sending_domains_status_check;
alter table sending_domains add constraint sending_domains_status_check
  check (status in ('pending', 'partial', 'verified', 'failed'));

-- Domena jest porownywana z adresem nadawcy po lower(). Zapis w innej wielkosci liter
-- obszedlby unikalnosc (tenant_id, domain) i dal dwa wiersze tej samej domeny.
alter table sending_domains add constraint sending_domains_domain_lower_check
  check (domain = lower(domain) and domain !~ '\s');

alter table sending_domains
  -- selektor DKIM podaje klient: przy wlasnym serwerze to JEGO serwer podpisuje maile,
  -- my tylko sprawdzamy, czy klucz publiczny pod <selektor>._domainkey jest w DNS
  add column dkim_selector text check (dkim_selector ~ '^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$'),
  -- mechanizm SPF dostawcy serwera (np. "include:_spf.google.com" albo "ip4:1.2.3.4"),
  -- opcjonalny: bez niego oceniamy SPF po adresie IP serwera SMTP
  add column spf_mechanism text check (spf_mechanism ~ '^(include:[a-z0-9._-]+|ip4:[0-9./]+|ip6:[0-9a-f:./]+)$'),
  add column spf_status text check (spf_status in ('ok', 'brak', 'bledny', 'niesprawdzony')),
  add column dkim_status text check (dkim_status in ('ok', 'brak', 'bledny', 'niesprawdzony')),
  add column dmarc_status text check (dmarc_status in ('ok', 'brak', 'bledny', 'niesprawdzony')),
  add column dmarc_policy text check (dmarc_policy in ('none', 'quarantine', 'reject')),
  -- pelny opis wyniku per rekord (co znaleziono, co poprawic). jsonb, bo to jest raport
  -- dla czlowieka, nie dane do filtrowania - filtruje sie po kolumnach *_status wyzej
  add column check_details jsonb not null default '{}'::jsonb,
  -- data OSTATNIEGO SPRAWDZENIA, podawana jawnie przez kod (AD-10), bez default now()
  add column last_checked_at timestamptz,
  -- blad, przez ktory sprawdzenie nie dalo odpowiedzi (timeout DNS, SERVFAIL). Osobno od
  -- statusow: "nie udalo sie sprawdzic" to nie to samo co "rekordu nie ma"
  add column last_error text;

-- ---------------------------------------------------------------------------
-- 2. Konfiguracja wlasnego serwera SMTP tenanta.
-- ---------------------------------------------------------------------------

create table tenant_smtp_configs (
  -- jeden serwer na tenanta: to jest ustawienie konta, nie lista
  tenant_id uuid primary key references tenants(id) on delete cascade,
  -- domena adresu nadawcy; FK zlozony, wiec tylko domena TEGO tenanta
  sending_domain_id uuid not null,
  host text not null check (length(host) between 1 and 253 and host !~ '\s'),
  -- baza pilnuje tylko zakresu; lista dozwolonych portow (25/465/587/2525) jest w kodzie,
  -- bo tryb deweloperski (Mailpit, 1025) jest jawna konfiguracja srodowiska, nie danych
  port int not null check (port between 1 and 65535),
  security text not null check (security in ('none', 'starttls', 'tls')),
  username text check (username is null or length(username) between 1 and 320),
  -- AES-256-GCM kluczem SECRETS_KEY (src/adapters/crypto.ts). Jawne haslo nigdy tu nie trafia.
  password_encrypted bytea,
  from_name text not null check (length(from_name) between 1 and 200),
  from_email text not null check (from_email = lower(from_email) and from_email ~ '^[^@\s<>]+@[^@\s<>]+$'),
  reply_to text check (reply_to is null or reply_to ~ '^[^@\s<>,]+@[^@\s<>,]+$'),
  -- ostatni UDANY test polaczenia z logowaniem. Kazda zmiana hosta, portu, trybu,
  -- uzytkownika albo hasla zeruje te kolumne: wysylka nie rusza na niesprawdzonym serwerze
  connection_verified_at timestamptz,
  last_tested_at timestamptz,
  last_test_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- haslo bez uzytkownika nie ma sensu i swiadczy o bledzie zapisu
  check (password_encrypted is null or username is not null),
  -- no action (NIE restrict): domeny uzywanej przez serwer nie da sie usunac spod nog
  -- konfiguracji, ale kaskadowe usuniecie calego tenanta przechodzi, bo sprawdzenie
  -- odbywa sie na koncu instrukcji, gdy wiersz konfiguracji tez juz zniknal
  foreign key (tenant_id, sending_domain_id) references sending_domains (tenant_id, id) on delete no action
);
