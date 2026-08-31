-- Epik 3 - silnik wysylki: wiadomosci, strumien stanu, akceptacje, limity.
--
-- Trzy decyzje architektoniczne wprost zakodowane w schemacie:
--   AD-22: `messages` sa niemutowalne poza projekcja stanu; historia zyje w append-only
--          `message_events` z unikalnoscia (message_id, event_type), wiec worker wysylki
--          i webhook dostawcy nie moga sie nawzajem nadpisac przy wyscigu.
--   AD-26: unikalnosc wiadomosci to (tenant_id, source_type, source_id, profile_id),
--          NIE (campaign_id, profile_id) - obejmuje tez automatyzacje i testy.
--   AD-33: token klikniecia i token wypisania sa osobnymi losowymi sekretami, nigdy
--          kluczem glownym, zeby z linku nie dalo sie zgadnac struktury ani cudzych tokenow.

create table sending_domains (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  domain text not null,
  -- komplet rekordow do ustawienia u rejestratora, wygenerowany przy dodaniu domeny
  dns_records jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'verified', 'failed')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, domain)
);

-- Akceptacja kampanii przez klienta (FR39-FR41). Token jednorazowy, w bazie tylko hash,
-- wazny 7 dni (NFR10). Decyzja jest osobnym wierszem, nie kolumna na kampanii, zeby
-- historia "kto, kiedy, z jakimi uwagami" zostala przy kolejnych rundach akceptacji.
create table campaign_approvals (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null,
  campaign_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  decided_at timestamptz,
  decision text check (decision in ('approved', 'changes_requested')),
  comment text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, campaign_id) references campaigns (tenant_id, id) on delete cascade
);

create index campaign_approvals_campaign_idx on campaign_approvals (tenant_id, campaign_id, created_at desc);

create table messages (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  profile_id uuid,
  source_type text not null check (source_type in ('campaign', 'journey', 'test')),
  source_id uuid not null,
  -- migawka adresu w momencie wyslania: profil moze potem zmienic adres, a historia
  -- wysylki musi mowic prawde o tym, dokad mail faktycznie poszedl
  email text not null,
  subject text not null,
  -- utrwalony HTML nalezy do WIADOMOSCI, nie do kampanii (AD-32): zmiana szablonu po
  -- wysylce nie moze wstecznie zmienic tego, co ludzie dostali
  body_html text not null,
  click_token text not null unique,
  unsubscribe_token text not null unique,
  provider_id text,
  -- projekcja stanu (AD-22): aktualizowana wylacznie monotonicznie warunkiem rank
  current_state text not null default 'queued',
  current_rank int not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique nulls not distinct (tenant_id, source_type, source_id, profile_id),
  foreign key (tenant_id, profile_id) references profiles (tenant_id, id) on delete set null (profile_id)
);

create index messages_source_idx on messages (tenant_id, source_type, source_id);
create index messages_state_idx on messages (tenant_id, current_state) where current_state in ('queued', 'sending');

create table message_events (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null,
  message_id uuid not null,
  event_type text not null check (event_type in
    ('queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed', 'held')),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  -- jedna wiadomosc przechodzi przez kazdy stan najwyzej raz; wyscig workera z webhookiem
  -- dostawcy konczy sie bledem unikalnosci, nie cichym nadpisaniem
  unique (message_id, event_type),
  foreign key (tenant_id, message_id) references messages (tenant_id, id) on delete cascade
);

-- Limit dobowy wysylki per tenant (FR52, AD-31). Nie ochrona przed spamerem, tylko przed
-- soba: zle policzony segment nie moze wyslac dziesiec razy za duzo, bo to nieodwracalne.
create table tenant_send_limits (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  daily_limit int not null default 500 check (daily_limit > 0),
  updated_at timestamptz not null default now()
);
