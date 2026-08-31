# Review faktów technicznych: ARCHITECTURE-SPINE midrev-esp

Data sprawdzenia: **2026-08-27**
Zakres: frontmatter `stack`, sekcja Structural Seed, AD-5, AD-6, AD-15, AD-16, sekcja Deferred.
Metoda: odczyt rejestru npm (`registry.npmjs.org`), API GitHub, dokumentacja producentów, cenniki. Nic z pamięci modelu.

## Werdykt

**Dokument wymaga poprawek.** Osiem znalezisk, w tym trzy blokujące start implementacji:

1. Struktura katalogów jest sprzeczna z Next.js App Router (`src/web/` nie zostanie znalezione, `src/app/` zostanie potraktowane jako router).
2. TypeScript 5.9.3 to zła wersja ostrożna. Właściwa ostrożna wersja to 6.0.3.
3. react-email-editor przy odsprzedaży produktu kosztuje minimum 250 USD/mies. i wprowadza obcy podmiot przetwarzający dane.

Wersje pakietów same w sobie są prawdziwe: wszystkie osiem istnieje w rejestrze npm i siedem z ośmiu to faktycznie `dist-tags.latest` na dzień 27.08.2026.

---

## 1. Wersje pakietów

Odczyt bezpośrednio z rejestru npm 27.08.2026:

| Pakiet | W dokumencie | `latest` w npm 27.08.2026 | Data publikacji tej wersji | Werdykt |
|---|---|---|---|---|
| next | 16.3.3 | 16.3.3 | rejestr modyfikowany 2026-08-27 | zgadza się |
| react | 19.2.8 | 19.2.8 | rejestr modyfikowany 2026-08-26 | zgadza się |
| tailwindcss | 4.3.3 | 4.3.3 | rejestr modyfikowany 2026-08-14 | zgadza się |
| typescript | 5.9.3 | 7.0.2 | 5.9.3 wydany **2025-09-30** | **do zmiany, patrz punkt 2** |
| pg | 8.23.0 | 8.23.0 | rejestr modyfikowany 2026-08-08 | zgadza się |
| zod | 4.4.3 | 4.4.3 | rejestr modyfikowany 2026-08-27 | zgadza się |
| vitest | 4.1.11 | 4.1.11 (linia 5.0 jest na tagu `rc`) | rejestr modyfikowany 2026-08-18 | zgadza się |
| react-email-editor | 2.1.2 | 2.1.2 | **2026-08-11** | wersja aktualna, ale patrz punkt 3 |

Źródła: `https://registry.npmjs.org/next`, `/react`, `/tailwindcss`, `/typescript`, `/pg`, `/zod`, `/vitest`, `/react-email-editor` (odczyt 2026-08-27).

### Zgodność między nimi

Sprawdzone w `peerDependencies` i `engines` bezpośrednio z manifestów npm:

