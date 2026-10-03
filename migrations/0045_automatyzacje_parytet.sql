-- E4b „Automatyzacje: parytet” (plan metryki-i-profil 3.3, 3.5, 7.1 stories 4.6–4.10).
--
-- 1. messages.transactional: wiadomosc z kroku oznaczonego jako transakcyjny. Wiazaca bramka
--    wysylki (canSendTo w transakcji przejscia w sending, AD-25) pomija dla niej brak zgody
--    marketingowej, ale NIGDY supresji (wypis, odbicie, skarga, wykluczenie globalne).
--    Expand (AD-46): kolumna z domyslnym false. Stary kod po rollbacku jej nie zna i traktuje
--    kazda wiadomosc jak marketingowa, czyli osobie bez zgody NIE wysle (bezpieczny kierunek).
--    Domyslna wartosc stala = bez przepisywania tabeli (Postgres 11+).
--
-- 2. flow_entry_skips: osoby, ktore zdarzenie wyzwalacza wpuscilo by do automatyzacji, ale nie
--    spelnily filtra profilu W CHWILI WEJSCIA (Klaviyo: „Skipped: Fails profile filters”).
--    Osobna tabela, a nie uczestnik ze statusem „wyszedl”: odrzucone wejscie nie moze zajac
--    klucza „raz” (osoba, ktora pozniej zacznie spelniac filtr, ma wejsc przy kolejnym
--    zdarzeniu) ani liczyc sie w „ponownie po X dniach”. Sciezka osoby i podglad wyzwalacza
--    czytaja stad powod. Klucz glowny = idempotencja: zakladka skanu przetwarza to samo
--    zdarzenie kilka razy, a wpis jest jeden.
--    Bez danych osobowych poza id profilu; usuniecie profilu albo flow usuwa wpisy.

alter table messages add column transactional boolean not null default false;

create table flow_entry_skips (
  tenant_id uuid not null,
  flow_id uuid not null,
  profile_id uuid not null,
  -- 'e:<id zdarzenia>' albo 'l:<lista>:<epoka dodania>' (jak entry_key, niezaleznie od trybu)
  entry_ref text not null,
  reason text not null check (reason in ('filtr_profilu')),
  detail jsonb not null default '{}'::jsonb,
  -- czas zdarzenia, ktore probowalo wprowadzic osobe (AD-10)
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  primary key (tenant_id, flow_id, entry_ref, profile_id),
  foreign key (tenant_id, flow_id) references flows (tenant_id, id) on delete cascade,
  foreign key (tenant_id, profile_id) references profiles (tenant_id, id) on delete cascade
);
create index flow_entry_skips_profil_idx on flow_entry_skips (tenant_id, profile_id, occurred_at desc);
