-- Nagrobki RODO i wersjonowanie profilu (review 24.09, znaleziska #1 i #3).
--
-- 1. `rodo_nagrobki`: po anonimizacji profil ma `email = null`, wiec nastepny webhook
--    `customer.updated` albo ponowny import `/customers` nie trafial w zanonimizowany
--    wiersz i zakladal NOWY profil z pelnymi danymi - anonimizacja odwracala sie po cichu,
--    a log mowil "zrobione". Nagrobek (tenant + kluczowany hasz adresu + id konta w sklepie)
--    jest sprawdzany przy kazdym tworzeniu profilu z danych sklepu: trafienie = brak
--    profilu, payload od razu zaslepiony, zamowienie zostaje bez osoby (przychod liczy sie).
-- 2. `profiles.source_updated_at`: kolejnosc dostarczania webhookow nie jest gwarantowana,
--    a zalegle zdarzenie odtworzone po dobie cofaloby nowsze imie/telefon. Ten sam guard,
--    co 0013 dla zamowien.
-- 3. `import_runs`: jeden trwajacy import na sklep - dwoch operatorow naraz to dwa
--    przebiegi na tych samych danych.
--
-- Osobny plik, nie edycja 0023: tamta byla juz zastosowana (checksum w schema_migrations).

create table rodo_nagrobki (
  tenant_id uuid not null references tenants(id) on delete cascade,
  email_hash text not null,
  -- konta w sklepie, ktore nalezaly do tej osoby (z surowych zdarzen customer.*):
  -- webhook o zmianie konta nie niesie starego adresu, wiec rozpoznajemy je po id
  store_id uuid,
  external_customer_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (tenant_id, email_hash),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete set null (store_id)
);
create index rodo_nagrobki_konta_idx on rodo_nagrobki using gin (external_customer_ids);

alter table profiles add column source_updated_at timestamptz;

create unique index import_runs_jeden_trwajacy_idx on import_runs (tenant_id, store_id) where status = 'running';
