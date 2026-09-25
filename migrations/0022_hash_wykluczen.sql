-- Hasz adresu na globalnej liscie wykluczen (audyt 24.09, #10 RODO).
--
-- Anonimizacja profilu (art. 17) musi zdjac adres e-mail z KAZDEGO miejsca w bazie,
-- takze z globalnej listy odbic i skarg. Ale ta lista chroni wspolna pule reputacji
-- wszystkich klientow agencji: gdyby wpis zniknal, osoba wracajaca z nowa zgoda
-- dostalaby maila na adres, ktory juz raz odbil albo zglosil spam.
--
-- Rozstrzygniecie: wpis zostaje, ale bez adresu. Kolumna `email_hash` trzyma
-- HMAC-SHA256 znormalizowanego adresu (lower/btrim) z kluczem pochodnym od
-- SECRETS_KEY (src/adapters/hash-adresu.ts). Przy anonimizacji `email` zamienia sie
-- na zaslepke `anonimizowano:<16 znakow hasza>` (unikalnosc po lower(btrim(email))
-- zachowana), a `email_hash` zostaje. Bramka wysylki (canSendTo) sprawdza ALBO
-- adres, ALBO hasz - wiersze bez hasza (sprzed tej migracji, nowe odbicia) dalej
-- dzialaja po adresie. Hasz jest kluczowany, wiec zrzut bazy nie pozwala go
-- odwrocic slownikiem adresow.
--
-- Wypelnienie dla istniejacych wierszy wymaga klucza z konfiguracji, wiec robi je
-- skrypt `scripts/uzupelnij-hash-wykluczen.ts`, nie SQL.

alter table suppressions add column email_hash text;

create index suppressions_email_hash_idx on suppressions (email_hash) where email_hash is not null;