- **next@16.3.3**: `peerDependencies.react = "^18.2.0 || 19.0.0-rc-de68d2f4-20241204 || ^19.0.0"`, `engines.node = ">=20.9.0"`. React 19.2.8 mieści się w tym zakresie. Brak konfliktu.
- **vitest@4.1.11**: `engines.node = "^20.0.0 || ^22.0.0 || >=24.0.0"`, `peerDependencies.vite = "^6.0.0 || ^7.0.0 || ^8.0.0"`. Vitest nie deklaruje `typescript` jako peer, więc nie ma twardej niezgodności z TS 5.9. Ograniczenie dotyczy tylko trybu `--typecheck`, patrz punkt 2.
- **Next 16 + Tailwind 4**: brak konfliktu na poziomie zależności. Jest natomiast **rozjazd w minimalnej przeglądarce**. Next.js 16 deklaruje próg Chrome 111+, Edge 111+, Firefox 111+, Safari 16.4+ (https://nextjs.org/docs/app/guides/upgrading/version-16, sprawdzone 2026-08-27). Tailwind v4 deklaruje Chrome 111, Safari 16.4 i **Firefox 128** (https://tailwindcss.com/docs/compatibility, sprawdzone 2026-08-27). Faktyczny próg panelu to Firefox 128, nie 111. Do panelu operatora bez znaczenia, ale jeśli cokolwiek z Tailwinda trafi do widoku klienta, to jest to liczba, którą trzeba znać.

**Nie ma niezgodności Next 16 + React 19 + Tailwind 4.** Ta trójka jest spójna.

---

## 2. TypeScript 5.9.3 vs 7.0.2: ostrożność jest słuszna, ale skierowana na złą wersję

### Ustalenia

- **TypeScript 7.0.2 wydany 2026-07-08** i jest tagiem `latest` w npm. To pełne przepisanie kompilatora w Go. Pakiet npm `typescript@7` **nie zawiera już `lib/typescript.js`**, czyli JavaScriptowego Compiler API. W `lib/` został tylko shim `tsc.js` delegujący do binarki natywnej. Źródło: https://github.com/vercel/next.js/discussions/95633 (sprawdzone 2026-08-27).
- **Next.js 16 wykrywa TypeScript przez ten właśnie JS Compiler API** (`createProgram`, plugin language service, obsługa typów `next.config.ts`). Przy `typescript@7.0.2` wykrywanie się wywala i Next raportuje pakiet jako niezainstalowany, mimo że jest.
- Obejście weszło w PR https://github.com/vercel/next.js/pull/95639, **zmergowany 2026-07-10 do canary**, jako flaga eksperymentalna **`experimental.useTypeScriptCli`**, która każe Nextowi wołać lokalne `tsc` zamiast API. Domyślny backend nadal zakłada instalację zgodną z TypeScriptem 6. Maintainer w tym samym wątku: pełne wsparcie API wymaga dopiero **TypeScript 7.1**.
- **Vitest 4 w trybie `--typecheck` woła `tsc` albo `vue-tsc` i parsuje wyjście.** Nie obsługuje `tsgo` jako silnika typecheckowania. Przy `typescript` rozwiązanym do wersji natywnej ten tryb pada. Źródła: https://vitest.dev/config/typecheck oraz https://vitest.dev/guide/testing-types (sprawdzone 2026-08-27).

**Wniosek: powstrzymanie się od TypeScripta 7.0.2 jest uzasadnione, nie jest przesadą.** Cena to flaga eksperymentalna w Nexcie plus utrata trybu typecheck w Viteście.

### Ale 5.9.3 to zła wersja ostrożna

Linia stabilna przed 7.0 to nie 5.9, tylko **6.0**:

| Wersja | Data wydania |
|---|---|
| 5.9.2 | 2025-07-31 |
| **5.9.3** | **2025-09-30** |
| 6.0.2 | 2026-03-23 |
| **6.0.3** | **2026-04-16** |
| 7.0.2 | 2026-07-08 |

(odczyt `time` z https://registry.npmjs.org/typescript, 2026-08-27)

TypeScript 6.0 to celowo wydana wersja pomostowa: ostatnia zbudowana na kompilatorze w JavaScripcie, która wprowadza nowe domyślne ustawienia i oznacza deprecacje, a TypeScript 7.0 te ustawienia przyjmuje i zamienia deprecacje w twarde błędy. Źródła: https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/ oraz https://visualstudiomagazine.com/articles/2026/03/23/typescript-6-0-ships-as-final-javascript-based-release-clears-path-for-go-native-7-0.aspx (sprawdzone 2026-08-27).

Konsekwencja dla projektu zaczynanego od zera w sierpniu 2026: pisanie pod 5.9.3 oznacza kod sprzed prawie roku, który przy późniejszym skoku będzie musiał przejść **naraz** przez zmiany łamiące z 6.0 (deprecacja `baseUrl`, `outFile`, `moduleResolution: node`, wycofanie celu ES5) i przez 7.0. Pisanie pod 6.0.3 od pierwszego dnia sprawia, że przejście na 7.x jest mechaniczne, bo domyślne ustawienia są już te same.

Minimalna wersja TypeScripta dla Next.js 16 to 5.1.0 (https://nextjs.org/docs/app/guides/upgrading/version-16, tabela "Node.js runtime and browser support", sprawdzone 2026-08-27), więc zarówno 5.9.3 jak i 6.0.3 przechodzą. Nie ma powodu wybierać starszej.

**Do wpisania:** `TypeScript 6.0.3`, z uzasadnieniem: ostatnia linia z JS Compiler API, wymagana przez domyślny backend Nexta i przez tryb `--typecheck` Vitesta; rewizja do 7.x po wydaniu TypeScripta 7.1 z API, nie wcześniej.

---

## 3. react-email-editor 2.1.2 i Unlayer: projekt żywy, ale model licencyjny nie pasuje do odsprzedaży

### Żywotność: dobra

- Repozytorium https://github.com/unlayer/react-email-editor: **nie zarchiwizowane**, 5211 gwiazdek, ostatni push **2026-08-26**, ostatnie merge'e commitów **2026-08-11**, 242 otwarte issues (sprawdzone przez API GitHub 2026-08-27).
- Wersja 2.0.0 wyszła 2026-07-06, czyli linia 2.x to świeża modernizacja, nie porzucony pakiet.

### React 19: działa

- `peerDependencies` w 2.1.2 to `{"react": ">=16.8"}`, więc React 19.2.8 jest formalnie objęty.
- Realne potwierdzenie: issue #487 "Rebuild demo on Vite with React 19" zamknięte 2026-07-06, PR #514 "pr495-ssr-hydration" zmergowany 2026-08-11, a commit z 2026-08-11 nosi opis "Exclude React-version selection glue from coverage", co oznacza, że pakiet ma jawną obsługę różnic między wersjami Reacta. Poprawka hydracji SSR jest istotna, bo w App Routerze komponent musi być klientowy.

### Licencja: dwie warstwy, i to jest problem

**Warstwa pierwsza, wrapper npm:** licencja **MIT** (pole `license` w manifeście 2.1.2 oraz `LICENSE` w tarballu, sprawdzone 2026-08-27). Ta część jest bez zastrzeżeń.

**Warstwa druga, sam edytor:** nie jest w paczce. Rozpakowanie `react-email-editor-2.1.2.tgz` pokazuje, że `dist/index.js` wstrzykuje skrypt z adresu **`https://editor.unlayer.com/embed.js`** i operuje na `projectId`. Cały edytor to hostowany komponent Unlayera ładowany z ich CDN.

Z tego wynikają trzy rzeczy, których dokument nie uwzględnia:

1. **Koszt.** Cennik https://unlayer.com/pricing (sprawdzone 2026-08-27): plan Free 0 USD, **Launch 250 USD/mies.**, Scale 750 USD/mies., Optimize 2000 USD/mies., Enterprise na wycenę. **White-label zaczyna się od planu Launch.** Plan darmowy nie ma white-labelingu, własnego storage'u ani narzędzi customowych. Produkt, który ma być odsprzedawany klientom agencji pod marką MidRev, wymaga zatem minimum 250 USD/mies. stałego kosztu od pierwszego płacącego klienta. To jest pozycja w rachunku jednostkowym produktu, a nie detal implementacyjny.
2. **Zależność operacyjna.** Edytor ładuje się z obcego CDN. Awaria Unlayera to brak możliwości edycji szablonów u wszystkich tenantów naraz. Dokument ma AD-7 i AD-8 właśnie po to, żeby wymienialne rzeczy były wymienialne, a edytor szablonów jest wpięty na sztywno, bez portu.
3. **RODO.** Treści szablonów klientów agencji przechodzą przez usługę Unlayera, co czyni go **podprocesorem**. Dokument w AD-2 powołuje się na umowę powierzenia, a w AD-16 na ścieżkę RODO. Podprocesor spoza tego opisu jest luką, nie szczegółem.

**Do wpisania:** albo nowy port (`TemplateEditor`) w AD, który czyni edytor wymienialnym tak jak dostawcę wysyłki, albo jawny wpis w Deferred: "Edytor szablonów: Unlayer Embed od 250 USD/mies. przy white-label, alternatywy open source do zbadania, podprocesor do umowy powierzenia". W obu wypadkach koszt 250 USD/mies. i status podprocesora muszą być w dokumencie.

---

## 4. Kolejka na Postgresie z `SELECT FOR UPDATE SKIP LOCKED` przy 1 mln wiadomości miesięcznie

### Czy realistyczne: tak, z dużym zapasem, ale nie z tego powodu, który zwykle się podaje

1 mln wiadomości miesięcznie to średnio **około 0,4 zadania na sekundę**. Nawet gdyby każda wiadomość generowała cztery zadania (ingest, wysyłka, webhook, atrybucja), to nadal poniżej 2/s średnio. Średnia jest tu jednak nieistotna, bo ruch ESP jest skokowy: kampania do 100 tys. odbiorców wypuszczona w godzinę to **około 28 zadań na sekundę**, w 15 minut to **111/s**. Postgres ze `SKIP LOCKED` obsługuje takie tempo bez zadyszki. Realnym ogranicznikiem przy tym wolumenie jest limit przepustowości dostawcy wysyłki i reputacja domeny, nie baza.

**Wolumen nie jest problemem. Problemem jest churn wierszy i to, co robi z nim MVCC.**

### Znane granice i pułapki, potwierdzone źródłowo

**a) Bloat sterty i indeksu.** Każdy wiersz zadania przechodzi kilka UPDATE-ów i zwykle DELETE. Każda z tych operacji tworzy nową wersję krotki. Martwe krotki narastają szybciej, niż autovacuum je sprząta, a indeks częściowy po statusie oczekującym jest "thrashed especially hard", bo wiersze bez przerwy zmieniają stan. Tabele kolejek rosną do dziesiątek gigabajtów przy megabajtach żywych danych. Źródła: https://planetscale.com/blog/keeping-a-postgres-queue-healthy oraz https://richyen.com/postgres/2026/05/04/postgres_job_queue.html (sprawdzone 2026-08-27).

**b) Przypięcie horyzontu MVCC przez długie transakcje.** To jest zabójca, nie sam wolumen. Autovacuum nie usunie martwych krotek widocznych dla aktywnej transakcji, niezależnie od konfiguracji. Wystarczy jeden długi raport, `pg_dump`, slot replikacyjny albo `hot_standby_feedback`, żeby tabela kolejki zaczęła puchnąć w nieskończoność. Zalecenie z PlanetScale wprost: transakcje workera mają być **submilisekundowe**. Źródło jak wyżej.

**c) Kontencja MultiXact SLRU.** Gdy wiele transakcji trzyma blokady na tych samych wierszach, identyfikatory MultiXact zapełniają bufory o stałym rozmiarze, backendy stają na `LWLock:MultiXactMemberSLRU` i `LWLock:MultiXactOffsetSLRU`, a przepustowość się zapada mimo tanich zapytań. Źródło: richyen, jak wyżej.

