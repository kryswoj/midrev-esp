-- E1 / Story 1.4 (MVP): backfill strumienia `metric_events` ze starej tabeli `events`
-- (plan 1.5; MVP bierze tylko `events` - wiadomosci, zaangazowanie, zgody i listy dojda
-- z emisja metryk e-mail, story 1.3 poza MVP).
--
-- Zasady z listy kontrolnej zapisu do produkcji (CLAUDE.md):
--   pkt 2: data zdarzenia ZE ZRODLA. `occurred_at` = events.occurred_at (uciety do pelnej
--          sekundy, AD-39), `recorded_at` i `ingested_at` = events.recorded_at. Nic z now().
--   pkt 3: odczyt ZWROTNY zapisanych wierszy w tym samym bloku, nie danych wejsciowych.
--   pkt 4: asercje licza faktyczny stan tabeli po zapisie, nie proby.
--   pkt 7: kopiujemy WYLACZNIE po identyfikatorach wierszy `events` (te same `id`).
-- Rozjazd = `raise exception`: cala migracja (i 0030 w tej samej paczce deployu nie,
-- bo migrator ma transakcje per plik) jest wycofana, jak w 0018.
--
-- Historia (zapisana w `events` ponad 4 h temu) i import dostaja `backfill = true`: zdarzenia,
-- ktorych okno minelo, nie moga wyzwolic flow w nowym silniku. Wiersze swiezsze niz 4 h
-- (zdarzenia z ostatnich minut przed deployem i z okna deployu) zostaja wyzwalajace: wejscie
-- do flow jest idempotentne po (flow, profil, entry_key) i tym samym id zdarzenia.
--
-- Mapowanie (kontrakt A-B, src/domain/zdarzenia/kontrakt.ts):
--   popup.submitted -> (midrev, Submitted Form)   unique_id form:{popup_id}:{id}, source client
--   order.created   -> (woocommerce, Placed Order) unique_id orders.id, value z totalMinor,
--                      source import gdy payload.kanal = 'import', inaczej webhook
--   customer.*      -> (midrev, ta sama nazwa), ukryte, source webhook
--   rodo.*          -> (midrev, ta sama nazwa), ukryte, source system
--   inne            -> (midrev, event_type), source system
--
-- Ta sama funkcja zostaje w bazie: worker przy starcie dosynchronizowuje wiersze `events`
-- zapisane przez STARY kod w oknie deployu (miedzy ta migracja a startem nowego kodu).
-- Nowy kod pisze oba wiersze (lustro, to samo id) w jednej transakcji, wiec funkcja ich
-- nie zdubluje (sprawdzenie po kluczu glownym strumienia + on conflict do nothing).

create function metryki_dosynchronizuj_events(p_od timestamptz)
returns integer
language plpgsql
as $$
declare
  zakres record;
  wstawione integer;
