-- Integracja Shopify „plug and play” (plan integracji, sekcja A; decyzja D1: aplikacja
-- „custom distribution” z Dev Dashboard, jedna na sklep klienta).
--
-- Expand-only (AD-46): nowe kolumny z wartościami domyślnymi albo NULL i nowe tabele.
-- Stary kod nie czyta ani nie pisze żadnej z nich, więc rollback kodu jest bezpieczny
-- bez cofania migracji. 0036 (ponowne wejście) nietknięte.

-- ── 1. Sklep Shopify ─────────────────────────────────────────────────────────────────
-- `shop_domain` = stała domena `{nazwa}.myshopify.com` (małe litery). Shopify identyfikuje
-- nią sklep w OAuth i w nagłówku X-Shopify-Shop-Domain webhooków; domena publiczna sklepu
-- (base_url) potrafi się zmienić.
alter table stores
  add column shop_domain text
    check (shop_domain is null or shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  add column installed_at timestamptz,
  add column uninstalled_at timestamptz;

-- Jeden sklep Shopify = jeden tenant w CAŁEJ bazie (nie tylko w tenancie). Webhook szuka
-- sklepu po domenie z nagłówka; dwa wiersze z tą samą domeną w dwóch tenantach oznaczałyby,
-- że zamówienia jednego klienta agencji mogą trafić do drugiego (historia: cross-tenant).
create unique index stores_shopify_domena_idx on stores (shop_domain) where platform = 'shopify';

-- ── 2. Stan OAuth (state/nonce) ──────────────────────────────────────────────────────
-- W bazie wyłącznie hasz stanu (SHA-256). Jednorazowy (used_at), ważny 10 minut, związany
-- ze sklepem: callback z cudzym albo zużytym stanem jest odrzucany. Drugą połową ochrony
-- jest ciasteczko HttpOnly z tym samym stanem w przeglądarce, która zaczęła instalację.
create table shopify_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  tenant_id uuid not null references tenants(id) on delete cascade,
  store_id uuid not null,
  shop_domain text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade
);
create index shopify_oauth_states_wygasle_idx on shopify_oauth_states (expires_at);

-- ── 3. Żądania RODO od Shopify (customers/data_request, customers/redact, shop/redact) ─
-- Dowód obsłużenia żądania przeżywa anonimizację, więc NIE trzyma adresu: tylko hasz
-- adresu (klucz HMAC jak nagrobki), id klienta w Shopify i liczniki wyniku.
create table shopify_gdpr_requests (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  store_id uuid not null,
  topic text not null check (topic in ('customers/data_request', 'customers/redact', 'shop/redact')),
  webhook_id text not null check (char_length(webhook_id) between 1 and 255),
  shopify_customer_id text,
  email_hash text,
  orders_count int not null default 0,
  status text not null default 'received'
    check (status in ('received', 'done', 'needs_operator', 'failed')),
  result jsonb not null default '{}',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (tenant_id, store_id, webhook_id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade
);
create index shopify_gdpr_requests_otwarte_idx on shopify_gdpr_requests (tenant_id, status, received_at desc);

-- ── 4. Import historii przez Bulk Operations: postęp na istniejącym `import_runs` ────────
-- `progress` = etap (produkty → klienci → zamówienia), id operacji bulk, liczba obiektów
-- wg Shopify; job jest wznawialny z tego miejsca.
alter table import_runs
  add column progress jsonb not null default '{}';
