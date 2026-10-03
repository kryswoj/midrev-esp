-- Builder formularzy zapisu jak w Klaviyo: typ (popup, wysuwany w rogu, osadzony), dowolna
-- liczba krokow z blokami, krok sukcesu, teaser, reguly wyswietlania, szkic i publikacja.
--
-- Numer 0043, nie 0042: 0042 jest zarezerwowany dla rownoleglej pracy nad delegacja NS
-- (domena platformowa). Migrator sortuje po nazwie pliku, wiec dziura w numeracji jest
-- bezpieczna, a 0042 wejdzie przed 0043 na kazdej bazie, ktora go jeszcze nie ma.
--
-- Model: popups dalej jest KONTENEREM formularza (id, tenant, nazwa, wlaczenie, lista,
-- biezaca wersja klauzuli z 0041). Tresc i zachowanie formularza to jeden dokument JSON:
--   draft       - wersja robocza z buildera (autozapis), nigdy nie trafia na strone sklepu,
--   definition  - wersja OPUBLIKOWANA; to ja skrypt /s/{tenant} pokazuje na stronie.
-- Publikacja kopiuje draft do definition w jednej transakcji z nadaniem wersji klauzuli
-- (0041), wiec dowod zgody to dalej dokladnie tekst wersji pokazanej przy polu wyboru.
-- Tekst klauzuli w JSON-ie jest tylko kopia robocza: skrypt bierze go z
-- popup_consent_versions, nie z definition.
--
-- Zgodnosc wsteczna (AD-46, expand): wszystkie nowe kolumny sa NULLABLE albo maja default.
-- Popup sprzed 0043 ma definition = null i jest renderowany przez nowy kod jako formularz
-- jednokrokowy zbudowany w locie ze starych kolumn (headline, body_text, button_text,
-- discount_code, rules.delay_seconds). Builder zapisuje go w nowym formacie dopiero przy
-- pierwszym zapisie operatora. Publikacja nowego formularza wypelnia tez stare kolumny
-- (naglowek, tresc, przycisk, kod, rules.delay_seconds), wiec stary kod po rollbacku dalej
-- pokaze sensowny, jednokrokowy popup z ta sama klauzula.

alter table popups
  add column form_type text not null default 'popup'
    check (form_type in ('popup', 'flyout', 'embed')),
  add column draft jsonb
    check (draft is null or (jsonb_typeof(draft) = 'object' and pg_column_size(draft) <= 262144)),
  add column definition jsonb
    check (definition is null or (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 262144)),
  -- licznik zapisow szkicu: optymistyczna wspolbieznosc autozapisu (dwie karty buildera)
  add column revision int not null default 1 check (revision >= 1),
  add column updated_at timestamptz,
  add column published_at timestamptz,
  -- formularza z wersjami klauzuli nie da sie usunac (dowod zgody, 0041); archiwum chowa go
  -- z listy i ze strony sklepu
  add column archived_at timestamptz;

-- Skrypt na strone pyta o wszystkie wlaczone, niezarchiwizowane formularze tenanta.
create index popups_na_strone_idx on popups (tenant_id, created_at desc)
  where active and archived_at is null;
