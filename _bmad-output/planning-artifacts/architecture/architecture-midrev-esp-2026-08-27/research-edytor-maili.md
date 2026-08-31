---
title: 'Research: edytor treści maila dla midrev-esp'
type: technical-research
decision: 'domyślny edytor fazy 1 + kontrakt portu TemplateEditor'
binds: ['FR32', 'FR33', 'FR42']
status: rekomendacja
created: '2026-08-27'
stan_na: '2026-08-27'
---

# Edytor treści maila dla własnego ESP MidRev

## Wniosek

Domyślnym edytorem fazy 1 ma być **Maily.to** (`@maily-to/core` + `@maily-to/render`, MIT, w pełni self-hosted), z pinem na `0.3.7` / `0.2.3` i adapterem, który zdejmuje z wyjścia zaszyty webfont z `rsms.me`. Jest to jedyny kandydat, który jednocześnie instaluje się bez konfliktu na React 19.2.8, generuje HTML z poprawną głową dokumentu i responsywnymi kolumnami, ma zadeklarowane API na własne bloki (`blocks`, `extensions`) i nie wprowadza żadnego zewnętrznego podprocesora.

Odrzucone: `react-email-editor` (Unlayer) i GrapesJS Studio SDK jako komponenty hostowane i płatne od 250 USD / 200 USD miesięcznie, EmailBuilder.js jako projekt bez commita od 2026-02-09 i bez wsparcia React 19, GrapesJS z presetem newsletter jako preset porzucony w 2023 roku, Templatical z powodu licencji FSL zakazującej konkurencyjnej usługi hostowanej.

## Metoda i weryfikowalność

Wszystkie daty i wersje pochodzą z rejestru npm i z GitHub API, odczytane 2026-08-27. Trzy twierdzenia zostały sprawdzone doświadczalnie, nie z dokumentacji:

1. **Rozstrzygalność zależności na docelowym stacku.** `npm install --dry-run` w katalogu z `react@19.2.8`, `react-dom@19.2.8`, `zod@4.4.3`.
2. **Jakość wyjścia.** Faktyczne wyrenderowanie dokumentu z nagłówkiem, zmienną, dwiema kolumnami i przyciskiem, z polskimi znakami, i sprawdzenie wyniku regexami.
3. **Zawartość paczek.** Rozpakowane tarballe z npm, czytany `dist`, nie README.

Powtórzenie testu 1:

```bash
mkdir peertest && cd peertest
cat > package.json <<'EOF'
{ "name":"peertest","private":true,
  "dependencies":{"react":"19.2.8","react-dom":"19.2.8","zod":"4.4.3"} }
EOF
npm install --dry-run @maily-to/core@0.3.7 @maily-to/render@0.2.3   # OK, 251 paczek
npm install --dry-run @usewaypoint/email-builder@0.0.9              # ERESOLVE
npm install --dry-run grapesjs@0.23.6 @grapesjs/react@2.0.0         # ERESOLVE
```

## Tabela zbiorcza

