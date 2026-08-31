# Wzorce UI - materiał źródłowy dla panelu operatora

Zebrane 2026-08-27 na potrzeby panelu operatora MidRev ESP (Next.js 16, React 19, Tailwind 4).
Dokument jest materiałem źródłowym, nie rekomendacją produktową. Każda liczba ma źródło.

## Spis treści

| # | Sekcja | Co znajdziesz |
|---|---|---|
| [1](#1-typografia-w-narzędziach-o-dużej-gęstości) | Typografia | pełne skale Lineara, Attio, Vercela, Stripe; reguły trackingu; dominanta 13px |
| [2](#2-skala-odstępów-i-rytm-pionowy) | Odstępy i rytm | cztery skale 4px, line-height w wartościach bezwzględnych, wysokości kontrolek |
| [3](#3-tabele) | Tabele | pełny CSS wiersza Lineara, wyrównanie liczb, checklist |
| [4](#4-nawigacja-boczna) | Nawigacja boczna | pełny CSS panelu Lineara, szerokości, przełącznik kontekstu |
| [5](#5-kolor) | Kolor | pełne palety Lineara, Vercela, Stripe; jak wąsko stosują akcent |
| [6](#6-elewacja-i-obramowania) | Elewacja i obramowania | cienie czterech systemów, promienie, hairline |
| [7](#7-co-odróżnia-narzędzie-klasy-premium-od-przeciętnego-panelu) | Detale premium | stan aktywny, focus ring, czasy animacji, paleta poleceń, warstwy z |
| [8](#8-ciemny-motyw) | Ciemny motyw | dowody na osobny projekt, drabiny tła, alfy interakcji |
| [9](#9-synteza-blok-theme-dla-tailwind-4) | Synteza `@theme` | gotowy blok tokenów plus tabela metryk komponentów |
| [10](#10-systemy-publikowane-primer-atlassian-polaris-radix-stripe-apps) | Systemy publikowane | Primer, Atlassian, Polaris, Radix, Stripe Apps: wysokości wierszy, kontrolek, focus ring |
| [11](#11-źródła) | Źródła | każdy URL, metoda, lista luk |

**Pięć liczb, które robią największą różnicę** (uzasadnienie w sekcjach niżej):

1. **13px** to domyślny rozmiar tekstu w gęstym panelu, nie 14px i nie 16px
2. **line-height 20px** w komórce tabeli, jako wartość bezwzględna, nie mnożnik
3. **2 punkty procentowe** to cała różnica między hover a stanem aktywnym w nawigacji
4. **maks. 7% alfy** w najmocniejszym cieniu całego systemu
5. **wiersz bez obramowań**, odsunięty 8px od krawędzi, z zaokrągleniem 8px na hover

---
## Jak czytać provenance

Wartości mają jeden z trzech statusów:

| Status | Znaczenie |
|---|---|
| **CSS produkcyjny** | wyciągnięte 2026-08-27 z żywych plików CSS serwowanych przez dany produkt. Najmocniejszy dowód, bo to liczby, które faktycznie renderuje przeglądarka |
| **Dokumentacja publiczna** | opublikowany design system lub kod open source |
| **do zweryfikowania** | brak potwierdzonego źródła. Nie wpisuj do tokenów bez sprawdzenia |

Zastrzeżenie do Lineara i Attio: wyciągnięte pliki to bundle stron `linear.app` i `attio.com`,
nie zalogowana aplikacja (ta jest za autoryzacją). Warstwa tokenów (`--title-*`, `--text-*`,
paleta, cienie) to ten sam system, którego używa produkt. Metryki komponentów listy Lineara
pochodzą z komponentu `IssueListView`, czyli z **repliki** listy zadań osadzonej na stronie.
Oznaczam je jako "replika" i traktuj jako wskazówkę proporcji, nie jako pomiar aplikacji.

Stripe: tokeny wyciągnięte z inline CSS `docs.stripe.com` (prefiks zmiennych jest
zaciemniony, nazwy semantyczne zachowane). To ten sam system tokenów, który Stripe
publikuje dla Stripe Apps.

---

## 1. Typografia w narzędziach o dużej gęstości

### 1.1 Co realnie renderuje się w chromie UI

Częstotliwość deklaracji `font-size` w px w produkcyjnych bundlach CSS (policzone
mechanicznie, 2026-08-27). To pokazuje, gdzie leży środek ciężkości interfejsu:

| Produkt | Najczęstsze rozmiary (liczba deklaracji) |
|---|---|
| Linear | **13px (32x)**, 12px (24x), 14px (10px), 15px (5x), 10px (5x), 11px (3x) |
| Attio | **13px (6x)**, 12px (6x), 16px (4x), 14px (4x), 11px (4x) |
| Vercel | 14px (45x), 16px (31x), **13px (22x)**, 20px (20x), 12px (17x) |
| Raycast | 14px (117x), 16px (62x), 13px (58x), 12px (55x) |

Wniosek do zapisania wprost: **domyślnym rozmiarem tekstu w gęstym panelu jest 13px,
nie 14px i nie 16px**. 12px jest rozmiarem etykiet i badge'y. 14-15px to już tekst
"czytelniczy", a nie chrome.

### 1.2 Linear - pełna skala (CSS produkcyjny)

Wagi. Linear używa Inter Variable i pięciu wag, w tym dwóch nietypowych pośrednich:

```
--font-weight-light: 300
--font-weight-normal: 400
--font-weight-medium: 510      <- nie 500
--font-weight-semibold: 590    <- nie 600
--font-weight-bold: 680        <- nie 700
```

To jest jeden z najbardziej charakterystycznych trików Lineara: przy zmiennym Interze
510/590 daje wagę wyraźnie mocniejszą od 400, ale bez "tłustości" 600. Do tego
`font-feature-settings` na poziomie `html, body`:

```
--font-settings: "cv01", "ss03"
--font-variations: "opsz" auto
```

`cv01` to jednopiętrowe `a` w Interze, `ss03` to alternatywne formy. To zmienia
charakter fontu bez zmiany fontu.

Skala tekstowa (`--text-*`), rem przeliczone przy root 16px:

| Token | rozmiar | line-height | letter-spacing | typowe zastosowanie |
|---|---|---|---|---|
| `--text-large` | 17px (1.0625rem) | 1.6 | 0 | tekst wiodący |
| `--text-regular` | 15px (0.9375rem) | 1.6 | **-0.011em** | tekst treściowy |
| `--text-small` | 14px (0.875rem) | 1.5 (21/14) | **-0.013em** | tekst pomocniczy |
| `--text-mini` | 13px (0.8125rem) | 1.5 | **-0.01em** | tekst tabeli, chrome UI |
| `--text-micro` | 12px (0.75rem) | 1.4 | **0** | etykiety, badge |
| `--text-tiny` | 10px (0.625rem) | 1.5 | **-0.015em** | znaczniki |

Skala tytułów (`--title-*`), wszystkie z wagą semibold 590:

| Token | rozmiar | line-height | letter-spacing |
|---|---|---|---|
| `--title-1` | 17px | 1.4 | -0.012em |
| `--title-2` | 20px | 1.33 | -0.012em |
| `--title-3` | 24px | 1.33 | -0.012em |
| `--title-4` | 32px | 1.125 | -0.022em |
| `--title-5` | 40px | 1.1 | -0.022em |
| `--title-6` | 48px | 1 | -0.022em |
| `--title-7` | 56px | 1.1 | -0.022em |
| `--title-8` | 64px | 1.06 | -0.022em |
| `--title-9` | 72px | 1 | -0.022em |

Osobna skala nazwana rozmiarem (używana w komponentach formularzy i menu):

```
--font-size-micro: 11px    --font-size-small: 13px    --font-size-large: 18px
--font-size-mini: 12px     --font-size-regular: 15px
--font-size-title1: 36px   --font-size-title2: 24px   --font-size-title3: 20px
```

**Kluczowa obserwacja o trackingu, wbrew popularnej poradzie.** Linear NIE dodaje
dodatniego trackingu przy małych rozmiarach. Przy 12px tracking wynosi dokładnie 0,
a przy 10px jest nadal ujemny (-0.015em). Ujemny tracking jest największy nie przy
najmniejszym tekście, tylko w środku skali (15px: -0.011em, 14px: -0.013em) i przy
dużych nagłówkach (-0.022em od 32px w górę). To wynika z tego, że Inter ma już
wbudowaną kompensację optyczną (`opsz auto`).

### 1.3 Attio - skala w formacie Tailwind 4 (CSS produkcyjny)

Attio ma tokeny już zapisane w składni `@theme` Tailwinda 4, razem z domyślną wagą
i trackingiem na krok skali. Do przepisania niemal jeden do jednego:

| Token | rozmiar | waga | line-height | letter-spacing |
|---|---|---|---|---|
| `--text-xs` | 12px (0.75rem) | **500** | 18px (1.125rem) | 0 |
| `--text-sm` | 14px (0.875rem) | **500** | 20px (1.25rem) | -0.005em |
| `--text-base` | 16px (1rem) | **500** | 22px (1.375rem) | -0.01em |
| `--text-lg` | 18px (1.125rem) | 500 | 24px (1.5rem) | -0.01em |
| `--text-xl` | 20px (1.25rem) | 500 | 26px (1.625rem) | -0.01em |
| `--text-2xl` | 24px (1.5rem) | 500 | 30px (1.875rem) | -0.01em |
| `--text-heading-xs` | 28px (1.75rem) | **600** | 34px (2.125rem) | -0.01em |
| `--text-heading-sm` | 32px (2rem) | 600 | 36px (2.25rem) | -0.01em |
| `--text-heading-md` | 40px (2.5rem) | 600 | 44px (2.75rem) | -0.01em |
| `--text-heading-lg` | 56px (3.5rem) | 600 | 60px (3.75rem) | -0.015em |
| `--text-heading-xl` | 64px (4rem) | 600 | 64px (4rem) | -0.02em |

Trzy rzeczy warte zapamiętania:

1. **Domyślna waga tekstu to 500, nie 400.** Attio nie ma w skali wagi 400 dla tekstu
   interfejsu. Cały panel jest o jeden stopień cięższy niż typowy dashboard. Przy Interze
   na jasnym tle to jest różnica między "czytelne" a "rozmyte".
2. Line-height jest podany **w bezwzględnych rem, nie jako mnożnik**. 12px/18px, 14px/20px,
   16px/22px. Wszystkie wartości siadają na siatkę 2px, co daje przewidywalny rytm pionowy
   w tabelach.
3. Tracking startuje od 0 przy 12px i schodzi tylko do -0.01em. Attio prawie nie ściska
   liter, bo przy wadze 500 ściskanie zabija czytelność.

Rodziny: `--font-inter` (UI), `--font-jetbrains-mono` (mono).

### 1.4 Vercel Geist - tracking jako funkcja rozmiaru (CSS produkcyjny)

Vercel stosuje regułę, którą da się zapisać jako trzy progi. Pary
`font-size` + `letter-spacing` policzone z produkcyjnego CSS:

| rozmiar | letter-spacing (px) | w em | liczba wystąpień |
|---|---|---|---|
| 14px | -0.28px | **-0.02em** | 1 |
| 16px | -0.32px | **-0.02em** | 8 |
| 20px | -0.4px | **-0.02em** | 10 |
| 24px | -0.96px | **-0.04em** | 12 |
| 32px | -1.28px | **-0.04em** | 9 |
| 40px | -2.4px | **-0.06em** | 8 |
| 48px | -2.88px | **-0.06em** | 9 |
| 56px | -3.36px | **-0.06em** | 6 |
| 64px | -3.84px | **-0.06em** | 7 |
| 72px | -4.32px | **-0.06em** | 5 |

Reguła: **do 20px włącznie -0.02em, od 24px do 32px -0.04em, od 40px w górę -0.06em.**
Nic pomiędzy, żadnej interpolacji. To jedna z prostszych rzeczy do wdrożenia i jedna
z bardziej widocznych.

Wagi Geista: 400 (`read`), 500 (`interact`), 600 (`announce`). Skala kończy się na 600,
nie ma 700 w interfejsie.

### 1.5 Raycast - kontrprzykład (CSS produkcyjny)

Raycast idzie w drugą stronę i stosuje **dodatni** tracking przy małych rozmiarach:
14px → +0.2px (43 wystąpienia), 13px → +0.1px, 12px → +0.1px lub +0.2px, 16px → +0.2px.

Wniosek: nie ma jednej prawdy. Ujemny tracking (Linear, Vercel, Attio) daje wrażenie
gęstości i "technicznej precyzji". Dodatni (Raycast) daje wrażenie spokoju i czytelności.
Dla panelu, w którym operator siedzi godzinami, bezpieczniejszy jest wariant Attio:
tracking blisko zera, waga 500.

### 1.6 Stripe (CSS produkcyjny, docs.stripe.com)

```
--typeface-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif
--typeface-monospace: 'Source Code Pro', Menlo, Monaco, monospace
--weight-regular: 400
--weight-semibold: 600
--weight-bold: 700
```

Stripe jako jedyny z tej grupy nadal jedzie na foncie systemowym, bez własnego kroju
w interfejsie. Trzy wagi, bez wartości pośrednich.

### 1.7 Podsumowanie ról typograficznych dla panelu operatora

Synteza pięciu ról, o które pytano, z podaniem, kto co robi:

| Rola | Rozmiar | Waga | Line-height | Tracking | Wzorzec |
|---|---|---|---|---|---|
| Tytuł strony | 20-24px | 590-600 | 1.33 / 30px | -0.01 do -0.012em | Linear `--title-2/3`, Attio `--text-2xl` |
| Tytuł sekcji / karty | 15-17px | 590-600 | 1.4 | -0.012em | Linear `--title-1` |
| Tekst tabeli | **13px** | 400-500 | 1.5 (20px) | -0.01 do 0em | Linear `--text-mini`, dominanta w CSS |
| Etykieta kolumny | **12px** | 500-510 | 1.4 (16-18px) | 0em | Linear `--text-micro` + medium |
| Podpis pomocniczy | 11-12px | 400-500 | 1.4 | 0em | Linear `--font-size-micro` 11px |

Etykiety kolumn: **nie stosuj wersalików z rozstrzelonym trackingiem**. Ani Linear,
ani Attio, ani Vercel tego nie robią w tabelach. Wersaliki z `letter-spacing: 0.05em`
to sygnatura panelu z 2015 roku. Różnicę robi kolor (trzeci stopień szarości) i waga
medium, nie transformacja wielkości liter.

---

## 2. Skala odstępów i rytm pionowy

### 2.1 Cztery realne skale (wszystkie z CSS produkcyjnego)

**Vercel Geist** - czysta siatka 4px, nazwana krotnościami:

```
--geist-space:      4px      --geist-space-8x:   32px
--geist-space-2x:   8px      --geist-space-10x:  40px
--geist-space-3x:   12px     --geist-space-16x:  64px
--geist-space-4x:   16px     --geist-space-24x:  96px
--geist-space-6x:   24px     --geist-space-32x:  128px
                             --geist-space-48x:  192px
                             --geist-space-64x:  256px
```

Plus trzy tokeny semantyczne, które są w istocie wysokościami kontrolek:
`--geist-space-small: 32px`, `--geist-space-medium: 36px`, `--geist-space-large: 40px`.
Oraz odstęp między sekcjami: `--geist-space-gap: 24px`, `--geist-space-gap-half: 12px`.
Vercel utrzymuje też pełny komplet wartości ujemnych (`-4px` ... `-256px`) do
kompensowania paddingu kontenerów.

**Stripe** - siatka 4px z dogęszczeniem w dolnym zakresie:

```
--space-0:   0px     --space-150: 12px    --space-400: 32px
--space-1:   1px     --space-200: 16px    --space-500: 40px
--space-25:  2px     --space-250: 20px    --space-600: 48px
--space-50:  4px     --space-300: 24px
--space-75:  6px     --space-350: 28px
```

Stripe jako jedyny ma **1px i 2px jako pełnoprawne tokeny odstępu**, oraz 6px.
To jest skala zaprojektowana pod gęste formularze finansowe, gdzie różnica 6px vs 8px
w paddingu inputa jest widoczna. Aliasy semantyczne: `xxsmall: 2px`, `xsmall: 4px`,
`small: 8px`, `medium: 16px`, `large: 24px`, `xlarge: 32px`, `xxlarge: 48px`.

**Raycast** - baza 8px, gdzie krok "0-5" to 4px:

```
--spacing-0-5: 4px    --spacing-3:  24px    --spacing-8:  64px
--spacing-1:   8px    --spacing-4:  32px    --spacing-9:  80px
--spacing-1-5: 12px   --spacing-5:  40px    --spacing-10: 96px
--spacing-2:   16px   --spacing-6:  48px    --spacing-11: 112px
--spacing-2-5: 20px   --spacing-7:  56px    --spacing-12: 168px
```

**Attio / Tailwind 4** - `--spacing: 0.25rem` (4px) jako mnożnik, reszta wyliczana.
Attio nie nadpisuje tej bazy, korzysta z domyślnej skali Tailwinda.

### 2.2 Wniosek dla siatki

Wszyscy czterej stoją na 4px. Różnica jest w tym, **ile kroków z tej siatki faktycznie
dopuszczają**. Vercel i Raycast praktycznie nie używają 4px w layoucie, tylko jako
mikro-korektę. Stripe używa 2px i 6px, bo ma gęste formularze.

Dla panelu operatora bezpieczny zestaw dopuszczonych kroków to:
`2, 4, 6, 8, 12, 16, 24, 32, 48, 64`. Dziesięć wartości. Każda wartość spoza tej listy
w kodzie to sygnał, że ktoś zgadywał.

### 2.3 Rytm pionowy: line-height w wartościach bezwzględnych

Najważniejszy trik Attio (CSS produkcyjny): line-height jest podany jako
**bezwzględny rozmiar w rem, nie jako mnożnik**.

```
--text-xs--line-height:   1.125rem  =  18px  (dla 12px)
--text-sm--line-height:   1.25rem   =  20px  (dla 14px)
--text-base--line-height: 1.375rem  =  22px  (dla 16px)
--text-lg--line-height:   1.5rem    =  24px  (dla 18px)
--text-xl--line-height:   1.625rem  =  26px  (dla 20px)
--text-2xl--line-height:  1.875rem  =  30px  (dla 24px)
```

Wszystko na siatce 2px. Konsekwencja praktyczna: wiersz tabeli z tekstem 13px
i line-height 20px, plus padding 8px góra i dół, daje **dokładnie 36px**. Bez
ułamków, bez subpikseli, bez rozjeżdżania się przy zoomie.

Linear robi to samo w jednym miejscu, jawnie: `--text-small-line-height: calc(21 / 14)`,
czyli 14px tekstu ma dokładnie 21px linii.

### 2.4 Wysokości kontrolek (CSS produkcyjny)

Linear, pełna skala przycisku:

| Rozmiar | Wysokość | Ikona | Font | Padding poziomy | Gap |
|---|---|---|---|---|---|
| `mini` | **24px** | 12px | 12px | 10px | 4px |
| `small` | **32px** | 16px | 13px | 12px | 8px |
| `medium` | **40px** | 16px | 13px | 14px | 8px |
| `default` | 40px | 18px | 15px | 16px | 6px |
| `large` | 44px | 18px | 16px | 20px | 6px |

Zwróć uwagę: przycisk 32px i 40px mają **ten sam rozmiar fontu (13px) i tę samą ikonę
(16px)**. Zmienia się tylko wysokość i padding. To jest sposób na spójność między
paskiem narzędzi a formularzem.

Wysokości elementów chrome w Linearze (replika listy zadań):

```
nagłówek widoku / pasek widoku:  44px
nagłówek grupy w liście:         36px
wiersz listy:                    40px
przycisk filtra:                 26px
pigułka / tab filtra:            28px
przycisk nawigacji:              28-30px
badge (domyślny / mały):         24px / 22px
avatar w badge:                  16px / 14px
```

Stripe: `--radius` i `--space` bez osobnych tokenów wysokości, kontrolki składane
z `space-*`. Vercel: `--geist-space-small/medium/large` = 32/36/40px jako wysokości
kontrolek.

shadcn/ui (kod open source, `registry/new-york-v4/ui/sidebar.tsx`):
przycisk menu `default: h-8` (32px), `sm: h-7` (28px), `lg: h-12` (48px).

### 2.5 Paddingi kart i odstępy między sekcjami

Linear, wartości z CSS:

```
padding paska lokalizacji:   8px 12px
padding okruszka:            6px 10px
padding wewnętrzny listy:    8px (margin-inline wierszy)
tooltip:                     6px 8px
toast:                       16px 24px 16px 16px, szerokość 364px
element menu kontekstowego:  0 10px, wysokość 32px
popup select:                padding 4px, radius 10px
```

Vercel: `--geist-space-gap: 24px` jako standardowy odstęp między blokami,
`--geist-space-gap-half: 12px` wewnątrz bloku.

Dla panelu: **karta = 16px padding przy gęstym widoku, 24px przy widoku
przeglądowym. Odstęp między sekcjami = 24px. Odstęp wewnątrz sekcji = 12px.**
Trzy liczby, nie dziesięć.

---

## 3. Tabele

### 3.1 Linear, lista zadań (CSS produkcyjny, replika komponentu na stronie)

Pełna specyfikacja wiersza, przepisana z klasy `.bVIB3G_row`:

```css
.row {
  height: 40px;                    /* wysokość wiersza */
  margin-inline: 8px;              /* wiersz NIE dotyka krawędzi panelu */
  padding-inline: 36px 28px;       /* miejsce na checkbox z lewej */
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: relative;
  flex-shrink: 0;
}

/* podświetlenie hover jako pseudoelement, nie background wiersza */
.row::before {
  content: "";
  position: absolute;
  inset: 0;
  background: #ffffff08;           /* biel 3% alpha */
  border-radius: 8px;
  opacity: 0;
  pointer-events: none;
}
.row:hover::before { opacity: 1; }

/* checkbox pojawia się DOPIERO na hover */
.row::after {
  content: "";
  position: absolute;
  top: 50%; left: 12px;
  transform: translateY(-50%);
  width: 14px; height: 14px;
  border: var(--border-hairline) solid var(--hero-line);
  border-radius: var(--radius-4);
  background: #ffffff05;
  opacity: 0;
}
.row:hover::after { opacity: 1; }

/* focus ring rysowany DO ŚRODKA, nie na zewnątrz */
.rowButton:focus-visible {
  outline: 2px solid var(--color-text-secondary);
  outline-offset: -2px;
  border-radius: 8px;
}
```

Trzy rzeczy, które robią tu całą różnicę:

1. **Zero obramowań między wierszami.** Nie ma `border-bottom`. Separacja jest robiona
   wyłącznie przez podświetlenie hover i grupowanie. Lista wygląda na "lekką", bo nie
   ma 200 poziomych kresek na ekranie.
2. **Wiersz jest odsunięty od krawędzi o 8px i ma zaokrąglenie 8px na hover.** Podświetlenie
   to pływająca pigułka, nie pas ciągnący się przez cały ekran. To najbardziej rozpoznawalny
   element listy Lineara.
3. **Focus ring z `outline-offset: -2px`.** Rysowany do wewnątrz, więc nie powiększa
   wiersza i nie powoduje przeskoku layoutu ani przycięcia przez `overflow: hidden`
   kontenera przewijania.

Nagłówek grupy: wysokość 36px, tło `#ffffff05`, radius 8px, `margin-inline: 8px`,
padding 8px, gap 8px. Czyli **nagłówek grupy jest tą samą pigułką co wiersz, tylko
z lekkim stałym tłem**.

Kolumny o stałej szerokości w wierszu Lineara:

```
identyfikator zadania:  width: 72px
data:                   width: 40px, text-align: right
slot statusu:           16x16px
komórka avatara:        24x24px
```

Oraz na okruszkach: `font-variant-numeric: lining-nums tabular-nums`.
Linear jawnie włącza cyfry tabelaryczne. To jest ta rzecz, przez którą liczby
w kolumnie nie "tańczą" przy odświeżeniu.

### 3.2 Attio

Tabela produktu jest za autoryzacją. Z CSS strony potwierdzone są tylko tokeny
(typografia, kolor, cienie), nie metryki tabeli. **Wysokość wiersza tabeli Attio:
do zweryfikowania.**

Co jest potwierdzone i przekłada się na tabelę: siedmiowarstwowy system cieni
`--shadow-attio-layer-1..7` (sekcja 6), używany do sygnalizowania przyklejonych
kolumn i nakładek.

### 3.3 shadcn/ui jako punkt odniesienia dla "przeciętnego" panelu

Kod open source, `registry/new-york-v4/ui/table.tsx`:

```
TableHead: h-10 px-2 text-left align-middle font-medium whitespace-nowrap
TableCell: p-2 align-middle whitespace-nowrap
TableRow:  border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted
```

Czyli: nagłówek 40px, komórka padding 8px, `border-b` na każdym wierszu,
hover i selected jako dwa różne poziomy tego samego koloru `muted`.

To jest dokładnie ten domyślny wygląd, od którego trzeba odejść, żeby panel nie
wyglądał jak każdy inny panel z shadcn. Trzy zmiany, które to załatwiają:
usunięcie `border-b`, odsunięcie wiersza od krawędzi z zaokrągleniem hover,
zejście z tekstu 14px (`text-sm`) na 13px.

### 3.4 Wyrównanie liczb

Potwierdzone w CSS Lineara: `font-variant-numeric: lining-nums tabular-nums`.

Reguła do wdrożenia:

```css
.col-numeric {
  text-align: right;
  font-variant-numeric: tabular-nums lining-nums;
  font-feature-settings: "tnum" 1;   /* fallback dla starszych silników */
}
```

Kolumny liczbowe wyrównane do prawej, cyfry tabelaryczne, a jeśli kolumna zawiera
kwoty w różnych walutach, symbol waluty wyrównany do lewej krawędzi komórki
a liczba do prawej.

### 3.5 Checklist tabeli operatorskiej

| Element | Wartość | Źródło |
|---|---|---|
| Wysokość wiersza, gęsto | **28-32px** | Primer `condensed` 28px, Polaris IndexTable 32px, Atlassian 28px (sekcja 10.1) |
| Wysokość wiersza, domyślnie | **36px** | konsensus Primer / Polaris / Radix / shadcn (sekcja 10.1). Linear: 40px |
| Wysokość nagłówka tabeli | 36-40px | Linear 36px grupa, shadcn 40px, Atlassian 24px, Polaris IndexTable min 56px |
| Rozmiar tekstu komórki | **13px** | dominanta w CSS Lineara i Attio, potwierdzone przez Polaris `bodyMd` desktop (sekcja 10.2) |
| Rozmiar etykiety kolumny | 12px, waga 500-510 | Linear `--text-micro` + medium, Atlassian `body-small` 12/16 |
| Separacja wierszy | brak obramowań, hover jako pigułka | Linear, CSS produkcyjny |
| Radius podświetlenia | 8px | Linear, CSS produkcyjny |
| Kolor hover (ciemny motyw) | `#ffffff08` (biel 3%) | Linear, CSS produkcyjny |
| Kolor zaznaczenia | `#ffffff14` (biel 8%) | Linear `filterTab[data-active]`, CSS produkcyjny |
| Checkbox zaznaczenia | 14x14px, radius 4px, widoczny na hover | Linear, CSS produkcyjny |
| Focus wiersza | `outline: 2px solid; outline-offset: -2px` | Linear, CSS produkcyjny. Primer stosuje -2px zawsze (sekcja 10.9) |
| Liczby | `text-align: right` + `tabular-nums` | Linear, CSS produkcyjny |
| Kolumny przyklejone | cień warstwowy na granicy | patrz sekcja 6 |

---

## 4. Nawigacja boczna

### 4.1 Linear, pełna specyfikacja panelu bocznego (CSS produkcyjny, replika)

Cały komponent, przepisany z klas `.Mmx1Wq_*`:

```css
/* kontener */
.sidebar { padding: 8px 16px 16px 8px; }   /* asymetryczny padding! */

/* przełącznik workspace, na SAMEJ GÓRZE */
.switchWorkspaceButton {
  height: 28px;
  border-radius: 8px;
  gap: 6px;
  padding-inline: 4px;
  transition: background .16s var(--ease-out-quad);
}
.switchWorkspaceButton:hover { background: #ffffff08; }
.logoWrapper { width: 20px; height: 20px; border-radius: 2px; background: #121414; }

/* akcje obok przełącznika */
.searchButton, .newIssueButton { width: 28px; height: 28px; border-radius: 9999px; }
.searchButton  { color: var(--label-muted); }
.newIssueButton{ color: var(--label-base);
                 border: var(--border-hairline) solid var(--border-thin);
                 background: #ffffff05; }

/* lista pozycji */
.navItems { display: flex; flex-direction: column; gap: 2px; }

.navItem {
  height: 28px;
  font-size: 12px;                            /* --font-size-miniPlus */
  font-weight: 510;                           /* --font-weight-medium */
  color: var(--color-text-secondary);         /* #d0d6e0 */
  border-radius: 8px;
  gap: 8px;
  padding-inline: 7px;
  width: 100%;
}
.navItem[data-active=true]                          { background: #ffffff0a; }  /* biel 4% */
.navItem:hover[data-interactive=true]:not([data-active=true]) { background: #ffffff05; }  /* biel 2% */
.navItem svg { color: var(--color-text-quaternary); }  /* #62666d, najciemniejszy stopień */

.navIconWrapper { width: 20px; height: 20px; border-radius: 2px; }
.navIconWrapper::before { background: var(--color); opacity: .08; inset: 0; }  /* podkład ikony 8% */

/* nagłówek grupy (rozwijalny) */
.collapsible {
  font-size: 11px;                     /* --font-size-micro */
  line-height: 14px;
  color: var(--label-muted);
  padding: 4px 0 4px 6px;
}

/* menu przełącznika workspace */
.menu {
  width: 210px;
  border-radius: 8px;
  background: #171718;
  border: 1px solid var(--color-border-translucent-strong);   /* #ffffff14 */
  padding: 4px 0;
  transition: transform .16s var(--ease-out-quad), opacity .16s var(--ease-out-quad);
}
.menu[data-starting-style] { opacity: 0; transform: scale(.9); }

.menuItem { height: 32px; font-size: 13px; font-weight: 510; padding: 0 12px; }
.menuItem::after {                      /* podświetlenie wsunięte od krawędzi */
  content: ""; position: absolute; inset: 0 4px;
  background: #ffffff08; border-radius: 6px; opacity: 0;
}
.menuItem[data-highlighted]::after { opacity: 1; }
```

**Najważniejsza liczba w całym dokumencie**: różnica między stanem hover a stanem
aktywnym pozycji nawigacji to **2 punkty procentowe alfy bieli**. Hover `#ffffff05`
(2%), aktywna `#ffffff0a` (4%). Nie ma paska po lewej, nie ma koloru akcentu,
nie ma pogrubienia. Aktywna pozycja jest ledwo jaśniejsza od tła i to wystarcza.

Drugi wniosek: **ikony w nawigacji są w NAJCIEMNIEJSZYM stopniu szarości**
(`--color-text-quaternary`, `#62666d`), ciemniejszym niż tekst obok
(`--color-text-secondary`, `#d0d6e0`). Odwrotnie niż w typowym panelu, gdzie ikona
jest równie mocna jak etykieta albo mocniejsza.

Trzeci: **gap między pozycjami to 2px, nie 4px i nie 0.** Pozycje są niemal sklejone,
ale nie stykają się, więc pigułki hover nie zlewają się w pas.

### 4.2 Szerokość panelu bocznego

| Źródło | Wartość | Status |
|---|---|---|
| shadcn/ui `SIDEBAR_WIDTH` | **16rem = 256px** | kod open source |
| shadcn/ui `SIDEBAR_WIDTH_MOBILE` | 18rem = 288px | kod open source |
| shadcn/ui `SIDEBAR_WIDTH_ICON` (zwinięty) | 3rem = 48px | kod open source |
| shadcn/ui skrót zwijania | `Cmd/Ctrl + B` | kod open source |
| Linear, kolumna nawigacji strony | 256px (grid `256px 256px 256px`) | CSS produkcyjny |
| Linear, panel boczny prawy (szczegóły) | **320px**, poniżej 1280px szerokości → **280px** | CSS produkcyjny (replika) |
| Linear, menu workspace | 210px | CSS produkcyjny (replika) |
| Linear, szerokość panelu bocznego w aplikacji | do zweryfikowania | |
| Attio, szerokość panelu bocznego | do zweryfikowania | |

256px jest wartością zgodną między shadcn i siatką Lineara. To bezpieczny domyślny wybór.

### 4.3 Anatomia z shadcn/ui (kod open source)

Do porównania, bo to punkt startowy większości implementacji:

```
SidebarGroupLabel:  h-8, px-2, text-xs, font-medium, text-sidebar-foreground/70
SidebarMenuButton:  default h-8 text-sm | sm h-7 text-xs | lg h-12 text-sm
                    rounded-md, p-2, gap-2, ikona size-4 (16px)
                    stan aktywny: data-[active=true]:bg-sidebar-accent
                                  data-[active=true]:font-medium
                    focus-visible:ring-2
SidebarMenuBadge:   h-5 min-w-5, text-xs, font-medium, TABULAR-NUMS
SidebarMenuSubButton: h-7
SidebarTrigger:     size-7 (28px)
SidebarInput:       h-8
```

Zwróć uwagę, że nawet shadcn stosuje `tabular-nums` na liczniku przy pozycji menu.
To ta sama zasada co w kolumnach liczbowych tabeli: licznik nieprzeczytanych nie ma
skakać przy każdej zmianie.

### 4.4 Gdzie siedzi przełącznik kontekstu

Linear: **na samej górze panelu bocznego**, w jednym rzędzie z ikoną wyszukiwania
i przyciskiem akcji podstawowej. Wysokość 28px, ta sama co pozycja nawigacji, więc
nie tworzy osobnego "nagłówka". Logo 20x20 z radius 2px (prawie kwadrat, nie kółko).
Rozwija menu o szerokości 210px z elementami 32px.

Vercel: przełącznik zespołu/projektu w **górnym pasku** aplikacji, nie w panelu
bocznym. `--header-height: 64px` (CSS produkcyjny strony), na wąskich ekranach
Linear ma `--header-height: 64px`, na szerokich 72px.

Dla panelu obsługującego kilka sklepów naraz to jest realna decyzja architektoniczna:
przełącznik w panelu bocznym (Linear) sugeruje, że kontekst zmienia całą nawigację.
Przełącznik w górnym pasku (Vercel) sugeruje, że nawigacja jest stała, a zmienia się
tylko zawartość.

---

## 5. Kolor

### 5.1 Ile stopni szarości realnie używają

| Produkt | Liczba stopni neutralnych | Struktura |
|---|---|---|
| Stripe | **13** (0, 50, 100, 150, 200, 300, 400, 500, 600, 700, 800, 900, 950) | jedna skala |
| Vercel Geist | **10 pełnych + 10 alfa + 2 tła** | `gray-100..1000`, `gray-alpha-100..1000`, `background-100/200` |
| Attio | **10 czarnych + 9 białych** | dwie osobne skale: `black-0..900`, `white-100..900` |
| Linear | **4 tekstu + 4 tła + 5 poziomów + 5 linii + 3 obramowań** | podzielone rolami, nie stopniami |
| Radix Colors | **12** | kroki o zdefiniowanych rolach (patrz 5.5) |

Linear jest tu odstępstwem wartym uwagi: **nie ma skali numerycznej, są role.**
Cztery stopnie tekstu, cztery tła, pięć poziomów wypiętrzenia, pięć linii. Nie da się
napisać `gray-450`, bo taka wartość nie istnieje. To wymusza dyscyplinę.

### 5.2 Linear, pełna paleta (CSS produkcyjny)

Ciemny motyw, `[data-theme=dark]`:

```
/* tła */
--color-bg-primary:      #08090a     /* prawie czarne, ale nie #000 */
--color-bg-secondary:    #1c1c1f
--color-bg-tertiary:     #232326
--color-bg-quaternary:   #28282c
--color-bg-quinary:      #282828
--color-bg-panel:        #0f1011
--color-bg-translucent:  #ffffff0d
--color-bg-marketing:    #010102

/* poziomy wypiętrzenia (osobna oś od tła) */
--color-bg-level-0: #08090a
--color-bg-level-1: #0f1011
--color-bg-level-2: #141516
--color-bg-level-3: #191a1b
--color-bg-tint:    #141516

/* obramowania */
--color-border-primary:             #23252a
--color-border-secondary:           #34343a
--color-border-tertiary:            #3e3e44
--color-border-translucent:         #ffffff0d   /* biel 5% */
--color-border-translucent-strong:  #ffffff14   /* biel 8% */

/* linie (cieńsze od obramowań, do siatek i separatorów) */
--color-line-primary:    #37393a
--color-line-secondary:  #202122
--color-line-tertiary:   #18191a
--color-line-quaternary: #141515
--color-line-tint:       #141516

/* tekst - DOKŁADNIE cztery stopnie */
--color-text-primary:    #f7f8f8
--color-text-secondary:  #d0d6e0
--color-text-tertiary:   #8a8f98
--color-text-quaternary: #62666d

/* akcent - JEDEN kolor */
--color-brand-bg:    #5e6ad2
--color-brand-text:  #fff
--color-accent:      #7170ff
--color-accent-hover:#828fff
--color-accent-tint: #18182f
--color-link-primary:#828fff

/* cienie i nakładka */
--shadow-low:    0px 2px 4px #0000001a
--shadow-medium: 0px 4px 24px #0003
--shadow-high:   0px 7px 32px #00000059
--color-overlay-primary: #000000d9

/* scrollbar */
--scrollbar-color:        #ffffff1a
--scrollbar-color-hover:  #ffffff33
--scrollbar-color-active: #ffffff66
--scrollbar-size: 6px
--scrollbar-size-active: 10px
--scrollbar-gap: 4px
```

Jasny motyw, `[data-theme=light]`:

```
--color-bg-primary:      #fff
--color-bg-secondary:    #f9f8f9
--color-bg-tertiary:     #f4f2f4
--color-bg-quaternary:   #eeedef
--color-bg-quinary:      #e9e8ea
--color-bg-translucent:  #00000005

--color-bg-level-0: #fff       --color-line-primary:    #d4d4d6
--color-bg-level-1: #f8f8f8    --color-line-secondary:  #eaeaeb
--color-bg-level-2: #f4f4f4    --color-line-tertiary:   #f0f0f0
--color-bg-level-3: #f0f0f0    --color-line-quaternary: #f4f4f4

--color-border-primary:            #e9e8ea
--color-border-secondary:          #e4e2e4
--color-border-tertiary:           #dcdbdd
--color-border-translucent:        #0000000d
--color-border-translucent-strong: #00000014

--color-text-primary:    #282a30
--color-text-secondary:  #3c4149
--color-text-tertiary:   #6f6e77
--color-text-quaternary: #86848d

--color-brand-bg:     #7070ff      /* JAŚNIEJSZY niż w ciemnym motywie */
--color-accent:       #7170ff
--color-accent-hover: #8989f0
--color-accent-tint:  #f1f1ff

--shadow-tiny:   0px 1px 1px 0px #00000017
--shadow-low:    0px 1px 4px -1px #00000017
--shadow-medium: 0px 3px 12px #00000017
--shadow-high:   0px 7px 24px #0000000f
--color-overlay-primary: #ffffffa6      /* nakładka BIAŁA, nie czarna */
```

Kolory statusów, wspólne dla obu motywów:

```
--color-blue:   #4ea7fc   (P3: color(display-p3 .431 .6816 .9988), fallback #5eb0ff)
--color-red:    #eb5757
--color-green:  #27a644
--color-orange: #fc7840
--color-yellow: #f0bf00
--color-indigo: #5e6ad2
--color-teal:   #00b8cc
```

### 5.3 Vercel Geist, skala neutralna (CSS produkcyjny)

| Token | Jasny | Ciemny | HSL jasny | HSL ciemny |
|---|---|---|---|---|
| `--ds-background-100` | `#fff` | `hsl(0 0% 4%)` | 0,0%,100% | 0,0%,4% |
| `--ds-background-200` | `#fafafa` | `hsl(0 0% 0%)` | 0,0%,98% | 0,0%,0% |
| `--ds-gray-100` | `#f2f2f2` | `#1a1a1a` | 0,0%,95% | 0,0%,10% |
| `--ds-gray-200` | `#ebebeb` | `#1f1f1f` | 0,0%,92% | 0,0%,12% |
| `--ds-gray-300` | `#e6e6e6` | `#292929` | 0,0%,90% | 0,0%,16% |
| `--ds-gray-400` | `#eaeaea` | `#2e2e2e` | 0,0%,92% | 0,0%,18% |
| `--ds-gray-500` | `#c9c9c9` | `#454545` | 0,0%,79% | 0,0%,27% |
| `--ds-gray-600` | `#a8a8a8` | `#878787` | 0,0%,66% | 0,0%,53% |
| `--ds-gray-700` | `#8f8f8f` | `#8f8f8f` | 0,0%,56% | 0,0%,56% |
| `--ds-gray-800` | `#7d7d7d` | `#7d7d7d` | 0,0%,49% | 0,0%,49% |
| `--ds-gray-900` | `#4d4d4d` | `#a0a0a0` | 0,0%,30% | 0,0%,63% |
| `--ds-gray-1000` | `#171717` | `#ededed` | 0,0%,9% | 0,0%,93% |

Uwaga do wdrożenia: `gray-700` i `gray-800` mają **tę samą wartość w obu motywach**.
To celowe, są to stopnie "granicznej czytelności" działające na obu tłach, więc
nie wymagają przełączania.

Równoległa skala alfa, do elementów, które muszą wtapiać się w kolorowe tło:

| Token | Jasny | Ciemny |
|---|---|---|
| `--ds-gray-alpha-100` | `#0000000d` (5%) | `#ffffff0f` (7%) |
| `--ds-gray-alpha-200` | `#00000014` (8%) | `#ffffff17` (9%) |
| `--ds-gray-alpha-300` | `#0000001a` (10%) | `#ffffff21` (13%) |
| `--ds-gray-alpha-400` | `#00000014` (8%) | `#ffffff24` (14%) |
| `--ds-gray-alpha-500` | `#00000036` (21%) | `#ffffff3d` (24%) |
| `--ds-gray-alpha-600` | `#00000057` (34%) | `#ffffff82` (51%) |
| `--ds-gray-alpha-700` | `#00000070` (44%) | `#ffffff8a` (54%) |
| `--ds-gray-alpha-800` | `#00000082` (51%) | `#ffffff78` (47%) |
| `--ds-gray-alpha-900` | `#000000b3` (70%) | `#ffffff9c` (61%) |
| `--ds-gray-alpha-1000` | `#000000e8` (91%) | `#ffffffeb` (92%) |

**Skala alfa jest osobnym systemem, nie wyliczeniem ze skali pełnej.** Wartości alfa
w ciemnym motywie są celowo wyższe niż w jasnym (13% vs 10%, 24% vs 21%), bo biel
na ciemnym tle ma mniejszą siłę percepcyjną niż czerń na jasnym.

### 5.4 Stripe, pełna paleta (CSS produkcyjny)

Neutralne, 13 stopni:

```
gray0:   #ffffff    gray300: #a3acba    gray700: #414552
gray50:  #f6f8fa    gray400: #87909f    gray800: #30313d
gray100: #ebeef1    gray500: #687385    gray900: #1a1b25
gray150: #d5dbe1    gray600: #545969    gray950: #10111a
gray200: #c0c8d2
```

Sześć rodzin kolorów, po 11 stopni każda:

```
blue   (info):      50 #ddfffe  300 #06b9ef  500 #0570de  700 #04438c  900 #011c3a
green  (success):   50 #ecfed7  300 #48c404  500 #228403  700 #0b5019  900 #02220d
orange (attention): 50 #fef9da  300 #ff8f0e  500 #c84801  700 #842106  900 #331302
red    (critical):  50 #fff5fa  300 #fe87a1  500 #df1b41  700 #890d37  900 #3e021a
purple (brand):     50 #f9f7ff  300 #b49cfc  500 #625afa  700 #3f32a1  900 #14134e
```

**Mapowanie ról, to jest najbardziej użyteczna część systemu Stripe:**

```
backgroundColor-surface:    neutral0      (#ffffff)
backgroundColor-container:  neutral50     (#f6f8fa)
borderColor-neutral:        neutral150    (#d5dbe1)
borderColor-critical:       critical500

textColor-primary:    neutral700   (#414552)   <- NIE czarny
textColor-secondary:  neutral500   (#687385)
textColor-disabled:   neutral300   (#a3acba)
textColor-brand:      brand500
textColor-info:       info500
textColor-success:    success500
textColor-attention:  attention500
textColor-critical:   critical500

iconColor-primary:    neutral600   (#545969)   <- ciemniejszy niż tekst primary
iconColor-secondary:  neutral400   (#87909f)
iconColor-disabled:   neutral200
```

Dwie rzeczy do zapamiętania:

1. **Tekst podstawowy Stripe to `#414552`, nie czerń.** Panel finansowy, w którym
   ludzie siedzą godzinami, nie używa `#000` ani `#111` na tekst.
2. **Ikony mają OSOBNĄ skalę ról od tekstu** i są konsekwentnie o jeden stopień
   inne niż tekst obok. To ta sama zasada, którą Linear stosuje w nawigacji.

### 5.5 Radix Colors, semantyka 12 kroków

Radix publikuje skalę, w której każdy krok ma przypisaną rolę. Do użycia jako
mapa myślowa, nawet jeśli nie bierzesz ich hexów:

| Kroki | Rola |
|---|---|
| 1-2 | tła aplikacji i subtelne tła komponentów |
| 3-5 | tła komponentów: **3 = stan normalny, 4 = hover, 5 = wciśnięty lub wybrany** |
| 6-8 | obramowania: 6 = subtelne, 7 = normalne, 8 = mocne lub focus |
| 9-10 | pełne wypełnienia, krok 9 ma najwyższą chromę w całej skali |
| 11-12 | tekst: **11 = niski kontrast, 12 = wysoki kontrast** |

Cele kontrastu Radix są liczone algorytmem **APCA**, nie WCAG 2.x. Każda skala ma
wariant alfa dla komponentów wtapiających się w kolorowe tło. Dark mode działa przez
dodanie klasy `dark` na `html` lub `body`.

Trzy pary kroków (3/4/5 dla tła i 11/12 dla tekstu) to najprostszy przepis na
rozróżnienie hover, wybrania i zaznaczenia w tabeli, bez zgadywania alf.

### 5.6 Jak wąsko stosują akcent

Policzone z CSS produkcyjnego:

| Produkt | Kolor akcentu | Gdzie się pojawia |
|---|---|---|
| Linear | `#5e6ad2` ciemny / `#7070ff` jasny | przycisk podstawowy, link, focus ring, zaznaczenie tekstu. **Nie ma go w nawigacji, nie ma go w tabeli** |
| Vercel | `--ds-blue-700` jasny / `--ds-blue-900` ciemny | wyłącznie focus ring i linki |
| Attio | `--color-blue-500 #266df0` | link, pierścień focusu (jako `#266df04d`, 30% alfy) |
| Stripe | `brand500 #625afa` | tekst brandowy, ikona brandowa |

Wzorzec jest jednoznaczny: **jeden kolor akcentu, cztery zastosowania maksymalnie
(przycisk podstawowy, link, focus, zaznaczenie).** Stany (sukces, ostrzeżenie, błąd)
nie są akcentem, mają własne rodziny. Nawigacja, tabela i chrome są całkowicie
achromatyczne.

### 5.7 Kodowanie stanów

Linear: `--color-green: #27a644` (sukces), `--color-red: #eb5757` (błąd),
`--color-orange: #fc7840` (ostrzeżenie), `--color-yellow: #f0bf00`,
`--color-blue: #4ea7fc` (informacja).

Attio: `--color-green-500 #0fc27b`, `--color-red-500 #ff5b59`,
`--color-yellow-500 #f5b900`, każdy z wariantem `-600` na hover.

Stripe: pełne 11-stopniowe rodziny na każdy stan, z konwencją że stopień 500 to
kolor tekstu i obramowania, stopień 50-100 to tło plakietki.

Dla panelu ESP, gdzie statusy wysyłki są krytyczne, wzorzec Stripe jest właściwy:
plakietka statusu = tło stopień 50-100, tekst stopień 500, obramowanie stopień 150.

---

## 6. Elewacja i obramowania

### 6.1 Odpowiedź na pytanie "cienie czy hairline'y": jedno i drugie, ale nie naraz

Wzorzec jest identyczny u wszystkich czterech: **hairline niesie strukturę, cień
niesie warstwę**. Element w płaszczyźnie strony (karta, wiersz, pole) dostaje
hairline i zero cienia. Element unoszący się nad stroną (menu, popover, dialog,
toast) dostaje cień, ale cień ZAWSZE zawiera warstwę 1px obramowania jako pierwszy
składnik.

Vercel zapisuje to najbardziej dosłownie (CSS produkcyjny):

```css
--ds-shadow-border-base:   0 0 0 1px #00000014;                 /* ciemny: 0 0 0 1px #ffffff25 */
--ds-shadow-border-inset:  inset 0 0 0 1px #00000014;           /* ciemny: inset ... #ffffff1a */
--ds-shadow-background-border: 0 0 0 1px var(--ds-background-200);

--ds-shadow-2xs:  0px 1px 1px #0000000a;                        /* ciemny: 0px 1px 1px #00000029 */
--ds-shadow-xs:   0px 1px 2px #0000000a;                        /* ciemny: 0px 1px 2px #00000029 */
--ds-shadow-small:0px 2px 2px #0000000a;
--ds-shadow-medium: 0px 2px 2px #0000000a, 0px 8px 8px -8px #0000000a;
--ds-shadow-large:  0px 2px 2px #0000000a, 0px 8px 16px -4px #0000000a;
--ds-shadow-xl:     0px 1px 1px #00000005, 0px 4px 8px -4px #0000000a, 0px 16px 24px -8px #0000000f;
--ds-shadow-2xl:    0px 1px 1px #00000005, 0px 8px 16px -4px #0000000a, 0px 24px 32px -8px #0000000f;

/* kompozyty: obramowanie + cień + obramowanie tła */
--ds-shadow-border:        var(--ds-shadow-border-base), var(--ds-shadow-background-border);
--ds-shadow-border-small:  var(--ds-shadow-border-base), var(--ds-shadow-small), var(--ds-shadow-background-border);
--ds-shadow-border-medium: var(--ds-shadow-border-base), var(--ds-shadow-medium), var(--ds-shadow-background-border);
--ds-shadow-border-large:  var(--ds-shadow-border-base), var(--ds-shadow-large), var(--ds-shadow-background-border);

/* semantyczne, per komponent */
--ds-shadow-tooltip: var(--ds-shadow-border-base), 0px 1px 1px #00000005, 0px 4px 8px #0000000a, var(--ds-shadow-background-border);
--ds-shadow-menu:    var(--ds-shadow-border-base), 0px 1px 1px #00000005, 0px 4px 8px -4px #0000000a, 0px 16px 24px -8px #0000000f, ...;
--ds-shadow-modal:   var(--ds-shadow-border-base), 0px 1px 1px #00000005, 0px 8px 16px -4px #0000000a, 0px 24px 32px -8px #0000000f, ...;
--ds-shadow-modal-elevated: 0px 0px 0px 1px #00000014, 0px 32px 72px -12px #0000000f,
                            0px 8px 32px -12px #00000014, 0px 8px 24px -12px #0000001f;
```

Alfy cieni Vercela w jasnym motywie to **4%, 5%, 6% i 10%**, nie 15-25% jak
w domyślnych cieniach Tailwinda. Panel nie potrzebuje cieni, które widać.

### 6.2 Attio, siedmiowarstwowa drabina (CSS produkcyjny)

Najbardziej regularny system z całej czwórki. Rozmycie podwaja się co krok,
przesunięcie podwaja się, odsunięcie negatywne podwaja się, alfa rośnie o 1 punkt:

```css
--shadow-attio-layer-1: 0px  1px   3px    0px #00000003;   /* 1% */
--shadow-attio-layer-2: 0px  2px   4px   -1px #00000005;   /* 2% */
--shadow-attio-layer-3: 0px  4px   8px   -2px #00000008;   /* 3% */
--shadow-attio-layer-4: 0px  8px  16px   -4px #0000000a;   /* 4% */
--shadow-attio-layer-5: 0px 16px  32px   -8px #0000000d;   /* 5% */
--shadow-attio-layer-6: 0px 32px  64px  -16px #0000000f;   /* 6% */
--shadow-attio-layer-7: 0px 64px 128px  -32px #00000012;   /* 7% */
```

Maksymalna alfa w całym systemie to **7%**. To jest liczba, która robi różnicę
między panelem "drogim" a panelem "z bootstrapa".

### 6.3 Linear, cienie i hairline (CSS produkcyjny)

```css
--border-hairline: 1px;      /* na ekranach zwykłych */
--border-hairline: .5px;     /* na ekranach o wysokiej gęstości pikseli */
```

Linear ma **hairline jako zmienną zależną od gęstości ekranu**. Na retinie
obramowania mają fizycznie pół piksela. To jest szczegół, którego się nie widzi,
ale czuje: interfejs wygląda ostrzej.

Cienie ciemnego motywu:
```
--shadow-low:    0px 2px 4px #0000001a
--shadow-medium: 0px 4px 24px #0003
--shadow-high:   0px 7px 32px #00000059
--shadow-stack-low: 0px 8px 2px 0px #0000, 0px 5px 2px 0px #00000003,
                    0px 3px 2px 0px #0000000a, 0px 1px 1px 0px #00000012,
                    0px 0px 1px 0px #00000014
```

Cienie jasnego motywu:
```
--shadow-tiny:   0px 1px 1px 0px #00000017
--shadow-low:    0px 1px 4px -1px #00000017
--shadow-medium: 0px 3px 12px #00000017
--shadow-high:   0px 7px 24px #0000000f
```

**W ciemnym motywie Linear ustawia wszystkie cienie w `:root` na `--shadow-none:
0px 0px 0px transparent` i przywraca je dopiero per motyw.** Cień na ciemnym tle
prawie nic nie robi, więc warstwy sygnalizuje skalą `--color-bg-level-0..3`.
To jest odpowiedź na pytanie z sekcji 8: wypiętrzenie w ciemnym motywie robi się
jasnością tła, nie cieniem.

Cień dialogu palety poleceń (CSS produkcyjny):
```css
/* ciemny */
box-shadow: 0 4px 40px #0000001a, 0 3px 20px #00000020, 0 3px 12px #00000020,
            0 2px 8px #00000020, 0 1px 1px #00000020;
/* jasny */
box-shadow: 0 9px 48px #00000014, 0 6px 24px #0000001a, 0 1px 1px #0000000a;
```

Pięć warstw w ciemnym, trzy w jasnym. Zawsze z warstwą `0 1px 1px` na końcu, która
robi za obramowanie.

### 6.4 Stripe, cienie (CSS produkcyjny)

```css
--shadow-top:   rgb(0 0 0 / 12%) 0px 1px 1px 0px;
--shadow-base:  rgb(64 68 82 / 8%) 0px 2px 5px 0px, 0 0 0 0 transparent;
--shadow-hover: rgb(64 68 82 / 8%) 0px 2px 5px 0px, rgb(64 68 82 / 8%) 0px 3px 9px 0px;
--shadow-focus: 0 0 0 4px rgb(1 150 237 / 36%);
```

Stripe nie używa czystej czerni w cieniach, tylko `rgb(64 68 82)`, czyli
**granatowo-szarego**. To jest ten sam trik co w Material Design: cień
o odcieniu tła wygląda naturalniej niż cień czarny.

Zwróć też uwagę, że `--shadow-base` kończy się na `0 0 0 0 transparent`.
To slot pod cień hover, żeby przejście `box-shadow` animowało się płynnie,
a nie skakało. To jest szczegół implementacyjny, którego nie widać w żadnym
przewodniku, a decyduje o tym, czy hover na karcie wygląda dobrze.

### 6.5 Promienie zaokrągleń

| Produkt | Skala | Uwagi |
|---|---|---|
| **Linear** | 4, 6, 8, 12, 16, 24, 32, 9999px, 50% | `--radius-4` ... `--radius-32`, `--radius-rounded`, `--radius-circle` |
| **Stripe** | xsmall 4, small 4, medium 8, large 10, rounded 999em | xsmall i small są identyczne (4px) |
| **Attio** | xs 2, sm 4, md 6, lg 8, xl 12, 2xl 16, 3xl 20px | `.125/.25/.375/.5/.75/1/1.25rem` |
| **Tailwind 4 domyślnie** | xs 2, sm 4, md 6, lg 8, xl 12, 2xl 16, 3xl 24, 4xl 32px | identyczne z Attio do 2xl |
| **Raycast** | `--radius-md: 6px`, `--radius: 8px` | |

Konkretne zastosowania z CSS produkcyjnego:

```
Linear, przycisk:                --radius-rounded (9999px, pigułka)
Linear, wiersz listy hover:      8px
Linear, nagłówek grupy:          8px
Linear, pozycja nawigacji:       8px
Linear, ikona w nawigacji:       2px
Linear, checkbox w wierszu:      4px  (--radius-4)
Linear, tooltip:                 8px  (--radius-8)
Linear, toast:                   6px
Linear, dialog palety poleceń:   12px
Linear, popup select:            10px
Linear, element w popupie:       6px
Linear, plakietka klawisza:      3px (w palecie) / 4px (komponent KBD)
Linear, badge/pigułka filtra:    9999px
Attio, pole i przycisk:          do zweryfikowania
Stripe, pole formularza:         4px (radius-small)
Stripe, karta:                   8px (radius-medium)
```

Wzorzec do przeniesienia: **4px dla najmniejszych elementów (checkbox, klawisz),
6px dla elementów menu, 8px dla wierszy, kart i pól, 12px dla dialogów,
9999px dla przycisków i plakietek statusu.** Pięć wartości.

Uwaga: Linear stosuje **pigułkę (9999px) na przyciskach**, nie 6px. To jest jedna
z najbardziej rozpoznawalnych decyzji ich systemu i najtańsza do skopiowania.

### 6.6 Grubość obramowania

```
Linear: --border-hairline: 1px  /  0.5px na high-DPI
Vercel: obramowania robione jako box-shadow 0 0 0 1px, nie border
Attio:  --tw-inset-ring-color: #1010101a  (inset ring 1px)
```

**Vercel i Attio rysują obramowania cieniem lub ringiem, nie właściwością `border`.**
Powód praktyczny: obramowanie z `box-shadow` nie zajmuje miejsca w modelu pudełkowym,
więc element nie zmienia rozmiaru przy pojawieniu się obramowania na hover ani focusie.
To jest przyczyna, dla której premium panele nie "drgają" przy najechaniu.

---

## 7. Co odróżnia narzędzie klasy premium od przeciętnego panelu

Ta sekcja to lista rzeczy, które są w CSS produkcyjnym tych narzędzi, a których
nie ma w domyślnym panelu z shadcn/ui. Każda jest tania do wdrożenia.

### 7.1 Stan aktywny: różnica 2 punktów procentowych

Powtórzenie z sekcji 4, bo to najważniejsza pojedyncza obserwacja z całego researchu.
Linear, CSS produkcyjny:

```
spoczynek       przezroczysty
hover           #ffffff05   (biel 2%)   pozycja nawigacji
hover           #ffffff08   (biel 3%)   wiersz listy, element menu
aktywny         #ffffff0a   (biel 4%)   pozycja nawigacji
zaznaczony      #ffffff14   (biel 8%)   zakładka filtra
```

Hover ma dwie wartości zależnie od kontekstu: **2% w wąskim panelu bocznym,
3% na szerokim wierszu listy**. Im większa powierzchnia podświetlenia, tym niższa
musi być alfa, żeby wrażenie jasności było takie samo. Pełny wykaz w sekcji 8.6.

Przeciętny panel oznacza aktywną pozycję kolorem akcentu, paskiem po lewej
i pogrubieniem. Linear zmienia tylko tło o 2 punkty procentowe alfy i kolor tekstu
o jeden stopień. Trzy sygnały o niskiej intensywności zamiast jednego mocnego.

Drugi element: **zaznaczenie (`selected`) jest dwa razy mocniejsze od aktywnego
(`active`)**, 8% vs 4%. To rozróżnia "jestem tutaj" od "wybrałem to".

### 7.2 Focus ring: cztery podejścia z CSS produkcyjnego

(Dziewięć specyfikacji łącznie z systemami publikowanymi: zestawienie w sekcji 10.9.)

Wszystkie z CSS produkcyjnego:

```css
/* Linear, globalnie */
--focus-ring-color: var(--color-indigo);   /* #5e6ad2 */
--focus-ring-width: 2px;
--focus-ring-offset: 2px;
/* w jasnym motywie kolor zmienia się na neutralny: */
[data-theme=light] { --focus-ring-color: #0006; }   /* czerń 40% */

/* Linear, wiersz listy - ring DO ŚRODKA */
.rowButton:focus-visible {
  outline: 2px solid var(--color-text-secondary);
  outline-offset: -2px;
  border-radius: 8px;
}

/* Vercel - dwuwarstwowy box-shadow, przerwa w kolorze tła */
--ds-focus-ring: 0 0 0 2px var(--ds-background-100), 0 0 0 4px var(--ds-focus-color);
.element:focus-visible { box-shadow: var(--ds-focus-ring); outline: none; }
/* wariant z obramowaniem */
--ds-focus-border: 0 0 0 1px var(--ds-gray-alpha-600), 0 0 0 4px #00000029;  /* ciemny: #ffffff3d */

/* Attio */
--internal-color-focus-ring: #266df04d;   /* jasny: niebieski 30% */
--internal-color-focus-ring: #709ff599;   /* ciemny: jaśniejszy niebieski 60% */
/* stosowany jako focus-visible:ring-3, czyli 3px */

/* Stripe */
--shadow-focus: 0 0 0 4px rgb(1 150 237 / 36%);
```

Cztery wnioski praktyczne:

1. **Zawsze `:focus-visible`, nigdy `:focus`.** Wszystkie cztery używają wyłącznie
   `:focus-visible`, więc ring nie pojawia się przy kliknięciu myszą.
2. **Dwuwarstwowy ring Vercela jest najlepszym rozwiązaniem dla tabeli.** Pierwsza
   warstwa 2px w kolorze tła robi przerwę, druga 4px to właściwy pierścień. Dzięki
   przerwie ring jest widoczny na dowolnym tle, także na wierszu w stanie hover.
3. **Wewnątrz kontenera przewijanego używaj `outline-offset: -2px`** (wzorzec Lineara).
   Ring narysowany na zewnątrz zostanie przycięty przez `overflow: hidden`.
4. **W jasnym motywie ring może być neutralny, nie akcentowy.** Linear przełącza go
   na `#0006`. Na jasnym tle neutralny ring jest mniej krzykliwy i lepiej się
   komponuje z gęstą tabelą.

Alfa pierścienia jest wyraźnie wyższa w ciemnym motywie: Attio 30% w jasnym vs 60%
w ciemnym, Vercel `#00000029` (16%) vs `#ffffff3d` (24%).

### 7.3 Mikrointerakcje: konkretne czasy z CSS produkcyjnego

Linear ma nazwane prędkości:

```css
--speed-quickTransition:   .1s
--speed-regularTransition: .25s
--speed-highlightFadeIn:   0s      /* podświetlenie pojawia się NATYCHMIAST */
--speed-highlightFadeOut:  .15s    /* i znika z wygaszeniem */
```

To jest szczegół, którego nie ma w żadnym przewodniku, a decyduje o wrażeniu
responsywności: **reakcja na wejście kursora jest natychmiastowa, wygaszenie jest
miękkie.** Przeciętny panel animuje oba kierunki tak samo, przez co hover wydaje
się opóźniony.

Faktyczne czasy per komponent (CSS produkcyjny, Linear):

| Komponent | Czas | Krzywa |
|---|---|---|
| Przycisk (border, tło, kolor, cień, transform) | **160ms** | `--ease-out-quad` |
| Pozycja nawigacji, tło | 160ms | `--ease-out-quad` |
| Wiersz listy, tło | 160ms | `--ease-out-quad` |
| Tooltip, otwarcie i zamknięcie | **120ms** | `--ease-out-quad` |
| Popup select, otwarcie | **80ms** | `--ease-out-quad` |
| Popup select, zamknięcie | **60ms** | `--ease-out-quad` |
| Menu workspace | 160ms | `--ease-out-quad` |
| Dialog palety poleceń | **175ms** | `--ease-out-quad` |
| Odbicie dialogu przy błędnym wejściu | 150ms | własna |
| Rozwijanie palety (max-height) | 80ms | liniowa |
| Ikona chevron, obrót | 120ms | `--ease-out-quad` |
| Sidebar shadcn, szerokość | 200ms | `ease-linear` |

Zakres to **60-200ms**. Nic w chrome UI nie animuje się dłużej niż 200ms.
Domyślne 150ms Tailwinda mieści się w tym przedziale, ale jest za wolne dla
zamykania popoverów (60-80ms) i za szybkie dla dialogów (175ms).

Krzywa: Linear ma pełen zestaw 18 krzywych, ale w praktyce w chrome UI używa
jednej: `--ease-out-quad: cubic-bezier(.25, .46, .45, .94)`. Attio używa
`--ease-out: cubic-bezier(0, 0, 0, 1)` i `--ease-in-out: cubic-bezier(.2, 0, 0, 1)`.
Tailwind 4 domyślnie `cubic-bezier(0.4, 0, 0.2, 1)`.

**Wciśnięcie przycisku.** Linear stosuje to na wszystkich wariantach przycisku:

```css
.button:not([disabled]):active { transform: scale(.97); }
.button-primary:not([disabled]):active { filter: brightness(98%); transform: scale(.97); }
.button-primary:not([disabled]):hover  { filter: brightness(115%); }
```

Hover na przycisku podstawowym to nie inny kolor, tylko `brightness(115%)`.
Wciśnięcie to `scale(.97)` plus `brightness(98%)`. Jedna reguła, działa na każdym
kolorze przycisku, nigdy nie wypada z palety.

**Osłona hoveru.** Każda reguła hover w CSS Lineara jest opakowana w
`@media (any-hover: hover)`. Na urządzeniu dotykowym styl hover się nie stosuje,
więc przycisk nie zostaje "zawieszony" w stanie hover po dotknięciu.

**Ograniczenie ruchu.** Linear wyłącza animacje shimmer pod
`@media (prefers-reduced-motion: reduce)` i zatrzymuje je na pozycji 50%.
Nie usuwa efektu, tylko go zatrzymuje.

### 7.4 Wyszukiwanie z klawiatury: pełna specyfikacja palety poleceń

Linear, CSS produkcyjny, kompletny komponent:

```css
.dialog {
  --input-height: 46px;
  max-width:  min(720px, 100vw - 32px);
  max-height: min(73vh, 500px);
  position: fixed; top: 13vh; left: 50%; transform: translate(-50%);
  border-radius: 12px;
  background: var(--color-bg-level-1);          /* #0f1011 */
  border: 1px solid var(--color-border-translucent);
  animation: scaleIn .175s var(--ease-out-quad);
  box-shadow: 0 4px 40px #0000001a, 0 3px 20px #00000020, 0 3px 12px #00000020,
              0 2px 8px #00000020, 0 1px 1px #00000020;
}
@keyframes scaleIn { from { opacity: 0; transform: translate(-50%) scale(.96); } }

.overlay { background: var(--color-overlay-primary); animation: fadeIn .175s var(--ease-out-quad); }

.input {
  height: 46px; padding: 0 18px; font-size: 15px;
  background: none; border: none;
  color: var(--color-text-secondary);
  caret-color: var(--color-brand-bg);           /* kursor w kolorze akcentu */
}
.input:focus-visible { outline: none; }         /* input NIE dostaje ringu, ma go dialog */

.list { padding: 6px; scroll-padding-block: 6px; overflow-y: auto; }

.groupHeading {
  height: 30px; padding-inline: 12px;
  font-size: 12px; font-weight: 510;
  color: var(--color-text-tertiary);
}

.item {
  min-height: 46px; padding: 8px 12px; gap: 12px;
  font-size: 13px; line-height: 1.2;
  color: var(--color-text-secondary);
}
.item[aria-selected=true] { color: var(--color-text-primary); }
.item[aria-selected=true]::after {
  content: ""; position: absolute; inset: 2px 0; z-index: -1;
  background: var(--color-bg-level-3); border-radius: 8px;
}

.item .icon { width: 16px; height: 16px; }
.item .icon svg { fill: var(--color-text-tertiary); }
.item[aria-selected=true] .icon svg { fill: var(--color-text-primary); }

.shortcut span {
  min-width: 20px; height: 20px; padding: 0 4px;
  font-size: 11px; font-weight: 510;
  color: var(--color-text-tertiary);
  border: 1px solid var(--color-border-translucent);
  border-radius: 3px; background: none;
}

.empty { padding-block: 20px; font-size: 14px; color: var(--color-text-tertiary);
         display: flex; justify-content: center; align-items: center; gap: 4px; }

/* podświetlenie dopasowania w wyniku */
.detail mark { font-weight: 590; color: var(--color-text-primary); background: none; }
```

Cztery szczegóły warte skopiowania:

1. **Dialog jest wysoko, `top: 13vh`, nie wyśrodkowany pionowo.** Lista rozwija się
   w dół i nie przesuwa pola wpisywania.
2. **Podświetlenie dopasowanego fragmentu robione jest wagą i kolorem, nie żółtym
   tłem.** `mark { font-weight: 590; color: primary; background: none; }`
3. **Kursor tekstowy w polu ma kolor akcentu** (`caret-color`). Jedno z niewielu
   miejsc, gdzie akcent w ogóle się pojawia.
4. **`scroll-padding-block: 6px`** na liście, żeby przy nawigacji strzałkami wybrany
   element nie przyklejał się do krawędzi.

Komponent klawisza (Linear `KBD`, CSS produkcyjny):

```
rozmiar small:  font-size 10px, klawisz min 16x16px, radius 4px
rozmiar normal: font-size 13px, klawisz min 20x20px, radius 4px
wariant normal: color text-secondary, background bg-quaternary, border 1px border-primary
wariant glass:  color text-primary, background #ffffff29, brak obramowania
odstęp między klawiszami: 4px
klawisze modyfikatorów (Shift/Command/Ctrl/Alt) w trybie width-aware: min-width 48px,
  wyrównane do lewej
```

Przyciski Lineara mogą zawierać `<kbd>` z podpowiedzią skrótu, który znika
poniżej 640px i na urządzeniach bez hoveru:

```css
@media not (any-hover: hover) { .button > kbd { display: none; } }
@media (max-width: 640px)     { .button > kbd { display: none; } }
```

Skrót zwijania panelu bocznego w shadcn/ui: `Cmd/Ctrl + B` (kod open source).

### 7.5 Puste stany

Z CSS produkcyjnego mam tylko wzorzec Lineara dla pustych wyników wyszukiwania:
`padding-block: 20px`, `font-size: 14px`, kolor trzeciorzędny, wyśrodkowane
poziomo i pionowo, `gap: 4px` (miejsce na ikonę obok tekstu). Czyli **pusty stan
w gęstym widoku jest jedną linią tekstu, nie ilustracją.**

Rozróżnienie, które warto zaimplementować, bo to trzy różne komunikaty:
- **pusto, bo nic jeszcze nie ma** (pierwsze uruchomienie) - miejsce na akcję
- **pusto, bo filtr nic nie znalazł** - miejsce na "wyczyść filtry"
- **pusto, bo błąd** - miejsce na "spróbuj ponownie"

Konkretne wymiary i treści dla pustych stanów w Linearze i Attio: do zweryfikowania.

### 7.6 Stany ładowania

Linear ma komponent shimmer działający na tekście, nie na prostokątach
(CSS produkcyjny, klasa `.zzFi7W_root`):

```css
.shimmer {
  color: transparent;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  -webkit-background-clip: text;
  background-blend-mode: screen, normal;
  background-size: 180px 72px, 100% 100%;
  background-position: -180px, 0;
  background-repeat: no-repeat, no-repeat;
  animation: shimmerSweep 2s linear infinite;
  will-change: background-position;
  white-space: nowrap;
  font: inherit; line-height: inherit; letter-spacing: inherit;
}
@keyframes shimmerSweep {
  0%, 100%      { background-position: -180px, 0; }
  90%, 99.999%  { background-position: calc(100% + 180px), 0; }
}
@media (prefers-reduced-motion: reduce) {
  .shimmer { background-position: 50%, 0; animation: none; }
}
```

Trzy rzeczy: pas świetlny ma **180px szerokości**, przebieg trwa **2s**,
i `font: inherit; line-height: inherit; letter-spacing: inherit` gwarantuje,
że placeholder zajmuje **dokładnie tyle miejsca co docelowy tekst**, więc nie ma
przeskoku layoutu po wczytaniu.

### 7.7 Gęste widoki: jak skalują komponenty

Linear ma dwa rozmiary plakietki, sterowane atrybutem (CSS produkcyjny):

```css
.badge {
  --badge-height: 24px;
  --badge-avatar: 16px;
  --badge-label-offset: 8px;
  font-size: 12px; line-height: 14px; font-weight: 510;
  border-radius: 9999px;
  padding-inline: var(--badge-label-offset) 4px;   /* padding ASYMETRYCZNY */
  gap: 6px;
}
.badge[data-size=small] {
  --badge-height: 22px;
  --badge-avatar: 14px;
  --badge-label-offset: 6px;
  font-size: 10px;
}
.badge[data-bare] { border-color: transparent; padding-inline: 4px; }
```

Wzorzec: **gęstość sterowana zmiennymi CSS na komponencie, nie osobnymi klasami.**
Zmiana `data-size` przestawia cztery liczby naraz. Przy przełączniku gęstości
tabeli (komfortowa / gęsta) to jest właściwa architektura: jeden atrybut na
kontenerze tabeli, zmienne CSS w dół.

Padding plakietki jest **asymetryczny**: 8px z lewej (tekst), 4px z prawej (ikona).
Ikona ma własne światło wewnętrzne, więc nie potrzebuje takiego samego marginesu
co tekst. To jest różnica, którą widać.

### 7.8 Scrollbar

Linear, CSS produkcyjny:

```css
--scrollbar-size: 6px;
--scrollbar-size-active: 10px;      /* pogrubia się przy przeciąganiu */
--scrollbar-gap: 4px;
--scrollbar-color:        #ffffff1a;   /* jasny: #0000001a */
--scrollbar-color-hover:  #ffffff33;   /* jasny: #00000033 */
--scrollbar-color-active: #ffffff66;   /* jasny: #0000004d */
--layer-scrollbar: 75;
```

Scrollbar 6px w spoczynku, 10px przy przeciąganiu, z 4px odstępu od zawartości.
Trzy stany koloru, nie jeden.

### 7.9 Warstwy z (z-index): mieć nazwaną skalę

Linear (CSS produkcyjny). To rozwiązuje problem, przez który w każdym panelu ktoś
w końcu wpisuje `z-index: 9999`:

```
--layer-debug:           11000     --layer-command-menu:  650
--layer-max:             10000     --layer-popover:       600
--layer-skip-nav:         5000     --layer-overlay:       500
--layer-context-menu:     1200     --layer-header:        100
--layer-tooltip:          1100     --layer-scrollbar:      75
--layer-toasts:            800     --layer-footer:         50
--layer-dialog:            700     --layer-3: 3  --layer-2: 2  --layer-1: 1
--layer-dialog-overlay:    699
```

Warto zauważyć kolejność: **tooltip (1100) jest NAD menu kontekstowym? Nie, jest
pod nim (1200).** A paleta poleceń (650) jest pod dialogiem (700), ale nad popoverem
(600). Nakładka dialogu (699) jest dokładnie o 1 pod dialogiem. To są decyzje, które
trzeba podjąć raz i zapisać.

### 7.10 Pozostałe drobiazgi z CSS produkcyjnego

```
--min-tap-size: 44px                    Linear, minimalny obszar dotyku
--border-hairline: .5px na high-DPI     Linear, ostrzejsze obramowania na retinie
--1fr: minmax(0, 1fr)                   Linear, alias naprawiający przepełnienie w gridzie
--underline-thickness: clamp(1px, .0625em, 3px)     Linear, podkreślenie skalujące się z tekstem
--underline-offset:    clamp(2px, .175em, 4px)
--prose-max-width: 624px                Linear, maksymalna szerokość kolumny tekstu
--icon-grayscale-image-filter: grayscale(100%) brightness(400%)    Linear, ujednolica logotypy
```

`--1fr: minmax(0, 1fr)` zasługuje na osobną wzmiankę. To obejście klasycznego
problemu, w którym element w gridzie z długim tekstem rozpycha kolumnę zamiast
się skrócić wielokropkiem. W tabeli z nazwami kampanii to jest realny bug.

`--icon-grayscale-image-filter` to sposób na to, żeby kolorowe logotypy klientów
(w panelu ESP: logotypy sklepów) wyglądały spójnie: odbarwione i rozjaśnione do
poziomu ikon interfejsu, a w stanie wybranym pokazane w pełnym kolorze.

---

## 8. Ciemny motyw

### 8.1 Odpowiedź na pytanie "odwracają czy projektują osobno": projektują osobno

Dowody z CSS produkcyjnego, wszystkie cztery produkty:

**1. Kolor akcentu zmienia się między motywami.**
Linear: `--color-brand-bg` to `#5e6ad2` w ciemnym i `#7070ff` w jasnym.
`--color-accent-hover` to `#828fff` w ciemnym i `#8989f0` w jasnym.
Vercel: `--ds-focus-color` to `--ds-blue-700` w jasnym i `--ds-blue-900` w ciemnym,
czyli inny stopień skali, nie ten sam kolor.

**2. Skale alfa mają inne wartości, nie odwrócone.**
Vercel `--ds-gray-alpha-300`: 10% czerni w jasnym, **13%** bieli w ciemnym.
`--ds-gray-alpha-600`: 34% czerni, **51%** bieli. Nie ma tu żadnej symetrii.

**3. Cienie są przeprojektowane, nie przeskalowane.**
Linear w jasnym: `--shadow-medium: 0px 3px 12px #00000017` (9% alfy, rozmycie 12px).
Linear w ciemnym: `--shadow-medium: 0px 4px 24px #0003` (20% alfy, rozmycie 24px).
Dwa razy większe rozmycie i dwa razy większa alfa.

**4. Nakładka modala zmienia kolor, nie tylko alfę.**
Linear jasny: `--color-overlay-primary: #ffffffa6` (biała, 65%).
Linear ciemny: `--color-overlay-primary: #000000d9` (czarna, 85%).
W jasnym motywie Linear przyciemnia tło **bielą**, nie czernią.

**5. Liczba wag fontu bywa redefiniowana per motyw.**
Linear powtarza `--font-weight-normal/medium/semibold/bold` wewnątrz bloku
`[data-theme=light]`. Nie zmienia wartości w tym konkretnym miejscu, ale sam fakt,
że wagi są w zakresie przełączanym motywem, oznacza, że system jest do tego
przygotowany. To jest standardowa kompensacja: tekst na ciemnym tle wydaje się
grubszy, więc bywa cieńszy o pół stopnia.

### 8.2 Tła: nikt nie używa czystej czerni jako tła treści

| Produkt | Tło podstawowe (ciemny) | Uwagi |
|---|---|---|
| **Linear** | `#08090a` | prawie czarne, ale ma lekki chłodny odcień (niebieskawy) |
| **Linear** panel | `#0f1011` | |
| **Vercel** | `hsl(0 0% 4%)` = `#0a0a0a` (`--ds-background-100`) | `background-200` to `hsl(0 0% 0%)`, czyli czerń jest tłem WTÓRNYM |
| **Attio** | `#101010` (`--color-black-50`) | `--color-black-0: #000` istnieje, ale nie jest przypisane do tła |
| **Raycast** | `#101111` (`--color-bg-100`) | |

Wzorzec jednoznaczny: **tło ciemnego motywu leży w przedziale `#08090a` do `#101111`,
czyli jasność HSL 3-7%.** Czysta czerń jest w palecie u wszystkich, ale nikt nie
używa jej jako tła głównego obszaru pracy.

Drugi wzorzec: **tła ciemne nie są neutralne, mają lekki chłodny odcień.**
Linear `#08090a` (R najniższy, B najwyższy), Raycast `#101111`, Attio `#101010`
(neutralne). Chłodny odcień redukuje wrażenie "wypalonego" ekranu.

### 8.3 Drabina wypiętrzenia w ciemnym motywie: jasność, nie cień

Linear, ciemny (CSS produkcyjny):
```
--color-bg-level-0: #08090a     (tło aplikacji)
--color-bg-level-1: #0f1011     (panel)
--color-bg-level-2: #141516     (karta w panelu)
--color-bg-level-3: #191a1b     (element wybrany, popover)
```
Cztery poziomy, krok jasności ok. 2-3%. To jest cała elewacja ciemnego motywu.

Attio, ciemny:
```
primary-background:        black-50   #101010
secondary-background:      black-100  #1c1d1f
surface-subtle:            black-300  #232529
surface:                   black-400  #2e3238
muted-background:          black-300  #232529
muted-strong-background:   black-400  #2e3238
```

Vercel, ciemny:
```
background-100: hsl(0 0% 4%)    background-200: hsl(0 0% 0%)
gray-100: #1a1a1a  (10%)        gray-300: #292929 (16%)
gray-200: #1f1f1f  (12%)        gray-400: #2e2e2e (18%)
```

Raycast, ciemny:
```
--color-bg-100: #101111    --color-bg-300: #313133
--color-bg-200: #18191a    --color-bg-400: #494b4d
```

Cztery produkty, cztery razy ta sama struktura: **4 poziomy tła, przyrost jasności
2-8% na poziom, brak cieni w obrębie panelu.**

### 8.4 Tekst w ciemnym motywie: nikt nie używa czystej bieli

| Produkt | Tekst podstawowy | Drugorzędny | Trzeciorzędny | Czwartorzędny |
|---|---|---|---|---|
| Linear | `#f7f8f8` | `#d0d6e0` | `#8a8f98` | `#62666d` |
| Attio | `#fff` (white-100) | `#edeff3` (white-400) | `#b5bdc9` (white-900) | `#505967` (black-600) |
| Vercel | `#ededed` (gray-1000) | `#a0a0a0` (gray-900) | `#8f8f8f` (gray-700) | `#878787` (gray-600) |
| Raycast | `#f4f4f6` | `#c2c7ca` | `#78787c` | `#5e6366` |

Trzy z czterech schodzą z bieli o 3-8% (`#f7f8f8`, `#ededed`, `#f4f4f6`).
Tylko Attio zostawia `#fff` na tekście podstawowym, ale ich tło jest o stopień
jaśniejsze (`#101010` vs `#08090a`).

Zwróć też uwagę na **stopień drugorzędny Lineara: `#d0d6e0`**. To nie jest szarość,
to jasny szaroniebieski. Linear celowo trzyma tekst drugorzędny w chłodnym odcieniu,
przez co przy tekście podstawowym `#f7f8f8` (neutralnym) powstaje różnica, którą
oko czyta jako hierarchię, mimo że różnica jasności jest niewielka.

### 8.5 Obramowania w ciemnym motywie: alfa bieli, nie stały szary

Linear (CSS produkcyjny):
```
ciemny:  --color-border-translucent:        #ffffff0d   (biel 5%)
         --color-border-translucent-strong: #ffffff14   (biel 8%)
jasny:   --color-border-translucent:        #0000000d   (czerń 5%)
         --color-border-translucent-strong: #00000014   (czerń 8%)
```

Vercel:
```
--ds-shadow-border-base:  0 0 0 1px #00000014   ->   ciemny: 0 0 0 1px #ffffff25
--ds-shadow-border-inset: inset 0 0 0 1px #00000014 -> ciemny: inset ... #ffffff1a
```

**Obramowanie w ciemnym motywie musi mieć wyższą alfę niż w jasnym.**
Vercel: 8% czerni w jasnym, 15% bieli w ciemnym. Prawie dwa razy więcej.

### 8.6 Interakcje w ciemnym motywie, konkretne alfy Lineara

Wszystkie z CSS produkcyjnego, to jest kompletny zestaw:

```
#ffffff05   (2%)   hover pozycji nawigacji, tło przycisku akcji, tło checkboxa
#ffffff08   (3%)   hover wiersza listy, hover przełącznika workspace,
                   tło zakładki filtra, hover przycisku filtra, podświetlenie w menu
#ffffff0a   (4%)   POZYCJA AKTYWNA w nawigacji, hover przycisku ikonowego
#ffffff0d   (5%)   obramowanie translucent, tło translucent
#ffffff14   (8%)   ZAZNACZONA zakładka filtra, obramowanie translucent-strong
#ffffff1a   (10%)  scrollbar
#ffffff26   (15%)  tło plakietki klawisza w wariancie glass
#ffffff29   (16%)  tło klawisza glass
#ffffff33   (20%)  scrollbar hover
#ffffff66   (40%)  scrollbar aktywny
```

Dziesięć wartości, cała interaktywność panelu. Krok między "spoczynek" a "hover"
a "aktywny" to 2% - 3% - 4%. To jest skala, na której trzeba się nauczyć pracować,
żeby panel przestał wyglądać na kontrastowy i zmęczony.

### 8.7 Implementacja przełącznika w Tailwind 4

Linear używa atrybutu `[data-theme=dark|light|glass]` na elemencie głównym,
Attio klasy `.dark`, Vercel klas `.dark, .dark-theme, .invert-theme`.

Wart uwagi jest wariant Vercela: `--ds-background-100: #fff` jest zdefiniowane
w selektorze `:root, .light-theme, .dark .invert-theme, .dark-theme .invert-theme`.
Czyli **`.invert-theme` wewnątrz ciemnego motywu przywraca jasny**. Dzięki temu
da się osadzić jasny fragment (np. podgląd maila) w ciemnym panelu bez hakowania.
Dla panelu ESP, gdzie operator ogląda kreacje mailowe zaprojektowane na białym tle,
to jest wzorzec wart skopiowania w całości.

---

## 9. Synteza: blok `@theme` dla Tailwind 4

Poniżej zestaw tokenów złożony z potwierdzonych wartości. To propozycja startowa,
nie kanon: każda liczba pochodzi z sekcji wyżej i ma tam swoje źródło.

Założenia przyjęte przy składaniu:
- typografia i tracking: model Attio (waga 500 domyślnie, line-height w bezwzględnych rem)
- tracking dużych nagłówków: trójprogowa reguła Vercela
- kolor: role Lineara (cztery stopnie tekstu, cztery tła, drabina poziomów)
- cienie: drabina Attio (maks. 7% alfy)
- promienie: pięć wartości
- interakcje: alfy Lineara

```css
@theme {
  /* ---------- FONT ---------- */
  --font-sans: "Inter Variable", "Inter", -apple-system, BlinkMacSystemFont,
               "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;

  --font-weight-normal:   400;
  --font-weight-medium:   510;   /* Linear: 510 zamiast 500 przy zmiennym Interze */
  --font-weight-semibold: 590;   /* Linear: 590 zamiast 600 */

  /* ---------- TYPOGRAFIA ---------- */
  /* wartości bezwzględne line-height, wszystko na siatce 2px (wzorzec Attio) */
  --text-2xs:  0.6875rem;  /* 11px - podpis pomocniczy */
  --text-2xs--line-height: 0.875rem;   /* 14px */
  --text-2xs--font-weight: 500;
  --text-2xs--letter-spacing: 0em;

  --text-xs:   0.75rem;    /* 12px - etykieta kolumny, badge */
  --text-xs--line-height: 1rem;        /* 16px */
  --text-xs--font-weight: 510;
  --text-xs--letter-spacing: 0em;

  --text-sm:   0.8125rem;  /* 13px - TEKST TABELI, domyślny tekst chrome UI */
  --text-sm--line-height: 1.25rem;     /* 20px */
  --text-sm--font-weight: 500;
  --text-sm--letter-spacing: -0.005em;

  --text-base: 0.875rem;   /* 14px - tekst formularzy */
  --text-base--line-height: 1.25rem;   /* 20px */
  --text-base--font-weight: 500;
  --text-base--letter-spacing: -0.005em;

  --text-md:   0.9375rem;  /* 15px - tekst czytelniczy */
  --text-md--line-height: 1.375rem;    /* 22px */
  --text-md--font-weight: 400;
  --text-md--letter-spacing: -0.011em;

  --text-lg:   1.0625rem;  /* 17px - tytuł sekcji / karty */
  --text-lg--line-height: 1.5rem;      /* 24px */
  --text-lg--font-weight: 590;
  --text-lg--letter-spacing: -0.012em;

  --text-xl:   1.25rem;    /* 20px - tytuł strony */
  --text-xl--line-height: 1.625rem;    /* 26px */
  --text-xl--font-weight: 590;
  --text-xl--letter-spacing: -0.02em;  /* próg Vercela: do 20px -> -0.02em */

  --text-2xl:  1.5rem;     /* 24px - tytuł dużej strony */
  --text-2xl--line-height: 1.875rem;   /* 30px */
  --text-2xl--font-weight: 590;
  --text-2xl--letter-spacing: -0.04em; /* próg Vercela: 24-32px -> -0.04em */

  --text-3xl:  2rem;       /* 32px */
  --text-3xl--line-height: 2.25rem;    /* 36px */
  --text-3xl--font-weight: 590;
  --text-3xl--letter-spacing: -0.04em;

  /* ---------- ODSTĘPY ---------- */
  --spacing: 0.25rem;   /* baza 4px, Tailwind wylicza resztę */
  /* dopuszczone kroki w kodzie: 0.5 (2px), 1 (4px), 1.5 (6px), 2 (8px),
     3 (12px), 4 (16px), 6 (24px), 8 (32px), 12 (48px), 16 (64px) */

  /* ---------- PROMIENIE ---------- */
  --radius-xs:   0.25rem;   /* 4px  - checkbox, plakietka klawisza */
  --radius-sm:   0.375rem;  /* 6px  - element menu, toast */
  --radius-md:   0.5rem;    /* 8px  - wiersz, karta, pole, pozycja nawigacji */
  --radius-lg:   0.75rem;   /* 12px - dialog, paleta poleceń */
  --radius-full: 9999px;    /*      - przycisk, plakietka statusu */

  /* ---------- KOLOR: jasny motyw (wartości Lineara) ---------- */
  --color-bg-0:  #ffffff;   /* tło aplikacji */
  --color-bg-1:  #f8f8f8;   /* panel */
  --color-bg-2:  #f4f4f4;   /* karta */
  --color-bg-3:  #f0f0f0;   /* element wybrany, popover */

  --color-fg-1:  #282a30;   /* tekst podstawowy */
  --color-fg-2:  #3c4149;   /* tekst drugorzędny */
  --color-fg-3:  #6f6e77;   /* tekst trzeciorzędny, etykiety kolumn */
  --color-fg-4:  #86848d;   /* tekst czwartorzędny, IKONY nawigacji */

  --color-line-1: #d4d4d6;  /* linia mocna */
  --color-line-2: #eaeaeb;  /* linia domyślna */
  --color-line-3: #f0f0f0;  /* linia subtelna */

  --color-border:        #0000000d;   /* czerń 5% */
  --color-border-strong: #00000014;   /* czerń 8% */

  --color-accent:       #7070ff;
  --color-accent-hover: #8989f0;
  --color-accent-tint:  #f1f1ff;

  /* stany, model Stripe: 50-100 tło, 150 obramowanie, 500 tekst */
  --color-success: #228403;  --color-success-bg: #ecfed7;  --color-success-line: #a6eb84;
  --color-warning: #c84801;  --color-warning-bg: #fef9da;  --color-warning-line: #fcd579;
  --color-danger:  #df1b41;  --color-danger-bg:  #fff5fa;  --color-danger-line:  #ffccdf;
  --color-info:    #0570de;  --color-info-bg:    #ddfffe;  --color-info-line:    #a2e5ef;

  /* ---------- CIENIE (drabina Attio, maks. 7% alfy) ---------- */
  --shadow-1: 0px  1px   3px    0px #00000003;
  --shadow-2: 0px  2px   4px   -1px #00000005;
  --shadow-3: 0px  4px   8px   -2px #00000008;
  --shadow-4: 0px  8px  16px   -4px #0000000a;
  --shadow-5: 0px 16px  32px   -8px #0000000d;
  --shadow-6: 0px 32px  64px  -16px #0000000f;
  --shadow-7: 0px 64px 128px  -32px #00000012;

  /* obramowanie jako cień, żeby nie zmieniało modelu pudełkowego (wzorzec Vercela) */
  --shadow-hairline: 0 0 0 1px #00000014;

  /* ---------- ANIMACJA ---------- */
  --ease-out: cubic-bezier(0.25, 0.46, 0.45, 0.94);   /* --ease-out-quad Lineara */
  --default-transition-duration: 160ms;               /* Linear: chrome UI */
  --default-transition-timing-function: var(--ease-out);
}

/* ---------- KOLOR: ciemny motyw ---------- */
:root:not([data-theme="light"]) { }   /* patrz uwaga niżej */

[data-theme="dark"] {
  --color-bg-0:  #08090a;
  --color-bg-1:  #0f1011;
  --color-bg-2:  #141516;
  --color-bg-3:  #191a1b;

  --color-fg-1:  #f7f8f8;
  --color-fg-2:  #d0d6e0;
  --color-fg-3:  #8a8f98;
  --color-fg-4:  #62666d;

  --color-line-1: #37393a;
  --color-line-2: #202122;
  --color-line-3: #18191a;

  --color-border:        #ffffff0d;   /* biel 5% */
  --color-border-strong: #ffffff14;   /* biel 8% */

  --color-accent:       #7170ff;
  --color-accent-hover: #828fff;
  --color-accent-tint:  #18182f;

  /* cienie w ciemnym motywie: głębsze rozmycie, wyższa alfa */
  --shadow-4: 0px  4px 24px #00000033;
  --shadow-6: 0px  7px 32px #00000059;
  --shadow-hairline: 0 0 0 1px #ffffff25;
}
```

### 9.1 Trzy tokeny, których w tym bloku brakuje, a które będą potrzebne

**Skala metryk.** Atlassian ma osobne tokeny `--ds-font-metric-large/medium/small`
(28 / 24 / 16px, waga 653) przeznaczone wyłącznie na liczby w kafelkach dashboardu.
Kafelek z liczbą wysłanych maili nie jest ani nagłówkiem, ani tekstem. Warto dodać:

```css
--text-metric-lg: 1.75rem;   /* 28px */
--text-metric-lg--line-height: 2rem;      /* 32px */
--text-metric-lg--font-weight: 590;
--text-metric-lg--letter-spacing: -0.02em;

--text-metric-md: 1.5rem;    /* 24px */
--text-metric-md--line-height: 1.75rem;   /* 28px */
--text-metric-md--font-weight: 590;
--text-metric-md--letter-spacing: -0.02em;

--text-metric-sm: 1rem;      /* 16px */
--text-metric-sm--line-height: 1.25rem;   /* 20px */
--text-metric-sm--font-weight: 590;
--text-metric-sm--letter-spacing: -0.01em;
```

Każdy z nich powinien mieć `font-variant-numeric: tabular-nums lining-nums`.

**Przełącznik gęstości tabeli.** Wzorzec Primera (`condensed / normal / spacious`),
zaimplementowany zmiennymi CSS na kontenerze tabeli, żeby jeden atrybut przestawiał
wszystko naraz (wzorzec `data-size` z plakietki Lineara, sekcja 7.7):

```css
[data-density="condensed"] { --row-pad-y:  4px; --row-pad-x:  8px; --row-h: 28px; }
[data-density="normal"]    { --row-pad-y:  8px; --row-pad-x: 12px; --row-h: 36px; }
[data-density="spacious"]  { --row-pad-y: 12px; --row-pad-x: 16px; --row-h: 44px; }
```

**Rodzina tokenów kontrolek.** Primer ma osobne `--control-bgColor-rest/hover/active`.
W panelu, gdzie pole wyszukiwania i przycisk filtra muszą wyglądać jak jedna rodzina,
to jest lepsze niż sięganie po `--color-bg-2` z ogólnej skali.

### 9.2 Warstwa interakcji, do zapisania osobno

Te wartości nie są tokenami koloru, tylko alfami nakładanymi na tło. Wyciągnięte
z Lineara, sekcja 8.6:

```css
:root {
  --state-hover:    #00000008;   /* czerń 3% */
  --state-active:   #0000000a;   /* czerń 4% */
  --state-selected: #00000014;   /* czerń 8% */
}
[data-theme="dark"] {
  --state-hover:    #ffffff05;   /* biel 2%  */
  --state-active:   #ffffff0a;   /* biel 4%  */
  --state-selected: #ffffff14;   /* biel 8%  */
}
```

Wartości ciemnego motywu są dokładnie te, których używa Linear, wraz z przypisaniem
do ról (sekcja 8.6).

Wartości jasnego motywu to alfy, które faktycznie **występują** w regułach
`[data-theme=light]` w CSS Lineara: `#00000008` (3%, 2 wystąpienia), `#0000000a`
(4%, 3 wystąpienia), `#00000014` (8%, 12 wystąpień), `#0000001a` (10%, 1 wystąpienie).
**Przypisanie ich do konkretnych ról hover / active / selected jest moją interpretacją,
nie odczytem z kodu: do zweryfikowania.** Pewne jest tylko, że Linear używa
w jasnym motywie tego samego przedziału 3-10% i że `--color-bg-translucent`
to `#00000005`.

Porównanie z Atlassianem (sekcja 10.8), który publikuje te role wprost:
`background-neutral` 6%, `-hovered` 14%, `-pressed` 29%. Atlassian jedzie
wyraźnie mocniej. To jest realna rozbieżność między systemami, nie błąd:
Atlassian projektuje pod bardzo szeroką grupę użytkowników i warunków oświetlenia,
Linear pod jeden, dobry monitor.

### 9.3 Metryki komponentów, do zapisania jako stałe

```
Wysokość wiersza tabeli, domyślnie     36px       konsensus Primer/Polaris/Radix/shadcn (10.1)
Wysokość wiersza tabeli, Linear         40px       Linear, CSS produkcyjny (replika)
Wysokość wiersza tabeli, gęsto         28-32px    Primer condensed 28px, Polaris IndexTable 32px
Wysokość wiersza tabeli, luźno         44px       Primer spacious, Radix Table size 2
Wysokość nagłówka tabeli               36px       Linear (nagłówek grupy)
Odsunięcie wiersza od krawędzi         8px        Linear, CSS produkcyjny
Wysokość paska widoku                  44px       Linear, CSS produkcyjny

Szerokość panelu bocznego              256px      shadcn/ui, siatka Lineara
Szerokość panelu bocznego zwiniętego   48px       shadcn/ui
Szerokość panelu szczegółów            320px      Linear (280px poniżej 1280px)
Wysokość pozycji nawigacji             28px       Linear, CSS produkcyjny
Odstęp między pozycjami nawigacji      2px        Linear, CSS produkcyjny
Wysokość przełącznika kontekstu        28px       Linear, CSS produkcyjny
Szerokość menu przełącznika            210px      Linear, CSS produkcyjny

Przycisk mini / small / medium         24/32/40px Linear, CSS produkcyjny
Ikona w przycisku small i medium       16px       Linear, CSS produkcyjny
Element menu kontekstowego             32px       Linear, CSS produkcyjny
Plakietka / badge                      24px (22px w gęstym)   Linear, CSS produkcyjny
Klawisz skrótu                         20x20px (16x16 mały)   Linear, CSS produkcyjny

Paleta poleceń: szerokość              min(720px, 100vw - 32px)   Linear, CSS produkcyjny
Paleta poleceń: wysokość               min(73vh, 500px)           Linear, CSS produkcyjny
Paleta poleceń: pozycja od góry        13vh                       Linear, CSS produkcyjny
Paleta poleceń: pole wpisywania        46px, font 15px            Linear, CSS produkcyjny
Paleta poleceń: element listy          min 46px, font 13px        Linear, CSS produkcyjny
Paleta poleceń: nagłówek grupy         30px, font 12px            Linear, CSS produkcyjny

Scrollbar                              6px, 10px aktywny, 4px odstępu   Linear
Minimalny obszar dotyku                44px                             Linear
```

---

## 10. Systemy publikowane: Primer, Atlassian, Polaris, Radix, Stripe Apps

Sekcje 1-9 opierają się na CSS produkcyjnym. Ta sekcja to druga, niezależna warstwa
dowodu: opublikowane tokeny sześciu design systemów, wzięte z ich kanonicznej
dystrybucji npm i ze stron dokumentacji. Wersje paczek użyte przy zbieraniu:
`@primer/primitives 11.10.0`, `@atlaskit/tokens 16.8.1`, `@atlaskit/button 25.2.0`,
`@atlaskit/dynamic-table 19.2.0`, `@atlaskit/focus-ring 5.1.0`,
`@shopify/polaris-tokens 9.4.2`, `@shopify/polaris 13.9.5`,
`@radix-ui/themes 3.3.0`, `shadcn/ui new-york-v4`.

### 10.1 Wysokość wiersza tabeli: liczby opublikowane

To jest odpowiedź na najważniejsze pytanie sekcji 3, potwierdzona z pięciu źródeł:

| System | Tryb | Padding pionowy | line-height | **Wysokość wiersza** |
|---|---|---|---|---|
| Primer DataTable | `condensed` | 4px | 20px (12px/1.667) | **28px** (+1px obramowanie = 29) |
| Primer DataTable | `normal` (domyślny) | 8px | 20px | **36px** (+1px = 37) |
| Primer DataTable | `spacious` | 12px | 20px | **44px** (+1px = 45) |
| Atlassian DynamicTable | komórka | 4px | 20px (body 14px) | **28px** |
| Atlassian DynamicTable | nagłówek | 4px | 16px (body-small 12px) | **24px** |
| Polaris DataTable | standard | 8px | 20px (bodyMd 13px) | **36px** |
| Polaris DataTable | `increasedTableDensity` | 6px | 20px | **32px** |
| Polaris IndexTable | komórka | 6px | 20px | **32px** |
| Polaris IndexTable | nagłówek | 8px | - | `min-height: 56px` |
| Radix Themes Table | `size="1"` | 8px | 20px | **36px** (`--table-cell-min-height`) |
| Radix Themes Table | `size="2"` (domyślny) | 12px | 20px | **44px** |
| Radix Themes Table | `size="3"` | 12px | 24px | **48px** |
| shadcn/ui Table | brak trybów | 8px | 20px | **36px** (+1px `border-b`) |
| Linear, lista zadań | - | - | - | **40px** (CSS produkcyjny, replika) |

**Wspólny mianownik wszystkich pięciu systemów to line-height 20px w komórce tabeli.**
Nie 24px, nie 1.5 jako mnożnik. 20px. To liczba, wokół której zbudowana jest cała
gęstość: wiersz to 20px tekstu plus dwa razy padding.

Trzy poziomy gęstości, na których zgadzają się Primer, Polaris i Radix:

```
gęsto:      28-32px    (padding pionowy 4-6px)
domyślnie:  36px       (padding pionowy 8px)      <- konsensus czterech systemów
luźno:      44px       (padding pionowy 12px)
```

Padding poziomy: Primer 8 / 12 / 16px wg gęstości, Atlassian 8px, Polaris 6px
(pierwsza i ostatnia komórka 12px), Radix 8 / 12 / 12-16px.

**Wzorzec pierwszej i ostatniej komórki.** Polaris daje pierwszej i ostatniej
komórce w wierszu 12px paddingu bocznego zamiast 6px. Efekt: treść tabeli ma
oddech od krawędzi kontenera, ale kolumny w środku pozostają ciasne.

### 10.2 Rozmiar tekstu w tabeli: potwierdzenie 12-14px

| System | Rozmiar tekstu w tabeli | line-height |
|---|---|---|
| Primer DataTable | **12px** (`--table-font-size: 0.75rem`) | `calc(20/12)` = 20px |
| Polaris, `bodyMd` desktop | **13px** | 20px |
| Atlassian, `--ds-font-body` | 14px | 20px |
| Radix Themes Table size 1 i 2 | 14px | 20px |
| shadcn/ui Table | 14px (`text-sm`) | 20px |

Polaris jest tu najciekawszy, bo **13px jest ich domyślnym rozmiarem tekstu na
desktopie** (`bodyMd` w bloku `:root, .p-theme-light`), a 16px w wariancie mobilnym
(`.p-theme-light-mobile`). To niezależnie potwierdza wniosek z sekcji 1.1, gdzie
13px wyszło jako dominanta w CSS Lineara i Attio.

Primer schodzi jeszcze niżej, do 12px, ale ma to skompensowane line-heightem 20px
(mnożnik 1.667, bardzo luźny jak na tę wielkość).

**Uwaga o kierunku skalowania.** Polaris zmniejsza kontrolki i tekst na desktopie,
a powiększa na mobile. Jeśli budujesz panel desktop-first, bierz wartości z bloku
`:root, .p-theme-light`, nie z `.p-theme-light-mobile`. Odwrotnie niż podpowiada
intuicja "mobile first".

### 10.3 Wysokości kontrolek: konsensus 24 / 28 / 32 / 40

**Primer** publikuje najpełniejszą tabelę (tokeny `--control-*`):

| Rozmiar | Wysokość | paddingBlock | paddingInline condensed/normal/spacious | gap |
|---|---|---|---|---|
| xsmall | **24px** | 2px | 4 / 8 / 12px | 4px |
| small | **28px** | 4px | 8 / 12 / 16px | 4px |
| medium | **32px** | 6px | 8 / 12 / 16px | 8px |
| large | **40px** | 10px | 8 / 12 / 16px | 8px |
| xlarge | 48px | 14px | 8 / 12 / 16px | 8px |

Minimalny cel dotykowy: `--control-minTarget-coarse: 44px`, `-fine: 16px`.

**Radix Themes**, przycisk i pole tekstowe:

| `size` | Wysokość | padding-inline | font-size / line-height | radius |
|---|---|---|---|---|
| 1 | **24px** (`--space-5`) | 8px | 12 / 16px | `--radius-1` (3px) |
| 2 (domyślny) | **32px** (`--space-6`) | 12px | 14 / 20px | `--radius-2` (4px) |
| 3 | **40px** (`--space-7`) | 16px | 16 / 24px | `--radius-3` (6px) |
| 4 | 48px (`--space-8`) | 24px | 18 / 26px | `--radius-4` (8px) |

TextField Radix: wysokości identyczne (24 / 32 / 40px), padding wewnętrzny
`calc(padding - 1px)`, żeby skompensować obramowanie: 5px / 7px / 11px.
To jest szczegół, przez który pole i przycisk obok siebie mają identyczną wysokość.

**Atlassian Button**: domyślny **32px** (padding 6px / 12px), compact **24px**
(padding 2px / 6px). Font body 14/20, waga 500.

**Polaris Button**, `min-height`, desktop od 768px:
micro **24px**, slim i medium **28px**, large **32px**, iconOnly plain 20px.
Padding: micro 4px / 8px, slim i medium 6px / 12px, large 6px / 12px.

**shadcn/ui Button**: default 36px (`h-9`), xs 24px, sm 32px, lg 40px.
Input: 36px (`h-9`), px 12px, py 4px.

Zestawienie zbieżności:

```
24px    Primer xsmall, Radix size 1, Atlassian compact, Polaris micro, shadcn xs
28px    Primer small, Polaris slim i medium (desktop)
32px    Primer medium, Radix size 2, Atlassian default, Polaris large, shadcn sm, LINEAR small
40px    Primer large, Radix size 3, shadcn lg, LINEAR medium
48px    Primer xlarge, Radix size 4
```

**Pięć systemów niezależnie zgadza się na 24 / 32 / 40px.** To jest skala do zapisania.
28px pojawia się u dwóch (Primer, Polaris) i u Lineara jako wysokość pozycji nawigacji
oraz pigułki filtra. 36px jest wyłącznie domyślną wartością shadcn i wypada z konsensusu.

### 10.4 Skale odstępów, cztery kolejne systemy

**Primer**, `--base-size-*`, nazwa tokena równa liczbie px:
`2, 4, 6, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 64, 80, 96, 112, 128`
plus lustrzane wartości ujemne od -2 do -48.

Odstępy funkcjonalne (to jest warstwa, którą realnie się stosuje):
```
--stack-gap-condensed: 8px    --stack-padding-condensed: 8px
--stack-gap-normal:   16px    --stack-padding-normal:   16px
--stack-gap-spacious: 24px    --stack-padding-spacious: 24px
--overlay-padding-condensed:  8px    --overlay-paddingBlock-condensed:  4px
--overlay-padding-normal:    16px    --overlay-paddingBlock-normal:    12px
--overlay-offset: 4px
```

**Atlassian**, `--ds-space-*` (nazwa to setne części rem):
```
0 = 0     025 = 2px   050 = 4px   075 = 6px   100 = 8px   150 = 12px
200 = 16px  250 = 20px  300 = 24px  400 = 32px  500 = 40px
600 = 48px  800 = 64px  1000 = 80px
```
plus wartości ujemne od -025 do -400.

**Polaris**, `--p-space-*`:
```
0 = 0     025 = 1px   050 = 2px   100 = 4px   150 = 6px   200 = 8px
300 = 12px  400 = 16px  500 = 20px  600 = 24px  800 = 32px
1000 = 40px  1200 = 48px  1600 = 64px  2000 = 80px  2400 = 96px
2800 = 112px  3200 = 128px
```
Polaris ma bliźniacze skale `--p-height-*` i `--p-width-*` o tych samych nazwach
i wartościach (`--p-height-700` = 28px, `-800` = 32px, `-900` = 36px).

**Radix Themes**, kroki 1-9, wszystkie mnożone przez `--scaling`:
```
--space-1: 4px    --space-4: 16px   --space-7: 40px
--space-2: 8px    --space-5: 24px   --space-8: 48px
--space-3: 12px   --space-6: 32px   --space-9: 64px
```

**Zbieżność.** Ciąg `4 / 8 / 12 / 16 / 24 / 32` jest identyczny w Radix (kroki 1-6),
Atlassian (050-400) i Polaris (100-600). Do gęstego interfejsu dochodzą 2px i 6px,
obecne w Stripe (`space-25`, `space-75`), Atlassian (`025`, `075`) i Polaris
(`050`, `150`). Polaris ma dodatkowo 1px.

To potwierdza listę dopuszczonych kroków z sekcji 2.2.

### 10.5 Przełącznik gęstości: dwa gotowe mechanizmy

**Radix `--scaling`** to najczystsze rozwiązanie z całej szóstki. Jeden atrybut
`data-scaling` na elemencie głównym o wartościach `90% / 95% / 100% / 105% / 110%`
mnoży **jednocześnie** odstępy, rozmiary czcionek, line-heighty i promienie.

```
scaling: 100%   ->  space-1 = 4px,   wiersz tabeli size 1 = 36px
scaling:  90%   ->  space-1 = 3.6px, wiersz tabeli size 1 = 32.4px
```

Implementacja polega na tym, że każdy token jest zapisany jako
`calc(<wartość bazowa> * var(--scaling))`.

**Primer `condensed / normal / spacious`** to trzy zestawy paddingu przy stałej
typografii. Prostsze, przewidywalne, ale nie skaluje tekstu.

Dla panelu operatora obsługującego kilka sklepów naraz właściwy jest wariant Primera
na tabeli (operator chce więcej wierszy, nie mniejszy tekst) i ewentualnie wariant
Radiksa jako globalne ustawienie konta.

### 10.6 Typografia: cztery kolejne skale

**Stripe Apps** (opublikowana warstwa semantyczna):

| Token | rozmiar | line-height | waga | uwagi |
|---|---|---|---|---|
| `heading` | 16px | 24px | 700 | |
| `subheading` | **11px** | 20px | 600 | `text-transform: uppercase` |
| `body` | 14px | 20px | 400 | |
| `caption` | 12px | 16px | 400 | |

Stripe jest jedynym z całej dziewiątki, który stosuje wersaliki w skali
typograficznej (`subheading`, 11px, waga 600). Bez podanego letter-spacingu
(**do zweryfikowania**).

**Primer**, kompozyty funkcjonalne:

| Token | rozmiar | waga | line-height |
|---|---|---|---|
| `--text-display` | 40px | 500 | 1.375 (55px) |
| `--text-title-large` | 32px | 600 | 1.5 (48px) |
| `--text-title-medium` | 20px | 600 | 1.625 (32.5px) |
| `--text-title-small` | 16px | 600 | 1.5 (24px) |
| `--text-subtitle` | 20px | 400 | 1.625 |
| `--text-body-large` | 16px | 400 | 1.5 (24px) |
| `--text-body-medium` | 14px | 400 | 1.5 (21px) |
| `--text-body-small` | 12px | 400 | 1.625 (19.5px) |
| `--text-caption` | 12px | 400 | 1.25 (15px) |
| `--text-codeBlock` | 13px | 400 | 1.5 |

Wagi Primera: 300 / 400 / 500 / 600. Line-heighty: tight 1.25, snug 1.375,
normal 1.5, relaxed 1.625, loose 1.75. **Primer nie publikuje żadnych tokenów
letter-spacing** (do zweryfikowania).

**Atlassian** (skrót `waga rozmiar/line-height`):

| Token | waga | rozmiar | line-height |
|---|---|---|---|
| `--ds-font-heading-xxlarge` | **653** | 32px | 36px |
| `--ds-font-heading-xlarge` | 653 | 28px | 32px |
| `--ds-font-heading-large` | 653 | 24px | 28px |
| `--ds-font-heading-medium` | 653 | 20px | 24px |
| `--ds-font-heading-small` | 653 | 16px | 20px |
| `--ds-font-heading-xsmall` | 653 | 14px | 20px |
| `--ds-font-heading-xxsmall` | 653 | 12px | 16px |
| `--ds-font-body-large` | 400 | 16px | 24px |
| `--ds-font-body` | 400 | 14px | 20px |
| `--ds-font-body-small` | 400 | 12px | 16px |
| `--ds-font-metric-large` | 653 | 28px | 32px |
| `--ds-font-metric-medium` | 653 | 24px | 28px |
| `--ds-font-metric-small` | 653 | 16px | 20px |

Dwie rzeczy warte przeniesienia:

1. **Waga 653.** Atlassian, tak jak Linear (510 / 590), używa niestandardowej wagi
   zmiennego fontu. Dwa niezależne systemy dochodzą do tego samego wniosku:
   przy zmiennym kroju okrągłe 600 lub 700 to nie jest optimum.
2. **Osobne tokeny `metric-*`.** Trzy style przeznaczone wyłącznie na liczby
   na dashboardzie (28 / 24 / 16px, waga 653). Dla panelu, w którym operator patrzy
   na kafelki z liczbami wysyłek i przychodu, to jest brakujący element skali.
   Kafelek metryki nie jest ani nagłówkiem, ani tekstem.

**Polaris**, presety desktopowe (blok `:root, .p-theme-light`):

| Wariant | rozmiar | line-height | waga | letter-spacing |
|---|---|---|---|---|
| `bodyXs` | 11px | 12px | 450 | 0 |
| `bodySm` | 12px | 16px | 450 | 0 |
| `bodyMd` (domyślny) | **13px** | 20px | 450 | 0 |
| `bodyLg` | 14px | 20px | 450 | 0 |
| `headingXs` | 12px | 16px | 650 | 0 |
| `headingSm` | 13px | 20px | 650 | 0 |
| `headingMd` | 14px | 20px | 650 | 0 |
| `headingLg` | 20px | 24px | 650 | **-0.2px** |
| `headingXl` | 24px | 32px | 700 | **-0.2px** |
| `heading2xl` | 30px | 40px | 700 | **-0.3px** |
| `heading3xl` | 36px | 48px | 700 | **-0.54px** |

Wagi Polarisa: **regular 450, medium 550, semibold 650, bold 700**. Trzeci system
(po Linearze i Atlassianie) używający wag pośrednich zmiennego Intera.

Tokeny letter-spacing Polarisa: `normal` 0, `dense` -0.2px, `denser` -0.3px,
`densest` -0.54px. **Tracking wchodzi dopiero od 20px** i tylko w nagłówkach.
Tekst interfejsu ma tracking 0. Zgadza się to z obserwacją z sekcji 1.2, że Linear
przy 12px też ma dokładnie 0.

**Radix Themes**, kroki 1-9 (mnożone przez `--scaling`):

| Krok | rozmiar | line-height Text | line-height Heading | letter-spacing |
|---|---|---|---|---|
| 1 | 12px | 16px | 16px | **+0.0025em** |
| 2 | 14px | 20px | 18px | 0em |
| 3 (domyślny) | 16px | 24px | 22px | 0em |
| 4 | 18px | 26px | 24px | -0.0025em |
| 5 | 20px | 28px | 26px | -0.005em |
| 6 | 24px | 30px | 30px | -0.00625em |
| 7 | 28px | 36px | 36px | -0.0075em |
| 8 | 35px | 40px | 40px | -0.01em |
| 9 | 60px | 60px | 60px | -0.025em |

Radix skaluje tracking płynnie, od **+0.0025em przy 12px** do -0.025em przy 60px,
i przechodzi przez zero przy 14-16px. To jest trzeci, pośredni model wobec ujemnego
Vercela i dodatniego Raycasta. Zwróć też uwagę, że **nagłówek ma ciaśniejszy
line-height niż tekst tej samej wielkości** (16px: 22px vs 24px).

Radix ma też `--default-leading-trim-start: 0.42em` i `--default-leading-trim-end: 0.36em`,
czyli obcinanie nadmiarowej wiodącej. To rozwiązuje problem, w którym nagłówek
w karcie ma optycznie za dużo miejsca nad sobą.

### 10.7 Promienie: cztery kolejne skale

| System | Skala |
|---|---|
| **Primer** | small 3px, medium/default 6px, large 12px, full 9999px |
| **Atlassian** | xsmall 2, small 4, medium 6, large 8, xlarge 12, xxlarge 16px, full 9999px, tile 25% |
| **Polaris** | 0, 050 = 2, 100 = 4, 150 = 6, 200 = 8, 300 = 12, 400 = 16, 500 = 20, 750 = 30px, full 9999px |
| **Radix** | `--radius-1..6` = 3 / 4 / 6 / 8 / 12 / 16px, mnożone przez `--radius-factor` |
| **Stripe Apps** | xsmall 4, small 4, medium 8, large 10px, rounded 999em |

Radix ma najciekawszy mechanizm: `--radius-factor` sterowany ustawieniem motywu.
`none` = 0, `small` = 0.75, `medium` = 1, `large` = 1.5, `full` = 1.5. Przy
`radius="small"` cała skala to 2.25 / 3 / 4.5 / 6 / 9 / 12px, przy `radius="large"`
to 4.5 / 6 / 9 / 12 / 18 / 24px. Osobno `--radius-full` (0 dla wszystkiego poza `full`,
gdzie 9999px) i `--radius-thumb` (0.5px dla none i small, 9999px dla reszty).

Szerokości obramowań:
```
Primer:    thin i default 1px, thick 2px, thicker 4px
Atlassian: --ds-border-width 1px, -selected 2px, -focused 2px
Polaris:   025 = 1px, 050 = 2px, 100 = 4px, 0165 = 0.66px
```

Polarisowe **0.66px** to odpowiednik triku Lineara z hairlinem 0.5px na ekranach
o wysokiej gęstości.

Primer ma też gotowe cienie inset do rysowania obramowań:
`--boxShadow-thin: inset 0 0 0 1px`, `-thick: inset 0 0 0 2px`, `-thicker: inset 0 0 0 4px`.

### 10.8 Kolor: skale neutralne i model semantyczny

**Radix Colors, pełna skala `gray`** (12 kroków, kanoniczne hexy):

```
jasna:  1 #fcfcfc   2 #f9f9f9   3 #f0f0f0   4 #e8e8e8   5 #e0e0e0   6 #d9d9d9
        7 #cecece   8 #bbbbbb   9 #8d8d8d  10 #838383  11 #646464  12 #202020
ciemna: 1 #111111   2 #191919   3 #222222   4 #2a2a2a   5 #313131   6 #3a3a3a
        7 #484848   8 #606060   9 #6e6e6e  10 #7b7b7b  11 #b4b4b4  12 #eeeeee
```

**Radix Colors, skala `slate`** (szary z chłodnym odcieniem, bliższy Linearowi):

```
jasna:  1 #fcfcfd   2 #f9f9fb   3 #f0f0f3   4 #e8e8ec   5 #e0e1e6   6 #d9d9e0
        7 #cdced6   8 #b9bbc6   9 #8b8d98  10 #80838d  11 #60646c  12 #1c2024
ciemna: 1 #111113   2 #18191b   3 #212225   4 #272a2d   5 #2e3135   6 #363a3f
        7 #43484e   8 #5a6169   9 #696e77  10 #777b84  11 #b0b4ba  12 #edeef0
```

Plus `--gray-surface: #ffffffcc` jasny / `#21212180` ciemny (półprzezroczysta
powierzchnia do kart nad kolorowym tłem).

Zwróć uwagę: **krok 1 skali ciemnej to `#111111` (gray) i `#111113` (slate)**,
czyli dokładnie ten przedział, który wyszedł z CSS produkcyjnego w sekcji 8.2
(`#08090a` do `#101111`). Slate ma ten sam chłodny odcień co tła Lineara.

W Radix Themes tokeny focusu są aliasami akcentu: `--focus-1..12` = `--accent-1..12`.

**Atlassian, surowa paleta neutralna, 13 kroków plus warianty alfa:**

```
Neutral0    #FFFFFF     Neutral600  #7D818A     Neutral1100 #1E1F21
Neutral100  #F8F8F8     Neutral700  #6B6E76     Neutral1200 #000000
Neutral200  #F0F1F2     Neutral800  #505258
Neutral300  #DDDEE1     Neutral900  #3B3D42
Neutral400  #B7B9BE     Neutral1000 #292A2E
Neutral500  #8C8F97
```

Warstwa semantyczna Atlassiana w motywie jasnym (466 tokenów kolorystycznych):
```
--ds-surface: #FFFFFF        --ds-text: #292A2E
--ds-surface-sunken: #F8F8F8 --ds-text-subtle: #505258
--ds-surface-raised: #FFFFFF --ds-text-subtlest: #6B6E76
--ds-surface-hovered: #F0F1F2   --ds-text-disabled: #080F214A
--ds-surface-pressed: #DDDEE1   --ds-text-brand: #1868DB
--ds-border: #0B120E24          --ds-border-focused: #4688EC
--ds-border-bold: #7D818A       --ds-border-input: #8C8F97
--ds-background-neutral: #0515240F           (czerń 6%)
--ds-background-neutral-hovered: #0B120E24   (czerń 14%)
--ds-background-neutral-pressed: #080F214A   (czerń 29%)
```

Atlassian, tak jak Linear, buduje warstwę interakcji na **alfach czerni, nie na
stałych szarościach**: 6% w spoczynku, 14% na hover, 29% wciśnięte.

**Primer** nie ma numerowanej skali szarości w warstwie funkcjonalnej, wszystko
jest semantyczne. Motyw jasny:
```
--bgColor-default: #ffffff       --fgColor-default: #1f2328
--bgColor-muted: #f6f8fa         --fgColor-muted: #59636e
--bgColor-disabled: #eff2f5      --fgColor-disabled: #818b98
--bgColor-emphasis: #25292e      --borderColor-default: #d1d9e0
--bgColor-neutral-emphasis: #59636e   --borderColor-muted: #d1d9e0b3
--bgColor-neutral-muted: #818b981f     --borderColor-emphasis: #818b98
--borderColor-accent-emphasis: #0969da
```

Primer ma **osobną rodzinę tokenów wyłącznie dla kontrolek**, co jest bardzo
przydatne w panelu:
```
--control-bgColor-rest:   #f6f8fa
--control-bgColor-hover:  #eff2f5
--control-bgColor-active: #e6eaef
--control-fgColor-rest:   #25292e
--control-checked-bgColor-hover:  #0860ca
--control-checked-bgColor-active: #0757ba
```

**Polaris** też jest w pełni semantyczny. Jego realna skala szarości to ciąg
luminancji: `255, 253, 250, 247, 243, 241, 235, 227, 204, 181, 138, 97, 48, 26`
(14 poziomów). Najważniejsze:
```
--p-color-bg: rgb(241,241,241)                 tło aplikacji (NIE białe)
--p-color-bg-surface: rgb(255,255,255)         karta
--p-color-bg-surface-hover: rgb(247,247,247)
--p-color-bg-surface-active: rgb(243,243,243)
--p-color-bg-surface-selected: rgb(241,241,241)
--p-color-border: rgb(227,227,227)
--p-color-border-hover: rgb(204,204,204)
--p-color-text: rgb(48,48,48)
--p-color-text-secondary: rgb(97,97,97)
--p-color-text-disabled: rgb(181,181,181)
--p-color-input-bg-surface: rgb(253,253,253)
--p-color-input-border: rgb(138,138,138)
--p-color-input-border-active: rgb(26,26,26)
```

Polaris jako jedyny robi **tło aplikacji szare (`rgb(241,241,241)`), a karty białe**.
Odwrotnie niż Linear, Vercel i Attio, gdzie tło jest białe, a karty odróżnia hairline.
To decyzja, którą trzeba podjąć świadomie: szare tło daje kartom naturalną separację
bez obramowań, ale zjada kontrast tekstu poza kartami.

**Stripe Apps, mapowanie ról** (pełne hexy w sekcji 5.4):
```
backgroundColor-surface   = neutral0   #ffffff
backgroundColor-container = neutral50  #f6f8fa
keyline-neutral           = neutral150 #d5dbe1
color-primary             = neutral700 #414552
color-secondary           = neutral500 #687385
color-disabled            = neutral300 #a3acba
iconColor-primary         = neutral600 #545969
iconColor-secondary       = neutral400 #87909f
iconColor-disabled        = neutral200 #c0c8d2
```
Kolory semantyczne biorą krok 500 dla tekstu i krok 400 dla ikon.
z-index Stripe: `zIndex-overlay: 299`, `zIndex-partial: 400`.

Zastrzeżenie: próbki kolorów renderowane w tabelach na stronie dokumentacji Stripe
są zahardkodowane i miejscami rozjeżdżają się ze zmiennymi (próbka `secondary`
pokazuje `#6A7383`, zmienna wskazuje `#687385`). **Kanonem są zmienne CSS.**

### 10.9 Focus ring: sześć opublikowanych specyfikacji

| System | Specyfikacja |
|---|---|
| **Stripe Apps** | `box-shadow: 0 0 0 4px rgb(1 150 237 / 36%)`, offset 0 |
| **Primer** | `--focus-outline-width: 2px`, `--focus-outline-offset: -2px` (**do wewnątrz**), `--focus-outline-color: var(--borderColor-accent-emphasis)` = `#0969da` |
| **Atlassian** | `outline: 2px solid #4688EC` z `outline-offset: 2px` (wariant zewnętrzny) lub `-2px` (wariant inset). W trybie `forced-colors`: `outline: 1px solid`, offset -1px |
| **Polaris** | `outline: 2px solid rgb(0,91,211)`. Offset zależny od komponentu: 1px, 2px, 6px, lub `calc(padding * -1)` w wariancie plain |
| **Radix Themes** | Przyciski: `outline: 2px solid var(--focus-8); outline-offset: 2px`. Pola tekstowe: to samo, ale `outline-offset: -1px`. Na dotyku, na `:active`: `outline: 0.5em solid var(--accent-a4); outline-offset: 0` |
| **shadcn/ui** | `focus-visible:ring-[3px]` w kolorze `ring-ring/50` (50% alfy), plus `focus-visible:border-ring`. Stan błędu: `aria-invalid:ring-destructive/20`, w ciemnym `/40` |
| **Linear** | 2px, offset 2px, kolor akcentu (jasny motyw: `#0006`). W wierszu listy: 2px, offset **-2px** |
| **Vercel** | `box-shadow: 0 0 0 2px var(--ds-background-100), 0 0 0 4px var(--ds-focus-color)` |
| **Attio** | ring 3px, kolor `#266df04d` jasny / `#709ff599` ciemny |

**Konsensus: obrys 2px.** Cztery z sześciu publikowanych systemów (Primer, Atlassian,
Polaris, Radix) plus Linear. Odstępstwa: Stripe 4px cienia, Attio i shadcn 3px ringu.

**Offset jest miejscem, gdzie systemy się różnią i gdzie trzeba podjąć decyzję:**
- Primer: **zawsze -2px**, obrys do wewnątrz. Nigdy nie wychodzi poza element,
  więc nigdy nie zostaje przycięty ani nie przesuwa layoutu
- Atlassian i Radix: **+2px dla przycisków, -2px lub -1px dla pól i elementów inset**
- Radix na polach tekstowych: -1px, dokładnie tyle, żeby obrys przykrył obramowanie

Wniosek do wdrożenia: **element z własnym obramowaniem (pole, karta, wiersz) dostaje
offset ujemny, element bez obramowania (przycisk, link) dostaje offset dodatni.**

Radix ma jeszcze jeden szczegół warty przeniesienia: na urządzeniach dotykowych,
na `:active`, obrys ma `0.5em` w kolorze `--accent-a4` (bardzo niska alfa).
To jest odpowiednik "ripple" bez animacji.

### 10.10 Czego te systemy nie publikują

- **Stripe Apps**: wysokości kontrolek (przycisk, pole, element listy), padding
  komponentów, letter-spacing. Nie ma tego ani na stronie `docs.stripe.com/stripe-apps/style`,
  ani w CSS strony. Do zweryfikowania w typach paczki `@stripe/ui-extension-sdk`
- **Primer**: letter-spacing (brak tokenów w systemie), jawne wysokości wierszy
  DataTable (są wyliczalne, nie opublikowane jako liczby)
- **Atlassian**: tryby gęstości tabeli (`DynamicTable` nie ma odpowiednika
  `condensed/spacious`), letter-spacing. Strona `atlassian.design/components/tokens/all-tokens`
  renderuje tokeny po stronie klienta i nie zwraca wartości przy pobraniu, dlatego
  wszystkie liczby Atlassiana pochodzą z paczki `@atlaskit/tokens`
- **Polaris**: strona `polaris.shopify.com/design/typography` przekierowuje (301)
  na `shopify.dev/docs/api/polaris` i nie zawiera tabeli skali. Liczby pochodzą
  z `@shopify/polaris-tokens` i `@shopify/polaris`
- **Radix**: dokumentacja `themes/docs/theme/radius` jawnie nie podaje wartości px,
  liczby 3/4/6/8/12/16 pochodzą z `tokens/radius.css` paczki
- **shadcn/ui**: konkretna wartość `--radius` i kolor `--ring` zależą od motywu
  wybranego przy instalacji

---

## 11. Źródła

### 11.1 CSS produkcyjny pobrany 2026-08-27

Hashe w nazwach plików są związane z konkretnym wdrożeniem i zmienią się przy
kolejnym deployu. Punktem wejścia jest zawsze strona główna produktu, z której
trzeba wyciągnąć aktualne odnośniki `<link rel="stylesheet">`.

**Linear** (https://linear.app/), 54 pliki CSS. Kluczowe:

| Plik | Co zawiera |
|---|---|
| `https://static.linear.app/web/_next/static/css/index.nDCywHOb.css` | pełny zestaw tokenów: `:root`, `[data-theme=dark]`, `[data-theme=light]`, `[data-theme=glass]`, skala typograficzna, promienie, warstwy z, krzywe, cienie, scrollbar |
| `https://static.linear.app/web/_next/static/css/IssueListView.BnuPS5_p.css` | wiersz listy, nagłówek grupy, pasek widoku, plakietka, zakładki filtrów, panel szczegółów |
| `https://static.linear.app/web/_next/static/css/HeroIllustration.Bvfe7oWz.css` | panel boczny: przełącznik workspace, pozycje nawigacji, menu, stany aktywny i hover |
| `https://static.linear.app/web/_next/static/css/CommandMenu.DVY7V9_S.css` | paleta poleceń w całości |
| `https://static.linear.app/web/_next/static/css/Button.dcAi4KbO.css` | pięć rozmiarów przycisku, pięć wariantów, stany |
| `https://static.linear.app/web/_next/static/css/KBD.ByHmXOx_.css` | plakietki klawiszy |
| `https://static.linear.app/web/_next/static/css/Select.Bb-JNkHr.css` | popup i element menu |
| `https://static.linear.app/web/_next/static/css/Tooltip.mgHd0F-S.css` | tooltip |
| `https://static.linear.app/web/_next/static/css/Toast.pcGZUK31.css` | toast |

**Vercel** (https://vercel.com/), 4 pliki CSS pod
`https://vercel.com/vc-ap-vercel-marketing/_next/static/immutable/chunks/*.css`.
Zawierają pełen zestaw `--ds-*` i `--geist-*`: skalę szarości jasną i ciemną (hex
i HSL), skalę alfa, wszystkie rodziny kolorów po 10 stopni, skalę odstępów,
komplet cieni semantycznych, pierścienie focusu.

**Attio** (https://attio.com/), 8 plików CSS pod
`https://attio.com/_next/static/immutable/chunks/*.css`. Zawierają blok `@theme`
Tailwinda 4: skalę typograficzną z wagą i trackingiem na krok, skale `black-*`
i `white-*`, semantyczne `--internal-color-*` dla `:root` i `.dark`,
siedmiowarstwowe cienie, promienie, krzywe.

**Raycast** (https://www.raycast.com/), 7 plików CSS pod
`https://www.raycast.com/_next/static/immutable/chunks/*.css`. Skala odstępów,
paleta ciemna, pary font-size + letter-spacing.

**Stripe** (https://docs.stripe.com/), tokeny w inline `<style>` na stronie.
Prefiks zmiennych jest zaciemniony (`--jybopzu-*` w pobranym wdrożeniu), nazwy
semantyczne zachowane: `hue-*`, `color-*`, `textColor-*`, `iconColor-*`,
`backgroundColor-*`, `borderColor-*`, `space-*`, `size-*`, `radius-*`,
`shadow-*`, `weight-*`, `typeface-*`.

**Klaviyo** (https://www.klaviyo.com/), 3 pliki CSS pod
`https://www.klaviyo.com/_astro/*.css`. To strona marek, nie aplikacja: zawiera
paletę brandową (poppy, sage, ocean, storm, sunflower) i pięciostopniowe cienie
`--box-shadow-xs..xl` o alfach 8-25%. **Metryki interfejsu aplikacji Klaviyo:
do zweryfikowania** (aplikacja jest za autoryzacją).

**Height** (https://height.app/): niedostępne. Połączenie TLS zrywane przy
pobieraniu (`SSL_ERROR_SYSCALL`). **Wszystkie wartości Height: do zweryfikowania.**

### 11.2 Kod open source

| Źródło | URL | Co wzięte |
|---|---|---|
| shadcn/ui, `sidebar.tsx` | `https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/sidebar.tsx` | `SIDEBAR_WIDTH` 16rem, `_MOBILE` 18rem, `_WIDTH_ICON` 3rem, skrót `Cmd+B`, wysokości pozycji menu, `tabular-nums` na liczniku |
| shadcn/ui, `table.tsx` | `https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/table.tsx` | `TableHead h-10 px-2`, `TableCell p-2`, `TableRow border-b hover:bg-muted/50 data-[state=selected]:bg-muted` |
| Tailwind CSS 4, `theme.css` | `https://raw.githubusercontent.com/tailwindlabs/tailwindcss/main/packages/tailwindcss/theme.css` | domyślne `--spacing: 0.25rem`, skala `--text-*`, `--radius-*`, `--shadow-*`, `--tracking-*`, `--default-transition-duration: 150ms` |

### 11.3 Systemy publikowane (sekcja 10)

Wersje paczek: `@primer/primitives 11.10.0`, `@atlaskit/tokens 16.8.1`,
`@atlaskit/button 25.2.0`, `@atlaskit/dynamic-table 19.2.0`,
`@atlaskit/focus-ring 5.1.0`, `@shopify/polaris-tokens 9.4.2`,
`@shopify/polaris 13.9.5`, `@radix-ui/themes 3.3.0`, `shadcn/ui new-york-v4`.

**Stripe Apps**
- https://docs.stripe.com/stripe-apps/style
- https://docs.stripe.com/stripe-apps/style.md

**GitHub Primer**
- https://primer.style/foundations/primitives/size
- https://primer.style/foundations/primitives/typography
- https://primer.style/foundations/primitives/color
- https://primer.style/components/data-table
- https://cdn.jsdelivr.net/npm/@primer/primitives@11.10.0/dist/fallbacks/functional/size/size.json
- https://cdn.jsdelivr.net/npm/@primer/primitives@11.10.0/dist/fallbacks/functional/size/border.json
- https://cdn.jsdelivr.net/npm/@primer/primitives@11.10.0/dist/fallbacks/functional/size/radius.json
- https://cdn.jsdelivr.net/npm/@primer/primitives@11.10.0/dist/fallbacks/functional/typography/typography.json
- https://cdn.jsdelivr.net/npm/@primer/primitives@11.10.0/dist/fallbacks/base/size/size.json
- https://cdn.jsdelivr.net/npm/@primer/primitives@11.10.0/dist/fallbacks/base/typography/typography.json
- https://cdn.jsdelivr.net/npm/@primer/primitives@11.10.0/dist/css/functional/themes/light.css
- https://cdn.jsdelivr.net/npm/@primer/primitives@11.10.0/dist/fallbacks/color-fallbacks.json
- https://raw.githubusercontent.com/primer/react/main/packages/react/src/DataTable/Table.module.css
- https://raw.githubusercontent.com/primer/react/main/packages/react/src/DataTable/Table.tsx

**Atlassian**
- https://atlassian.design/components/tokens/all-tokens (strona renderuje tokeny po stronie klienta, przy pobraniu nie zwraca wartości)
- https://cdn.jsdelivr.net/npm/@atlaskit/tokens@16.8.1/dist/esm/artifacts/themes/atlassian-spacing.js
- https://cdn.jsdelivr.net/npm/@atlaskit/tokens@16.8.1/dist/esm/artifacts/themes/atlassian-shape.js
- https://cdn.jsdelivr.net/npm/@atlaskit/tokens@16.8.1/dist/esm/artifacts/themes/atlassian-typography.js
- https://cdn.jsdelivr.net/npm/@atlaskit/tokens@16.8.1/dist/esm/artifacts/themes/atlassian-light.js
- https://cdn.jsdelivr.net/npm/@atlaskit/tokens@16.8.1/dist/esm/artifacts/palettes-raw/palette.js
- https://cdn.jsdelivr.net/npm/@atlaskit/focus-ring@5.1.0/dist/esm/focus-ring.js
- https://cdn.jsdelivr.net/npm/@atlaskit/button@25.2.0/dist/esm/new-button/variants/shared/button-base.compiled.css
- https://cdn.jsdelivr.net/npm/@atlaskit/dynamic-table@19.2.0/dist/esm/styled/table-cell.compiled.css
- https://cdn.jsdelivr.net/npm/@atlaskit/dynamic-table@19.2.0/dist/esm/styled/head-cell.compiled.css

**Shopify Polaris**
- https://polaris.shopify.com/design/typography (301 na https://shopify.dev/docs/api/polaris, brak wartości)
- https://cdn.jsdelivr.net/npm/@shopify/polaris-tokens@9.4.2/dist/css/styles.css
- https://cdn.jsdelivr.net/npm/@shopify/polaris@13.9.5/build/esm/styles.css

**Radix**
- https://www.radix-ui.com/colors
- https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale
- https://www.radix-ui.com/themes/docs/theme/typography
- https://www.radix-ui.com/themes/docs/theme/spacing
- https://www.radix-ui.com/themes/docs/theme/radius (dokumentacja jawnie nie podaje wartości px)
- https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.3.0/src/styles/tokens/typography.css
- https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.3.0/src/styles/tokens/space.css
- https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.3.0/src/styles/tokens/radius.css
- https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.3.0/src/styles/tokens/scaling.css
- https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.3.0/src/styles/tokens/color.css
- https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.3.0/src/styles/tokens/colors/gray.css
- https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.3.0/src/styles/tokens/colors/slate.css
- https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.3.0/src/components/_internal/base-button.css
- https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.3.0/src/components/button.css
- https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.3.0/src/components/text-field.css
- https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.3.0/src/components/table.css
- https://cdn.jsdelivr.net/npm/@radix-ui/colors@latest/gray.css
- https://cdn.jsdelivr.net/npm/@radix-ui/colors@latest/gray-dark.css
- https://cdn.jsdelivr.net/npm/@radix-ui/colors@latest/slate.css
- https://cdn.jsdelivr.net/npm/@radix-ui/colors@latest/slate-dark.css

**shadcn/ui**
- https://ui.shadcn.com/r/styles/new-york-v4/button.json
- https://ui.shadcn.com/r/styles/new-york-v4/table.json
- https://ui.shadcn.com/r/styles/new-york-v4/input.json

### 11.4 Metoda

Pobranie: `curl` z nagłówkiem User-Agent przeglądarki, potem wyciągnięcie
odnośników `.css` z HTML i pobranie każdego arkusza.

Ekstrakcja: skrypt Pythona wyszukujący deklaracje `--nazwa: wartość` oraz bloki
selektorów zawierające konkretne tokeny, plus analiza częstotliwości par
`font-size` i `letter-spacing` w obrębie jednej reguły.

Pliki robocze researchu leżą w katalogu tymczasowym sesji i nie są trwałe.
Żeby powtórzyć research po kolejnym wdrożeniu tych produktów, wystarczy powtórzyć
te dwa kroki: hashe w nazwach plików się zmienią, nazwy zmiennych CSS nie.

### 11.5 Czego tu nie ma

Uczciwa lista luk, żeby nikt ich nie wypełnił zgadywaniem:

- Wysokość wiersza tabeli w Attio, Height i Klaviyo: **do zweryfikowania**
  (dla Primer, Atlassian, Polaris, Radix i shadcn liczby są w sekcji 10.1)
- Szerokość panelu bocznego w aplikacji Lineara i Attio: **do zweryfikowania**
- Zachowanie kolumn przyklejonych (konkretny cień na granicy) w Linearze i Attio:
  **do zweryfikowania**, żaden z pobranych arkuszy nie zawiera implementacji
- Wymiary i treści pustych stanów poza pustym wynikiem wyszukiwania w Linearze:
  **do zweryfikowania**
- Alfy stanów hover/active/selected w JASNYM motywie Lineara: **do zweryfikowania**
  (w bundlu jest tylko `--color-bg-translucent: #00000005`)
- Skala typograficzna Stripe: rozmiary z warstwy semantycznej są w sekcji 10.6
  (heading 16/24, subheading 11/20, body 14/20, caption 12/16). Brakuje
  **letter-spacingu oraz wysokości kontrolek Stripe** (przycisk, pole, element listy):
  **do zweryfikowania** w typach paczki `@stripe/ui-extension-sdk`
- Promienie pól i przycisków w Attio: **do zweryfikowania**
- Formalne wymagania dostępności dla pierścienia focusu (WCAG 2.2, kryteria 2.4.11
  i 2.4.13: minimalna powierzchnia i kontrast obrysu): **do zweryfikowania**.
  W dokumencie są wyłącznie wartości stosowane przez producentów, nie norma.
  Wszystkie zebrane specyfikacje (obrys 2px, kontrastowy kolor) mieszczą się
  w duchu tych kryteriów, ale nie zostało to sprawdzone wobec tekstu normy
- Progi czasowe dla stanu ładowania (kiedy pokazać spinner, kiedy szkielet, kiedy nic):
  **do zweryfikowania** wobec badań Nielsen Norman Group o granicach 0,1 s / 1 s / 10 s.
  W sekcji 7.6 jest tylko implementacja shimmera Lineara, bez progu jego włączania
- Konwencje skrótów klawiszowych (które litery na jakie akcje, kolejność modyfikatorów):
  **do zweryfikowania**. W dokumencie jest wygląd plakietki klawisza i skrót
  `Cmd/Ctrl + B` z shadcn/ui, nie ma mapy skrótów
