---
name: 'review-rubric-architecture-spine'
type: architecture-review
target: 'ARCHITECTURE-SPINE.md'
reviewed: '2026-08-27'
verdict: 'PASS Z ZASTRZEŻENIAMI'
---

# Recenzja ARCHITECTURE-SPINE.md (midrev-esp)

**Werdykt: PASS Z ZASTRZEŻENIAMI.**

Paradygmat jest właściwy dla tego produktu i nie wymusza przepisania fundamentu.
Dokument nie nadaje się jednak w obecnej postaci do rozbicia na epiki i story, bo w
trzech miejscach zaprzecza ratyfikowanemu kodowi, w jednym blokuje wymaganie z PRD,
a w dwóch odkłada rzeczy, które faza 1 już buduje.

**Warunek dopuszczenia do poziomu epików:** naprawa Z1, Z2, Z3, Z4, Z5, Z6, Z7.
Reszta może iść jako poprawki równolegle z pierwszymi story.

## Znaleziska

| Id | Waga | Czego dotyczy | Na czym polega problem | Proponowana poprawka |
|---|---|---|---|---|
| Z1 | krytyczne | Structural Seed, ERD | ERD pokazuje `TENANTS \|\|--o{ SUPPRESSIONS`, czyli wykluczenia jako byt per tenant. Migracja `0001_init.sql` celowo trzyma `suppressions` globalnie (brak `tenant_id`, unikalny indeks po `lower(btrim(email))` ponad tenantami), z komentarzem uzasadniającym tę decyzję. FR28 wymaga obu list naraz. W tej postaci dwa zespoły zbudują dwie różne rzeczy, a jeden z nich skasuje ochronę reputacji platformy. | Rozdziel w ERD i w tekście na `suppressions` (globalna, bez `tenant_id`, ratyfikacja stanu z `0001`) oraz `tenant_suppressions` (per tenant, wypisania ze sklepu), i dopisz w AD-9, że brama odpytuje obie. |
| Z2 | krytyczne | brak AD, obszar FR1 do FR7 | Nie ma żadnego niezmiennika o autoryzacji. Mapa wiąże FR1 do FR7 z AD-2, AD-3 i AD-15, a żaden z nich nie mówi, gdzie sprawdzane jest uprawnienie ani skąd bierze się `tenantId` w żądaniu. Przy operatorze mającym dostęp do wielu tenantów (FR2) brak tej reguły to zaproszenie do przekazania `tenantId` w ciele żądania i cichego przejścia między tenantami. | Dodaj AD: `tenantId` pochodzi wyłącznie z sesji i tabeli przypisań operatora, nigdy z wejścia żądania; sprawdzenie uprawnienia z macierzy PRD wykonuje use-case, nie server action i nie komponent. |
| Z3 | krytyczne | AD-6 | Ograniczenie `unique (campaign_id, profile_id)` nie działa dla automatyzacji, choć AD-6 deklaruje `Binds: kampanie i automatyzacje`. Wiadomość z journey (FR66 do FR69) nie ma `campaign_id`, a NULL w Postgresie nie równa się NULL, więc ograniczenie przestaje cokolwiek wymuszać dokładnie tam, gdzie ryzyko podwójnej wysyłki jest największe. Faza 2 wymusi przebudowę `messages`, wbrew NFR26. | Ustal klucz teraz: `unique (tenant_id, source_type, source_id, profile_id, dedup_key)` z kolumnami NOT NULL, gdzie `source_type` przyjmuje `campaign` albo `journey_run`, a `dedup_key` rozróżnia kolejne przebiegi tej samej automatyzacji. |
| Z4 | krytyczne | Deferred, wiersz o koszyku porzuconym | Wewnętrzny kontrakt danych koszyka jest odłożony do zbadania Shopera, a FR12 fazy 1 przyjmuje zdarzenia koszyka na bieżąco i adapter WooCommerce musi je zapisać. AD-8 wymienia `Cart` jako część jednego kontraktu. Odłożenie oznacza, że kształt wymyśli zespół Woo, a zespół Shopify zastanie go nie do użycia. To jest klasyczny przypadek odłożenia rzeczy, którą trzeba ustalić teraz. | Ustal minimalny kontrakt `Cart` w tym dokumencie (identyfikator koszyka w sklepie, profil, pozycje, wartość w groszach z walutą, `occurred_at`) i zapisz, że platforma bez tego zdarzenia deklaruje brak przez `capabilities` z AD-8, zamiast zmieniać kontrakt. |
| Z5 | wysokie | AD-16 wobec FR30 | AD-16 zakazuje `UPDATE` i `DELETE` na `suppressions` poza ścieżką RODO. FR30 wprost daje administratorowi prawo usunięcia wpisu z wykluczeń, a macierz uprawnień w PRD traktuje to jako operację celową i najbardziej niebezpieczną w systemie. Reguła w obecnym brzmieniu blokuje wymaganie. | Dopisz: zdjęcie wykluczenia to nowy wiersz odwracający z autorem, powodem i datą, stan czytany z ostatniego wpisu dla adresu; fizyczny `DELETE` pozostaje zabroniony. |
| Z6 | wysokie | AD-15 wobec migracji `0001` | Wszystkie tabele w migracji mają `id uuid primary key default gen_random_uuid()`, czyli UUIDv4 generowany po stronie bazy. AD-15 każe generować UUIDv7 po stronie aplikacji i nie ma znacznika `[ADOPTED]`, więc czyta się jak decyzja nowa, ale dokument nie mówi ani słowa, co zrobić z istniejącym schematem i z testami, które wstawiają wiersze bez `id`. | Dopisz do AD-15 zdanie wdrożeniowe: nowa migracja zdejmuje `DEFAULT` z `tenants`, `profiles`, `events` i `suppressions`, wolumen sandboxa idzie do skasowania, a `tests/cdp.test.ts` przechodzi na jawne przekazywanie `id`. |
| Z7 | wysokie | AD-10 wobec migracji `0001` | `events.occurred_at timestamptz not null default now()` to dokładnie to, czego AD-10 zabrania („zapis bez `occurred_at` jest błędem, nie wartością domyślną”). Kolumny `recorded_at` nie ma nigdzie. Testy CDP wstawiają zdarzenia bez daty i przechodzą, więc reguła jest dziś złamana przez ratyfikowany kod, a nikt tego nie zauważy. | Przeformułuj regułę na sprawdzalną: kolumna `occurred_at` jest `not null` i **bez klauzuli `DEFAULT`**, obok stoi `recorded_at timestamptz not null default now()`; wskaż, że realizuje to migracja `0002`. |
| Z8 | wysokie | AD-2 wobec Deferred (RLS) | Jedynym mechanizmem egzekwowania jest zdanie „zapytanie bez predykatu `tenant_id` nie przechodzi review”, a review robi ta sama osoba, która pisze kod. Jedyny mechaniczny substytut, czyli RLS, jest odłożony do pierwszego realnego klienta, czyli do momentu, w którym błąd już kosztuje umowę powierzenia. Reguła w tej postaci jest życzeniem. | Albo RLS wchodzi teraz (na sandboxie to koszt jednej migracji), albo AD-2 dostaje wykonalny substytut: dostęp do puli wyłącznie przez helper przyjmujący `tenantId` i doklejający predykat, plus test wykrywający zapytania bez `tenant_id`. |
| Z9 | wysokie | Consistency Conventions, brak wiersza | FR19 i FR64 stoją na „znormalizowanym adresie e-mail”, a kanon normalizacji już fizycznie istnieje w bazie jako `lower(btrim(email))` w indeksie z `0001`. Spine go nie nazywa, więc każdy moduł znormalizuje po swojemu (samo `lower`, `trim`, wariant z kropkami Gmaila), a rozjazd objawi się jako losowe naruszenia unikalności i niewykryte duplikaty przy imporcie z Klaviyo. | Dodaj wiersz do tabeli konwencji: jedna funkcja `normalizeEmail` równoważna `lower(btrim(...))`, używana przed każdym zapisem i każdym wyszukaniem; indeks z `0001` jest jej definicją. |
| Z10 | wysokie | AD-9 wobec FR46, FR52, FR69 | Brama obejmuje wyłącznie wykluczenia, a FR69 wymaga, żeby automatyzacje podlegały tym samym regułom wykluczeń, **limitów i zgód**. Warmup (FR46) i limit wolumenu tenanta (FR52) nie mają żadnego AD, więc pierwsza automatyzacja ominie plan warmupu i spali domenę, czyli scenariusz nazwany w PRD ryzykiem nr 1. | Rozszerz AD-9 na: wykluczenia globalne i tenanta, ważna zgoda, limit dobowy tenanta i bieżący krok planu warmupu sprawdzane w jednym use-case budującym listę odbiorców, dla każdej ścieżki wysyłki bez wyjątku. |
| Z11 | wysokie | AD-15 wobec NFR11 | AD-15 mówi „wszystkie encje” i UUIDv7, czyli identyfikator uporządkowany w czasie i częściowo przewidywalny. NFR11 wymaga, żeby znacznik kliknięcia był nieodgadywalny. Reguła w obecnym brzmieniu wprost zachęca do użycia klucza głównego wiadomości jako tokenu w linku, a wtedy da się enumerować odbiorców cudzej kampanii. | Dopisz wyjątek: tokeny publiczne (kliknięcie, wypisanie, akceptacja kampanii) to co najmniej 128 bitów z generatora kryptograficznego, nigdy klucz główny ani wartość z niego wyprowadzona. |
| Z12 | wysokie | Deferred, wiersz o hostingu workera | Odłożone „do pierwszego realnego klienta”, a od tej decyzji zależą: ciągła ochrona rejestru zgód wymagana przez AD-16 i NFR18 (czyli PITR, którego nie ma w każdym hostingu), oraz NFR19, czyli przyjmowanie zdarzeń i obsługa wypisań działające przy padniętym panelu. Dokument sam to przyznaje w kolumnie uzasadnienia i mimo to odkłada całość. | Rozdziel: odłóż wybór dostawcy hostingu, ale ustal teraz dwa warunki brzegowe, że baza musi wspierać odtworzenie do punktu w czasie, a przyjmowanie zdarzeń i wypisanie działają w procesie niezależnym od panelu operatora. |
| Z13 | średnie | AD-7 | Sygnatura portu (`send`, `verifyDomain`, `listDomainRecords`, `parseWebhook`, `quotaStatus`) nie ma miejsca na identyfikator wiadomości zwracany przez dostawcę, bez którego nie da się powiązać webhooka odbicia z rekordem z AD-6, ani na nagłówki wiadomości, czyli `List-Unsubscribe` z RFC 8058 (FR50) i dane nadawcy z FR53. Brakuje też wysyłki zaplanowanej i dławionej pod warmup. Efekt: moduł realizujący FR50 obejdzie port. | Dopisz do kontraktu: `send` zwraca `providerMessageId` zapisywany na rekordzie wiadomości i przyjmuje jawną mapę nagłówków oraz moment wysyłki. |
| Z14 | średnie | Deferred, wiersz o silniku automatyzacji | Dopuszczenie Dittofeeda „pod spodem” nie jest neutralne: jeśli to on wysyła, unieważnia AD-9 (brama) i AD-6 (unikalność wiadomości), bo wysyłka wychodzi poza nasz use-case. Deferral wygląda na wybór biblioteki, a jest wyborem, kto trzyma bramę zgód. | Dopisz warunek brzegowy do tego wiersza: silnik zewnętrzny może wyłącznie wyznaczać moment i odbiorcę, samą wysyłkę zawsze wykonuje nasz use-case przez port z AD-7. |
| Z15 | średnie | AD-4 wobec NFR29 | Konwencja mówi o idempotencji handlerów, a NFR29 wymaga braku założeń o kolejności zdarzeń. To dwie różne własności: idempotentny handler `order.updated` przetworzony przed `order.created` nadal zapisze zły stan. | Dopisz do AD-4: zapis do modelu domenowego to upsert po identyfikatorze zewnętrznym, odrzucający dane o `occurred_at` starszym niż już zapisane dla tego bytu. |
| Z16 | średnie | Structural Seed, ERD | `ORDERS` nie ma relacji ani do `TENANTS`, ani do `PROFILES`, choć AD-2 wymaga tenanta wszędzie, a FR24 i FR57 wymagają wiązania zamówień z profilem. `EVENTS` wisi wyłącznie pod `PROFILES`, mimo że migracja celowo dopuszcza `profile_id` NULL dla zdarzeń jeszcze nieprzypisanych. `JOBS \|\|--o{ RAW_EVENTS` sugeruje, że surowe zdarzenie należy do joba, co jest odwróceniem zależności. | Dodaj `TENANTS` jako rodzica `ORDERS` i `EVENTS`, dodaj opcjonalną relację `PROFILES` do `ORDERS`, usuń relację `JOBS` do `RAW_EVENTS`. |
| Z17 | średnie | Structural Seed, akapit o wersjach | `package.json` ma `typescript ^5.7.2`, `vitest ^2.1.8`, `pg ^8.13.1` i zero Next, React, Tailwind, zod. Spine pinuje `vitest 4.1.11`, czyli dwa majory ponad runnerem, na którym stoi ratyfikowany AD-20, i nie mówi, czy to stan docelowy, czy polecenie podniesienia. Dwie osoby rozstrzygną to inaczej. | Dopisz jedno zdanie: vitest idzie do 4.x osobnym commitem przed pierwszym modułem, `tests/cdp.test.ts` musi po nim przejść bez zmian; wersje podawaj do minora, nie do patcha. |
| Z18 | średnie | Structural Seed, odesłanie do memloga | „powód i warunek rewizji w memlogu” odsyła do dokumentu, którego nie ma ani w `sources`, ani w `companions` (pole puste). Agent czytający sam spine nie ma jak sprawdzić, kiedy wolno podnieść TypeScript. | Podaj ścieżkę pliku albo przenieś powód do spine w jednym zdaniu. |
| Z19 | średnie | brak AD, FR6 i NFR12 | Log dostępu operatora do danych osobowych nie ma pokrycia. AD-16 wymienia `consents`, `messages` i `suppressions`, ale nie access log, a NFR12 wymaga 12 miesięcy retencji i braku edycji z poziomu aplikacji. | Dopisz `access_log` do listy tabel objętych AD-16 i dodaj do konwencji, że zapis do niego idzie tą samą ścieżką co use-case, którego dotyczy. |
| Z20 | średnie | Consistency Conventions wobec kodu | Konwencja ustala `order.created`, a migracja i `tests/cdp.test.ts` używają `order_placed`. Dokument nie mówi, że stary format jest zastąpiony, więc nie wiadomo, czy kod jest ratyfikowany, czy do poprawy. | Dopisz zdanie: nazwy zdarzeń z sandboxa są tymczasowe i zmieniają się w tej samej migracji, która porządkuje `occurred_at`. |
| Z21 | niskie | brak pokrycia FR53 | Dane nadawcy wymagane w kraju odbiorcy (adres fizyczny przy CAN-SPAM) nie mają odbicia ani w AD, ani w ERD, a PRD ostrzega wprost, że doklejenie tego później oznacza migrację wszystkich szablonów. | Dodaj pole konfiguracji tenanta do ERD i wiersz do konwencji, że stopka nadawcy jest doklejana przez adapter, nie przez szablon. |
| Z22 | niskie | Structural Seed, drugi diagram | Diagram kontekstowy powtarza to, co pokazuje flowchart zależności z sekcji Invariants, i pokazuje to niespójnie: raz `app -.-> adapters` przez port, raz `core --> db` bezpośrednio. Czytelnik dostaje dwa obrazy tej samej rzeczy z inną regułą. | Zostaw diagram zależności, usuń kontekstowy albo zredukuj go do listy aktorów zewnętrznych bez strzałek wewnętrznych. |
| Z23 | niskie | Capability to Architecture Map | Tabela dubluje pole `binds` z frontmattera, tyle że w wersji rozszerzonej o katalogi. Dwa miejsca do aktualizacji przy każdej zmianie zakresu. | Zostaw tabelę, skróć `binds` do samego zakresu FR bez opisów. |
| Z24 | niskie | AD-14 wobec FR58 | „zmiana okna przelicza projekcję jawnie” nie rozstrzyga, czy przeliczenie obejmuje historię. Klient, który widział już raport, zobaczy inną liczbę, albo nie zobaczy, zależnie od tego, co wybierze implementujący. | Dopisz, że przeliczenie jest wsteczne dla całego tenanta i zapisuje datę przeliczenia obok rekordu atrybucji. |
| Z25 | niskie | AD-8 wobec NFR31 | Adapter deklaruje `capabilities`, ale nie budżet zapytań, a NFR31 wymaga respektowania limitów platformy bez utraty danych. | Dopisz do deklaracji adaptera limit zapytań i strategię spowalniania synchronizacji. |

