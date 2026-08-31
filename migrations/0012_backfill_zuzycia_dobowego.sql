-- Backfill licznika dobowego (znalezisko z review 0011): tenant_send_usage startowalo
-- puste, wiec instancja z wysylkami wykonanymi DZISIAJ przed migracja dostalaby caly
-- limit od nowa i mogla wyslac go drugi raz. Zasiewamy biezacy dzien z faktycznych
-- zdarzen 'sent'; greatest() zamiast nadpisania, bo miedzy 0011 a 0012 rezerwacje
-- mogly juz przyrastac i wiekszy z licznikow jest tym bezpieczniejszym (konserwatywnym).
insert into tenant_send_usage (tenant_id, day, used)
select e.tenant_id, current_date, count(*)::int
  from message_events e
 where e.event_type = 'sent' and e.occurred_at >= date_trunc('day', now())
 group by e.tenant_id
on conflict (tenant_id, day) do update
  set used = greatest(tenant_send_usage.used, excluded.used);
