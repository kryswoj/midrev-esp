-- Token pixela otwarc, wyprowadzony z click_token kolumna generowana.
--
-- Problem, ktory to rozwiazuje: pixel otwarc i redirect klikniec sa OSIAGALNE Z SIECI BEZ
-- SESJI, bo klika je odbiorca maila. Gdyby pixel niosl ten sam token co redirect, kazdy,
-- kto zobaczy adres pixela - a widzi go proxy obrazkow Gmaila, skaner bramki pocztowej
-- i kazdy posrednik po drodze - moglby z niego zlozyc adres /r/<token>?l=0 i wstrzyknac
-- klikniecie do ATRYBUCJI PRZYCHODU (0007). Pixel jest z natury bardziej wystawiony niz
-- redirect: pobiera go maszyna, zanim czlowiek cokolwiek zrobi.
--
-- Dlatego pixel dostaje wlasny token, ktorego nie da sie odwrocic do click_token.
--
-- Dlaczego kolumna GENEROWANA, a nie zwykla kolumna wypelniana przy budowie wiadomosci:
--   1. nie da sie jej zapomniec wypelnic ani rozjechac z click_token - baza liczy ja sama,
--      takze dla wiadomosci sprzed tej migracji,
--   2. nie trzeba dotykac sciezki wysylki, zeby token zaczal istniec,
--   3. sha256 jest funkcja IMMUTABLE i wbudowana (PG11+), wiec nie wnosi zaleznosci od
--      rozszerzenia ani od strefy czasowej. Tekst na bajty idzie rzutowaniem `::bytea`,
--      a nie `convert_to(..., 'UTF8')`: to drugie jest STABLE (zalezy od kodowania
--      polaczenia) i Postgres odmawia uzycia go w kolumnie generowanej. Token sklada sie
--      wylacznie ze znakow base64url, wiec obie drogi daja te same bajty.
--
-- Prefiks 'otwarcie:' jest domenowym rozdzielnikiem przestrzeni tokenow: gdyby kiedys
-- powstal trzeci kanal (np. pixel potwierdzenia), dostanie wlasny prefiks i jego token
-- nie zderzy sie z tymi dwoma. Prefiks NIE jest sekretem i nie udaje nim byc - cala sila
-- tokena siedzi w losowosci click_token (18 bajtow z CSPRNG), a sha256 sluzy wylacznie
-- do tego, zeby z jednego adresu nie dalo sie wyprowadzic drugiego.
alter table messages
  add column open_token text
    generated always as (encode(sha256(('otwarcie:' || click_token)::bytea), 'hex')) stored;

-- Unikalny, bo click_token jest unikalny, a sha256 nie ma tu kolizji. Indeks jest jedyna
-- droga wyszukiwania przy kazdym pobraniu pixela - bez niego trasa robilaby seq scan po
-- najwiekszej tabeli systemu przy kazdym otwarciu maila.
create unique index messages_open_token_idx on messages (open_token);
