-- Domkniecie RODO i hasza wykluczen po review (24.09): dedup po haszu, kanal surowych
-- zdarzen, indeksy pod predykaty, ktore do tej pory szly pelnym skanem.
--
-- 1. `suppressions.email_hash` jest UNIKALNY: drugi wpis dla tego samego adresu (np.
--    kolejne odbicie po anonimizacji, gdy w tabeli lezy juz zaslepka z haszem) ma trafic
--    w konflikt, a nie stanac obok jako jawny duplikat. Check: zaslepka bez hasza to
--    wiersz, ktory nikogo nie blokuje - taki nie ma prawa istniec.
-- 2. `raw_events.channel` rozroznia webhook od importu. Ocena ciszy sklepu liczy
--    "ostatnie zdarzenie" wylacznie z kanalu webhook - import 8 tys. zamowien nie moze
--    przez dobe udawac, ze sklep dosyla dane.
-- 3. Indeksy: predykat RODO po (byt, id) z klucza idempotencji i po e-mailu w payloadzie;
--    planowanie jobow cyklicznych po (tenant, rodzaj, czas).

create unique index suppressions_email_hash_uidx on suppressions (email_hash) where email_hash is not null;
alter table suppressions add constraint suppressions_zaslepka_ma_hash_check
  check (email not like 'anonimizowano:%' or email_hash is not null);

alter table raw_events add column channel text not null default 'webhook'
  check (channel in ('webhook', 'import'));

create index raw_events_byt_id_idx
  on raw_events (tenant_id, split_part(idempotency_key, ':', 3), split_part(idempotency_key, ':', 4));
create index raw_events_billing_email_idx
  on raw_events (tenant_id, lower(btrim(payload -> 'billing' ->> 'email')))
  where payload -> 'billing' ->> 'email' is not null;
create index raw_events_email_idx
  on raw_events (tenant_id, lower(btrim(payload ->> 'email')))
  where payload ->> 'email' is not null;
create index raw_events_nieprzetworzone_kanal_idx
  on raw_events (received_at) where processed_at is null;

create index jobs_tenant_kind_created_idx on jobs (tenant_id, kind, created_at);
