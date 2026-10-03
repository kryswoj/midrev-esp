-- Port „Sklep” i integracje plug and play (plan integracji E.1–E.6, B, F; 03.10.2026).
--
-- Jedna migracja dla całego strumienia (port + Woo z wtyczką), żeby agent Shopify mógł wziąć
-- ją razem z commitem portu. Expand-only (AD-46): poszerzone CHECK, nowe kolumny z wartościami
-- domyślnymi albo NULL i nowe tabele. Stary kod żadnej z nich nie czyta i nie pisze, więc
-- rollback kodu nie wymaga cofania migracji.
--
--  1. stores.platform dopuszcza `custom` (plan R1), stores dostaje sposób połączenia, stan
--     wtyczki i kursor synchronizacji przyrostowej.
--  2. metrics.integration_key dopuszcza `shoper` i `custom` (zamówienia pod integracją sklepu).
--  3. metric_mappings: role zamówień i statusów (placed/ordered/fulfilled/cancelled/refunded).
--  4. raw_events.channel `plugin`: zdarzenia serwer-serwer z wtyczki sklepu (Woo), osobno od
--     webhooków (ocena ciszy sklepu liczy wyłącznie `webhook`) i od przeglądarki (`client`).
--  5. store_connect_tokens: jednorazowe kody parowania wtyczki, stan `/wc-auth` i OAuth.
--     W bazie wyłącznie hash kodu; kod w jawnej postaci widzi tylko operator w panelu.
--  6. store_consent_versions: wersjonowana klauzula zgody w checkoucie sklepu (jak
--     popup_consent_versions z 0041) + wskazanie wersji w consents.

-- ── 1. stores ─────────────────────────────────────────────────────────────────────────
alter table stores drop constraint stores_platform_check,
  add constraint stores_platform_check check (platform in ('woocommerce', 'shopify', 'shoper', 'custom'));

-- `disconnected`: sklep odłączony (wtyczka „Odłącz”, odinstalowanie aplikacji). Wiersz zostaje,
-- bo wskazują go zamówienia, koszyki i wersje klauzuli zgody (dowód).
alter table stores drop constraint stores_status_check,
  add constraint stores_status_check check (status in ('pending', 'connected', 'error', 'disconnected'));

alter table stores
  -- jak sklep został połączony: klucze wklejone ręcznie, wtyczka, /wc-auth, OAuth (Shopify)
  add column connection_method text check (connection_method is null or connection_method in ('klucze', 'wtyczka', 'wc_auth', 'oauth')),
  -- wersja wtyczki zgłoszona przy ostatnim kontakcie (tylko do ekranu zdrowia)
  add column plugin_version text check (plugin_version is null or char_length(plugin_version) <= 40),
  -- ostatni podpisany kontakt wtyczki (zdarzenia, ping); null = wtyczka nigdy się nie odezwała
  add column plugin_seen_at timestamptz,
  -- kursory synchronizacji przyrostowej (katalog, zamówienia) per sklep; kształt zna adapter
  add column sync_state jsonb not null default '{}'::jsonb;

-- ── 2. metrics ────────────────────────────────────────────────────────────────────────
alter table metrics drop constraint metrics_integration_key_check,
  add constraint metrics_integration_key_check
    check (integration_key in ('midrev', 'api', 'woocommerce', 'stripe', 'shopify', 'shoper', 'custom'));

-- ── 3. metric_mappings: role ──────────────────────────────────────────────────────────
alter table metric_mappings drop constraint metric_mappings_role_check,
  add constraint metric_mappings_role_check check (role in (
    'placed_order', 'ordered_product', 'fulfilled_order', 'cancelled_order', 'refunded_order',
    'started_checkout', 'added_to_cart', 'viewed_product', 'active_on_site'));

-- ── 4. raw_events.channel ─────────────────────────────────────────────────────────────
alter table raw_events drop constraint raw_events_channel_check,
  add constraint raw_events_channel_check check (channel in ('webhook', 'import', 'api', 'client', 'plugin'));

-- ── 5. Kody parowania / stan połączenia ───────────────────────────────────────────────
-- Kod parowania wtyczki (purpose 'wtyczka'), stan `/wc-auth` (purpose 'wc_auth') i stan OAuth
-- (purpose 'oauth'). Jednorazowy: `used_at` ustawiany w tej samej transakcji co połączenie
-- sklepu. Wygasa po `expires_at`. Hash SHA-256 kodu (kod ma ≥ 100 bitów entropii, więc bez soli).
create table store_connect_tokens (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  platform text not null check (platform in ('woocommerce', 'shopify', 'shoper')),
  purpose text not null check (purpose in ('wtyczka', 'wc_auth', 'oauth')),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  -- adres sklepu podany przez operatora (opcjonalny); gdy jest, parowanie z innego adresu = odmowa
  base_url text check (base_url is null or (base_url ~ '^https?://' and char_length(base_url) <= 500)),
  expires_at timestamptz not null,
  used_at timestamptz,
  store_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete set null (store_id)
);
create index store_connect_tokens_tenant_idx on store_connect_tokens (tenant_id, created_at desc);

-- ── 6. Klauzula zgody w checkoucie sklepu (wersjonowana, niezmienna) ──────────────────
create table store_consent_versions (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  store_id uuid not null,
  version int not null check (version >= 1),
  -- dokładnie ten tekst widzi kupujący przy polu wyboru (bez HTML)
  wording text not null check (char_length(btrim(wording)) between 20 and 2000),
  privacy_url text check (privacy_url is null or (privacy_url ~ '^https?://[^\s<>"]+$' and char_length(privacy_url) <= 500)),
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  unique (tenant_id, id),
  unique (store_id, version),
  -- wersja jest dowodem zgody: usunięcie sklepu jej nie kasuje po cichu (no action); znika
  -- wyłącznie z tenantem (kaskada wyżej)
  foreign key (tenant_id, store_id) references stores (tenant_id, id)
);
create unique index store_consent_versions_biezaca_idx on store_consent_versions (store_id) where superseded_at is null;

create function store_consent_versions_niezmienne() returns trigger language plpgsql as $$
begin
  if new.wording is distinct from old.wording
     or new.privacy_url is distinct from old.privacy_url
     or new.version is distinct from old.version
     or new.store_id is distinct from old.store_id
     or new.tenant_id is distinct from old.tenant_id
     or new.created_at is distinct from old.created_at
     or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at) then
    raise exception 'store_consent_versions: wersja klauzuli jest niezmienna (dozwolone tylko jednorazowe superseded_at)';
  end if;
  return new;
end $$;

create trigger store_consent_versions_niezmienne
  before update on store_consent_versions
  for each row execute function store_consent_versions_niezmienne();

alter table consents
  -- wersja klauzuli checkoutu, przy której kupujący zaznaczył zgodę (tekst i tak jest w wording)
  add column store_consent_version_id uuid,
  add constraint consents_store_consent_version_fk
    foreign key (tenant_id, store_consent_version_id) references store_consent_versions (tenant_id, id)
    on delete set null (store_consent_version_id);