## Ocena wg listy kontrolnej

**1. Punkty rozjazdu dla poziomu niżej.** Częściowo. Ustalone są: warstwy, ingest, kolejka,
jednostka wysyłki, porty, daty, kwoty, migracje, atrybucja, identyfikatory, ścieżka mutacji,
testy. Pominięte punkty rozjazdu, które na pewno rozjadą epiki: autoryzacja i pochodzenie
`tenantId` (Z2), kanon normalizacji e-maila (Z9), format i pochodzenie tokenów publicznych
(Z11), brama limitów i warmupu (Z10), korelacja wiadomości z identyfikatorem dostawcy (Z13),
odporność na kolejność zdarzeń (Z15). Nie ustalono też, jak składany jest klucz idempotencji
webhooka per platforma, mimo że AD-4 się na nim opiera, ani w jakiej strefie czasowej
operator planuje wysyłkę (FR36) skoro wszystko jest w UTC.

**2. Egzekwowalność reguł.** Reguły wymuszone strukturalnie (baza albo typ): AD-6 częściowo
(patrz Z3), AD-10 po poprawce Z7, AD-11, AD-12, AD-16, AD-20. Reguły, które są dziś
życzeniem, nie regułą:

- **AD-1** nie nazywa żadnego mechanizmu. „Zależności wyłącznie do środka” bez reguły
  lintera albo `dependency-cruiser` w CI jest zwyczajem, a nie niezmiennikiem.
