-- E2 / Story 2.4: identyfikatory profilu pod API zdarzen (plan 2.5).
--
-- Kolejnosc dopasowania w kodzie: id -> email -> phone_number -> external_id -> anonymous_id.
--
-- ODSTEPSTWO OD PLANU (swiadome, opisane w 04-strumien-A.md): plan zaklada UNIKALNY indeks
-- na (tenant_id, phone) po normalizacji istniejacych numerow do E.164 w miejscu. Nie robimy
-- tego w MVP, bo:
--   - `phone` pisza dzis webhook i import Woo (`upsertProfilKlienta`) oraz import Klaviyo.
--     Dwoch klientow sklepu z jednym numerem (rodzina, firma) = unikalny indeks wywraca
--     zapis profilu, a job webhooka wyczerpuje proby. To regresja istniejacego ingestu.
--   - przepisanie numerow w miejscu zmienia dane zrodlowe bez odwrotu.
-- Zamiast tego: niemutujaca funkcja normalizacji i ZWYKLY indeks na wyrazeniu. Dopasowanie
-- po telefonie w kodzie bierze profil tylko wtedy, gdy numer wskazuje DOKLADNIE jeden
-- profil; wiecej niz jeden = konflikt (alert), telefon nie decyduje.
--
-- external_id i anonymous_id to NOWE kolumny, pisane wylacznie przez API, wiec unikalnosc
-- per tenant nie grozi niczemu, co juz dziala.

alter table profiles
  add column external_id text check (external_id is null or char_length(external_id) between 1 and 255),
  add column anonymous_id text check (anonymous_id is null or char_length(anonymous_id) between 1 and 255),
  add column organization text,
  add column title text,
  add column locale text,
  -- address1, address2, city, region, country, zip, latitude, longitude, timezone
  add column location jsonb not null default '{}'::jsonb check (jsonb_typeof(location) = 'object'),
  add column updated_at timestamptz;

create unique index profiles_tenant_external_idx on profiles (tenant_id, external_id) where external_id is not null;
create unique index profiles_tenant_anon_idx on profiles (tenant_id, anonymous_id) where anonymous_id is not null;

-- Normalizacja numeru do E.164 (domyslny kraj: PL). Zwraca NULL, gdy numeru nie da sie
-- jednoznacznie sprowadzic do E.164 - taki numer nie bierze udzialu w dopasowaniu.
-- Ta sama regula jest w TS (src/domain/zdarzenia/telefon.ts) i test pilnuje zgodnosci.
create function midrev_telefon_e164(p text)
returns text
language sql
immutable
parallel safe
returns null on null input
as $$
  select case
    when n ~ '^\+[1-9][0-9]{6,14}$' then n
    when n ~ '^00[1-9][0-9]{6,14}$' then '+' || substr(n, 3)
    when n ~ '^[1-9][0-9]{8}$' then '+48' || n
    when n ~ '^48[1-9][0-9]{8}$' then '+' || n
    else null
  end
  from (select regexp_replace(btrim(p), '[\s().\-/]', '', 'g') as n) x
$$;

create index profiles_tenant_telefon_idx on profiles (tenant_id, midrev_telefon_e164(phone)) where phone is not null;

-- Nagrobki RODO dla identyfikatorow bez e-maila (review Codeksa R1): osoba po art. 17
-- zidentyfikowana w API telefonem, external_id albo anonymous_id nie moze wrocic przez
-- kolejne zdarzenie z tym samym identyfikatorem. Hasz HMAC (klucz jak w 0022), nie wartosc.
create table rodo_nagrobki_identyfikatorow (
  tenant_id uuid not null references tenants(id) on delete cascade,
  rodzaj text not null check (rodzaj in ('phone_number', 'external_id', 'anonymous_id')),
  hash text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, rodzaj, hash)
);
