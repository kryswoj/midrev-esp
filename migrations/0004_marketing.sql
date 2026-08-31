-- Epik 2 - odbiorcy, zgody i wykluczenia. Plus szkielet kampanii z Epiku 4.
--
-- Trzy rzeczy, ktore ta migracja rozstrzyga inaczej, niz podpowiada odruch:
--
-- 1. ZGODY sa dopisywane, nigdy nadpisywane (AD-16). Stan zgody to ostatni wpis, a nie
--    kolumna boolean w profilu. Przy sporze z klientem albo kontroli trzeba pokazac,
--    KIEDY i SKAD zgoda przyszla, a kolumna boolean tego nie pamieta.
-- 2. WYKLUCZENIA sa dwupoziomowe (AD-27): globalne chronia reputacje calej platformy,
--    lokalne to wypisania z konkretnego sklepu. Sprawdzane sa obie.
-- 3. Wpis do wykluczen tez jest LOGIEM ZDARZEN, nie wierszem do skasowania. Administrator
--    moze zdjac wykluczenie (FR30), ale robi to nowym wpisem, a nie DELETE, zeby historia
--    zostala. Aktualny stan liczy sie z ostatniego zdarzenia dla adresu.

create table lists (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table list_members (
  tenant_id uuid not null,
  list_id uuid not null,
  profile_id uuid not null,
  added_at timestamptz not null default now(),
  source text not null default 'reczny',
  primary key (list_id, profile_id),
  foreign key (tenant_id, list_id) references lists (tenant_id, id) on delete cascade,
  foreign key (tenant_id, profile_id) references profiles (tenant_id, id) on delete cascade
);

create index list_members_profile_idx on list_members (tenant_id, profile_id);

-- Segment to definicja regul, nie zapisana lista ludzi. Liczebnosc jest przeliczana,
-- bo lista zamrozona w momencie zapisu klamie juz nastepnego dnia.
create table segments (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  -- zamkniety zestaw regul w fazie 1 (FR24), generyczny builder to faza 3 (FR31)
  rules jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table consents (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null,
  profile_id uuid not null,
  channel text not null check (channel in ('email', 'sms')),
  state text not null check (state in ('granted', 'withdrawn')),
  -- skad zgoda: formularz, import z innego ESP, zamowienie w sklepie, operator
  source text not null,
  -- tresc klauzuli w brzmieniu, na ktore osoba sie zgodzila
  wording text,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, profile_id) references profiles (tenant_id, id) on delete cascade
);

create index consents_profile_idx on consents (tenant_id, profile_id, channel, occurred_at desc);

-- Wypisania i skargi konkretnego sklepu. Globalna tabela `suppressions` z migracji 0001
-- zostaje bez zmian i chroni reputacje calej platformy.
create table tenant_suppressions (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email text not null,
  -- 'suppressed' dodaje wykluczenie, 'released' je zdejmuje. Oba to wpisy, nie DELETE.
  action text not null check (action in ('suppressed', 'released')),
  reason text not null,
  actor text,
  occurred_at timestamptz not null default now()
);

create index tenant_suppressions_email_idx
  on tenant_suppressions (tenant_id, lower(btrim(email)), occurred_at desc);

create table campaigns (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  subject text,
  preheader text,
  -- tresc jako nieprzezroczysty dokument edytora (AD-32): modul kampanii nie zna
  -- wewnetrznego formatu, bo inaczej zmiana edytora oznacza przepisanie kampanii
  content jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in ('draft', 'awaiting_approval', 'approved', 'scheduled', 'sending', 'sent', 'cancelled')),
  scheduled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

-- Odbiorcy kampanii jako zbior list i segmentow, z wykluczeniami (FR34).
create table campaign_audience (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null,
  campaign_id uuid not null,
  mode text not null check (mode in ('include', 'exclude')),
  source_type text not null check (source_type in ('list', 'segment')),
  source_id uuid not null,
  foreign key (tenant_id, campaign_id) references campaigns (tenant_id, id) on delete cascade
);

create index campaign_audience_idx on campaign_audience (tenant_id, campaign_id);