- **AD-2** stoi na „nie przechodzi review” przy jednoosobowym zespole (Z8).
- **AD-3** tak samo: „żaden skrypt nie wykonuje SQL bezpośrednio” nie ma nic, co by to
  wykrywało, a skrypty jednorazowe to dokładnie ta klasa kodu, która omija zasady pod presją.
- **AD-9** deklaruje, że adapter „przyjmuje wyłącznie adresy pochodzące z tego use-case”,
  ale nic tego nie wymusza. Ta sama reguła da się wymusić typem, tak jak AD-13 wymusza
  opakowanie sekretu. Bez tego to zdanie o dobrych intencjach.
- **AD-19** „kontrakt zmienia się wyłącznie w sposób wstecznie zgodny” nie ma testu
  kontraktowego ani zapisanej wersji kontraktu, więc złamanie wyjdzie w przeglądarkach odbiorców.

**3. Deferred.** Dwie pozycje pozwalają zbudować rzeczy niekompatybilne: kontrakt koszyka (Z4)
i silnik automatyzacji (Z14). Trzecia, hosting workera (Z12), nie tyle rozjeżdża zespoły, co
odkłada warunek wykonalności AD-16 i NFR18. Odłożenie RLS (Z8) jest uzasadnione tylko wtedy,
gdy AD-2 dostanie inny mechanizm niż review. Odłożenie wyboru dostawcy wysyłki i modelu
uprawnień drobnoziarnistych jest w porządku, z zastrzeżeniem Z13 i Z2: odkłada się dostawcę,
nie kształt portu, i odkłada się RBAC, nie miejsce sprawdzania uprawnień.