**d) `SKIP LOCKED` nie jest darmowe.** Postgres i tak musi znaleźć te wiersze, sprawdzić ich stan zablokowania i je pominąć. Przy wielu workerach walczących o tę samą głowę kolejki procesor idzie w górę bez wzrostu przepustowości. Źródło: PlanetScale, jak wyżej.

**e) Wolumen WAL.** Każde zajęcie i zwolnienie zadania to pełna transakcja logowana do WAL. Przy tysiącach operacji na sekundę można wysycić writer WAL i checkpointy. Źródło: richyen, jak wyżej.

### Konkretna pułapka wynikająca z AD-6 tego dokumentu

AD-6 mówi: "rekord w `messages` (...) powstaje **przed wywołaniem dostawcy**". Jeśli ten zapis i wywołanie HTTP do dostawcy znajdą się w jednej transakcji, to transakcja żyje tyle, ile trwa odpowiedź obcego API, czyli setki milisekund do kilku sekund. To jednocześnie trzyma blokadę wiersza kolejki i **przypina horyzont MVCC** (punkt b). Przy 1 mln wiadomości miesięcznie i skokowej wysyłce to jest scenariusz, w którym kolejka degraduje się w ciągu dni, a nie miesięcy. AD-5 nie zawiera zakazu wołania obcego API wewnątrz transakcji zajmującej zadanie, a powinien.

