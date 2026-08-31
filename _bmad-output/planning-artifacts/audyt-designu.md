# Audyt designu: midrev-esp

Data: 2026-08-27
Zakres: zrzuty `przeglad`, `kampania` (2880x1800 i 2880x1640, viewport 1440 CSS px, DPR 2)
oraz kod: `src/app/globals.css`, `src/app/layout.tsx`, `src/app/t/[tenantId]/**`.
Zrzuty `segmenty.png` i `zgody.png` to Next.js 404, nie panel. Te dwa ekrany oceniam z kodu.

Poziom odniesienia: Linear, Attio, Stripe Dashboard, Vercel, Height, Raycast.

---

## Werdykt

Panel jest poprawnie zbudowany logicznie i całkowicie nieukończony wizualnie. To nie jest
"średni design", to brak systemu: siedem różnych paddingów poziomych, pięć promieni, dwie
niezdefiniowane zmienne CSS renderujące się jako błąd, nagłówki kart mniejsze od treści kart,
zero stanu aktywnego w nawigacji i zero nawigacji na telefonie. Warstwa dekoracyjna (szkło,
gradienty, cienie) jest dopracowana bardziej niż warstwa funkcjonalna, co jest dokładną
odwrotnością tego, co robią narzędzia z poziomu odniesienia.

Kierunek "biel, szkło z rozmyciem, iOS-owy niebieski" idzie do kosza. Nie dlatego, że jest
brzydki, tylko dlatego, że jest kosztowny i nic nie kupuje: `backdrop-filter: blur(24px)`
na siedmiu kartach jednocześnie, nałożony na białe tło z kartami o kryciu 0.72, daje efekt
niewidoczny gołym okiem i siedem osobnych warstw kompozycji przemalowywanych przy każdym
przewinięciu. Na telefonie właściciela sklepu to jest różnica między płynnością a szarpaniem.
Kierunek "jasny, neutralny, gęsty, Inter" zostaje.

---

## Kierunek wizualny: co zostaje, co wypada

### Wypada

| Element | Powód |
|---|---|
| `backdrop-filter: blur(24px) saturate(180%)` na `.karta` | Niewidoczny na białym tle, kosztowny w kompozycji, x7 na ekran |
| Trzy radialne gradienty w `body` (niebieski, fioletowy, turkusowy) | Widoczne jako fioletowa poświata w prawym dolnym rogu `kampania.png`, na pustym obszarze czyta się jak artefakt renderowania |
| `background-attachment: fixed` | Zepsute i kosztowne w iOS Safari, a właściciel sklepu wchodzi z telefonu |
| `box-shadow: 0 12px 32px -18px` na kartach | Cień marketingowej karty na landingu, nie powierzchni w narzędziu. Karta, która nie unosi się nad niczym, nie rzuca cienia |
| `border-radius: 980px` na przyciskach | Pigułka to iOS. Linear, Attio, Vercel, Stripe: wszyscy mają 6 px |
| `#0071e3` jako akcent | To dosłownie systemowy niebieski Apple. Czyta się jako aplikacja iOS, nie narzędzie |
| `"SF Pro Text"` w stosie fallbacku | Na Macu podstawia się przed załadowaniem Intera i wzmacnia ten sam odczyt iOS. `next/font` i tak robi size-adjusted fallback, więc ten wpis nic nie wnosi |

### Zostaje

Biała podstawa, Inter, semantyka kolorów stanu (zielony/pomarańcz/czerwień), zasada
"stan nigdy samym kolorem" z NFR33, tabularne cyfry, `prefers-reduced-motion`.

---

## Nowy system

### Kolor

Reguła: kolor niesie znaczenie albo go nie ma. Tło jest neutralne i nieruchome.
Akcent pojawia się w trzech miejscach i nigdzie indziej: aktywna pozycja nawigacji,
link, pierścień fokusu. Główny przycisk jest prawie czarny, jak u Vercela i Attio,
bo to zdejmuje z niebieskiego obowiązek bycia jednocześnie akcją i nawigacją.

```css
@theme {
  /* Powierzchnie: nieprzezroczyste, bez rozmycia */
  --color-canvas:      #FBFBFC;  /* tło aplikacji */
  --color-surface:     #FFFFFF;  /* karty, tabele */
  --color-sunken:      #F4F5F7;  /* nagłówki tabel, pola, skeletony */
  --color-hover:       #F7F8F9;  /* hover wiersza i karty */
  --color-line:        #E7E8EC;  /* włos: krawędzie kart, wiersze tabel */
  --color-line-strong: #D6D8DE;  /* krawędzie pól, dzielniki wyższego rzędu */

  /* Tekst: trzy poziomy, nie cztery */
  --color-ink:         #16181D;  /* treść, wartości, nagłówki */
  --color-muted:       #5C616B;  /* opisy, metadane w wierszu */
  --color-faint:       #8A8F99;  /* etykiety kolumn, sekcje nawigacji, timestampy */

  /* Akcent: link, aktywna nawigacja, fokus. Nic więcej */
  --color-accent:      #2F6FEB;  /* 4.6:1 na bieli, przechodzi dla tekstu 13 px */
  --color-accent-weak: #EEF1FD;  /* tło aktywnej pozycji nawigacji, zaznaczony wiersz */
  --color-focus:       rgb(47 111 235 / 0.20);

  /* Akcja główna: prawie czarny */
  --color-action:      #16181D;
  --color-action-hover:#2A2D35;

  /* Stan */
  --color-ok:          #16794A;
  --color-ok-bg:       #E9F5EE;
  --color-warn:        #A25B00;
  --color-warn-bg:     #FBF1E3;
  --color-danger:      #C4291C;
  --color-danger-bg:   #FBECEA;
}
```

Ciemny motyw: obecnie jest zdefiniowany wyłącznie w `@media (prefers-color-scheme: dark)`
pod strażą `:root:not([data-theme="light"])`, a bloku `:root[data-theme="dark"]` nie ma
w ogóle. Skutek: użytkownik z jasnym systemem nie ma jak włączyć ciemnego, nawet gdyby
dodać przełącznik. Dopisz trzeci blok z tymi samymi tokenami i przełącznik w stopce
nawigacji.

### Typografia

Podstawa spada z 15 px na 13 px dla gęstych powierzchni (tabele, nawigacja, plakietki)
i 14 px dla prozy. Największy błąd do naprawienia od razu: globalny `letter-spacing: -0.01em`
na 15 px i `-0.021em` na wszystkich `h1, h2, h3`, łącznie z nagłówkami kart o rozmiarze
14 px. Inter dostaje ujemny tracking dopiero powyżej 20 px. Poniżej tej granicy ujemny
tracking zbija polskie znaki diakrytyczne (ogonki w ą i ę wchodzą pod sąsiednią literę).

