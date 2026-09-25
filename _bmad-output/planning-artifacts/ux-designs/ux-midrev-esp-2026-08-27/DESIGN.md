---
name: midrev-esp
type: design-spine
status: final
created: '2026-08-27'
updated: '2026-09-23'
kierunek: dzien
colors:
  plotno: '#F6F7F9'
  powierzchnia: '#FFFFFF'
  powierzchnia-2: '#F4F5F7'
  linia: '#E3E6EA'
  tekst: '#16181D'
  tekst-2: '#5B616B'
  tekst-3: '#868D97'
  akcent: '#814AC8'
  akcent-jasny: '#DF7AFE'
  niebieski: '#0099FF'
  ok: '#14795D'
  uwaga: '#98620B'
  blad: '#B52A24'
typography:
  rodzina: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
  baza: 14
  skala: [12, 13, 14, 15, 17, 22, 26, 28]
  liczby: 'Inter z tabular-nums'
rounded:
  klawisz: 5
  kontrolka: 8
  karta: 10
spacing:
  baza: 4
  kroki: [4, 8, 12, 16, 24, 32]
  sekcja: 20
components:
  wiersz-tabeli: 52
  kontrolka: 38
  nawigacja-szerokosc: 264
---

# DESIGN.md: MidRev ESP, kierunek „Dzień”

## Charakter produktu

Panel ma wyglądać jak dojrzałe narzędzie ESP dla operatora agencji i klienta sklepu.
Punktem odniesienia jest Klaviyo: jasne płótno, płaskie białe powierzchnie, duży tytuł
strony, spokojna nawigacja, czytelne tabele i jedna wyraźna akcja na sekcję. Fiolet
MidRev oznacza akcję albo aktywność, nie dekorację.

Interfejs jest rzeczowy. Nie pokazuje surowych enumów, identyfikatorów ani bloków
technicznego wyjaśnienia na pierwszym planie. Statusy są po polsku. Kontrolka pojawia
się tylko wtedy, gdy ma działającą logikę.

## Tokeny

### Kolor

| Rola | Token | Zastosowanie |
|---|---|---|
| Płótno | `#F6F7F9` | tło obszaru roboczego |
| Powierzchnia | `#FFFFFF` | karta, tabela, panel nawigacji |
| Powierzchnia wtórna | `#F4F5F7` | hover, tło neutralne, pola pomocnicze |
| Linia | `#E3E6EA` | obrys karty i separatory |
| Tekst | `#16181D` | tytuły, wartości i ważne treści |
| Tekst wtórny | `#5B616B` | opisy i metadane |
| Tekst trzeciego planu | `#868D97` | dane pomocnicze |
| Akcent | `#814AC8` | przycisk główny, ikona aktywnej pozycji, link |
| Marka dodatkowa | `#DF7AFE`, `#0099FF` | ograniczone użycie w grafice i wyróżnieniu |
| Stan dobry | `#14795D` | działające, wysłane, zgodne |
| Stan uwagi | `#98620B` | oczekiwanie albo praca w toku |
| Stan błędu | `#B52A24` | blokada, błąd i akcja nieodwracalna |

Tła statusów są bardzo jasne. Kolor nie może dominować nad treścią.

### Skala typograficzna i siatka odstępów

Fontem produktu jest Inter. Jedyna skala interfejsu to:

| Rola | Rozmiar / interlinia | Waga | Tracking |
|---|---:|---:|---:|
| Tytuł strony | 26/34 px, telefon 22/29 px | 650 | -0.02em |
| Liczba metryki hero | 28/36 px, telefon 26/34 px | 600 | -0.02em |
| Liczba sekcyjna | 22/30 px | 600 | -0.02em |
| Tytuł karty | 17/24 px | 650 | -0.01em |
| Tytuł sekcji | 15/22 px | 600 | -0.006em |
| Tekst bazowy i liczba tabeli | 14/20 px | 400; liczba 550 | 0 |
| Etykieta metryki, pola i tekst pomocniczy | 13/18-19 px | 500 | 0 |
| Nagłówek kolumny i metadane | 12/16 px | 600 i 400 | 0 |

