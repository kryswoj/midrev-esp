-- Integracja „custom” jak Klaviyo (E7, plan 6 + decyzja D5): klucz publiczny strony,
-- ustawienia skryptu midrev.js, katalog produktów i feed Google Merchant.
--
-- Expand-only (AD-46): same nowe kolumny z wartościami domyślnymi i nowe tabele. Stary kod
-- (sprzed tego wydania) nie czyta ani nie pisze żadnej z nich, więc rollback kodu jest
-- bezpieczny bez cofania migracji.
--
-- `site_keys` powstało w 0032 (odpowiednik company_id Klaviyo), dotąd nieużywane.

-- ── 1. Klucz publiczny strony: ustawienia skryptu ────────────────────────────────────
alter table site_keys
  -- autodetekcja zdarzeń e-commerce z dataLayer GA4 (view_item, add_to_cart, begin_checkout)
  add column ga4_datalayer boolean not null default false,
  -- skrypt dołącza formularze/popupy tenanta (istniejący loader /s/{tenantId})
  add column load_forms boolean not null default true,
  -- dokładne brzmienie zgody marketingowej przyjmowanej przez POST /client/subscriptions;
  -- NULL = subskrypcje z przeglądarki wyłączone (nie da się zapisać zgody bez dowodu)
  add column consent_wording text check (consent_wording is null or char_length(consent_wording) between 10 and 2000),
  -- adres polityki prywatności dopisywany do dowodu zgody
  add column consent_privacy_url text check (consent_privacy_url is null or consent_privacy_url ~ '^https?://' and char_length(consent_privacy_url) <= 500),
  -- CORS tylko z domen strony (allowed_origins); false = każdy origin (jak Klaviyo)
  add column restrict_origins boolean not null default false,
  -- adapter piksela (plan integracji E.2); custom = midrev.js + dataLayer + ręczne track
  add column platform text not null default 'custom' check (platform in ('custom', 'woocommerce', 'shopify', 'shoper')),
  add column updated_at timestamptz not null default now();

alter table site_keys
  add constraint site_keys_link_domains_check check (cardinality(link_domains) <= 20),
  add constraint site_keys_allowed_origins_check check (cardinality(allowed_origins) <= 20);

-- jeden aktywny klucz strony na tenanta (rotacja = unieważnij + utwórz nowy)
create unique index site_keys_tenant_aktywny_idx on site_keys (tenant_id) where revoked_at is null;