```css
/* Skala. Rozmiar / interlinia / waga / tracking */
--t-label:   11px / 16px / 500 / +0.045em / uppercase   /* etykiety kolumn, sekcje nawigacji */
--t-meta:    12px / 17px / 400 /  0                     /* e-mail pod nazwiskiem, timestamp */
--t-body:    13px / 20px / 400 /  0                     /* tabele, nawigacja, plakietki */
--t-prose:   14px / 21px / 400 /  0                     /* opisy, akapity wyjaśniające */
--t-card:    15px / 20px / 600 / -0.006em               /* nagłówek karty */
--t-page:    20px / 26px / 600 / -0.014em               /* H1 strony */
--t-metric:  28px / 30px / 600 / -0.022em               /* JEDNA metryka wiodąca na ekran */
--t-metric-s:18px / 22px / 600 / -0.010em               /* metryki w pasku */
```

Zdejmij `letter-spacing` z `body` i z reguły `h1, h2, h3`. Ustaw tracking punktowo,
tylko na `--t-card` i wyżej.

Drugi krój: monospace wyłącznie dla identyfikatorów (numery zamówień, id kampanii).
Zero pobrań, stos systemowy wystarczy:
`--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace`, 12 px,
kolor `--color-faint`. `#63` renderowany 15-px Interem obok e-maila wygląda jak treść,
a to jest identyfikator.

Opcjonalnie: jeśli `next/font/google` serwuje Inter v4 z osią `opsz`, dopisz
`font-optical-sizing: auto`. Wtedy 11-px etykiety i 28-px liczby dostają poprawne
traktowanie optyczne automatycznie. Sprawdź w devtoolsach, czy oś jest dostępna,
zanim to wstawisz.

### Przestrzeń

Obecnie w kodzie żyje siedem różnych paddingów poziomych: `px-1`, `px-1.5`, `px-3.5`,
`px-4` (10 wystąpień), `px-5` (5), `px-6` (4), `px-7` (12). Cztery z nich, 16/20/24/28 px,
robią dokładnie tę samą robotę w różnych miejscach. To nie jest system, to jest historia
edycji.

Baza 4 px, dozwolone kroki: 4, 8, 12, 16, 24, 32, 48. Reszta nie istnieje.

| Zastosowanie | Wartość | Klasa |
|---|---|---|
| Rynna strony (lewa i prawa) | 24 px | `px-6` |
| Odstęp pionowy między blokami | 24 px | `gap-6` / `py-6` |
| Odstęp między kartami w siatce | 12 px | `gap-3` |
| Padding karty | 16 px | `p-4` |
| Padding nagłówka karty | 12 px 16 px | `px-4 py-3` |
| Komórka tabeli | 0 12 px, wysokość wiersza 36 px | `px-3 h-9` |
| Padding pozycji nawigacji | 0 8 px, wysokość 30 px | `px-2 h-[30px]` |

Usuń `px-5` i `px-7` z całego drzewa. `src/app/t/[tenantId]/sklepy/page.tsx` używa `px-6`,
gdy wszystkie pozostałe strony używają `px-7`. Ta jedna strona ma treść przesuniętą
o 4 px względem reszty i to widać przy przełączaniu zakładek.

### Promienie i cienie

Trzy promienie, nie pięć:

- **6 px**: przyciski, pola, plakietki, pozycje nawigacji, skeletony
- **10 px**: karty, sekcje, panele
- **999 px**: wyłącznie awatary i kropki stanu

Cień tylko na tym, co faktycznie unosi się nad treścią (menu, modal, toast, paleta poleceń):

```css
--shadow-overlay: 0 4px 12px rgb(16 18 29 / 0.08), 0 1px 2px rgb(16 18 29 / 0.06);
```

Karty dostają `border: 1px solid var(--color-line)` i zero cienia.

---

## Poprawki, od najważniejszej

### P1. Brak stanu aktywnego w nawigacji