begin
  -- limit 200 metryk na tenanta (AD-37) obowiazuje tez tutaj (review Codeksa R1). Ta sama
  -- blokada doradcza per tenant co metrykaPoKluczu (R2b), w stalej kolejnosci tenantow,
  -- i liczenie po ZMAPOWANYM kluczu metryki, nie po surowym event_type.
  -- Blokada SESYJNA, zwalniana zaraz po utworzeniu metryk (nie trzymana przez kopiowanie
  -- zdarzen): worker API trzyma wiersz profilu i czeka na te blokade przy nowej metryce,
  -- a kopiowanie zdarzen sprawdza FK do profili - blokada do konca transakcji dawalaby
  -- cykl (review Codeksa R3).
  perform pg_advisory_lock(hashtextextended('metrics:limit:' || t.tenant_id::text, 0))
     from (select distinct e.tenant_id from events e where e.recorded_at >= p_od order by 1) t;
  begin
  if exists (
    select 1 from (
      select k.tenant_id, count(*) as nowe
        from (select distinct e.tenant_id,
                     case e.event_type when 'order.created' then 'woocommerce' else 'midrev' end as integracja,
                     case e.event_type when 'popup.submitted' then 'Submitted Form'
                                       when 'order.created' then 'Placed Order'
                                       else left(e.event_type, 127) end as nazwa
                from events e where e.recorded_at >= p_od) k
       where not exists (select 1 from metrics m
                          where m.tenant_id = k.tenant_id and m.integration_key = k.integracja and m.name = k.nazwa)
       group by k.tenant_id
    ) n
    where n.nowe + (select count(*) from metrics m where m.tenant_id = n.tenant_id) > 200
  ) then
    raise exception 'metryki_dosynchronizuj_events: tenant przekroczylby limit 200 metryk';
  end if;

  -- metryki potrzebne dla brakujacych wierszy (w locie, jak zapiszZdarzenie)
  insert into metrics (tenant_id, name, integration_key, integration_category, builtin, can_trigger, hidden,
                       first_seen_at, last_seen_at, created_at)
  select e.tenant_id,
         case e.event_type when 'popup.submitted' then 'Submitted Form'
                           when 'order.created' then 'Placed Order'
                           else left(e.event_type, 127) end,
         case e.event_type when 'order.created' then 'woocommerce' else 'midrev' end,
         case e.event_type when 'order.created' then 'eCommerce' else 'Internal' end,
         e.event_type in ('popup.submitted', 'order.created', 'customer.created', 'customer.updated',
                          'rodo.eksport', 'rodo.anonimizacja'),
         not (e.event_type like 'customer.%' or e.event_type like 'rodo.%'),
         (e.event_type like 'customer.%' or e.event_type like 'rodo.%'),
         min(date_trunc('second', e.occurred_at)), max(date_trunc('second', e.occurred_at)),
         min(e.recorded_at)
    from events e
   where e.recorded_at >= p_od
   group by e.tenant_id, e.event_type
  on conflict (tenant_id, integration_key, name) do nothing;

  exception when others then
    -- blokada sesyjna nie znika z rollbackiem: zwolnic przed przekazaniem bledu dalej
    perform pg_advisory_unlock(hashtextextended('metrics:limit:' || t.tenant_id::text, 0))
     from (select distinct e.tenant_id from events e where e.recorded_at >= p_od order by 1) t;
    raise;
  end;
  perform pg_advisory_unlock(hashtextextended('metrics:limit:' || t.tenant_id::text, 0))
     from (select distinct e.tenant_id from events e where e.recorded_at >= p_od order by 1) t;

  select min(e.occurred_at) as od, max(e.occurred_at) as do_ into zakres
    from events e where e.recorded_at >= p_od;
  if zakres.od is not null then
    perform metric_events_zapewnij_partycje(zakres.od, zakres.do_);
  end if;

  with zrodlo as (
    select e.id, e.tenant_id, e.profile_id, e.event_type, e.payload, e.recorded_at,
           date_trunc('second', e.occurred_at) as occurred_at,
           o.id as order_id, o.external_id as order_external_id, o.number as order_number, o.currency as order_currency,
           t.currency as tenant_currency
      from events e
      join tenants t on t.id = e.tenant_id
      left join orders o on e.event_type = 'order.created'
            and o.tenant_id = e.tenant_id
            -- porownanie tekstowe, nie rzutowanie: smiec w payloadzie nie wywraca migracji
            and o.id::text = (e.payload ->> 'orderId')
     where e.recorded_at >= p_od
  ), mapa as (
    select z.*,
           case z.event_type when 'popup.submitted' then 'Submitted Form'
                             when 'order.created' then 'Placed Order'
                             else left(z.event_type, 127) end as nazwa,
           case z.event_type when 'order.created' then 'woocommerce' else 'midrev' end as integracja,
           case when (z.payload ->> 'totalMinor') ~ '^-?[0-9]{1,18}$' then (z.payload ->> 'totalMinor')::bigint end as wartosc
      from zrodlo z
  )
  , wstawione_wiersze as (
  insert into metric_events (id, tenant_id, metric_id, profile_id, occurred_at, recorded_at, ingested_at,
                             unique_id, value_minor, value_currency, properties, source, backfill)
  select m.id, m.tenant_id, mt.id, m.profile_id, m.occurred_at, m.recorded_at, m.recorded_at,
         case m.event_type
           when 'order.created' then coalesce(m.payload ->> 'orderId', m.id::text)
           when 'popup.submitted' then 'form:' || coalesce(m.payload ->> 'popup_id', '') || ':' || m.id::text
           else 'legacy:' || m.id::text end,
         case when m.event_type = 'order.created' then m.wartosc end,
         case when m.event_type = 'order.created' and m.wartosc is not null
              then coalesce(m.order_currency, m.tenant_currency) end,
         case m.event_type
           when 'popup.submitted' then jsonb_strip_nulls(jsonb_build_object(
             'form_id', m.payload ->> 'popup_id', 'form_name', m.payload ->> 'popup_name'))
           when 'order.created' then jsonb_strip_nulls(jsonb_build_object(
             'OrderId', m.order_external_id,
             'OrderNumber', m.order_number,
             '$value', case when m.wartosc is not null then round(m.wartosc / 100.0, 2) end))
           else case when jsonb_typeof(m.payload) = 'object' then m.payload
                     else jsonb_build_object('payload', m.payload) end
         end,
         case
           when m.event_type = 'order.created' and m.payload ->> 'kanal' = 'import' then 'import'
           when m.event_type = 'order.created' then 'webhook'
           when m.event_type = 'popup.submitted' then 'client'
           when m.event_type like 'customer.%' then 'webhook'
           else 'system' end,
         -- backfill (nie wyzwala flow): historia starsza niz okno wyzwalania (4 h, jak
         -- OKNO_WYZWALANIA_MS w kontrakcie) albo import. Swiezy wiersz to zdarzenie NA ZYWO,
         -- ktore zapisal jeszcze stary kod (okno deployu, rollback kodu i powrot): musi moc
         -- wyzwolic flow w nowym silniku, inaczej powitanie z tych minut przepada. Podwojnego
         -- wejscia nie ma: stary silnik wpuszczal osobe po tym samym id, a wejscie chroni
         -- unikalnosc (flow, profil, entry_key) - integracja MVP, raport 06.
         m.recorded_at < now() - interval '4 hours'
           or (m.event_type = 'order.created' and m.payload ->> 'kanal' = 'import')
    from mapa m
    join metrics mt on mt.tenant_id = m.tenant_id and mt.integration_key = m.integracja and mt.name = m.nazwa
   where not exists (
     select 1 from metric_events x
      where x.tenant_id = m.tenant_id and x.occurred_at = m.occurred_at and x.id = m.id)
  on conflict do nothing
  returning tenant_id, metric_id, occurred_at
  ), metryki_po as (
    -- pierwsze/ostatnie wystapienie liczone z WSTAWIONYCH wierszy (bez skanu calego strumienia)
    update metrics mt set
      first_seen_at = least(coalesce(mt.first_seen_at, s.pierwsze), s.pierwsze),
      last_seen_at = greatest(coalesce(mt.last_seen_at, s.ostatnie), s.ostatnie)
      from (select tenant_id, metric_id, min(occurred_at) as pierwsze, max(occurred_at) as ostatnie
              from wstawione_wiersze group by tenant_id, metric_id) s
     where s.tenant_id = mt.tenant_id and s.metric_id = mt.id
    returning mt.id
  )
  select count(*) into wstawione from wstawione_wiersze;

  -- klucze deduplikacji dla zrodel zewnetrznych z profilem (AD-38): powtorka tego samego
  -- zdarzenia po backfillu ma trafic w istniejacy klucz
  insert into event_keys (tenant_id, metric_id, profile_id, unique_id, event_id, occurred_at)
  select me.tenant_id, me.metric_id, me.profile_id, me.unique_id, me.id, me.occurred_at
    from events e
    -- po kluczu glownym strumienia (tenant, occurred_at, id): bez skanu wszystkich partycji
    join metric_events me on me.tenant_id = e.tenant_id and me.occurred_at = date_trunc('second', e.occurred_at) and me.id = e.id
   where e.recorded_at >= p_od
     and me.source in ('api', 'client', 'webhook', 'import')
  on conflict do nothing;

  return wstawione;