### Czego brakuje w AD-5

Reguła w AD-5 mówi tylko "tabela `jobs`, pobieranie przez `SELECT ... FOR UPDATE SKIP LOCKED`, dostarczenie at-least-once, każdy handler idempotentny". Brakuje czterech rzeczy, które decydują o tym, czy ten wzorzec przeżyje rok:

1. **Zakaz wywołań sieciowych wewnątrz transakcji zajmującej zadanie.** Zajęcie w jednej krótkiej transakcji, praca poza transakcją, oznaczenie wyniku w drugiej krótkiej transakcji.
2. **Zajmowanie partiami** (kilkanaście zadań na transakcję), żeby zamortyzować koszt skanu indeksu, zamiast jednego wiersza na transakcję.
3. **Cykl życia wierszy**: zakończone zadania wypadają z tabeli gorącej. Partycjonowanie po dniu i `DROP PARTITION` zamiast `DELETE`, bo `DELETE` sam produkuje martwe krotki.
4. **Ustawienia autovacuum per tabela** dla `jobs`, agresywniejsze niż globalne (niski `autovacuum_vacuum_scale_factor`, wyższy `autovacuum_vacuum_cost_limit`), plus indeks częściowy tylko po wierszach do wzięcia.

Do tego jedna rzecz z tego samego mechanizmu dotyczy `messages`, nie `jobs`: jeżeli 1 mln wierszy miesięcznie przechodzi przez trzy lub cztery UPDATE-y statusu, to `messages` jest równie gorącą tabelą jak kolejka, a AD-16 wymaga na niej odtwarzania do punktu w czasie. Te dwa wymagania trzeba pogodzić świadomie.

