-- Delegacja subdomeny wysyłkowej do strefy Route 53 platformy („jeden wpis NS", 02.10.2026).
-- Klient wpisuje u dostawcy domeny JEDEN rekord NS (nazwa news, cztery serwery Route 53),
-- a rekordy pod news.<domena> (podpis, adres zwrotny, ochrona) zakłada i utrzymuje
-- platforma przez API Route 53. Ręczna tabela rekordów zostaje jako druga ścieżka.
--
-- Numer 0042: 0036 zarezerwowana (migrations-pending/0036 re-entry contract), 0037-0039
-- rezerwuje plan metryki-i-profil (03-PLAN.md, 7.5), 0040 i 0041 zajęte.
--
-- Typ expand (AD-46): nowe kolumny z wartością domyślną stałą i nowa tabela, bez UPDATE
-- istniejących wierszy. Każda istniejąca domena ma dns_mode = 'reczny', czyli dokładnie
-- dotychczasowe zachowanie. Stary kod działa na tej bazie bez zmian.

-- 1. Strefy Route 53 platformy ------------------------------------------------------
-- Strefa należy do JEDNEGO tenanta i PRZEŻYWA odłączenie domeny: aplikacja nie usuwa
-- stref (polityka IAM nie daje DeleteHostedZone), a ponowne podłączenie tej samej domeny
-- przez tego samego tenanta używa tej samej strefy (te same serwery NS, klient nie musi
-- niczego zmieniać u dostawcy). Inny tenant tej samej domeny dostaje WŁASNĄ strefę
-- (inny CallerReference) i nigdy nie dotyka cudzej.
create table dns_hosted_zones (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  domain text not null check (domain = lower(domain) and length(domain) between 3 and 253 and domain !~ '\s'),
  -- deterministyczny z (tenant, domena), idempotencja CreateHostedZone; Route 53 pamięta
  -- go na zawsze, więc powtórka po zgubionej odpowiedzi nie robi drugiej strefy
  caller_reference text not null unique check (caller_reference ~ '^[A-Za-z0-9_-]{1,128}$'),
  -- identyfikator strefy bez /hostedzone/; null = zakładanie w toku (rezerwacja przed AWS)
  zone_id text unique check (zone_id is null or zone_id ~ '^Z[A-Z0-9]{1,32}$'),
  -- cztery serwery z DelegationSet, bez kropki na końcu
  name_servers text[] not null default '{}' check (cardinality(name_servers) <= 8),
  -- tag midrev_tenant na strefie potwierdzony odczytem (ListTagsForResource)
  tagged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, domain),
  -- cel złożonego klucza obcego z sending_domains (wzorzec izolacji 0005/0017/0040)
  unique (tenant_id, id)
);

-- 2. Tryb domeny i stan delegacji -----------------------------------------------------
alter table sending_domains
  -- 'reczny'    klient wpisuje rekordy z tabeli (dotychczasowe zachowanie)
  -- 'delegacja' klient wpisuje jeden NS, rekordy są w naszej strefie
  add column dns_mode text not null default 'reczny' check (dns_mode in ('reczny', 'delegacja')),
  add column hosted_zone_id uuid,
  -- co widać u dostawcy klienta (domain/email/route53.ts: ocenDelegacje); null = nie sprawdzano
  add column delegation_state text check (delegation_state is null or delegation_state in ('brak', 'czeka', 'czesciowa', 'bledna', 'konflikt', 'dziala')),
  -- szczegóły ostatniej oceny (komunikat dla klienta, znalezione serwery) — bez danych osobowych
  add column delegation_details jsonb,
  add column delegation_checked_at timestamptz,
  -- dlaczego opcji „jeden wpis" nie proponujemy: apex | zajeta_nazwa | dostawca | route53 |
  -- niesprawdzona (DNS nie odpowiedział przy podłączeniu; worker ponawia)
  add column delegation_unavailable text check (delegation_unavailable is null or delegation_unavailable in ('apex', 'zajeta_nazwa', 'dostawca', 'route53', 'niesprawdzona')),
  -- ostatnia synchronizacja rekordów w strefie (odczyt zwrotny zgodny z oczekiwanym)
  add column r53_synced_at timestamptz,
  add column r53_change_id text check (r53_change_id is null or r53_change_id ~ '^[A-Z0-9]{1,64}$'),
  add column r53_change_status text check (r53_change_status is null or r53_change_status in ('PENDING', 'INSYNC')),
  -- strefa tylko z TEGO SAMEGO tenanta (złożony klucz); usunięcie strefy z bazy przy żywej
  -- domenie jest błędem (NO ACTION), kasowanie tenanta zabiera oba wiersze w jednej instrukcji
  add constraint sending_domains_strefa_fk foreign key (tenant_id, hosted_zone_id) references dns_hosted_zones (tenant_id, id),
  add constraint sending_domains_delegacja_check check (dns_mode = 'reczny' or (managed_by = 'platforma' and hosted_zone_id is not null));

-- jedna strefa = jedna domena wysyłkowa naraz
create unique index sending_domains_strefa_uniq on sending_domains (hosted_zone_id) where hosted_zone_id is not null;