| Kandydat | Licencja | Hosting | Ostatnie wydanie | React 19 | Koszt komercyjny | Werdykt |
|---|---|---|---|---|---|---|
| **Maily.to** | [MIT](https://github.com/arikchakma/maily.to/blob/main/license) | w całości u nas | `@maily-to/core` 0.3.7 (2026-02-03), `@maily-to/render` 0.2.3 (2026-01-23) | tak, instaluje się czysto | 0 | **rekomendacja** |
| EmailBuilder.js | [MIT](https://github.com/usewaypoint/email-builder-js/blob/main/package.json) | u nas, ale UI trzeba przepisać | 0.0.9 (2026-01-09), bloki 0.0.3 (2024-04-19) | nie, `ERESOLVE` | 0 | odrzucone |
| GrapesJS + preset newsletter | core [BSD-3-Clause](https://github.com/GrapesJS/grapesjs/blob/dev/packages/core/LICENSE), preset BSD-3-Clause | u nas | core 0.23.6 (2026-08-25), preset 1.0.2 (2023-06-09) | core agnostyczny, wrapper React w konflikcie | 0 | odrzucone |
| GrapesJS Studio SDK | zamknięta, `SEE LICENSE IN LICENSE.md` | licencja per sesja, weryfikacja zdalna | 1.1.1 (2026-05-15) | tak | [200 USD / mies. (20k sesji)](https://grapesjs.com/sdk/pricing) | odrzucone |
| Unlayer (`react-email-editor`) | wrapper MIT, edytor zamknięty | `editor.unlayer.com`, podprocesor | 2.1.2 (2026-08-11) | tak | [250 USD / mies. za white-label](https://unlayer.com/pricing) | odrzucone |
| Templatical | [FSL-1.1-MIT](https://www.npmjs.com/package/@templatical/editor) | u nas, ale paczka wozi klienta Pushera | 0.28.1 (2026-08-25) | tak | 0 z zastrzeżeniem licencyjnym | odrzucone |

## 1. EmailBuilder.js (usewaypoint)

| Pole | Ustalenie |
|---|---|
| Licencja | MIT, `license: "MIT"` w `package.json` każdej paczki, [repo](https://github.com/usewaypoint/email-builder-js) |
| Hosting | w całości własny, zero wywołań zewnętrznych |
| Ostatnie wydanie | `@usewaypoint/email-builder` **0.0.9, 2026-01-09**; paczki bloków (`block-button`, `block-columns-container` i pozostałe) **0.0.3, 2024-04-19** |
| Aktywność | ostatni commit **2026-02-09**, w repo **zero commitów w ostatnich 6 miesiącach**; repozytorium nigdy nie wydało release'u na GitHubie; 1740 gwiazdek, 51 otwartych zgłoszeń |
| React 19 | **nie**. `peerDependencies: react ^16 \|\| ^17 \|\| ^18`. Trzy zgłoszenia dodające React 19 zostały **zamknięte bez merge'a**: [#183](https://github.com/usewaypoint/email-builder-js/pull/183) (2026-02-11), [#190](https://github.com/usewaypoint/email-builder-js/pull/190) (2026-04-08), [#186](https://github.com/usewaypoint/email-builder-js/pull/186) (2026-06-08) |
| Zod | `peer zod ^1 \|\| ^2 \|\| ^3`, projekt ma `zod@4.4.3`, więc drugi konflikt obok Reacta |
| Format wyjścia | HTML z `renderToStaticMarkup(document, { rootBlockId })` |
| Własne bloki | technicznie tak, przez `buildBlockConfigurationDictionary` w `@usewaypoint/document-core`, ale rejestr wymaga zbudowania własnego słownika bloków po stronie edytora, którego nie ma w paczce |
| Koszt | 0 |

### Co przesądza

**Nie ma paczki z edytorem.** Na npm publikowane są wyłącznie renderer i bloki. Interfejs edytora żyje jako `examples/vite-emailbuilder-mui`, oznaczony `"private": true`, na React 18, MUI 5, Vite 5 i Zustand 4. Adopcja oznacza wklejenie tej aplikacji do naszego repo i utrzymywanie jej samodzielnie, przy okazji wciągając MUI do stacku, który stoi na Tailwindzie 4.

**Wyjście nie ma głowy dokumentu.** Renderer składa dosłownie:

```js
return "<!DOCTYPE html>" + renderToStaticMarkup(
  React.createElement("html", null,
    React.createElement("body", null,
      React.createElement(Reader, { document, rootBlockId }))));
```

Brak `<head>`, brak `charset`, brak `viewport`, brak `lang`, brak przestrzeni nazw dla VML. Brak deklaracji `charset` przy polskich znakach diakrytycznych to nie jest kosmetyka, tylko realne ryzyko krzaków w klientach, które nie ufają nagłówkowi MIME.

**Kolumny nie zwijają się na telefonie.** `ColumnsContainer` renderuje `<table style="table-layout: fixed">` z trzema `<td>`, a w całej paczce nie ma ani jednej reguły `@media`. Trzykolumnowy blok produktowy z FR42 zostanie na telefonie ściśnięty do trzech kolumn po około 60 pikseli.

Na plus: przycisk ma poprawny trik ghost padding dla Outlooka (`<!--[if mso]><i style="letter-spacing:...;mso-font-width:-100%" hidden>`), więc autor wiedział, co robi. To jednak wyspa jakości w projekcie, który stanął.

**Ryzyko:** projekt bez opiekuna. Przy pierwszym problemie z Reactem albo z klientem pocztowym jesteśmy sami z forkiem, którego nikt nie zamawiał.

## 2. GrapesJS z presetem newsletter

| Pole | Ustalenie |
|---|---|
| Licencja core | BSD-3-Clause, [`packages/core/LICENSE`](https://github.com/GrapesJS/grapesjs/blob/dev/packages/core/LICENSE), z klauzulą zakazującą używania nazwy GrapesJS do promocji produktu pochodnego. Do odsprzedaży bez przeszkód, wymaga zachowania noty w materiałach |
| Licencja presetu | BSD-3-Clause, [`grapesjs-preset-newsletter`](https://github.com/GrapesJS/preset-newsletter) |
| Hosting | w całości własny |
| Ostatnie wydanie core | 0.23.6, **2026-08-25**, repo aktywne (26166 gwiazdek) |
| Ostatnie wydanie presetu | 1.0.2, **2023-06-09**, ostatni commit tego samego dnia, czyli **ponad 3 lata bez zmiany** |
| React 19 | core jest waniliowym JS, więc obojętny. Oficjalny wrapper [`@grapesjs/react`](https://www.npmjs.com/package/@grapesjs/react) 2.0.0 wydany **2025-02-20** deklaruje `peer grapesjs: ^0.22.5`, co przy core 0.23.6 daje `ERESOLVE`. Da się obejść `overrides`, ale to obejście, nie zgodność |
| Format wyjścia | HTML plus CSS, opcjonalnie MJML przez [`grapesjs-mjml`](https://github.com/GrapesJS/mjml) 1.0.8 (2026-03-13), BSD-3-Clause, repo ruszane 2026-06-15 |
| Własne bloki | tak i to najmocniejsza strona GrapesJS: `BlockManager`, własne typy komponentów, traits. Kosztem jest to, że blok trzeba opisać podwójnie, raz jako komponent kanwy, raz jako serializację |
| Koszt | 0 dla core |

### Co przesądza

GrapesJS to edytor stron, nie maili. Warstwą, która czyniła z niego edytor newsletterów, jest preset stojący od 2023 roku, a druga droga (`grapesjs-mjml`) zamienia go w edytor MJML, gdzie operator marketingowy dostaje kanwę zachowującą się jak dokument HTML, a nie jak zestaw bloków.

Osobna sprawa to kierunek projektu. Autor GrapesJS założył w 2025 roku spółkę komercyjną i buduje **Studio SDK**, czyli zamkniętą wersję osadzalną. Paczka `@grapesjs/studio-sdk` 1.1.1 (2026-05-15) deklaruje `"license": "SEE LICENSE IN LICENSE.md"`, a [cennik](https://grapesjs.com/sdk/pricing) jest rozliczany sesjami: Free 1 000 sesji miesięcznie (50 USD za każdy kolejny tysiąc), **Startup 200 USD / mies. za 20 000 sesji** (20 USD za nadwyżkowy tysiąc), **Business 2 000 USD / mies. za 50 000 sesji** (10 USD), Enterprise po kontakcie. Startup dopuszcza 2 domeny, każda kolejna 150 USD.

Dla nas oznacza to trzy rzeczy naraz: koszt rosnący z liczbą klientów agencji, licencja weryfikowana zdalnie (czyli kolejny podmiot w łańcuchu przy umowie powierzenia) i wyraźny sygnał, że rozwój funkcji mailowych idzie do produktu płatnego, a nie do core'a.

**Ryzyko:** przyjmujemy najcięższy w utrzymaniu edytor w zestawie, żeby po roku odkryć, że rozsądna droga prowadzi do 200 USD miesięcznie i weryfikacji licencji przez sieć.

## 3. Maily.to

| Pole | Ustalenie |
|---|---|
| Licencja | **MIT**, plik [`license`](https://github.com/arikchakma/maily.to/blob/main/license) w korzeniu monorepo, Copyright Arik Chakma. **Uwaga:** opublikowane paczki npm nie mają pola `license` w `package.json` ani pliku licencji w tarballu (`files: ["dist/**"]`). Licencja obowiązuje z poziomu repozytorium, ale tekst MIT trzeba samodzielnie dołączyć do noty o oprogramowaniu zewnętrznym w produkcie odsprzedawanym klientom |
| Hosting | w całości własny. Edytor to komponent React, renderer to funkcja w Node. Zero wywołań do usług autora |
| Ostatnie wydanie | `@maily-to/core` **0.3.7 (2026-02-03)**, `@maily-to/render` **0.2.3 (2026-01-23)**. Kanał `beta`: `2.0.0-beta.7` (2026-06-11) |
| Aktywność | ostatni commit **2026-07-21**, ale **tylko 2 commity w ostatnich 6 miesiącach**. 3950 gwiazdek, 5 otwartych zgłoszeń. Otwarty od 2026-04-11 [PR #234 „v2: Complete rewrite of Maily editor"](https://github.com/arikchakma/maily.to/pull/234) |
| React 19 | **tak**. `peer react: ^18 \|\| ^19`. Instalacja na `react@19.2.8` przechodzi bez konfliktu (251 paczek). Pod spodem TipTap 2.27.2. Beta 2.0.0 idzie na `peer react: ^19.2.5` i TipTap 3.22.3 |
| Format wyjścia | dokument to JSON TipTapa (ProseMirror). HTML powstaje po stronie serwera przez `@react-email/render` plus `juice` do inline'owania CSS |
| Własne bloki | **tak, jako zadeklarowane API.** `Editor` przyjmuje `blocks?: BlockGroupItem[]` i `extensions?: AnyExtension[]` |
| Koszt | 0 |

### Co potwierdził test renderowania

Wyrenderowany dokument (nagłówek z polskimi znakami, akapit ze zmienną, dwie kolumny, przycisk, tekst preheadera, piksel otwarcia) dał 5987 znaków HTML. Sprawdzone regexami na faktycznym wyjściu:

| Kontrola | Wynik |
|---|---|
| `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN">` | jest |
| `<head>` z `charset=UTF-8`, `viewport`, `x-apple-disable-message-reformatting`, `format-detection` | jest |
| `@media only screen and (max-width:425px)` z `.tab-col-full{display:block!important;width:100%!important}` | jest, **kolumny zwijają się na telefonie** |
| tekst preheadera | jest |
| piksel otwarcia z podanego przez nas URL-a | jest |
| podstawienie zmiennej (`setVariableValues`) | jest |
| layout tabelaryczny plus reguły `mso-` | jest |
| polskie znaki diakrytyczne (`żółć`) | poprawne |

### Co Maily daje pod nasze wymagania funkcjonalne

- **FR32, edytor wizualny.** Gotowy komponent `Editor` z paskiem narzędzi, menu ukośnika i menu kontekstowym. Bloki wbudowane: `text`, `heading1..3`, `button`, `image`, `inlineImage`, `logo`, `linkCard`, `columns`, `section`, `repeat`, `spacer`, `divider`, listy, `blockquote`, `footer`, `htmlCodeBlock`, `clearLine`.
- **FR33, wgrywanie grafik.** `ImageUploadExtension` przyjmuje `onImageUpload?: (file: Blob) => Promise<string>`, obsługuje przeciągnięcie i wklejenie, domyślnie z listą dozwolonych typów MIME. Podpinamy go do własnego magazynu plików i edytor nigdy nie wysyła pliku gdzie indziej.
- **FR42, blok produktowy.** Renderer ma węzeł `repeat` (dawniej `for`) oraz `setPayloadValues(values)`, czyli natywny mechanizm powtarzania podrzewa po tablicy danych. Blok produktowy nie wymaga własnego renderera: definiujemy w edytorze węzeł konfiguracyjny (którą kolekcję, ile pozycji), a przy renderowaniu podajemy produkty w `payloadValues`. Do tego `showIfKey` w atrybutach węzłów daje bloki warunkowe.
- **Wysyłka.** `setOpenTrackingPixel(url)`, `getAllLinks()` i `setLinkValues(map)` to gotowe zaczepy pod piksel otwarcia i przepisywanie linków klikalnych, czyli dokładnie to, czego potrzebuje AD-19 i moduł atrybucji. Żaden inny kandydat nie ma tego wbudowanego.
- **Marka klienta.** `setTheme` na kolory i rozmiary, `setHtmlProps` na `lang` i `dir`, `setMetaTags` na nagłówki dokumentu. `MailyKit` pozwala wyłączyć poszczególne węzły, czyli ograniczyć zestaw bloków per tenant.

### Trzy rzeczy do naprawienia w adapterze, wykryte w teście

1. **Zaszyty webfont z `rsms.me`.** Każdy wyrenderowany mail zawiera `@font-face` z `src: url(https://rsms.me/inter/font-files/Inter-Regular.woff2)`. Sprawdzone: `setTheme({ font: ... })` **tego nie usuwa**. Skutek jest taki, że klient pocztowy odbiorcy, który honoruje zdalny CSS, pobiera plik z serwera osoby trzeciej, ujawniając mu adres IP odbiorcy. Do produktu sprzedawanego z umową powierzenia to nie przechodzi. Adapter musi wycinać ten blok `<style>` po renderowaniu i podstawiać stos czcionek systemowych albo webfont z naszej domeny. Jest to kilka linijek, ale musi być zapisane jako obowiązkowy krok i pokryte testem.
2. **`lang="en"` domyślnie.** Naprawiane przez `setHtmlProps({ lang: 'pl', dir: 'ltr' })`, potwierdzone testem. Adapter ustawia to z lokalizacji tenanta, nie na sztywno.
3. **Brak trybu ciemnego.** Wyjście deklaruje `color-scheme: light` i `supported-color-schemes: light`. Jeśli tryb ciemny wejdzie do zakresu, dokłada się go przez `setMetaTags`, ale w fazie 1 świadomie zostaje jak jest.

### Ryzyka Maily i plan wyjścia

- **Tempo prac.** Dwa commity w pół roku, a wersja stabilna nie ruszyła się od lutego 2026. Projekt nie jest martwy (jest sponsorowany, między innymi przez Novu), ale jest wolny.
- **Przepisanie na v2.** Otwarty PR #234 i seria `2.0.0-beta` zapowiadają zmianę API i skok na TipTap 3. Faza 1 pinuje `0.3.7` / `0.2.3` na sztywno i nie tyka bety.
- **Podwójny Tailwind.** `@maily-to/core` trzyma `tailwindcss` i `@tailwindcss/postcss` w `dependencies`, nie w `devDependencies`. Test rozstrzygania podniósł `@tailwindcss/postcss@4.3.3`, czyli tę samą wersję, którą ma projekt, więc dziś to bezkolizyjne, ale trzeba pilnować przy podbiciach.
- **Plan wyjścia.** Licencja MIT plus rozmiar rendererza (`dist` około 21 KB) sprawiają, że fork jest realną, a nie teoretyczną opcją. Gdyby projekt zamarł albo v2 poszła w bok, przejmujemy `@maily-to/render` do repo i utrzymujemy sami. Edytor jest cieńszą warstwą nad TipTapem, który sam w sobie jest żywy.

## 4. Unlayer, wersja self-hosted lub on-premise

Taka opcja **istnieje, ale wyłącznie w planie Enterprise z ceną na zapytanie**. [Cennik Unlayera](https://unlayer.com/pricing) na 2026-08-27: Free 0 USD, **Launch 250 USD / mies.**, **Scale 750 USD / mies.**, **Optimize 2 000 USD / mies.**, Enterprise po kontakcie. White-label zaczyna się od Launch. Wiersz „On-Premise / Offline" występuje **tylko w kolumnie Enterprise**, co potwierdza FAQ na tej samej stronie („Enterprise plans include custom contracts, SOC 2 Type II, on-premise deployment, white-label, and a dedicated CSM").

Wniosek dla nas: jedyna konfiguracja Unlayera, która nie czyni z `editor.unlayer.com` naszego podprocesora, jest jednocześnie jedyną bez podanej ceny i wymaga negocjacji kontraktu. Dla produktu, który dopiero ma pierwszego klienta, to nie jest punkt startu.

## 5. Pozostali kandydaci, sprawdzeni i odrzuceni

| Projekt | Ustalenie | Dlaczego odpada |
|---|---|---|
| [react-email](https://github.com/resend/react-email) 6.9.3 (2026-08-25), MIT | 19672 gwiazdek, bardzo aktywne, `peer react ^18 \|\| ^19` | **To nie jest edytor.** To biblioteka komponentów plus serwer podglądu dla programisty. FR32 wymaga edycji przez operatora. Trafia jednak do stacku tylnymi drzwiami, bo `@maily-to/render` renderuje właśnie przez `@react-email/render` i `@react-email/components`, czyli bierzemy jakość react-email bez pisania szablonów w kodzie |
| [easy-email](https://github.com/zalify/easy-email-editor) 4.17.1 (2026-06-10), MIT | oparte na MJML, repo ruszane 2026-08-13, 2919 gwiazdek | `peer react: ^18.2.0` bez React 19. Ciągnie `react-final-form` i `mjml-browser`, czyli MJML kompilowany w przeglądarce. Wersja komercyjna (Easy Email Pro) jest płatna, co powtarza schemat open core |
| [Templatical](https://www.npmjs.com/package/@templatical/editor) 0.28.1 (2026-08-25) | bardzo aktywne, ale licencja **FSL-1.1-MIT** | Klauzula wprost: „provided that you do not offer the Software, or a substantially similar product built using the Software, as a hosted or managed service that competes with Templatical's commercial offerings". Nasz ESP to usługa hostowana z osadzonym edytorem, więc pytanie o konkurencyjność jest sporne, a spornej licencji nie wkłada się do produktu odsprzedawanego klientom. Dodatkowo w `dist` siedzi klient `pusher-js` i odwołania do `templatical.com`, czyli w pakiecie jedzie warstwa chmurowa |
| [Mosaico](https://github.com/voidlabs/mosaico), GPL-3.0 | ostatni ruch 2025-08-22 | GPL plus Knockout.js. Wiekowe podejście, brak Reacta, brak sensownego API na bloki |
| [mysigmail/card](https://github.com/mysigmail/card), AGPL-3.0 | ruszane 2026-08-24 | AGPL z klauzulą sieciową. Dla zamkniętego SaaS-a odsprzedawanego klientom to wymusiłoby otwarcie kodu |

## 6. MJML: czy ma sens w tym produkcie

MJML żyje: [`mjml` 5.4.0](https://github.com/mjmlio/mjml/releases) wydany **2026-06-29**, MIT, 18211 gwiazdek. Wrapper reactowy [`@faire/mjml-react` 4.0.1](https://www.npmjs.com/package/@faire/mjml-react) (2026-06-01) obsługuje React 19.

Mimo to **nie wprowadzamy MJML do fazy 1**, z trzech powodów.

1. **Rozwiązuje problem, którego nie mamy.** MJML jest warstwą pośrednią dla ludzi piszących szablony ręcznie. My mamy edytor blokowy: dokument JSON i renderer w jednym kroku. Dokładanie MJML oznaczałoby JSON → MJML → HTML, czyli o jedną reprezentację i jedno źródło rozjazdów więcej.
2. **Kompilator MJML to zależność wagi ciężkiej.** Wciąga własny parser i całe drzewo komponentów po stronie serwera, dla efektu, który `@react-email/render` plus `juice` osiągają lżej.
3. **MJML wraca dopiero razem z konkretną potrzebą.** Jedyny scenariusz, który go uzasadnia, to zaimportowanie u klienta gotowej biblioteki szablonów MJML przy migracji z innego ESP (FR62 do FR65). To jest zadanie dla osobnego adaptera importu, nie powód, by przestawiać na MJML edytor.

Zapis do decyzji: port `TemplateEditor` ma być na tyle wąski, żeby przyszły adapter oparty o MJML (GrapesJS z `grapesjs-mjml` albo import szablonów) wszedł jako kolejna implementacja, bez ruszania modułu kampanii. To warunek, nie deklaracja intencji.

## 7. Rekomendacja

**Maily.to jako domyślny edytor fazy 1, pinowany na `@maily-to/core@0.3.7` i `@maily-to/render@0.2.3`.**

Uzasadnienie w kolejności wagi:

1. **Jedyny kandydat bez podprocesora.** Cała ścieżka, od edycji po HTML, wykonuje się na naszej infrastrukturze. Umowa powierzenia z klientem agencji nie zyskuje ani jednego nowego podmiotu. Alternatywy, które by tu weszły, to `editor.unlayer.com` przy Unlayerze, weryfikacja licencji przy Studio SDK i Pusher przy Templatical.
2. **Jedyny kandydat, który instaluje się na React 19.2.8 bez obejść.** Potwierdzone doświadczalnie, a nie odczytane z README. EmailBuilder.js i wrapper reactowy GrapesJS przewracają rozstrzyganie zależności.
3. **Jedyny kandydat z jakością wyjścia sprawdzoną na faktycznym HTML.** Głowa dokumentu, `charset`, zwijanie kolumn na telefonie i poprawne polskie znaki potwierdzone testem, a nie obietnicą. U EmailBuildera brakuje głowy dokumentu i reguł `@media`, co przy pierwszym mailu do polskiej bazy wyjdzie na produkcji.
4. **Trzy wymagania funkcjonalne mają gotowe zaczepy.** `blocks` i `extensions` na FR42, `onImageUpload` na FR33, gotowy `Editor` na FR32. Do tego `setOpenTrackingPixel` i `setLinkValues`, których nie ma nigdzie indziej, a są nam potrzebne w module wysyłki.
5. **Koszt zero i możliwość forka.** MIT plus mały renderer oznacza, że najgorszy scenariusz (projekt zamiera) kończy się przejęciem 21 KB kodu, a nie zmianą edytora w produkcie z żywymi klientami.

Warunki wdrożenia, bez których rekomendacja nie obowiązuje:

- Adapter **musi** usuwać z wyjścia `@font-face` wskazujący na `rsms.me`, a test akceptacyjny musi to sprawdzać.
- `lang` i `dir` ustawiane z lokalizacji tenanta przez `setHtmlProps`.
- Wersje pinowane dokładnie, kanał `beta` wykluczony do czasu wydania 2.0.0 stabilnego i osobnej decyzji.
- Tekst licencji MIT z repozytorium Maily dołączony do noty o oprogramowaniu zewnętrznym produktu, bo paczki npm go nie wiozą.

## 8. Port `TemplateEditor`: co musi w nim być

Cel portu jest jeden: **zmiana edytora ma być podmianą adaptera, a nie przepisaniem modułu kampanii.** Poniżej to, co musi być w kontrakcie, żeby tak było, wraz z powodem. Każdy punkt odpowiada konkretnej ścieżce, którą łatwo zepsuć.

### 8.1 Trzy rozdzielone odpowiedzialności

Najczęstszy błąd to zlepienie edycji, przechowywania i renderowania w jedno. Port rozbija je na trzy niezależne kontrakty.

```ts
// src/domain/ports/template-editor.ts

/** Dokument szablonu. Rdzeń NIGDY nie zagląda do `content`. */
export type TemplateDocument = {
  editorId: string;        // 'maily'
  schemaVersion: number;   // wersja formatu TEGO edytora
  content: unknown;        // nieprzezroczysta dla domeny i dla modułu kampanii
};

/** Renderowanie: serwer, czysta funkcja wejścia w HTML. */
export interface TemplateRenderer {
  readonly editorId: string;
  capabilities(): EditorCapabilities;
  validate(doc: TemplateDocument): Result<void>;
  render(input: RenderInput): Promise<RenderOutput>;
  migrate(doc: TemplateDocument, toVersion: number): Result<TemplateDocument>;
}

export type RenderInput = {
  document: TemplateDocument;
  locale: string;                          // 'pl'
  brand: BrandTheme;                       // kolory, czcionki, logo tenanta
  variables: Record<string, string>;       // wartości merge tagów profilu
  products: ProductForRender[];            // FR42, rozwiązane PRZED renderowaniem
  rewriteLink: (url: string) => string;    // przepisanie na link śledzony
  openPixelUrl?: string;
  mode: 'preview' | 'test' | 'send';
};

export type RenderOutput = {
  html: string;
  text: string;              // wersja tekstowa, obowiązkowa
  links: string[];           // wszystkie URL-e do rejestracji kliknięć
  warnings: RenderWarning[];
};

export type EditorCapabilities = {
  productBlock: boolean;
  conditionalBlock: boolean;
  loopBlock: boolean;
  rawHtmlBlock: boolean;
  imageUpload: boolean;
  darkMode: boolean;
};
```

Strona edycji żyje w `web` i jest osobnym kontraktem, bo to komponent React, a nie byt domenowy:

```ts
// src/web/ports/template-editor-ui.ts
export type TemplateEditorProps = {
  value: TemplateDocument;
  onChange: (doc: TemplateDocument) => void;
  variables: VariableDefinition[];              // katalog merge tagów tenanta
  uploadImage: (file: Blob) => Promise<string>; // FR33, przez port magazynu plików
  pickProducts: () => Promise<ProductRef[]>;    // FR42, przez port platformy sklepowej
  brand: BrandTheme;
  locale: string;
  readOnly?: boolean;
};
```

### 8.2 Reguły, które przesądzają o wymienialności

**R1. Moduł kampanii nie zna formatu dokumentu.** W bazie `campaigns` trzyma `template_editor_id text`, `template_schema_version integer` i `template_content jsonb`. Żaden kod poza adapterem edytora nie parsuje `template_content`. Bez tego pierwsze zapytanie w stylu „policz bloki obrazkowe w kampanii" przykleja moduł kampanii do TipTapa na stałe.

**R2. HTML nie jest źródłem prawdy kampanii.** Jest artefaktem renderowania, utrwalanym na `messages` w chwili wysyłki (AD-6). Kampania trzyma dokument, wiadomość trzyma HTML, który poszedł. Dzięki temu podmiana edytora nie zmienia wstecznie tego, co odbiorcy już dostali, a podgląd archiwalnej wysyłki nie wymaga starego rendererza.

**R3. Przepisywanie linków wykonuje adapter przez wstrzykniętą funkcję, nie regex po HTML.** `rewriteLink` wchodzi w `RenderInput`, adapter stosuje ją do wartości `href` na poziomie dokumentu (w Maily przez `setLinkValues`). Regex po gotowym HTML rozjeżdża się na komentarzach warunkowych Outlooka i na URL-ach w atrybutach stylu, a błąd tu oznacza niepoliczone kliknięcia w atrybucji (AD-14).

**R4. Blok produktowy jest referencją, nie zrzutem danych.** Dokument zapisuje odwołanie („kolekcja X, 3 pozycje, sortowanie Y"), nigdy nazw i cen. Produkty rozwiązuje use-case przez port `StorePlatform` (AD-8) tuż przed renderowaniem i podaje w `RenderInput.products`. Inaczej mail wysłany za tydzień pokaże cenę sprzed tygodnia, a to jest ryzyko prawne, nie kosmetyczne.

**R5. Wgrywanie grafik idzie przez port magazynu plików.** Adapter edytora dostaje wyłącznie `uploadImage`, callback zwracający URL. Żadna implementacja edytora nie ma prawa wysyłać pliku samodzielnie. To jedyne, co powstrzymuje przyszły adapter hostowany przed cichym wyprowadzeniem grafik klienta na obcy serwer.

**R6. Katalog zmiennych należy do domeny.** Edytor dostaje listę `VariableDefinition` i nic o niej nie wie. Nazwy merge tagów to kontrakt, tak jak nazwy zdarzeń w konwencjach spine'u, i nie mogą pochodzić z konfiguracji edytora.

**R7. Zdolności deklarowane, nie zakładane.** `capabilities()` działa tak jak `capabilities` adaptera platformy sklepowej (AD-8): interfejs chowa blok produktowy, jeśli aktywny edytor go nie ma. Bez tego pierwszy adapter bez `repeat` rozwala ekran kampanii, zamiast wyłączyć jedną opcję.

**R8. Podgląd, wysyłka testowa i wysyłka właściwa mają jedną ścieżkę renderowania.** Różnią się wyłącznie polem `mode` w `RenderInput`. Druga ścieżka podglądu to dokładnie ten sam wzorzec błędu, który AD-9 blokuje przy wykluczeniach: to, co obejrzał operator, przestaje być tym, co dostał odbiorca.

**R9. Migracja wersji formatu należy do adaptera.** `schemaVersion` plus `migrate()`. Zmiana formatu przez autora edytora (na przykład Maily v2) jest wtedy zadaniem wewnątrz adaptera, a nie migracją danych w module kampanii.

**R10. Jeden wspólny zestaw testów akceptacyjnych obowiązuje każdy adapter**, tak jak w AD-8 i AD-20, na realnym wyjściu, nie na mockach. Minimum:

| Test | Asercja |
|---|---|
| kodowanie | wyjście deklaruje `charset=UTF-8`, polskie znaki diakrytyczne przechodzą bez zniekształceń |
| język | `lang` odpowiada `locale` z wejścia |
| responsywność | kolumny zwijają się poniżej 480 px, obecna reguła `@media` |
| brak obcych hostów | **żaden** zewnętrzny host w `src`, `href` czcionek ani w `@font-face`, poza domenami tenanta i naszym CDN-em |
| śledzenie | każdy link zewnętrzny przepisany przez `rewriteLink`, `links` zawiera komplet |
| piksel | przy `mode: 'send'` i podanym `openPixelUrl` piksel obecny, przy `mode: 'preview'` nieobecny |
| wersja tekstowa | `text` niepusty i pozbawiony znaczników |
| determinizm | to samo wejście daje bajt w bajt to samo wyjście |
| izolacja tenanta | renderowanie z marką tenanta A nie wciąga zasobów tenanta B |

### 8.3 Co dopisać do ARCHITECTURE-SPINE

Proponowana decyzja do dopisania obok AD-7 i AD-8:

> **AD-21, Port TemplateEditor z nieprzezroczystym dokumentem**
> - **Binds:** moduł kampanii, automatyzacje, wysyłka
> - **Prevents:** przyklejenie modułu kampanii do formatu jednego edytora, przez co zmiana edytora stałaby się przepisaniem, oraz wyciek zasobów odbiorcy do obcych hostów przez domyślną konfigurację edytora
> - **Rule:** kampania trzyma `editor_id`, `schema_version` i nieprzezroczysty `content`; renderowanie idzie wyłącznie przez `TemplateRenderer` z wstrzykniętymi `rewriteLink`, `products` i `brand`; HTML utrwala się na `messages`, nie na kampanii; wspólny zestaw testów akceptacyjnych obowiązuje każdy adapter i zawiera kontrolę braku obcych hostów w wyjściu

Do sekcji `stack.key_deps` wchodzi `@maily-to/core@0.3.7` i `@maily-to/render@0.2.3` w miejsce `react-email-editor@2.1.2`.

## Źródła

- EmailBuilder.js: [repozytorium](https://github.com/usewaypoint/email-builder-js), [`@usewaypoint/email-builder` na npm](https://www.npmjs.com/package/@usewaypoint/email-builder), PR-y React 19: [#183](https://github.com/usewaypoint/email-builder-js/pull/183), [#186](https://github.com/usewaypoint/email-builder-js/pull/186), [#190](https://github.com/usewaypoint/email-builder-js/pull/190)
- GrapesJS: [repozytorium](https://github.com/GrapesJS/grapesjs), [licencja core](https://github.com/GrapesJS/grapesjs/blob/dev/packages/core/LICENSE), [preset newsletter](https://github.com/GrapesJS/preset-newsletter), [grapesjs-mjml](https://github.com/GrapesJS/mjml), [`@grapesjs/react`](https://www.npmjs.com/package/@grapesjs/react), [cennik Studio SDK](https://grapesjs.com/sdk/pricing), [`@grapesjs/studio-sdk` na npm](https://www.npmjs.com/package/@grapesjs/studio-sdk)
- Maily.to: [repozytorium](https://github.com/arikchakma/maily.to), [licencja MIT](https://github.com/arikchakma/maily.to/blob/main/license), [`@maily-to/core`](https://www.npmjs.com/package/@maily-to/core), [`@maily-to/render`](https://www.npmjs.com/package/@maily-to/render), [PR #234 v2](https://github.com/arikchakma/maily.to/pull/234)
- Unlayer: [cennik](https://unlayer.com/pricing), [`react-email-editor`](https://github.com/unlayer/react-email-editor)
- react-email: [repozytorium](https://github.com/resend/react-email), [`react-email` na npm](https://www.npmjs.com/package/react-email)
- MJML: [repozytorium](https://github.com/mjmlio/mjml), [`@faire/mjml-react`](https://www.npmjs.com/package/@faire/mjml-react)
- easy-email: [repozytorium](https://github.com/zalify/easy-email-editor), [`easy-email-editor` na npm](https://www.npmjs.com/package/easy-email-editor)
- Templatical: [`@templatical/editor` na npm](https://www.npmjs.com/package/@templatical/editor), tekst licencji FSL-1.1-MIT z pliku `LICENSE` w tarballu paczki 0.28.1
- Mosaico: [repozytorium](https://github.com/voidlabs/mosaico)