Nie wprowadzamy rozmiarów pośrednich. Kwoty, daty i liczniki używają `tabular-nums`.
Monospace wolno stosować wyłącznie do identyfikatorów technicznych, sekretów i skrótów
klawiszowych. Identyfikator techniczny pozostaje schowany w elemencie rozwijanym.

Siatka odstępów to 4 / 8 / 12 / 16 / 24 / 32 px. Wartość 20 px jest świadomym
odstępem wewnętrznym: pion nagłówka karty i oddech sekcji w karcie. Karta ma 24 px
paddingu na desktopie i 16 px na telefonie; odstęp między kartami wynosi odpowiednio
24 i 16 px. Nagłówek karty ma 20 px w pionie i 24 px w poziomie. Tytuł od opisu dzielą
4 px. Formularze ustawień mają 280 px na opis po lewej i pola po prawej, z odstępem
32 px; na telefonie przechodzą w jedną kolumnę z odstępem 16 px.

### Odstępy, promienie i cienie

Kontrolka ma 38 px wysokości, mały przycisk 32 px, a wiersz tabeli 52-56 px. Karta ma
promień 10 px, obrys 1 px i prawie niewidoczny cień `--cien-karta`. Cień uniesiony
jest zarezerwowany dla menu, podpowiedzi i modali.

## Szkielet aplikacji

Desktop ma lewą nawigację szerokości 264 px. Blok marki ma znak 30 px oraz nazwę
15/650; przełącznik sklepu pozostaje od niego optycznie lżejszy (nazwa 14/600,
bez stałego podpisu typu konta). Tekst pozycji ma 14 px i wagę 500, każda pozycja
ma 36 px wysokości, a ikona 18 px oraz stroke 1.75. Aktywna pozycja ma bardzo jasne neutralne tło
`#F4F4F5`, prawie czarny tekst o wadze 650, fioletową ikonę i zaokrąglony pionowy
pasek akcentu o szerokości 3 px. Liczniki są numerami 12 px z `tabular-nums`,
wyrównanymi do jednej prawej kolumny, bez kapsułki.

Wybór sklepu ma charakter przełącznika kontekstu, nie pola formularza: inicjał sklepu
w jasnofioletowym kwadracie, nazwa 14/600 i subtelny chevron.
Cały wiersz reaguje tłem na hover, a działający natywny `select` leży nad nim jako
przezroczysta kontrolka z dostępną etykietą.

Telefon ma dwa rzędy o łącznej wysokości około 104 px. Pierwszy zawiera markę i ten
sam działający przełącznik sklepu.
Drugi pokazuje trzy główne zakładki: Przegląd, Kampanie i Profile oraz działające
`details` „Więcej” z prawdziwymi linkami do pozostałych modułów. Automatyzacje są
pierwszą pozycją w „Więcej”. Pełne etykiety nie są ucinane ani przewijane poziomo.
Cele dotykowe mają co najmniej 44 px. Aktywna pozycja używa ciemniejszej typografii
i fioletowego znacznika przy dolnej krawędzi; pasek nie sugeruje ukrytych pozycji
przez przypadkowe ucięcie poziomego przewijania.

Layout jest jedynym właścicielem poziomego paddingu treści: 16 px na telefonie i 32 px
od `md`. `PageHeader`, `.tresc-strony` i pojedyncze ekrany nie dodają drugiego paddingu.
Dzięki temu tytuł strony i karty zawsze zaczynają się na tej samej osi.

## Biblioteka `src/app/ui`