---

## 5. UUIDv7 w Postgresie i w Node

### Postgres: natywne od 18

`uuidv7()` jest w rdzeniu PostgreSQL od **wersji 18.0, wydanej we wrześniu 2025**. Generuje wartości zgodne z RFC 9562, uporządkowane czasowo. Razem z nim doszły alias `uuidv4()` oraz `uuid_extract_timestamp()` i `uuid_extract_version()`. W implementacji Postgresa 12 bitów podmilisekundowej części znacznika czasu działa jak licznik gwarantujący monotoniczność w obrębie tej samej milisekundy. Źródła: https://www.postgresql.org/docs/release/18.0/ oraz https://www.postgresql.org/docs/current/release-18.html (sprawdzone 2026-08-27).

Bieżąca stabilna linia na 27.08.2026 to **PostgreSQL 18.6**, wydany 2026-08-13 (wersja 18.5 została pominięta z powodu regresji). Linia 19 jest w fazie beta 3. Źródło: https://www.postgresql.org/about/news/postgresql-186-1711-1615-1519-1424-and-19-beta-3-released-3365/ (sprawdzone 2026-08-27).

Przed 18 trzeba było rozszerzenia (`pg_uuidv7`) albo funkcji w PL/pgSQL. Na Postgresie 18+ nic nie trzeba.

### Node: brak natywnego generatora

Sprawdzone lokalnie na Node v20.20.0, 2026-08-27: `crypto.randomUUID()` zwraca UUID **wersji 4**, a `crypto.uuidv7` jest `undefined`. Node nie ma wbudowanego generatora UUIDv7.

### Co z tego wynika dla AD-15

AD-15 mówi: "klucz główny `uuid` generowany **po stronie aplikacji**". Ta decyzja jest sama w sobie dobra i spójna z paradygmatem heksagonalnym (encja ma tożsamość, zanim dotknie bazy) oraz z zasadą AD-6 o idempotencji. Ale dokument nigdzie nie mówi, **skąd** ta aplikacja bierze UUIDv7. Bez wskazania biblioteki (`uuid`, obecnie 14.0.2 w npm, funkcja `v7()`) albo własnej implementacji, pierwsza osoba pisząca kod sięgnie po `crypto.randomUUID()`, dostanie UUIDv4 i cała korzyść z uporządkowania czasowego dla indeksów B-drzewa zniknie po cichu, bez żadnego błędu. To dokładnie ten typ pomyłki, który wychodzi dopiero przy kilku milionach wierszy.

