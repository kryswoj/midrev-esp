-- Niezawodnosc wysylki - naprawy z audytu 2026-08-31 (W1, W2, W4, W8).
--
-- Cztery decyzje wprost zakodowane w schemacie:
--   W1: `claimed_at` na messages - recovery zombie liczy timeout od momentu ZAJECIA
--       partii, nie od utworzenia wiadomosci. Wiadomosc zbudowana wczoraj (limit dobowy
--       przerwal wysylke) nie moze byc cofnieta do queued w trakcie, gdy inny worker
--       wlasnie ja przetwarza - to konczylo sie podwojna wysylka, a ta jest
--       nieodwracalna (NFR15).
--   W2: `attempts` na messages - blad przejsciowy dostawcy (odmowa polaczenia, timeout,
--       odpowiedz 4xx) wraca do queued z licznikiem prob zamiast trwalego failed.
--       Trwale failed dopiero po wyczerpaniu prob albo przy bledzie trwalym (5xx).
--   W4: `tenant_send_usage` - limit dobowy przestaje byc miekki. Rezerwacja miejsca
--       (`used = used + 1` z warunkiem `<= limit`) dzieje sie W TEJ SAMEJ transakcji
--       co przejscie wiadomosci w sending, wiec dwa rownolegle procesy (job kampanii
--       + tik automatyzacji) nie moga razem przekroczyc limitu. Rezerwacja NIE jest
--       zwalniana przy niejasnym wyniku dostawcy - lepiej wyslac mniej niz za duzo.
--       Jeden wiersz per tenant per doba; doba liczona w strefie serwera bazy,
--       spojnie z `run_after` odroczonego joba kampanii.
--   W8: indeksy pod goraca sciezke - message_events nie mialo zadnego indeksu
--       zaczynajacego sie od tenant_id, wiec licznik "wyslane dzisiaj" i raporty
--       robily seq scan najwiekszej tabeli systemu przy kazdej partii.

alter table messages add column claimed_at timestamptz;
alter table messages add column attempts int not null default 0;

create table tenant_send_usage (
  tenant_id uuid not null references tenants(id) on delete cascade,
  day date not null,
  used int not null default 0 check (used >= 0),
  primary key (tenant_id, day)
);

-- Partial, bo predykat licznika dobowego i raportu "wyslane" filtruje wylacznie 'sent';
-- pozostale typy zdarzen (delivered, bounced, kliki webhooka) nie obciazaja indeksu.
create index message_events_tenant_sent_idx
  on message_events (tenant_id, occurred_at)
  where event_type = 'sent';

-- raportKampanii laczy clicks z messages po (tenant_id, message_id); 0007 dalo tylko
-- (tenant_id, profile_id, occurred_at), wiec raport i kaskady FK szly po seq scanie.
create index clicks_message_idx on clicks (tenant_id, message_id);

-- Recovery zombie skanuje wiadomosci w 'claimed' po claimed_at co 5 minut; partial,
-- bo wiadomosci w tym stanie sa nieliczne (jedna partia w locie per worker).
create index messages_claimed_idx on messages (claimed_at) where current_state = 'claimed';