**Co jest źle.** `.nawigacja-pozycja` ma wyłącznie `:hover`. Na zrzucie `przeglad.png`
użytkownik jest na "Przegląd", a ta pozycja wygląda identycznie jak "Sklepy" i "Profile":
ten sam `--color-muted` (#6b7280), ta sama waga, to samo tło. Dziewięć pozycji nawigacji
w jednym odcieniu szarości.

**Dlaczego to psuje odbiór.** Użytkownik traci orientację przy każdym wejściu.
W narzędziu, w którym siedzi się godzinami i przełącza między dziewięcioma widokami
i kilkoma klientami, to jest najdroższa pojedyncza usterka. Żadne narzędzie z listy
odniesienia nie ma nawigacji bez stanu aktywnego.

**Zmiana.** Wydziel `<PozycjaNawigacji>` jako komponent kliencki, użyj `usePathname()`,
porównuj dokładnie dla `href === ""` i przez `startsWith` dla reszty. Ustaw `aria-current="page"`.

```css
.nawigacja-pozycja {
  display: flex; align-items: center; gap: 8px;
  height: 30px; padding: 0 8px; border-radius: 6px;
  font-size: 13px; line-height: 20px; font-weight: 400;
  color: var(--color-muted);
  transition: background 120ms ease-out, color 120ms ease-out;
}
.nawigacja-pozycja:hover { background: var(--color-hover); color: var(--color-ink); }
.nawigacja-pozycja[aria-current="page"] {
  background: var(--color-accent-weak);
  color: var(--color-accent);
  font-weight: 500;
}
.nawigacja-pozycja:focus-visible {
  outline: 2px solid var(--color-accent); outline-offset: 1px;
}
```

Dołóż ikony 16 px (Lucide, stroke 1.75, `opacity: 0.75`, przy stanie aktywnym `opacity: 1`).
Dziewięć pozycji bez ikon to ściana tekstu, a skanowanie jej kosztuje takt przy każdym
spojrzeniu. Sugerowane: Przegląd `layout-dashboard`, Sklepy `store`, Profile `users`,
Zamówienia `receipt`, Zgodność danych `shield-check`, Kampanie `send`, Segmenty `filter`,
Listy `list`, Zgody i wykluczenia `ban`.

---

### P2. Dwie niezdefiniowane zmienne CSS renderują się jako błąd

**Co jest źle.** Kod używa `--color-link` i `--color-subtle`, a `globals.css` nie definiuje
żadnej z nich.

- `src/app/t/[tenantId]/page.tsx`: link "wszystkie" ma `text-[var(--color-link)]`.
  Zmienna nie istnieje, więc kolor jest nieprawidłowy i dziedziczy `--color-ink`.
  Na zrzucie ten link jest czarny, nieodróżnialny od nagłówka obok.
- `src/app/t/[tenantId]/przelacznik.tsx`: etykieta "KLIENT" ma `text-[var(--color-subtle)]`.
  Efekt ten sam: dziedziczy `--color-ink` i jest ciemniejsza niż "DANE" i "MARKETING",
  które używają `.etykieta` z `--color-faint` (#9aa1ac). Widać to na zrzucie: "KLIENT"
  wybija się mocniej niż nagłówki sekcji, choć jest tym samym poziomem hierarchii.

**Dlaczego to psuje odbiór.** Jedyny link nawigacyjny na ekranie przeglądu nie wygląda
jak link. Nikt go nie kliknie. Plus przypadkowa hierarchia w nawigacji.

**Zmiana.** Usuń obie zmienne z kodu. Link: `text-[13px] text-[var(--color-accent)]
hover:underline underline-offset-2`. Etykieta "KLIENT": po prostu klasa `.etykieta`,
tak jak "DANE" i "MARKETING".

Dorzuć do CI regułę: grep na `var(--color-` w `src/app/**/*.tsx` przeciw liście
zdefiniowanej w `globals.css`, twarde `exit 1` na różnicy. To dwuwierszowy skrypt,
a zapobiega dokładnie tej klasie cichych błędów.

---

### P3. Gęstość: siedem kafelków 28-px zjada cały pierwszy ekran

**Co jest źle.** Przegląd otwiera się siedmioma kartami metryk, każda z `.wielkosc`
(28 px / 600). Wszystkie mają identyczną wagę wizualną. Zajmują ~360 CSS px wysokości,
plus nagłówek 118 px, czyli 478 px z 900 px widoku, zanim pojawi się pierwszy wiersz
danych. Tabela zamówień, czyli jedyna rzecz, na którą operator naprawdę patrzy, zaczyna
się poniżej połowy ekranu.

Do tego trzy z tych siedmiu nie są metrykami:
- "Historia: 23 lip 2025" to metadana zakresu danych, nie liczba do śledzenia.
- "Segmenty 4", "Kampanie 3", "Zgody na e-mail 5" to liczniki nawigacyjne. 28-px cyfra
  "3" komunikuje "to jest kluczowy wskaźnik biznesowy", a to jest liczba wierszy w tabeli
  obok.

**Dlaczego to psuje odbiór.** Gdy siedem rzeczy krzyczy z tą samą siłą, nie krzyczy żadna.
To jest gęstość landinga, a nie narzędzia, w którym siedzi się osiem godzin. Stripe
Dashboard otwiera się wykresem, nie siatką liczników.

**Zmiana.** Jedna metryka wiodąca plus jeden pasek.

1. **Karta wiodąca** (pełna szerokość kolumny głównej, wysokość 140 px):
   Przychód, 28 px / 600, obok delta vs poprzedni okres (`+12,4%`, 13 px / 500,
   `--color-ok` lub `--color-danger`), pod spodem sparkline 100 px x 32 px,
   w prawym górnym rogu segmentowany przełącznik okresu `7 d / 30 d / 90 d / rok`
   (wysokość 28 px, tło `--color-sunken`, aktywny segment `--color-surface` z cieniem
   `0 1px 2px rgb(16 18 29 / 0.06)`). Dziś "6061,00 PLN" nie ma podanego okresu,
   więc jest liczbą bez znaczenia.
2. **Pasek metryk**: jedna karta, cztery kolumny rozdzielone `border-left: 1px solid
   var(--color-line)`, padding `16px 20px`. Etykieta `--t-label`, wartość `--t-metric-s`
   (18 px / 600). Zero osobnych kart, zero osobnych krawędzi.
3. "Historia" schodzi pod pasek jako podpis 12 px `--color-faint`: `Dane od 23 lip 2025`.
4. Liczniki segmentów, kampanii i zgód idą do nawigacji bocznej jako plakietka po prawej
   stronie pozycji (11 px, `--color-faint`, tak jak Linear pokazuje liczby przy widokach).

Odzysk: około 300 CSS px pionu. Tabela zamówień wchodzi nad zgięcie.

---

### P4. Wiersze tabeli o 36% za wysokie, nagłówki kart mniejsze od treści

**Co jest źle.**

- `.tabela td { padding: 0.7rem 1rem }` przy interlinii 22.5 px daje wiersz ~49 CSS px.
  Zmierzone na zrzucie: 68 px obrazu / 1.389 = 49 px. Linear i Attio: 32 do 36 px.
  W 400 px pionu mieści się 8 wierszy zamiast 11.
- `.tabela th` ma `font-weight: 500` przy 11 px uppercase, ale kolor `--color-faint`
  (#9aa1ac) na bieli daje kontrast 2.6:1. Poniżej progu 4.5:1 nawet dla tekstu
  pomocniczego etykiety kolumn powinny być czytelne. To jest błąd dostępności,
  nie stylizacja.
- Nagłówki kart (`h2`) mają `text-sm`, czyli 14 px, a treść tabeli 15 px. Tytuł sekcji
  "Ostatnie zamówienia" jest mniejszy od adresów e-mail pod nim. Odwrócona hierarchia,
  widoczna na zrzucie gołym okiem.
- Kolumna STATUS: pigułki o zmiennej szerokości, wyrównane do lewej, dają postrzępioną
  krawędź prawą. Przy ośmiu wierszach wygląda to jak niedokończony układ.

**Dlaczego to psuje odbiór.** Rozstrzelona tabela z nieczytelnymi nagłówkami kolumn
i nagłówkiem sekcji mniejszym od danych to najbardziej amatorski element całego panelu,
a jednocześnie ten, na który operator patrzy najdłużej.

**Zmiana.**

```css
table.tabela { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 20px; }
.tabela th {
  height: 32px; padding: 0 12px;
  text-align: left; font-size: 11px; font-weight: 500;
  letter-spacing: 0.045em; text-transform: uppercase;
  color: #6E737D;                       /* 4.6:1 na bieli, zamiast #9aa1ac */
  background: var(--color-sunken);
  border-bottom: 1px solid var(--color-line);
}
.tabela td { height: 36px; padding: 0 12px; border-bottom: 1px solid var(--color-line); }
.tabela tbody tr:last-child td { border-bottom: 0; }
.tabela tbody tr:hover td { background: var(--color-hover); }
.tabela tbody tr:focus-within td { background: var(--color-accent-weak); }
```

Nagłówek karty: `font-size: 15px; font-weight: 600; letter-spacing: -0.006em;`
(zamień `text-sm font-semibold` na `text-[15px] font-semibold` we wszystkich `h2`
w `src/app/t/[tenantId]/**`).

Kolumna STATUS: stała szerokość `w-32` na `th` i `td`, plakietka wyrównana do lewej
wewnątrz tej szerokości. Wtedy prawa krawędź kolumny jest prosta.

Numery zamówień: `font-family: var(--font-mono); font-size: 12px; color: var(--color-faint)`.

---

### P5. Zero nawigacji na telefonie

**Co jest źle.** `src/app/t/[tenantId]/layout.tsx`, linia z `<aside>`:
`className="... hidden ... md:block"`. Poniżej 768 px nawigacja znika i nic jej nie
zastępuje. Brak hamburgera, brak dolnego paska, brak przełącznika klienta. Właściciel
sklepu, drugi z dwóch zadeklarowanych typów użytkownika, wchodzący na trzy minuty
z telefonu, nie ma jak przejść z raportu do niczego innego.

Do tego tabele nie mają wersji mobilnej. Tabela zamówień z pięcioma kolumnami na 375 px
albo się rozjedzie poziomo, albo zwinie kolumny do nieczytelności.

**Dlaczego to psuje odbiór.** To nie jest usterka estetyczna, to jest niedziałający
produkt dla połowy zadeklarowanej publiczności.

**Zmiana.**

- **Nawigacja poniżej 768 px**: pasek 52 px u góry: hamburger 40x40 po lewej, nazwa
  klienta 14 px / 500 na środku, akcja po prawej. Hamburger otwiera panel wysuwany:
  szerokość 280 px, `transform: translateX(-100%)` do `0`, `transition: transform 200ms
  cubic-bezier(0.32, 0.72, 0, 1)`, overlay `rgb(16 18 29 / 0.4)` z `transition: opacity
  160ms`. W środku ten sam komponent nawigacji, plus przełącznik klienta na górze.
  Zamknięcie: Esc, klik w overlay, klik w pozycję nawigacji.
- **Tabele poniżej 768 px**: wiersz przechodzi w blok dwuliniowy, wysokość 56 px,
  cała powierzchnia klikalna. Linia 1: `#63` (mono 12 px) po lewej, kwota 14 px / 600
  po prawej. Linia 2: e-mail 12 px `--color-muted` po lewej, plakietka stanu po prawej.
  Data jako 12 px `--color-faint` pod spodem albo w linii 2 przed plakietką.
- **Kafelki poniżej 640 px**: karta wiodąca pełna szerokość, pasek metryk łamie się
  na siatkę 2x2 z dzielnikami `border-top` i `border-left`.
- `background-attachment: fixed` usunąć bez względu na resztę, iOS Safari go nie obsługuje
  poprawnie i płaci za to przemalowaniem przy przewijaniu.

---

### P6. Nagłówek strony: 118 px sticky pod trzy akapity prozy

**Co jest źle.** `Naglowek` renderuje `h1` 21.6 px plus `opis` w `text-xs` (12 px)
z `leading-relaxed` (19.5 px) i `max-w-[68ch]`, całość w `px-7 py-5` i `sticky top-0`.
Na przeglądzie opis łamie się na dwie linie i nagłówek ma 118 px. Na Segmentach opis
ma około 270 znaków, na Zgodach około 380. To nie mieści się w dwóch liniach, więc
te nagłówki będą jeszcze wyższe.

Do tego 12-px proza pod 21.6-px tytułem to zbyt duży skok. Kontrast rozmiarów 1.8x
przy jednoczesnym spadku poniżej progu wygodnego czytania.

**Dlaczego to psuje odbiór.** Sticky nagłówek zjadający 118 px w narzędziu, w którym
przewija się tabele, to podatek płacony na każdym ekranie i przy każdym przewinięciu.
A wyjaśnienie zasad działania segmentów operator czyta raz w życiu, po czym ogląda je
codziennie przez rok. Linear trzyma nagłówek na 40 px, Attio na 44, Stripe na 56.

**Zmiana.**

- Nagłówek: stała wysokość 48 px, jeden rząd, `padding: 0 24px`, `border-bottom: 1px
  solid var(--color-line)`, tło `--color-surface`, bez rozmycia.
- W środku po lewej okruszki zamiast `h1`: `Sklep Testowy MidRev / Kampanie /
  Wrześniowa wyprzedaż`. 13 px, separator `/` w `--color-line-strong`, człony
  nieostatnie `--color-muted` i klikalne, ostatni `--color-ink` 500.
- Po prawej: akcje strony plus pole wyszukiwania albo skrót `Ctrl K` jako przycisk 28 px.
- `opis` wychodzi z nagłówka do pasa informacyjnego pod nim: `<details>` domyślnie
  zwinięty, wysokość 36 px, tło `--color-sunken`, tekst 13 px `--color-muted`, widoczne
  pierwsze zdanie plus `Więcej` z chevronem. Rozwinięty pokazuje całość w `--t-prose`
  (14 px / 21 px) z `max-width: 72ch`.

To zwraca 70 px pionu na każdym ekranie i naprawia rozmiar prozy przy okazji.

---

### P7. Karta detalu kampanii: przycisk powrotu zamiast okruszków

**Co jest źle.** Na `kampania.png` jedyną drogą w górę hierarchii jest pigułka
"Wróć do kampanii" w prawym górnym rogu, w stylu `przycisk-wtorny`. To jest wzorzec
mobilny wstawiony na desktop, a do tego umieszczony po przeciwnej stronie ekranu
niż kierunek, w którym prowadzi.

**Dlaczego to psuje odbiór.** Powrót w górę drzewa to nawigacja, nie akcja, więc nie
powinien wyglądać jak przycisk i nie powinien zajmować miejsca zarezerwowanego na
akcję główną. W prawym górnym rogu detalu kampanii powinno stać "Wyślij do akceptacji",
a nie "Wróć".

**Zmiana.** Usuń `akcja={<Link ... przycisk-wtorny>}` z detalu kampanii. Powrót
obsługują okruszki z P6. Prawy górny róg zwalnia się na akcję główną:
`Wyślij do akceptacji` w stylu `--color-action` plus `…` z akcjami wtórnymi
(Duplikuj, Zmień harmonogram, Odwołaj).

---

### P8. Plakietki stanu: angielskie enumy w polskim interfejsie

**Co jest źle.** Tabela zamówień na `przeglad.png` pokazuje `processing`, `completed`,
`refunded`, `cancelled`. Surowe wartości z bazy WooCommerce, po angielsku, w panelu,
w którym cała reszta jest po polsku. Ta sama aplikacja, plik
`src/app/t/[tenantId]/kampanie/page.tsx`, ma poprawnie zrobioną mapę `STANY`
tłumaczącą statusy kampanii. Dla zamówień takiej mapy nie ma.

Podobnie na Zgodach: `z.source` i `w.reason` idą prosto z bazy do widoku bez mapy.

**Dlaczego to psuje odbiór.** To najdrobniejszy i najbardziej rzucający się w oczy
sygnał "prototyp": widać przez interfejs schemat bazy danych.

**Zmiana.** Mapa analogiczna do `STANY`, w jednym miejscu, np. `src/domain/etykiety.ts`:

```ts
export const STAN_ZAMOWIENIA: Record<string, { etykieta: string; ton: Ton }> = {
  pending:    { etykieta: "oczekuje na płatność", ton: "uwaga" },
  processing: { etykieta: "w realizacji",         ton: "uwaga" },
  "on-hold":  { etykieta: "wstrzymane",           ton: "uwaga" },
  completed:  { etykieta: "zrealizowane",         ton: "ok" },
  cancelled:  { etykieta: "anulowane",            ton: "blad" },
  refunded:   { etykieta: "zwrócone",             ton: "blad" },
  failed:     { etykieta: "nieudane",             ton: "blad" },
};
```

Nieznany status renderuj jako `--color-faint` z surową wartością, żeby nowa wartość
z Woo nie znikała po cichu.

Sama plakietka też do przebudowy. Obecna ma promień 980 px, obramowanie i tło
`color-mix(... 8%)`, czyli tło praktycznie niewidoczne przy widocznej ramce.
Odwróć proporcje i zejdź z promienia:

```css
.plakietka {
  display: inline-flex; align-items: center; gap: 5px;
  height: 20px; padding: 0 7px; border-radius: 5px;
  font-size: 11px; font-weight: 500; line-height: 1;
  border: 0;
  background: var(--color-sunken); color: var(--color-muted);
}
.plakietka::before { width: 5px; height: 5px; border-radius: 999px; background: currentColor; }
.plakietka-ok    { background: var(--color-ok-bg);     color: var(--color-ok); }
.plakietka-uwaga { background: var(--color-warn-bg);   color: var(--color-warn); }
.plakietka-blad  { background: var(--color-danger-bg); color: var(--color-danger); }
```

NFR33 jest spełniony samym słowem, kropka zostaje jako kotwica wzrokowa, nie jako
wymóg.

---

### P9. Formatowanie kwot niezgodne z polskim standardem

**Co jest źle.** `src/domain/kwoty.ts`, funkcja `zGroszy`, składa string ręcznie:

```ts
return `${znak}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")} ${waluta}`;
```

Efekt: `6061,00 PLN`. Brak separatora tysięcy, waluta jako kod ISO zamiast symbolu.
Przy kwotach powyżej czterech cyfr, czyli przy każdym realnym sklepie, `1234567,00 PLN`
jest nieczytelne z jednego spojrzenia.

**Dlaczego to psuje odbiór.** Przychód to liczba, na podstawie której klient ocenia kanał,
i jednocześnie największy element na ekranie przeglądu. Źle sformatowana podważa zaufanie
do wszystkiego obok. Komentarz nad `naGrosze` mówi wprost, że chodzi o "różnicę między
zaufaniem a tłumaczeniem się", a formatowanie wyjściowe tej samej reguły nie trzyma.

**Zmiana.**

```ts
const formatery = new Map<string, Intl.NumberFormat>();
export function zGroszy(minor: number, waluta = "PLN"): string {
  let f = formatery.get(waluta);
  if (!f) {
    f = new Intl.NumberFormat("pl-PL", { style: "currency", currency: waluta });
    formatery.set(waluta, f);
  }
  return f.format(minor / 100);
}
```

Daje `6 061,00 zł`. Dzielenie przez 100 na tym etapie jest bezpieczne, bo `Intl` dostaje
liczbę do sformatowania, a nie do arytmetyki, i wartości do 2^53 groszy mieszczą się
bez straty. Cała ochrona przed zmiennoprzecinkowym gubieniem grosza siedzi w `naGrosze`
i tam zostaje.

Do tego `.wielkosc` i `.liczba` już mają `font-variant-numeric: tabular-nums`, więc
kolumna kwot będzie się wyrównywać. Dopisz jeszcze `font-variant-numeric: tabular-nums`
do całej `.tabela td`, bo daty też są cyframi.

---

### P10. Fokus klawiaturowy praktycznie nie istnieje

**Co jest źle.** `.przycisk:focus-visible` ma outline. `.pole:focus` ma pierścień
`0 0 0 3px var(--color-accent-weak)`, czyli niebieski o kryciu 9%, praktycznie
niewidoczny na bieli. Poza tym: `.nawigacja-pozycja` bez fokusu, wiersze tabeli bez
fokusu, karty kampanii (`<Link className="karta block">`) bez fokusu, `<select>`
przełącznika klienta polega na `.pole:focus`, czyli na tym samym niewidocznym pierścieniu.

**Dlaczego to psuje odbiór.** Narzędzia z poziomu odniesienia są obsługiwalne
z klawiatury w całości i widać, gdzie jest kursor. Panel, po którym nie da się chodzić
Tabem, jest z definicji poniżej tego progu, niezależnie od tego, jak wygląda.

**Zmiana.** Jeden token, jedna reguła, wszędzie:

```css
:where(a, button, select, input, [tabindex]):focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
  border-radius: 6px;
}
.pole:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-focus);   /* 20%, nie 9% */
}
.tabela tbody tr:focus-within td { background: var(--color-accent-weak); }
```

Wiersze tabeli zamówień muszą stać się klikalne i osiągalne Tabem, dziś nie są ani jednym,
ani drugim.

---

### P11. Hover karty kampanii: pełna niebieska ramka

**Co jest źle.** `src/app/t/[tenantId]/kampanie/page.tsx`:
`className="karta block p-4 transition hover:border-[var(--color-accent)]"`.
Najechanie zmienia całą krawędź karty na `#0071e3`.