Dokument **nie przypina też nigdzie wersji Postgresa**, mimo że od niej zależą co najmniej cztery decyzje: `uuidv7()` (AD-15, gdyby jednak generować w bazie), `timestamptz` (AD-10), zachowanie `SKIP LOCKED` przy partycjonowaniu (AD-5) i odtwarzanie do punktu w czasie (AD-16).

---

## 6. Pozostałe znaleziska

### 6.1. Struktura katalogów jest sprzeczna z Next.js App Router. To blokuje start.

Dokument w tabeli warstw i w drzewie katalogów przypisuje:
- `src/app/` = "use-case'y: jedno wejście na każdą zmianę stanu"
- `src/web/` = "Next App Router: panel operatora i widok klienta"

Next.js **nie pozwala przenieść katalogu App Routera**. Dokumentacja https://nextjs.org/docs/app/getting-started/project-structure (wersja 16.3.3, aktualizacja 2026-07-21, sprawdzone 2026-08-27) wymienia jako foldery najwyższego poziomu wyłącznie `app` (App Router), `pages`, `public` i `src` ("opcjonalny folder źródłowy aplikacji"). Nie ma opcji konfiguracyjnej zmieniającej lokalizację katalogu `app`.

Skutek jest podwójny:
1. Router w `src/web/` **nie zostanie w ogóle rozpoznany**. Aplikacja nie wystartuje jako App Router.
2. Katalog `src/app/` z use-case'ami **zostanie potraktowany jako App Router**, ze wszystkimi tego konsekwencjami (skanowanie, `next typegen`, kolizje z konwencjami plików `page`/`route`/`layout`).

To nie jest kwestia gustu ani konwencji nazewniczej, tylko twardej reguły frameworka. Trzeba przemianować jedną z tych warstw.

Najmniej inwazyjna poprawka: warstwę use-case'ów nazwać `src/usecases/` albo `src/application/`, a router umieścić w `src/app/`. Zaletą jest to, że `AD-3` mówi o "use-case", więc nazwa `src/usecases/` jest bardziej opisowa niż `src/app/`, a przy okazji znika kolizja. Alternatywa, gdyby zależało na zachowaniu `src/app/` dla domeny: przenieść całego Nexta do osobnego pakietu w monorepo (`apps/web/src/app/`), ale to jest dużo więcej pracy przy jednoosobowym zespole.

Uwaga poboczna: AD-17 opisuje "route handlery" w `src/web/`, a Structural Seed nazywa je `api`. Po przemianowaniu warto ujednolicić także to.

### 6.2. Brak przypiętej wersji Node, a lokalne środowisko jest po EOL

Dokument nie podaje wersji Node w ogóle, mimo że przypina osiem pakietów npm.