**4. Stosunek do istniejącego kodu.** Ratyfikuje: `scripts/migrate.ts` przez AD-12, wzorzec
`tests/cdp.test.ts` przez AD-20, złożony klucz obcy per tenant przez AD-2, brak ORM przez
AD-18, kolejkę w Postgresie przez AD-5. Zaprzecza w trzech miejscach, wszystkie do naprawy
bez ruszania fundamentu: ERD wobec globalnej `suppressions` (Z1), AD-15 wobec
`default gen_random_uuid()` (Z6), AD-10 wobec `default now()` na `occurred_at` (Z7). Żadna
z tych sprzeczności nie wymusza przepisania działającego kodu, ale każda wymaga zdania
wdrożeniowego, którego w dokumencie nie ma, więc dziś czyta się jak przeoczenie, a nie decyzja.
Osobno: konwencja nazw zdarzeń rozjeżdża się z kodem (Z20), a lista wersji z `package.json` (Z17).

**5. Pokrycie FR i NFR.** Bez pokrycia w żadnym AD ani konwencji:

| Wymaganie | Stan |
|---|---|
| FR6, NFR12 (log dostępu operatora) | brak, patrz Z19 |
| FR46, FR52 (warmup, limit wolumenu) | brak bramy, patrz Z10 |
| FR47 (blokada nietypowo dużego segmentu) | brak, wymaga zapamiętania liczebności poprzedniej wysyłki, nikt tego nie ustala |
| FR53 (dane nadawcy per kraj odbiorcy) | brak, patrz Z21 |
| FR50 (List-Unsubscribe one-click) | brak miejsca w porcie, patrz Z13 |
| FR58 (zmiana okna atrybucji) | niedomknięte, patrz Z24 |
| NFR10 (token akceptacji jednorazowy, 7 dni) | brak reguły, spada na story |
| NFR11 (nieodgadywalny znacznik kliknięcia) | w konflikcie z AD-15, patrz Z11 |
| NFR29 (brak założeń o kolejności) | mylone z idempotencją, patrz Z15 |
| NFR31 (limity zapytań platform) | brak, patrz Z25 |
| NFR24 (raport nie starszy niż 15 minut) | AD-14 nie ma budżetu opóźnienia projekcji |