end $$;

do $$
declare
  skopiowane integer;
  zrodlo bigint;
  strumien bigint;
  bez_lustra bigint;
  rozjazd bigint;
begin
  skopiowane := metryki_dosynchronizuj_events('-infinity');

  -- ODCZYT ZWROTNY: stan tabel po zapisie, nie licznik prob.
  select count(*) into zrodlo from events;
  select count(*) into strumien from metric_events;
  -- kazdy wiersz events ma w strumieniu wiersz o tym samym id, tenancie, profilu i czasie
  select count(*) into bez_lustra from events e
   where not exists (
     select 1 from metric_events m
      where m.tenant_id = e.tenant_id and m.id = e.id
        and m.occurred_at = date_trunc('second', e.occurred_at)
        and m.profile_id is not distinct from e.profile_id
        and m.recorded_at = e.recorded_at);
  -- licznosc i min/max czasu per (tenant, metryka) rowne zrodlu, w obie strony
  with z as (
    select e.tenant_id,
           case e.event_type when 'popup.submitted' then 'Submitted Form'
                             when 'order.created' then 'Placed Order' else left(e.event_type, 127) end as nazwa,
           count(*) as ile, min(date_trunc('second', e.occurred_at)) as od, max(date_trunc('second', e.occurred_at)) as do_
      from events e group by 1, 2
  ), s as (
    select m.tenant_id, mt.name as nazwa, count(*) as ile, min(m.occurred_at) as od, max(m.occurred_at) as do_
      from metric_events m join metrics mt on mt.tenant_id = m.tenant_id and mt.id = m.metric_id
     group by 1, 2
  )
  select count(*) into rozjazd from ((select * from z except select * from s) union all (select * from s except select * from z)) r;

  if skopiowane <> zrodlo or strumien <> zrodlo or bez_lustra <> 0 or rozjazd <> 0 then
    raise exception '0031: rozjazd backfillu - events %, skopiowane %, w strumieniu %, bez lustra %, rozjazd licznosci/dat % grup',
      zrodlo, skopiowane, strumien, bez_lustra, rozjazd;
  end if;
  raise notice '0031: skopiowano % zdarzen z events do metric_events (odczyt zwrotny zgodny)', skopiowane;
end $$;