- Next.js 16 wymaga minimum **Node 20.9.0** (`engines` w manifeście next@16.3.3 oraz tabela w https://nextjs.org/docs/app/guides/upgrading/version-16, sprawdzone 2026-08-27).
- Vitest 4.1.11 wymaga `^20.0.0 || ^22.0.0 || >=24.0.0`.
- **Node 20 osiągnął koniec wsparcia 2026-04-30**, czyli cztery miesiące temu. Node 22 jest wspierany do 2027-04-30, Node 24 (Active LTS od 2025-10-28) do 2028-04-30. Źródło: https://www.herodevs.com/blog-posts/node-js-end-of-life-dates-you-should-be-aware-of oraz https://www.pkgpulse.com/guides/nodejs-22-vs-nodejs-24-2026 (sprawdzone 2026-08-27).
- Maszyna, na której powstaje ten dokument, ma **Node v20.20.0** (sprawdzone lokalnie 2026-08-27), czyli wersję bez łatek bezpieczeństwa.

Dla produktu, który ma być odsprzedawany i przetwarza dane osobowe odbiorców, uruchamianie na środowisku po EOL jest ryzykiem, o którym trzeba wiedzieć świadomie. Do wpisania: **Node 24 LTS**.

### 6.3. AD-6 jest sprzeczne z AD-16

- **AD-6**: "stan zmienia się jednokierunkowo `queued → sent → delivered|bounced|complained`".
- **AD-16**: "brak `UPDATE` i `DELETE` na tych tabelach [`consents`, `messages`, `suppressions`] poza ścieżką RODO".

Zmiana stanu wiersza w `messages` **jest** UPDATE-em. Obie reguły nie mogą obowiązywać jednocześnie w obecnym brzmieniu. To nie jest czepianie się słów: pierwsza osoba implementująca `jobs/send` musi wiedzieć, czy wolno jej wykonać `UPDATE messages SET status = 'sent'`, czy nie.

Dwa spójne rozwiązania:
- **a)** `messages` trzyma stan i wolno na niej robić UPDATE **wyłącznie kolumny stanu i znaczników czasu przejść**, a AD-16 dostaje jawny wyjątek w tym brzmieniu. Wtedy jednak `messages` jest tabelą o wysokim churnie (1 mln wierszy miesięcznie razy 3-4 przejścia) i dotyczą jej wszystkie ostrzeżenia z punktu 4.
- **b)** `messages` jest naprawdę append-only, a przejścia stanu lądują w osobnej tabeli `message_events` (też append-only), z której bieżący stan liczy się jako projekcja. To jest droższe w odczycie, ale zgodne z AD-14, które już wprowadza wzorzec projekcji dla atrybucji.

Wybór trzeba podjąć w dokumencie, nie zostawiać implementacji.

### 6.4. Dittofeed w sekcji Deferred: licencja w porządku, ale projekt stoi

Dokument rozważa Dittofeed jako silnik automatyzacji w fazie 2.

- Licencja: **MIT** (pole `license` w API GitHub dla `dittofeed/dittofeed`, sprawdzone 2026-08-27). To istotne, bo według wcześniejszych ustaleń projektu n8n odpadł właśnie z powodu licencji przy odsprzedaży. Dittofeed pod tym względem nie ma tego problemu.
- Żywotność: **ostatni commit 2026-03-27**, ostatnie wydanie **v0.24.0-alpha.17 z 2026-03-28**. To pięć miesięcy bez ruchu, przy 2914 gwiazdkach i wersji, która nigdy nie wyszła poza `alpha`.

To nie dyskwalifikuje opcji, ale zmienia jej charakter: nie jest to "gotowy silnik pod spodem", tylko kod, który trzeba by utrzymywać samemu. Warunek rewizji tej decyzji warto zapisać jako "sprawdzić, czy projekt ruszył, przed Epikiem fazy 2", a nie jako neutralne "zależy od reguł segmentacji".

### 6.5. Rzeczy, które sprawdziłem i które są w porządku

Dla porządku, żeby nie sprawdzać ich drugi raz: paradygmat portów i adapterów, brak ORM przy `pg` 8.x, `timestamptz` w UTC, kwoty w jednostkach minorowych z ISO 4217, walidacja zodem na granicach, ingest dwufazowy z kluczem idempotencji, szyfrowanie sekretów tenantów, atrybucja jako projekcja liczona przez job, migracje append-only z sumą kontrolną, testy integracyjne na realnym Postgresie. Żadne z nich nie opiera się na nieaktualnej informacji.

---

## Lista poprawek do wpisania

