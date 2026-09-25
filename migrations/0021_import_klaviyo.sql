-- Import bazy z Klaviyo (audyt 24.09, braki #1 i #2): przebiegi importu CSV, bledy per
-- wiersz, wlasciwosci wlasne profilu i idempotencja zgod z importu.
--
-- Cztery rozstrzygniecia, ktore ta migracja utrwala w schemacie, a nie w kodzie:
--
-- 1. Przebieg importu ma DWA zestawy liczb: `planned` (co zapowiedzielismy w podgladzie,
--    zanim cokolwiek zapisano) i `counters` (co faktycznie powstalo, liczone odczytem
--    zwrotnym z bazy po zakonczeniu). Ten sam wzorzec co import_runs z 0003 (NFR2, NFR6).
--    Rozjazd tych dwoch liczb jest informacja dla czlowieka, nie czyms do ukrycia.
-- 2. Zgoda z importu jest idempotentna NA POZIOMIE BAZY: ten sam plik wgrany dwa razy nie
--    moze dac dwoch wpisow 'granted' o tej samej dacie. Rejestr zgod zostaje append-only
--    (AD-16) - indeks czesciowy blokuje wylacznie duplikat tego samego faktu z importu,
--    nie kolejne zdarzenia zgody z innych zrodel.
-- 3. Kazda zgoda z importu pamieta, KTORY przebieg ja wpisal (`import_job_id`). Licznik
--    "zgody nadane" liczy sie wtedy prostym COUNT po bazie, a nie z pamieci procesu.
-- 4. Wlasciwosci wlasne z Klaviyo (Shopify Tags, punkty lojalnosciowe, miasto...) laduja
--    w jednym jsonb na profilu, a nie w kolumnach: zestaw jest inny u kazdego klienta.

create table import_jobs (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- kreator: uploaded (plik profili wgrany) -> mapped (kolumny przypisane)
  --          -> suppressions (krok supresji rozstrzygniety) -> planned (podglad policzony,
  --          start zlecony) -> running -> done | failed
  status text not null default 'uploaded'
    check (status in ('uploaded', 'mapped', 'suppressions', 'planned', 'running', 'done', 'failed')),
  source text not null default 'klaviyo',
  -- nazwa pliku wylacznie DO WYSWIETLENIA, po odkazeniu. Sciezka na dysku nie jest
  -- kolumna: buduje ja kod z tenant_id i id przebiegu, wiec nazwa od uzytkownika
  -- nigdy nie trafia do systemu plikow (path traversal).
  file_name text not null,
  file_size bigint not null check (file_size >= 0),
  row_count int not null default 0,
  headers jsonb not null default '[]'::jsonb,
  sample jsonb not null default '[]'::jsonb,
  -- tablica rownolegla do headers: docelowe pole dla kazdej kolumny
  mapping jsonb not null default '[]'::jsonb,
  -- listId, supresjePominiete (swiadome klikniecie "nie mam pliku supresji")
  options jsonb not null default '{}'::jsonb,
  suppression_file_name text,
  suppression_file_size bigint check (suppression_file_size is null or suppression_file_size >= 0),
  suppression_row_count int,
  suppression_headers jsonb,
  suppression_sample jsonb,
  suppression_mapping jsonb,
  planned jsonb not null default '{}'::jsonb,
  counters jsonb not null default '{}'::jsonb,
  -- laczna liczba bledow; w import_job_errors zostaje ograniczona probka
  error_count int not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  created_by text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create index import_jobs_tenant_idx on import_jobs (tenant_id, created_at desc);

-- Bledy per wiersz z numerem linii pliku. Osobna tabela, nie jsonb w przebiegu: przy
-- pliku z 200 tys. wierszy i 30% bledow jeden jsonb mialby dziesiatki megabajtow
-- i ekran przebiegu nie dalby sie otworzyc.
create table import_job_errors (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null,
  job_id uuid not null,
  file text not null check (file in ('profiles', 'suppressions')),
  line_no int not null,
  email text,
  reason text not null,
  foreign key (tenant_id, job_id) references import_jobs (tenant_id, id) on delete cascade
);

create index import_job_errors_job_idx on import_job_errors (tenant_id, job_id, line_no);

-- Wlasciwosci wlasne profilu (Klaviyo `properties`). Scalane przy imporcie operatorem ||,
-- wiec kolejny plik dopisuje klucze, a nie kasuje wczesniejszych.
alter table profiles add column properties jsonb not null default '{}'::jsonb;

-- Zgoda pamieta przebieg importu, ktory ja wpisal. FK zlozony po tenancie (wzorzec 0001):
-- zgoda tenanta A nie moze wskazywac przebiegu tenanta B. Skasowanie przebiegu odpina
-- zgode, nie kasuje jej - rejestr zgod jest append-only.
alter table consents add column import_job_id uuid;
alter table consents
  add constraint consents_import_job_fk
  foreign key (tenant_id, import_job_id) references import_jobs (tenant_id, id)
  on delete set null (import_job_id);

create index consents_import_job_idx on consents (tenant_id, import_job_id)
  where import_job_id is not null;

-- Idempotencja zgod z importu: ten sam fakt (osoba, kanal, stan, data zdarzenia) z pliku
-- wchodzi raz. Indeks jest CZESCIOWY - dotyczy wylacznie source = 'import', wiec zgoda
-- z popupu albo checkoutu o tej samej dacie nadal wejdzie jako osobne zdarzenie.
create unique index consents_import_idempotencja_idx
  on consents (tenant_id, profile_id, channel, state, occurred_at)
  where source = 'import';

-- Czlonkostwo w liscie z importu pamieta przebieg w `source` ('import:<job_id>'), a klucz
-- glowny (list_id, profile_id) z 0004 juz blokuje duplikat. FK zlozone po tenancie sa
-- w 0004 od poczatku - nic do dokladania.