-- ── 2. Katalog produktów (plan integracji E.4 = szkic `products`/`product_variants` z planu
-- Shopera 3.3). `store_id` NULL = katalog bez podłączonego sklepu (custom: feed Google
-- Merchant albo Viewed Product z przeglądarki). Sklep podłączony (Woo/Shoper/Shopify) wypełni
-- `store_id` tym samym schematem. Produkt usunięty ze źródła dostaje active=false (nie kasujemy:
-- stare maile i zdarzenia go wskazują).
create table products (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  store_id uuid,
  external_id text not null check (char_length(external_id) between 1 and 255),
  -- skąd wiersz: feed > api/webhook > viewed (uzupełnienie z przeglądarki, nie nadpisuje feedu)
  source text not null check (source in ('feed', 'api', 'webhook', 'viewed')),
  title text not null check (char_length(title) between 1 and 500),
  url text check (url is null or (url ~ '^https?://' and char_length(url) <= 2000)),
  image_url text check (image_url is null or (image_url ~ '^https?://' and char_length(image_url) <= 2000)),
  description_short text check (description_short is null or char_length(description_short) <= 5000),
  -- cena „od” (najniższa z wariantów), jednostki minor (AD-11)
  price_minor bigint check (price_minor is null or price_minor >= 0),
  compare_at_minor bigint check (compare_at_minor is null or compare_at_minor >= 0),
  currency char(3) check (currency is null or currency ~ '^[A-Z]{3}$'),
  categories text[] not null default '{}' check (cardinality(categories) <= 20),
  brand text check (brand is null or char_length(brand) <= 255),
  in_stock boolean,
  stock_qty numeric,
  active boolean not null default true,
  flags jsonb not null default '{}',
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique nulls not distinct (tenant_id, store_id, external_id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade
);
create index products_tenant_idx on products (tenant_id, synced_at desc);

create table product_variants (
  tenant_id uuid not null,
  product_id uuid not null,
  external_id text not null check (char_length(external_id) between 1 and 255),
  sku text check (sku is null or char_length(sku) <= 255),
  ean text check (ean is null or char_length(ean) <= 64),
  title text check (title is null or char_length(title) <= 500),
  -- plan integracji E.4: warianty mają własny adres i zdjęcie (Shopify, Woo, feed)
  url text check (url is null or (url ~ '^https?://' and char_length(url) <= 2000)),
  image_url text check (image_url is null or (image_url ~ '^https?://' and char_length(image_url) <= 2000)),
  price_minor bigint check (price_minor is null or price_minor >= 0),
  compare_at_minor bigint check (compare_at_minor is null or compare_at_minor >= 0),
  currency char(3) check (currency is null or currency ~ '^[A-Z]{3}$'),
  in_stock boolean,
  stock_qty numeric,
  is_default boolean not null default false,
  active boolean not null default true,
  synced_at timestamptz not null default now(),
  primary key (tenant_id, product_id, external_id),
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete cascade
);

-- ── 3. Feed produktów (custom: Google Merchant XML RSS/Atom albo CSV/TSV) ────────────
-- Plan integracji E.4 mówi o `feed_url` w `stores`; custom nie ma wiersza `stores`
-- (brak poświadczeń i platformy), więc feed żyje w osobnej tabeli per tenant. Sklep
-- podłączony może w przyszłości dostać tu własny wiersz (store_id).
create table product_feeds (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  url text not null check (url ~ '^https?://' and char_length(url) <= 2000),
  interval_hours int not null default 6 check (interval_hours between 1 and 168),
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_status text check (last_status is null or last_status in ('ok', 'blad', 'bez_zmian')),
  -- komunikat dla człowieka (bez treści feedu)
  last_error text check (last_error is null or char_length(last_error) <= 500),
  last_products int,
  last_variants int,
  etag text check (etag is null or char_length(etag) <= 300),
  last_modified text check (last_modified is null or char_length(last_modified) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id)
);
create index product_feeds_next_idx on product_feeds (next_run_at);

-- ── 4. Stan koszyka i checkoutu (plan integracji E.5) ─────────────────────────────────
-- Custom: z Added to Cart / Started Checkout ze skryptu; `platform_token` = token koszyka
-- podany przez sklep albo identyfikator przeglądarki. `recovery_url` = CheckoutURL z track
-- (jeśli sklep go poda), inaczej NULL (blok w mailu pokaże zwykły /cart sklepu).
create table carts (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  store_id uuid,
  platform_token text not null check (char_length(platform_token) between 1 and 255),
  profile_id uuid,
  anonymous_id text check (anonymous_id is null or char_length(anonymous_id) <= 255),
  email text,
  stage text not null check (stage in ('cart', 'checkout', 'ordered', 'expired')),
  items jsonb not null default '[]',
  value_minor bigint,
  currency char(3) check (currency is null or currency ~ '^[A-Z]{3}$'),
  recovery_url text check (recovery_url is null or (recovery_url ~ '^https?://' and char_length(recovery_url) <= 2000)),
  order_external_id text,
  source_updated_at timestamptz not null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique nulls not distinct (tenant_id, store_id, platform_token),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade,
  foreign key (tenant_id, profile_id) references profiles (tenant_id, id) on delete set null (profile_id)
);
create index carts_profile_idx on carts (tenant_id, profile_id, updated_at desc);

-- ── 5. Role metryk (plan integracji E.3): szablon flow wskazuje rolę, nie metrykę ──────
-- „Porzucony checkout” na Shopify (metryka shopify) i na stronie custom (metryka midrev) to
-- ten sam szablon. Custom ustawia added_to_cart / started_checkout / viewed_product przy
-- zapisie kreatora; placed_order ustawi integracja zamówień (API/webhook).
create table metric_mappings (
  tenant_id uuid not null references tenants(id) on delete cascade,
  role text not null check (role in ('placed_order', 'started_checkout', 'added_to_cart', 'viewed_product', 'active_on_site')),
  metric_id uuid not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, role),
  foreign key (tenant_id, metric_id) references metrics (tenant_id, id) on delete cascade
);