**Dlaczego to psuje odbiór.** Niebieska ramka to sygnał zaznaczenia albo fokusu,
nie najechania. Użycie jej na hover zabiera akcentowi jego jedyne znaczenie
i przy przesuwaniu myszą po liście kampanii daje efekt migającej choinki.

**Zmiana.** `hover:bg-[var(--color-hover)] hover:border-[var(--color-line-strong)]`,
przejście 120 ms. Niebieską ramkę zostaw dla `:focus-visible` i dla stanu zaznaczonego.

---

### P12. Puste stany to gołe akapity szarego tekstu

**Co jest źle.** Wszystkie puste stany mają jedną formę:
`<p className="p-4 text-sm text-[var(--color-muted)]">Nie ma jeszcze żadnej kampanii.</p>`
albo, na liście kampanii, akapit bez żadnego kontenera, wiszący w komórce siatki.
Zero ikony, zero przycisku, zero ramy.

**Dlaczego to psuje odbiór.** Pusty stan to pierwsze, co widzi nowy klient po podłączeniu
sklepu. Dziś wygląda jak awaria: pusty biały prostokąt z jednym zdaniem po lewej.
A niektóre z tych komunikatów są dobre merytorycznie ("Nikt nie przechodzi przez bramkę.
Sprawdź zgody i wykluczenia albo dobór segmentów.") i giną w formie.

**Zmiana.** Jeden komponent `<Pusto>` z ikoną, tytułem, zdaniem i akcją:

```
kontener: border: 1px dashed var(--color-line-strong); border-radius: 10px;
          padding: 32px 24px; text-align: center;
ikona:    20px Lucide w kółku 40px, tło var(--color-sunken), kolor var(--color-faint)
tytuł:    14px / 500, var(--color-ink), margin-top 12px
opis:     13px / 19px, var(--color-muted), max-width 44ch, margin: 4px auto 0
akcja:    przycisk główny, margin-top 16px
```

Mapa treści:

| Miejsce | Tytuł | Akcja |
|---|---|---|
| Kampanie puste | Żadnej kampanii | Utwórz szkic |
| Segmenty puste | Żadnego segmentu | Dodaj segment |
| Sklepy puste | Sklep nie jest podłączony | Podłącz sklep |
| Zamówienia puste | Brak danych | Uruchom import |
| Próbka odbiorców pusta | Nikt nie przechodzi przez bramkę | Sprawdź zgody |
| Wykluczenia globalne puste | Lista jest pusta | brak akcji, sam opis |

---

### P13. Zero stanów ładowania przy renderze blokowanym bazą

**Co jest źle.** Każda strona ma `export const dynamic = "force-dynamic"`, a przegląd
odpala siedem zapytań w `Promise.all` przed pierwszym bajtem HTML. Strona Segmentów
robi N+1: `segmenty.map(async (s) => policzSegment(...))` odpala osobne zapytanie
na każdy segment, w trakcie renderu. Przy 20 segmentach to 21 round-tripów, a użytkownik
przez ten czas patrzy na poprzednią stronę albo na biel.

Brak jakiejkolwiek granicy `Suspense` i brak jakiegokolwiek skeletonu w całym drzewie.

**Dlaczego to psuje odbiór.** Postrzegana szybkość jest częścią rzemiosła na poziomie
odniesienia równie mocno co typografia. Linear renderuje szkielet w kilkadziesiąt
milisekund i dopełnia dane. Tutaj panel zamiera.

**Zmiana.**

1. Nagłówek i nawigacja renderują się natychmiast, każda karta z danymi idzie w osobne
   `<Suspense fallback={<Szkielet .../>}>`.
2. Szkielet: `background: var(--color-sunken); border-radius: 6px; animate-pulse`,
   o wysokości dokładnie równej finalnej treści (wiersz tabeli 36 px, kafelek metryki
   18 px na wartość, 11 px na etykietę). Skeleton, który nie pasuje wysokością,
   powoduje przeskok układu i jest gorszy od jego braku.
3. `policzSegment` przepisz na jedno zapytanie zwracające liczebność wszystkich
   segmentów naraz. To jest poprawka wydajnościowa, ale jej efekt jest wizualny.
4. Dla akcji serwerowych (`utworzSegmentAkcja`, `utworzKampanieAkcja`, `importujAkcja`)
   dodaj `useFormStatus` i stan `pending` na przycisku: tekst zostaje, dochodzi spinner
   16 px i `pointer-events: none; opacity: 0.7`. Dziś kliknięcie "Zapisz segment"
   nie daje żadnej reakcji aż do przeładowania.

---

### P14. Przełącznik klienta wygląda jak pole formularza

**Co jest źle.** `PrzelacznikTenanta` to natywny `<select class="pole">`: pełna szerokość,
promień 11 px, obramowanie `--color-line-strong`, natywny chevron przeglądarki.
Wygląda dokładnie jak pole "Reguła" w formularzu nowego segmentu, choć pełni zupełnie
inną funkcję: to jest przełącznik kontekstu całej aplikacji, jedyny element w panelu,
którego pomyłkowe użycie przenosi operatora do danych innego klienta.

**Dlaczego to psuje odbiór.** Najważniejsza kontrolka w panelu operatora obsługującego
kilka sklotów naraz jest nieodróżnialna od zwykłego selecta. Plus natywny `<select>`
renderuje się inaczej w każdej przeglądarce, więc to jedyny element, którego wyglądu
nie kontrolujecie.

**Zmiana.** Przycisk plus menu, nie `<select>`:

```
przycisk: wysokość 34px, pełna szerokość, promień 6px,
          tło var(--color-surface), border 1px var(--color-line),
          hover tło var(--color-hover)
w środku: awatar 20px (promień 5px, inicjały 10px/600, tło z hasha nazwy klienta)
          + nazwa 13px/500 truncate + chevron-down 14px var(--color-faint)
menu:     promień 8px, cień var(--shadow-overlay), padding 4px,
          pozycja 28px wiersze, aktywny z ikoną check 14px po prawej
          powyżej 6 klientów: pole filtrujące na górze menu, autofocus
```

Podepnij pod `Ctrl K` jako pierwszą kategorię wyników (patrz P15).

---

### P15. Brak wyszukiwania i skrótów klawiszowych

**Co jest źle.** W całym panelu nie ma ani jednego pola wyszukiwania i ani jednego
skrótu klawiszowego. Operator obsługujący kilka sklepów, chcący znaleźć zamówienie
po numerze albo profil po e-mailu, musi przejść: przełącznik klienta, zakładka,
przewijanie oczami.

**Dlaczego to psuje odbiór.** Paleta poleceń jest w tej klasie narzędzi standardem,
nie wyróżnikiem. Raycast, Linear, Height, Vercel, Attio: wszystkie mają `Ctrl K`.
Panel bez niej czyta się jako panel administracyjny sprzed dekady, niezależnie
od typografii.

**Zmiana.** Paleta `Ctrl K` / `Cmd K`:

```
overlay:  rgb(16 18 29 / 0.35), pojawienie 120ms
panel:    szerokość 560px, top 15vh, promień 12px, cień var(--shadow-overlay),
          tło var(--color-surface)
pole:     wysokość 48px, 15px, bez obramowania, ikona search 16px po lewej,
          border-bottom 1px var(--color-line)
wyniki:   wysokość wiersza 36px, padding 0 12px, promień 6px,
          zaznaczony tło var(--color-accent-weak)
grupy:    etykieta 11px uppercase var(--color-faint), padding 12px 12px 4px
stopka:   32px, tło var(--color-sunken), podpowiedzi skrótów 11px z klawiszami
          w ramkach 1px var(--color-line-strong), promień 4px
```

Zakres wyszukiwania: klienci, kampanie, segmenty, listy, profile po e-mailu,
zamówienia po numerze, plus polecenia nawigacyjne ("Przejdź do Zgód").

Skróty poza paletą:
- `/` fokus na wyszukiwanie w bieżącej tabeli
- `g` potem `p` / `s` / `k` / `z` skok do sekcji (przegląd, sklepy, kampanie, zgody)
- `j` / `k` ruch po wierszach tabeli, `Enter` otwiera, `Esc` zamyka
- `?` ściąga ze skrótami

---

### P16. Tabele bez sortowania, filtrowania, paginacji i akcji kontekstowych

**Co jest źle.** Tabela zamówień na przeglądzie pokazuje sztywno 8 wierszy
(`zamowieniaTenanta(tenantId, 8)`) i tekstowy link "wszystkie". Pełne widoki
(Zamówienia, Profile, Zgody) też nie mają ani sortowania po kolumnie, ani filtra,
ani paginacji, ani akcji na wierszu. Nie da się kliknąć wiersza zamówienia.

**Dlaczego to psuje odbiór.** Gęsty widok tabelaryczny z filtrami i akcjami w wierszu
to rdzeń Attio i Linear. Tabela wyłącznie do czytania, bez możliwości uporządkowania
danych, jest raportem, a nie narzędziem pracy.

**Zmiana.**

- **Sortowanie**: `th` staje się `<button>` z chevronem 12 px pojawiającym się na hover
  (`opacity: 0` do `0.5`) i widocznym na stałe przy aktywnym sortowaniu (`opacity: 1`,
  `--color-ink`). Stan w query params, żeby był linkowalny.
- **Filtry**: pas 40 px nad tabelą, po lewej przycisk `+ Filtr` (wysokość 28 px,
  promień 6 px, `border: 1px dashed var(--color-line-strong)`), po prawej licznik
  wyników 12 px `--color-faint`. Aktywne filtry jako plakietki z `x`.
- **Paginacja**: stopka tabeli 44 px, po lewej `1-25 z 1 284` (12 px `--color-muted`),
  po prawej dwa przyciski 28x28 z chevronami plus wybór rozmiaru strony.
- **Akcje wiersza**: kolumna `w-10` po prawej, przycisk `…` 24x24 z `opacity: 0`,
  na `tr:hover` i `tr:focus-within` `opacity: 1`. Menu: Otwórz, Kopiuj e-mail,
  Zobacz profil, Wyklucz adres.
- Wiersz zamówienia klikalny w całości: `<tr>` z `onClick` plus `tabIndex={0}`
  plus obsługa `Enter`, albo `<Link>` rozciągnięty przez `::after` na pierwszej komórce.

---

### P17. Zero wizualizacji danych

**Co jest źle.** Panel raportowy nie ma ani jednego wykresu. "PRZYCHÓD 6061,00 PLN"
bez okresu, bez porównania i bez trendu.

**Dlaczego to psuje odbiór.** Właściciel sklepu wchodzi na trzy minuty z telefonu.
Jedna liczba bez kontekstu nie odpowiada na jego pytanie ("czy jest lepiej niż
w zeszłym miesiącu"). Odpowiada na nie linia.

**Zmiana.** Dwa wykresy na przeglądzie, oba bez zewnętrznej biblioteki wykresów
(wystarczy inline SVG, dane i tak są serwerowe):

1. **Sparkline** w karcie wiodącej: 100x32 px, `stroke: var(--color-accent)`,
   `stroke-width: 1.5`, `fill: none`, pod spodem gradient do przezroczystości
   przy kryciu 0.10. Bez osi, bez siatki, bez etykiet.
2. **Przychód w czasie**: pełna szerokość, wysokość 200 px. Linia 2 px
   `--color-accent`, linie siatki poziome 1 px `--color-line` (4 sztuki, nie więcej),
   oś X z etykietami 11 px `--color-faint` co 7 dni, brak osi Y poza etykietami przy
   liniach siatki. Tooltip na hover: promień 6 px, tło `--color-ink`, tekst `#fff` 12 px,
   cień `--shadow-overlay`, plus pionowa linia prowadząca 1 px `--color-line-strong`.
   Poprzedni okres jako linia przerywana `--color-faint` przy kryciu 0.5.

Paleta serii, gdy pojawi się więcej niż jedna: `#2F6FEB`, `#16794A`, `#A25B00`,
`#7C4DBE`, `#0E7490`. Nigdy nie koduj serii samym kolorem, każda dostaje etykietę
przy końcu linii albo w legendzie z kształtem znacznika.

---

### P18. Notka "Faza 1" na stałe zajmuje nawigację

**Co jest źle.** Na dole nawigacji siedzi karta 232x180 px z tekstem o tym, że wysyłka
jest w kolejnych epikach. To jest notatka o stanie budowy produktu, wpisana na stałe
w chrom aplikacji.

**Dlaczego to psuje odbiór.** Nawigacja to najcenniejsza powierzchnia w panelu.
Oddanie 180 px pionu komunikatowi, który operator przeczyta raz i będzie oglądał
codziennie przez pół roku, to zły handel. Do tego jest to najbardziej "wewnętrzny"
element panelu, a przecież widzi go też klient.

**Zmiana.** Usuń z nawigacji. Wstaw jako jednolinijkowy pas nad treścią, 36 px,
tło `--color-warn-bg`, tekst 13 px `--color-warn`, ikona `info` 14 px, po prawej `x`
zapisujący odrzucenie w `localStorage`. Pełna treść pod "Dowiedz się więcej"
w popoverze. Na miejsce zwolnione w nawigacji: przełącznik motywu, wersja aplikacji,
link do wsparcia, 12 px `--color-faint`.

---

### P19. Przyciski: pigułka, słaba hierarchia, brak rozmiarów

**Co jest źle.** `.przycisk` ma `border-radius: 980px`, 14 px / 500, padding
`0.5rem 1rem` bez ustalonej wysokości. Wariant wtórny (`przycisk-wtorny`) różni się
od głównego tylko kolorem tła i ma `backdrop-filter: blur(12px)`, więc rozmywa to,
co pod nim, czyli nic. Nie ma wariantu tekstowego ani destrukcyjnego, nie ma rozmiarów.

**Dlaczego to psuje odbiór.** Pigułka to najsilniejszy pojedynczy sygnał "iOS"
w całym panelu, mocniejszy nawet niż kolor akcentu. Żadne z narzędzi odniesienia
jej nie używa.

**Zmiana.**

```css
.przycisk {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; padding: 0 12px; border-radius: 6px;
  font-size: 13px; font-weight: 500; line-height: 1;
  background: var(--color-action); color: #fff; border: 1px solid transparent;
  transition: background 120ms ease-out;
}
.przycisk:hover  { background: var(--color-action-hover); }
.przycisk:active { background: var(--color-action); }

.przycisk-wtorny {
  background: var(--color-surface); color: var(--color-ink);
  border-color: var(--color-line-strong);
}
.przycisk-wtorny:hover { background: var(--color-hover); }

.przycisk-cichy {
  background: transparent; color: var(--color-muted); border-color: transparent;
}
.przycisk-cichy:hover { background: var(--color-hover); color: var(--color-ink); }

.przycisk-groza { background: var(--color-danger); color: #fff; }

.przycisk-s { height: 28px; padding: 0 10px; font-size: 12px; }
.przycisk-l { height: 36px; padding: 0 16px; font-size: 14px; }
```

Usuń `backdrop-filter` z wariantu wtórnego i `transform: scale(0.98)` z `:active`
(skalowanie przycisku to znów wzorzec iOS, na desktopie wystarczy zmiana tła).

---

### P20. Pola formularzy

**Co jest źle.** `.pole` ma promień 11 px (nie pasuje do żadnej innej wartości w systemie),
`backdrop-filter: blur(12px)` na tle o kryciu 0.88 (koszt bez efektu), padding
`0.55rem 0.8rem` bez ustalonej wysokości, i pierścień fokusu przy kryciu 9%.
Etykiety pól w formularzach mają `text-xs` (12 px) `--color-muted`, czyli są ciemniejsze
i większe niż etykiety kolumn tabel (11 px `--color-faint`), choć są tym samym poziomem
hierarchii.

**Zmiana.**

```css
.pole {
  width: 100%; height: 32px; padding: 0 10px;
  background: var(--color-surface); color: var(--color-ink);
  border: 1px solid var(--color-line-strong); border-radius: 6px;
  font-size: 13px; font-family: inherit;
  transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
}
.pole::placeholder { color: var(--color-faint); }
.pole:hover:not(:focus) { border-color: #C2C5CD; }
.pole:focus { outline: none; border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-focus); }
.pole-blad  { border-color: var(--color-danger); }
.pole-blad:focus { box-shadow: 0 0 0 3px rgb(196 41 28 / 0.18); }
textarea.pole { height: auto; min-height: 72px; padding: 8px 10px; line-height: 20px; }
```

Etykieta pola: 12 px / 500 `--color-ink`, `margin-bottom: 6px`. Podpis pomocniczy
pod polem: 12 px `--color-faint`, `margin-top: 4px`. Komunikat błędu w tym samym
miejscu, `--color-danger`, z ikoną `alert-circle` 12 px.

Formularze "Nowy segment" i "Nowa kampania" nie mają dziś żadnej walidacji po stronie
klienta ani komunikatu o błędzie przy polu. Jedyny kanał zwrotny to `Komunikat`
przez query param `?blad=`, wyświetlany na górze strony, czyli daleko od pola,
którego dotyczy.

---

### P21. Komponent `Komunikat`: plakietka udająca ikonę

**Co jest źle.** `Komunikat` renderuje kartę z plakietką "błąd" albo "gotowe" po lewej
i tekstem obok. Plakietka w roli ikony to obejście, a nie wzorzec. Do tego karta dziedziczy
promień 16 px i cień z `.karta`, więc komunikat wygląda cięższej niż treść, o której mówi.
Nie ma też sposobu zamknięcia go ani samoznikania.

**Zmiana.** Toast w prawym dolnym rogu zamiast bloku w treści:

```
pozycja:  fixed, bottom 20px, right 20px, szerokość 320px, z-index 60
kontener: promień 8px, tło var(--color-surface), border 1px var(--color-line),
          cień var(--shadow-overlay), padding 12px, gap 10px
ikona:    16px, check-circle var(--color-ok) lub alert-circle var(--color-danger)
tekst:    13px / 19px var(--color-ink)
zamknij:  x 14px var(--color-faint), 20x20 pole trafienia
wejście:  translateY(8px) + opacity 0 do 1, 180ms cubic-bezier(0.32,0.72,0,1)
znikanie: automatycznie po 5s dla sukcesu, błąd zostaje do kliknięcia
```

---

### P22. Ruch bez systemu

**Co jest źle.** W `globals.css` są trzy różne czasy: 140 ms (przycisk), 120 ms
(pole nawigacji), 120 ms (wiersz tabeli), wszystkie z `ease`. Plus `transform: scale(0.98)`
na `:active` przycisku. Wygaszenie ruchu przy `prefers-reduced-motion` jest zrobione
dobrze i zostaje.

**Zmiana.** Dwa czasy, dwie krzywe, koniec:

```css
--ruch-szybki: 120ms cubic-bezier(0.4, 0, 0.2, 1);   /* kolor, tło, krycie */
--ruch-panel:  180ms cubic-bezier(0.32, 0.72, 0, 1); /* przesunięcie, wysuwane panele */
```

`scale` na przyciskach usunąć.

---

## Czego brakuje, a jest standardem w tej klasie

| Brak | Gdzie to jest standardem | Priorytet |
|---|---|---|
| Stan aktywny w nawigacji | wszędzie | P1 |
| Nawigacja na telefonie | wszędzie | P5 |
| Okruszki | Attio, Stripe, Vercel | P6 |
| Paleta poleceń `Ctrl K` | Linear, Raycast, Height, Vercel, Attio | P15 |
| Skróty klawiszowe (`g`+litera, `j/k`, `/`) | Linear, Height | P15 |
| Widoczny fokus klawiaturowy | wszędzie | P10 |
| Sortowanie kolumn | Attio, Stripe | P16 |
| Filtry nad tabelą | Attio, Linear | P16 |
| Paginacja z licznikiem | Stripe, Attio | P16 |
| Akcje kontekstowe w wierszu (`…`) | Attio, Linear | P16 |
| Wykresy trendu | Stripe, Vercel | P17 |
| Wybór zakresu dat | Stripe, GA, Vercel | P3, P17 |
| Skeletony i granice Suspense | Linear, Vercel | P13 |
| Stan `pending` na przyciskach formularzy | wszędzie | P13 |
| Puste stany z ikoną i akcją | Linear, Attio | P12 |
| Toasty zamiast bloków w treści | wszędzie | P21 |
| Przełącznik motywu (paleta ciemna już jest, tylko nieosiągalna) | Linear, Vercel, Raycast | kolor |
| Ikony w nawigacji | Attio, Stripe, Height | P1 |
| Awatary klientów w przełączniku | Attio, Linear | P14 |
| Tooltipy przy skróconych wartościach i skrótach | Linear | po P16 |
| Eksport widoku do CSV | Stripe, Attio | po P16 |

---

## Trzy zmiany o największym skoku jakości

**1. Zdejmij warstwę dekoracyjną i przejdź na nieprzezroczyste powierzchnie z krawędzią
włosową.** Usuń `backdrop-filter` ze wszystkich `.karta`, `.pole`, `.przycisk-wtorny`,
nagłówka i nawigacji, usuń trzy radialne gradienty z `body` i `background-attachment:
fixed`, zamień cień karty `0 12px 32px -18px` na `border: 1px solid #E7E8EC` bez cienia,
zejdź z promienia 16 px na 10 px dla kart i z 980 px na 6 px dla przycisków, i przenieś
akcję główną z `#0071e3` na `#16181D`. To jest kilkanaście linii w `globals.css`
i jednym ruchem przenosi panel z rejestru "widżet iOS" do rejestru "narzędzie",
zanim ruszysz cokolwiek w układzie.

**2. Zagęść i odwróć hierarchię.** Wiersz tabeli z 49 px na 36 px, podstawa z 15 px
na 13 px, nagłówek karty z 14 px na 15 px / 600 (dziś jest mniejszy od własnej treści),
sticky nagłówek strony ze 118 px na 48 px z okruszkami zamiast tytułu i akapitu,
siedem kafelków 28-px na jedną metrykę wiodącą z wykresem plus jeden czterokolumnowy
pasek 18-px, oraz zdjęcie globalnego ujemnego trackingu z tekstu poniżej 20 px.
Odzysk to około 300 px pionu na przeglądzie, tabela wchodzi nad zgięcie, a wzrok
dostaje wreszcie jeden punkt wejścia zamiast siedmiu równorzędnych.

**3. Dołóż mechanikę, bez której to nie jest narzędzie.** Stan aktywny w nawigacji
z ikonami i `aria-current`, widoczny pierścień fokusu na wszystkim, co da się kliknąć,
paleta `Ctrl K` obejmująca klientów, kampanie, segmenty, profile i zamówienia,
oraz wysuwana nawigacja poniżej 768 px z tabelami przechodzącymi w bloki dwuliniowe.
Punkty pierwszy i drugi sprawiają, że panel wygląda jak Linear. Ten sprawia, że się
tak zachowuje, i naprawia produkt dla właściciela sklepu z telefonu, który dziś
po prostu nie ma jak nawigować.
