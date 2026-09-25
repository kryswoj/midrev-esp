-- Runda 2 review automatyzacji.
--
-- 1. journeys.draft_version: licznik wersji szkicu wiadomosci (temat, nazwa, tresc). Publikacja
--    automatyzacji porownuje wersje grafu I wersje kazdej wiadomosci z tym, co operator mial
--    na ekranie: bez tego "Opublikuj" wypuszczalo tresc zmieniona w innej karcie, ktorej
--    publikujacy nie widzial. Zapis wiadomosci z nieaktualna wersja jest odrzucany.
-- 2. list_members.source: domyslna wartosc 'reczny' (0004) sprawiala, ze kazdy przyszly zapis
--    bez jawnego zrodla udawal dodanie reczne i odpalal automatyzacje "dolaczenie do listy".
--    Nowa domyslna 'nieznane' nie odpala zadnej automatyzacji (filtr wejscia przepuszcza tylko
--    jawne zrodla pojedyncze: reczny, formularz, popup). Istniejacych wierszy nie ruszamy:
--    ich wejscie i tak ogranicza granica active_since i okno skanu.
-- 3. Uwaga do 0025 (4b): 0025 ustawila updated_at = created_at dla wierszy zmigrowanych przez
--    0019. Nie cofamy tego. Dotyczy wylacznie srodowisk, na ktorych 0019 byla juz wykonana;
--    poza sandboxem developerskim takich nie ma (0019 i 0025 nie byly wdrozone na produkcji).

alter table journeys add column draft_version int not null default 1;

alter table list_members alter column source set default 'nieznane';