- `PageHeader` buduje tytuł, opis, powrót, oznaczenie i prawdziwe akcje strony.
- `Card`, `CardHeader`, `CardBody`, `CardFooter` budują podstawową powierzchnię sekcji.
- `Table`, `THead`, `TBody`, `Th`, `Td` służą do tabel desktopowych.
- `ResponsiveTable` łączy pełną tabelę desktopową z priorytetyzowaną listą mobilną.
- `MobileList` i `MobileListItem` udostępniają wspólną strukturę listy mobilnej.
- `Stat` i `StatGrid` prezentują liczby. Na telefonie cztery metryki układają się 2 na 2.
- `Badge` prezentuje status słowem i kształtem.
- `Button` obsługuje akcję główną, wtórną, niebezpieczną i stan zablokowany z powodem.
- `Field`, `Input`, `Select`, `Textarea` zapewniają wspólne pola i komunikaty.
- `EmptyState` pokazuje ikonę, krótkie wyjaśnienie i najwyżej jedną akcję.
- `Alert` służy do krótkiej informacji wymagającej reakcji.
- `Tabs` zawiera wyłącznie linki do istniejących tras.
- `Icon` jest jedyną mapą ikon Lucide używanych w panelu.

## Kontrakt klas CSS

Poniższych klas nie wolno usuwać ani zmieniać ich znaczenia. Wszystkie definicje
pozostają wewnątrz `@layer components`:

`karta`, `karta-naglowek`, `karta-naglowek-licznik`, `karta-opis`, `karta-stopka`,
`karta-plaska`, `przycisk`, `przycisk-wtorny`, `przycisk-niebezpieczny`,
`przycisk-maly`, `pole`, `etykieta`, `tabela`, `plakietka`, `plakietka-ok`,
`plakietka-uwaga`, `plakietka-blad`, `plakietka-szkic`, `plakietka-nieaktywna`,
`liczba`, `wielkosc`, `wielkosc-hero`, `wielkosc-brak`, `pusty-stan`,
`pusty-stan-w-tabeli`, `krok`, `krok-znacznik`, `krok-zrobiony`, `krok-tytul`,
`krok-opis`, `siatka-wloskiem`, `pasek-stanu`, `wiersz-link`, `wiersz-link-cel`,
`nawigacja-pozycja`, `nawigacja-licznik`, `klawisz`.

## Wzorce ekranów

### Nagłówek strony

Nagłówek zawiera duży tytuł, opcjonalny krótki podtytuł i akcję po prawej. Dłuższe
wyjaśnienie trafia pod ikonę informacji. Nie dodajemy atrap wyszukiwania, zakresu dat,
powiadomień ani menu użytkownika.

### Karta

Karta grupuje jeden temat. Nagłówek ma tytuł, maksymalnie jedno zdanie opisu i akcję
albo licznik. Tytuł i opis dzielą 4 px, a akcja jest wyśrodkowana względem całego
bloku tytułu z opisem. Na telefonie prawdziwa akcja karty schodzi pod opis i przyjmuje
postać małego fioletowego linku ze strzałką, dzięki czemu nie ściska tytułu. Karty są
płaskie, precyzyjnie obrysowane i nie konkurują cieniem.

### Builder automatyzacji

Formularz automatyzacji jest pojedynczą pionową ścieżką o maksymalnej szerokości
około 760 px. Cztery akcentowe koła 28 px połączone ciągłą linią prowadzą przez: Podstawy,
Wyzwalacz, Opóźnienie i Wiadomość. Każdy krok ma krótki opis oraz wyłącznie pola
potrzebne na tym etapie; główna akcja zapisu występuje raz, pod ostatnim krokiem.
Kafle szablonów mają jednakową wysokość, ikonę 36 px oraz akcję wyrównaną do dolnej
krawędzi.

### Segmenty

Reguła na liście segmentów jest tokenem: ikona filtra 12 px, tekst 13 px, neutralne
tło, cienki obrys i promień 6 px. Liczba profili ma 15/600 i wspólną prawą oś.
W kreatorze pojedynczy warunek jest białym blokiem z mocniejszym obrysem; nagłówek
„Warunek”, żeton „Osoba”, wybór reguły i jej wartość tworzą jeden czytelny układ.

### Tabela i lista mobilna

Tabela ma nagłówki 12/16 i 600 w kolorze `tekst-2`, wysokość nagłówka 40 px oraz
wiersze 52-56 px. Pierwsza kolumna ma wagę 500. Liczby mają 14/20, wagę 550,
główny kolor tekstu, `tabular-nums` i wspólną prawą oś z nagłówkiem. Hover używa
`powierzchnia-2`, a wiersz prowadzący do szczegółu pokazuje kursor.

