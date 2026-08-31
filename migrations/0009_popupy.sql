-- Epik F - popupy i zbieranie leadow na stronie sklepu.
--
-- Popup jest KONFIGURACJA, nie trescia strony: skrypt on-site (AD-19) pobiera ja
-- w momencie generowania i renderuje po swojej stronie przez textContent, wiec
-- w bazie trzymamy czysty tekst bez zadnego HTML.
--
-- Zgloszenia z popupu NIE maja wlasnej tabeli. Zgloszenie to profil (profiles),
-- zgoda (consents, append-only wg AD-16) i zdarzenie 'popup.submitted' (events).
-- Osobna tabela zgloszen powielalaby te same dane i wymagalaby wlasnej sciezki RODO.
--
-- Zadnego `if not exists`: w migracji append-only (AD-12) ukryloby to rozjazd schematu.

create table popups (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- nazwa robocza dla operatora; wchodzi tez do consents.source jako 'popup:<name>',
  -- zeby przy sporze o zgode dalo sie wskazac konkretny formularz, z ktorego przyszla
  name text not null,
  headline text not null,
  body_text text not null,
  button_text text not null,
  -- kod rabatowy pokazywany PO zapisie; null = popup bez rabatu
  discount_code text,
  -- reguly wyswietlania (np. delay_seconds) jako jsonb, bo ich zestaw bedzie rosl
  -- (exit intent, scroll depth) i kazda nowa regula kolumna wymagalaby migracji
  rules jsonb not null default '{}'::jsonb,
  -- popup rodzi sie wylaczony: operator najpierw sprawdza tresc, potem wlacza
  active boolean not null default false,
  created_at timestamptz not null default now(),
  -- para (tenant_id, id) pod zlozone klucze obce - ten sam wzorzec, ktorym 0001
  -- zablokowalo mieszanie danych miedzy tenantami (AD-2)
  unique (tenant_id, id),
  unique (tenant_id, name)
);

-- skrypt on-site pyta o "najnowszy aktywny popup tenanta" przy kazdym wejsciu na
-- strone sklepu, wiec to zapytanie musi isc po indeksie, nie po sekwencyjnym skanie
create index popups_tenant_active_idx on popups (tenant_id, active, created_at desc);