Reszta obszarów FR ma pokrycie, choć mapa zdolności jest gruboziarnista: wiersz
„FR23 do FR31 odbiorcy i zgody” wskazuje AD-9, AD-16 i AD-18, a nie mówi nic o FR27
(techniczna blokada importu bez zgody), które PRD wyróżnia jako blokadę, nie ostrzeżenie.

**6. Structural Seed.** Przerósł minimum. Zbędne albo szkodliwe: ERD z szesnastoma bytami
i relacjami, który w trzech miejscach zaprzecza migracji (Z1, Z16) i w tej postaci będzie
źródłem prawdy dla kogoś, kto nie zajrzy do `0001_init.sql`; drugi diagram powtarzający
flowchart zależności inną, niespójną kreską (Z22); pinowanie ośmiu zależności do wersji
patch, które zdezaktualizują się w tygodniu i już dziś rozjeżdżają się z `package.json`
(Z17); odesłanie do nieistniejącego memloga (Z18). Do zostawienia bez zmian: drzewo
katalogów, bo to jedyna część, która realnie odcina rozjazd na starcie. ERD zostaw, ale
zredukowany do bytów niosących niezmiennik i zgodny z migracją, albo przenieś w całości
do osobnego dokumentu modelu danych i zostaw w spine odesłanie.
