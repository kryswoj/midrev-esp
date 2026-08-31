-- Epik E, automatyzacje (journeys): powitanie po zapisie, podziekowanie po zakupie.
-- Journey nie ma wlasnego toru wysylki: buduje wiadomosci queued w `messages`
-- (source_type 'journey'), a wysyla je ten sam silnik co kampanie, przez te same
-- bramki (AD-25, FR69). Unikalnosc (tenant_id, source_type, source_id, profile_id)
-- z AD-26 gwarantuje, ze jeden profil dostanie jeden mail z danego journeya,
-- nawet gdy dwa tiki przetwarzania pobiegna rownolegle.

create table journeys (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  -- typ zdarzenia z tabeli events, np. 'popup.submitted' albo 'order.created'
  trigger_event text not null,
  -- odstep liczony od occurred_at zdarzenia (AD-10), nie od chwili przetwarzania:
  -- "godzine po zakupie" ma znaczyc godzine po zakupie, a nie godzine po tiku workera
  delay_minutes int not null default 0 check (delay_minutes >= 0),
  subject text not null,
  content jsonb not null default '{}'::jsonb,
  active boolean not null default false,
  -- moment OSTATNIEJ aktywacji. Journey wlaczony dzis nie moze ostrzelac ludzi,
  -- ktorych zdarzenia zaszly przed aktywacja (powitanie sprzed dwoch dni to spam,
  -- nie powitanie). Null = nigdy nie aktywowany, wtedy granica jest created_at.
  active_since timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, name),
  -- para pod przyszle zlozone FK, ten sam wzorzec co profiles/messages
  unique (tenant_id, id)
);

-- Rejestr "ten profil juz dostal ten journey". Dubluje unikalnosc z messages,
-- ale jest tanszy: pozwala odfiltrowac obsluzone profile JEDNYM not-exists w SQL,
-- zanim zaczniemy renderowac HTML i generowac tokeny per wiadomosc.
-- Wpis powstaje PO wstawieniu wiadomosci, wiec awaria miedzy nimi nie gubi maila:
-- kolejny tik trafi konfliktem w messages (AD-26) i tylko uzupelni rejestr.
create table journey_runs (
  journey_id uuid not null references journeys(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  -- occurred_at zdarzenia, ktore odpalilo journey (AD-10: data ze zrodla)
  triggered_at timestamptz not null,
  primary key (journey_id, profile_id)
);
