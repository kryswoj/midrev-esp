-- Epik 5 - atrybucja: klikniecia, wersjonowane reguly, przebiegi przeliczen.
--
-- AD-14: atrybucja jest projekcja liczona przez job i zapisywana, nie zapytaniem ad hoc
--        w raporcie. Raport czyta wylacznie zapisane wiersze.
-- AD-28: regula (okno, model) jest bytem wersjonowanym; rekord atrybucji nosi rule_id,
--        a przeliczenie tworzy NOWY przebieg zamiast kasowac poprzednie liczby. Dzieki
--        temu liczba pokazana wczoraj klientowi jest do odtworzenia co do grosza.

-- 0003 nie przewidziało, że coś będzie się odwoływać do zamówień złożonym kluczem
-- (tenant_id, id). Dokładamy unikalność tutaj, bo 0003 jest już zastosowane, a migracje
-- są append-only (AD-12).
alter table orders add constraint orders_tenant_id_unique unique (tenant_id, id);

create table clicks (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null,
  message_id uuid not null,
  profile_id uuid,
  url text not null,
  occurred_at timestamptz not null default now(),
  user_agent text,
  foreign key (tenant_id, message_id) references messages (tenant_id, id) on delete cascade
);

create index clicks_profile_idx on clicks (tenant_id, profile_id, occurred_at desc);

create table attribution_rules (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  model text not null default 'last_click' check (model in ('last_click')),
  window_hours int not null default 120 check (window_hours > 0),
  effective_from timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table attribution_runs (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  rule_id uuid not null references attribution_rules(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  note text
);

create table attributions (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null,
  run_id uuid not null references attribution_runs(id) on delete cascade,
  order_id uuid not null,
  message_id uuid not null,
  campaign_id uuid not null,
  click_id uuid not null references clicks(id),
  amount_minor bigint not null,
  computed_at timestamptz not null default now(),
  -- jedno zamowienie ma w obrebie przebiegu najwyzej jedna atrybucje (last-touch)
  unique (run_id, order_id),
  foreign key (tenant_id, order_id) references orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, message_id) references messages (tenant_id, id) on delete cascade
);

create index attributions_campaign_idx on attributions (tenant_id, campaign_id, run_id);