| # | Miejsce w dokumencie | Co wpisać |
|---|---|---|
| 1 | Structural Seed, tabela warstw, drzewo katalogów | Przemianować warstwę use-case'ów z `src/app/` na `src/usecases/`, a Next App Router przenieść z `src/web/` do `src/app/`; Next nie pozwala przenieść katalogu routera |
| 2 | frontmatter `stack.languages`, Structural Seed | `TypeScript 6.0.3` zamiast `5.9.3`, z uzasadnieniem: ostatnia linia z JS Compiler API, wymagana przez domyślny backend Nexta i tryb `--typecheck` Vitesta; rewizja po wydaniu TS 7.1 |
| 3 | frontmatter `stack`, nowa pozycja | `Node 24 LTS` (wsparcie do 2028-04-30); Node 20 jest po EOL od 2026-04-30 |
| 4 | Structural Seed, nowa pozycja | `PostgreSQL 18.6` (aktualna stabilna, `uuidv7()` natywnie od 18.0) |
| 5 | AD-15 | Dopisać źródło UUIDv7 w Node: biblioteka `uuid` w wersji 14.x, funkcja `v7()`; `crypto.randomUUID()` daje v4 i po cichu zabija uporządkowanie indeksu |
| 6 | AD-5 | Dopisać cztery reguły: zakaz wywołań sieciowych w transakcji zajmującej zadanie, zajmowanie partiami, partycjonowanie `jobs` po dniu z `DROP PARTITION`, ustawienia autovacuum per tabela plus indeks częściowy |
| 7 | AD-6 i AD-16 | Rozstrzygnąć sprzeczność: albo jawny wyjątek w AD-16 na UPDATE kolumny stanu w `messages`, albo przenieść przejścia stanu do append-only `message_events` z projekcją |
| 8 | AD-7 lub Deferred, przy react-email-editor | Dopisać: Unlayer Embed to hostowany komponent z `editor.unlayer.com`, white-label od 250 USD/mies. (plan Launch), jest podprocesorem do umowy powierzenia; rozważyć port `TemplateEditor` |
| 9 | Deferred, wiersz o Dittofeed | Dopisać: licencja MIT (bez problemu n8n), ale ostatnie wydanie v0.24.0-alpha.17 z 2026-03-28 i brak commitów od 2026-03-27; przed fazą 2 sprawdzić, czy projekt ruszył |
| 10 | Structural Seed, nota o przeglądarkach (opcjonalne) | Faktyczny próg to Firefox 128 (wymóg Tailwinda v4), nie 111 z tabeli Next.js 16 |

## Źródła

Wszystkie sprawdzone 2026-08-27.

- Rejestr npm: https://registry.npmjs.org/next, /react, /tailwindcss, /typescript, /pg, /zod, /vitest, /react-email-editor, /uuid
- Next.js, przewodnik migracji do 16: https://nextjs.org/docs/app/guides/upgrading/version-16
- Next.js, struktura projektu: https://nextjs.org/docs/app/getting-started/project-structure
- Next.js, wsparcie dla TypeScripta 7: https://github.com/vercel/next.js/discussions/95633 i https://github.com/vercel/next.js/pull/95639
- TypeScript 6.0: https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/ i https://visualstudiomagazine.com/articles/2026/03/23/typescript-6-0-ships-as-final-javascript-based-release-clears-path-for-go-native-7-0.aspx
- Vitest, typecheck: https://vitest.dev/config/typecheck i https://vitest.dev/guide/testing-types
- Tailwind CSS, zgodność przeglądarek: https://tailwindcss.com/docs/compatibility
- Unlayer, cennik: https://unlayer.com/pricing
- Unlayer, repozytorium: https://github.com/unlayer/react-email-editor (API GitHub)
- Kolejka na Postgresie: https://planetscale.com/blog/keeping-a-postgres-queue-healthy i https://richyen.com/postgres/2026/05/04/postgres_job_queue.html
- PostgreSQL 18, uwagi o wydaniu: https://www.postgresql.org/docs/release/18.0/ i https://www.postgresql.org/docs/current/release-18.html
- PostgreSQL 18.6: https://www.postgresql.org/about/news/postgresql-186-1711-1615-1519-1424-and-19-beta-3-released-3365/
- Node.js, daty EOL: https://www.herodevs.com/blog-posts/node-js-end-of-life-dates-you-should-be-aware-of i https://www.pkgpulse.com/guides/nodejs-22-vs-nodejs-24-2026
- Dittofeed: https://github.com/dittofeed/dittofeed (API GitHub)
