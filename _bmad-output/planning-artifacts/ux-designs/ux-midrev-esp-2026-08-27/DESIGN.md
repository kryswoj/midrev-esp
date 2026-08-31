---
name: midrev-esp
type: design-spine
status: final
created: '2026-08-27'
updated: '2026-08-27'
kierunek: noc
colors:
  plotno: '#08090B'
  app: '#101114'
  panel: '#0B0C0F'
  powierzchnia: '#16181C'
  powierzchnia-2: '#1C1F24'
  linia-0: '#1F2228'
  linia: '#262A31'
  linia-mocna: '#333841'
  tekst: '#EDEFF2'
  tekst-tabela: '#C9CFD8'
  tekst-2: '#9BA2AD'
  tekst-3: '#808791'
  akcent: '#7C9CFF'
  akcent-tlo: '#1A2035'
  akcent-ramka: '#3C528F'
  ok: '#46B784'
  ok-tlo: '#12261F'
  czeka: '#E0A93E'
  czeka-tlo: '#2A2113'
  blad: '#E4736B'
  blad-tlo: '#2C1A19'
typography:
  rodzina: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  skala: [10, 11, 12, 13, 15, 19, 26]
  baza: 13
  etykieta: '11px wersaliki, tracking 0.08em'
  liczby: 'monospace, tabular-nums, zawsze'
rounded:
  klawisz: 4
  kontrolka: 6
  karta: 6
spacing:
  baza: 4
  kroki: [4, 8, 12, 16, 20, 24]
components:
  wiersz-tabeli: 30
  naglowek-strony: 44
  kontrolka: 26
  nawigacja-szerokosc: 236
sources:
  - '../../../prd-midrev-esp-2026-08-27.md'
  - '../../architecture/architecture-midrev-esp-2026-08-27/ARCHITECTURE-SPINE.md'
  - '../../wzorce-ui.md'
  - '../../audyt-designu.md'
---

# DESIGN.md — midrev-esp

## Brand & Style

Panel jest **narzędziem pracy**, nie materiałem marketingowym agencji. Operator siedzi
w nim godzinami i obsługuje kilka sklepów naraz, więc gęstość informacji wygrywa
z przestrzenią, a spokój wygrywa z efektami.

Trzy odrzucone kierunki i powód odrzucenia, żeby nie wracały: ciemny w brandzie MidRev
(materiał agencji, a nie narzędzie), jasny z serifowymi liczbami (rejestr redakcyjny,
nie roboczy), biały glassmorphism (rozmycie na białym tle nie daje efektu widocznego
okiem, a kosztuje warstwy kompozycji).

Głos interfejsu: rzeczowy, bez uprzejmości. Komunikat mówi, co się stało i co zrobić.
Statusy po polsku, nigdy surowe enumy platformy sklepowej.

## Colors

Kolor pojawia się wyłącznie tam, gdzie coś znaczy. Wszystko poza stanem jest szarością.

| Rola | Wartość | Użycie |
|---|---|---|
| Płótno | `#08090B` | tło poza panelem aplikacji |
| Aplikacja | `#101114` | tło obszaru roboczego |
| Panel boczny | `#0B0C0F` | nawigacja |
| Powierzchnia | `#16181C` | karta, tabela |
| Powierzchnia wyżej | `#1C1F24` | wiersz pod kursorem, kontrolka wtórna |
| Akcent | `#7C9CFF` | wyłącznie to, co klikalne i aktywne |
| Stan dobry | `#46B784` | połączony sklep, zgodne dane, zakończony import |
| Stan czeka | `#E0A93E` | kampania u klienta, zamówienie w realizacji |
| Stan problem | `#E4736B` | zwrot, anulowanie, rozjazd danych |

**Warstwy rozdziela jasność powierzchni, nie cień.** W ciemnym interfejsie cień nie ma
kontrastu wobec tła i nie niesie informacji o wysokości.

## Typography

Skala: 10, 11, 12, 13, 15, 19, 26 px. Baza 13 px, bo to rozmiar narzędzia, w którym
siedzi się godzinami (w produkcyjnym CSS Lineara 13 px ma 32 deklaracje, 14 px tylko 10).

- Tytuł strony: 19/26, waga 600, tracking −0.015em
- Tytuł sekcji: 13/20, waga 600
- Tekst tabeli: 13, kolor `#C9CFD8`
- Etykieta kolumny i sekcji: 11 px wersalikami, tracking 0.08em, kolor `#808791`
- Klawisz skrótu: 10 px monospace

**Wszystkie liczby monospace z `tabular-nums`.** Kwoty, daty i identyfikatory mają się
zgadzać w pionie co do znaku.

## Layout & Spacing

Siatka 4 px, kroki 4 / 8 / 12 / 16 / 20 / 24. Nawigacja 236 px. Nagłówek strony 44 px,
nie 118: sticky nagłówek zabierający szóstą część ekranu to zmarnowane miejsce na dane.

Wiersz tabeli 30 px. Kontrolki 26 px. Opis ekranu chowa się pod „Jak to działa", żeby
nie wypychać danych poniżej krawędzi ekranu.

## Elevation & Depth

**Zero cieni w całym systemie.** Hierarchia idzie jasnością powierzchni i włosową
krawędzią `#262A31`. Wyżej znaczy jaśniej.

## Shapes

Dwa promienie: 4 px dla klawiszy skrótów, 6 px dla kontrolek i kart. Nic więcej.

## Components

**Plakietka statusu** niesie kształt, nie tylko kolor: kwadrat to stan dobry, trójkąt
to uwaga, okrąg to problem. Przy daltonizmie i przy wydruku informacja zostaje.

**Nawigacja** ma stan aktywny (jaśniejsza powierzchnia plus akcent na ikonie) i licznik
po prawej, żeby operator widział rozmiar zbioru bez wchodzenia w zakładkę.

**Tabela** bez pełnej siatki: pozioma włoska najsłabsza (`#1F2228`), zero pionowych linii,
liczby do prawej. Podświetlenie wiersza niesie tę samą informację co kreska.

**Przycisk główny** `#2C3E75` z ramką `#3C528F`. Przycisk zablokowany zawsze z widocznym
powodem obok, nigdy sam wyszarzony.

**Pasek stanu** na górze ekranu dla rzeczy wymagających decyzji (kampania czekająca
na akceptację klienta), żeby nie trzeba było wchodzić w zakładkę, by się o niej dowiedzieć.

## Do's and Don'ts

- **Nie** przekazuj stanu samym kolorem. Zawsze słowo albo kształt (NFR33).
- **Nie** dokładaj cieni. Warstwa to jasność.
- **Nie** pokazuj surowych enumów platformy sklepowej w interfejsie.
- **Nie** buduj atrapy kontrolki, która nic nie robi. Puste pole wyszukiwania jest gorsze
  niż jego brak.
- **Tak** dla liczników przy pozycjach nawigacji i skrótów wypisanych wprost na ekranie.
- **Tak** dla kwot w monospace i wyrównanych do prawej.
- **Tak** dla pustych stanów pisanych jako zdanie twierdzące z jedną akcją.
