-- Swiezosc zamowien ze zrodla (znalezisko review fazy 2 webhookow).
--
-- Kolejnosc dostarczania webhookow Woo nie jest gwarantowana: order.updated
-- z 'completed' moze dojsc PRZED zaleglym order.updated z 'pending'. occurred_at
-- to data ZLOZENIA zamowienia i nie rozstrzyga, ktory payload jest nowszy.
-- source_updated_at niesie date_modified_gmt ze zrodla; upsert nadpisuje wiersz
-- tylko wtedy, gdy przychodzacy payload nie jest starszy od zapisanego.
--
-- Null oznacza wiersze sprzed tej migracji (import historyczny bez znacznika):
-- traktowane jako "dowolnie stare", wiec kazdy webhook je nadpisze.

alter table orders add column source_updated_at timestamptz;