Poniżej 768 px tabela nie jest ściskana ani ucinana. `ResponsiveTable` pokazuje osobną
listę. Element listy zawiera tytuł, jedną wartość wiodącą oraz najwyżej dwa pola
pomocnicze. Wyjątkiem jest tabela w rozwiniętym, administracyjnym szczególe, która może
przewijać się we własnym kontenerze.

### Pusty stan

Pusty stan ma jedną ikonę, zdanie opisujące stan oraz najwyżej jedną realną akcję.
Nie udaje tabeli i nie pokazuje niedziałających kontrolek.

### Status i NFR33

Status zawsze zawiera polskie słowo oraz rozróżnialny kształt. Kwadrat oznacza stan
dobry, trójkąt uwagę, pierścień błąd, a pusty kwadrat szkic albo stan nieaktywny.
Kolor jest wsparciem, nigdy jedynym nośnikiem znaczenia.

### Przycisk zablokowany

Zablokowany przycisk zawsze ma widoczny powód obok albo bezpośrednio pod nim. Sama
zmiana koloru i `disabled` nie wystarczają. Akcja nieodwracalna używa wariantu
niebezpiecznego dopiero wewnątrz sekcji, która jasno opisuje skutek.

### Onboarding

Nagłówek pokazuje cienki pasek postępu obok wyniku. Gdy większość kroków jest gotowa,
ukończone kroki składają się do jednego wiersza podsumowania. Otwarte kroki zachowują
opis, stan i działającą akcję. Na telefonie przycisk pozostaje pod opisem kroku.

### Alert

Alert jest krótki i proporcjonalny do problemu. Ikona i tytuł mówią, co się stało,
tekst podaje konsekwencję, a działająca akcja znajduje się po prawej albo pod treścią
na telefonie. Duży czerwony panel jest zarezerwowany dla aktywnego błędu, nie dla
samej obecności funkcji administracyjnej.

### Oś czasu profilu

Zdarzenie ma ikonę w białym kole 28 px z obrysem `linia`. Kolejne zdarzenia łączy
linia 1 px w tym samym kolorze. Na desktopie wiersz pokazuje tytuł, kwotę w stałej
kolumnie 112 px, datę i opis. Na telefonie widoczne są najpierw tytuł 14/600, kwota
bezpośrednio pod nim oraz data. Typ i detal zdarzenia są skrócone do jednej linii metadanych, bez
powtarzalnych rozwinięć „Szczegóły”. Dane profilu, listy i segmenty są jedną kartą,
domyślnie złożoną na telefonie. Jej nagłówek pokazuje jawne „Pokaż” oraz obracany
chevron, a awatar i nazwisko mają wspólną oś.

### Strefa niebezpieczna

Akcja nieodwracalna nie może wyglądać jak zwykły accordion. Jej zamknięta podsekcja
ma białe tło, czerwony obrys, ikonę ostrzegawczą, nazwę i jednozdaniowy skutek.
Treść rozwiniętej sekcji nadal pozostaje biała, aby strefa nie przytłaczała reszty
karty; czerwony jest tytuł 14/600, obrys i właściwy przycisk nieodwracalnej akcji.
Szczegóły oraz formularz potwierdzenia pozostają domyślnie złożone.
Zablokowany przycisk nadal pokazuje bezpośrednio obok powód blokady.

## Zasady stałe

- Nie przekazuj stanu samym kolorem.
- Nie używaj monospace dla kwot i dat.
- Nie pokazuj surowych enumów ani identyfikatorów na pierwszym planie.
- Nie twórz kontrolki bez danych lub logiki.
- Nie ściskaj tabeli desktopowej do szerokości telefonu.
- Nie zostawiaj zablokowanego przycisku bez widocznego powodu.
- Utrzymuj wspólną lewą oś tytułu strony i kart.
- Priorytetem ekranu startowego jest przychód, następnie działanie wymagające decyzji.
