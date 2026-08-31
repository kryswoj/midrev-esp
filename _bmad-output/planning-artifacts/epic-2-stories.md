## Epik 2: Odbiorcy, zgody i wykluczenia

Cel epiku: zanim powstanie cokolwiek, co wysyła maile, system wie do kogo wolno wysłać, potrafi to udowodnić rejestrem zgód z datą i źródłem, i egzekwuje to jedną bramką sprawdzaną w transakcji wysyłki, a nie życzeniem w interfejsie.

### Granice epiku (czytać przed pierwszą story)

| Sprawa | Gdzie należy |
|---|---|
| FR21 eksport danych profilu, FR22 usunięcie profilu (RODO) | Epik 7. Tu powstaje tylko punkt zaczepienia: jedno repozytorium i jeden use-case odczytu profilu |
| FR6 log dostępu operatora do danych osobowych | Epik 7, wpina się w use-case z Story 2.2 |
| Reguły segmentu oparte na zaangażowaniu (`engagement.*`) | Epik 5. Tu powstaje rejestr reguł jako punkt rozszerzenia, nie drugi kompilator |
| Sprawdzenie trybu równoległego z Klaviyo w `canSendTo` (FR65) | Epik 6, dokłada wartość do tej samej enumeracji powodów |
| Limity wolumenu i warmup w `canSendTo` (FR46, FR52) | Epik 3, tak samo: rozszerzenie tej samej funkcji, nigdy druga bramka |
| FR47 blokada nietypowo dużego segmentu | Epik 3. Tu powstaje tylko historia policzonych liczebności, na której tamta blokada stanie |
| Numeracja migracji | Każda story dokłada **nowy** plik z kolejnym wolnym numerem po migracji 0002 z Epiku 1 (AD-30). Edycja zastosowanego pliku jest błędem (AD-12) |

Wiążąca kolejność wewnątrz epiku: 2.1 → 2.2, 2.3, 2.4 → 2.5 → 2.6 → 2.7 → 2.8, 2.9 → 2.10, 2.11.
Żadna story nie zależy od story o wyższym numerze.

---

### Story 2.1: Znormalizowany adres jako tożsamość profilu

Jako operator MidRev, chcę żeby ten sam adres zapisany w różnej postaci trafiał do jednego profilu, żeby historia klienta nie rozjechała się na trzy kartoteki, a wykluczenie działało niezależnie od tego, kto jak wpisał adres.

**Pokrywa:** FR18, FR19 | **Rządzą:** AD-2, AD-3, AD-15, AD-18, AD-21 | **Jakość:** NFR1, NFR9, NFR20

**Kryteria akceptacji**

1. **Zakładając** funkcję normalizującą adres w warstwie domeny, **Kiedy** dostanie `"  Jan.Kowalski@Example.COM "`, **Wtedy** zwraca `jan.kowalski@example.com`, **Oraz** nie usuwa kropek w części lokalnej ani członu po plusie: `a.b+promo@gmail.com` zostaje bez zmian.
2. **Zakładając** korpus co najmniej 15 wejść zawierający spację wiodącą i kończącą, tabulator, spację niełamliwą, wielkie litery w domenie i w części lokalnej oraz adres pusty, **Kiedy** wynik funkcji porównamy z wynikiem zapytania `select lower(btrim($1))` z tej samej bazy, **Wtedy** dla każdego wejścia oba wyniki są identyczne, **Oraz** klasa wejścia, dla której się różnią, jest odrzucana walidacją na granicy z kodem błędu `invalid_email`, a nie zapisywana.
3. **Zakładając** migrację dodającą kolumnę `profiles.email_normalized` i unikalny indeks `(tenant_id, email_normalized)` obowiązujący tylko dla wierszy z adresem, **Kiedy** migracja zostanie zastosowana na bazie z istniejącymi profilami, **Wtedy** każdy profil z adresem ma wypełnioną kolumnę, **Oraz** migracja po zapisie odczytuje liczbę wierszy z pustą kolumną i pustym adresem i przerywa pracę, jeśli jest większa od zera.
4. **Zakładając** istniejący profil `jan@example.com` w tenancie A, **Kiedy** use-case zapisu profilu dostanie `JAN@EXAMPLE.COM ` z nowym imieniem, **Wtedy** liczba profili w tenancie A nie rośnie, **Oraz** zwrócony identyfikator jest identyfikatorem istniejącego profilu, **Oraz** `created_at` istniejącego profilu nie zmienia się.
5. **Zakładając** tenanta A, **Kiedy** zapiszemy dwa profile bez adresu e-mail, **Wtedy** oba istnieją i żaden nie jest scalony z drugim.
6. **Zakładając** ten sam adres w tenancie A i w tenancie B, **Kiedy** oba zostaną zapisane, **Wtedy** istnieją dwa osobne profile, **Oraz** wywołanie use-case z kontekstem tenanta A nigdy nie zwraca identyfikatora profilu tenanta B.
7. **Zakładając** wywołanie z warstwy web, **Kiedy** w ciele żądania znajdzie się `tenantId` inny niż w sesji, **Wtedy** use-case pracuje na tenancie z sesji i wartość z żądania jest ignorowana, **Oraz** istnieje test, który to potwierdza.

**Notatki implementacyjne:** `src/domain/audience/email.ts` (normalizacja, bez zależności wychodzących), `src/domain/audience/profile.ts` (encja), `src/adapters/db/profiles-repo.ts` (ręczny SQL wg AD-18, wynik parsowany zodem), `src/usecases/profiles/upsert-profile.ts`, nowy plik w `migrations/`. Jeśli ingest z Epiku 1 zapisuje profile własnym SQL-em, ta story konsoliduje zapis: po niej żadna ścieżka nie wstawia do `profiles` poza tym repozytorium (AD-3). Pułapka pierwsza: JS `trim()` obcina szerszy zbiór znaków niż `btrim()` w Postgresie, więc indeks i kod mogą uznać dwa różne adresy za ten sam albo odwrotnie. Pułapka druga: `crypto.randomUUID()` daje wersję 4 i psuje uporządkowanie indeksu, klucze generuje `uuidv7()` (AD-15).

**Testy:** integracyjny na sandboxie Postgres, bez mocków bazy. Sprawdza: scalanie adresu różniącego się wielkością liter i spacjami do jednego profilu; brak scalania dla adresów różniących się kropką lub tagiem po plusie; wiele profili bez adresu w jednym tenancie; zgodność funkcji normalizującej z wyrażeniem indeksu na korpusie z punktu 2; poprawność backfillu po migracji przez odczyt zwrotny. **Test izolacji cross-tenant:** ten sam adres w dwóch tenantach daje dwa profile, a odczyt i zapis z kontekstem tenanta A nie widzi i nie modyfikuje wiersza tenanta B.

---

### Story 2.2: Wyszukanie profilu i podgląd jego historii

Jako operator MidRev, chcę znaleźć profil po adresie i zobaczyć komplet jego zdarzeń, żeby odpowiedzieć klientowi na pytanie „dlaczego ta osoba dostała ten mail" bez wchodzenia do bazy.

**Pokrywa:** FR20, FR18 | **Rządzą:** AD-2, AD-3, AD-18, AD-21 | **Jakość:** NFR20, NFR9

**Kryteria akceptacji**

1. **Zakładając** profil `jan@example.com` w tenancie A, **Kiedy** operator wyszuka `  JAN@Example.com `, **Wtedy** dostaje ten profil, **Oraz** wyszukiwanie używa tej samej funkcji normalizującej co Story 2.1.
2. **Zakładając** wyszukiwanie po fragmencie adresu, **Kiedy** operator wpisze `jan`, **Wtedy** dostaje listę dopasowań ograniczoną do 50 pozycji z informacją, że wynik jest przycięty, **Oraz** dopasowanie liczone jest na kolumnie znormalizowanej.
3. **Zakładając** profil z 500 zdarzeniami, **Kiedy** operator otworzy jego historię, **Wtedy** widzi zdarzenia posortowane malejąco po `occurred_at`, stronicowane po 50, **Oraz** każda pozycja pokazuje typ zdarzenia, `occurred_at` i `recorded_at` jako dwie osobne wartości (AD-10).
4. **Zakładając** profil z 200 tys. profili w tenancie, **Kiedy** operator wyszuka po pełnym adresie, **Wtedy** wynik wraca poniżej 2 sekund, **Oraz** zapytanie korzysta z indeksu na `(tenant_id, email_normalized)`, co potwierdza plan zapytania w teście.
5. **Zakładając** profil w tenancie B, **Kiedy** operator zalogowany w kontekście tenanta A wyszuka jego adres, **Wtedy** dostaje pusty wynik, **Oraz** próba otwarcia historii po podanym wprost identyfikatorze profilu tenanta B zwraca `{ ok: false, error: { code: 'not_found' } }`, nie dane i nie `forbidden`.
6. **Zakładając** wymóg FR6 z Epiku 7, **Kiedy** ktoś doda log dostępu do danych osobowych, **Wtedy** ma dokładnie jedno miejsce do wpięcia, bo odczyt profilu i historii idzie przez jeden use-case, **Oraz** żaden komponent warstwy web nie wykonuje zapytania do `profiles` ani `events` bezpośrednio.

**Notatki implementacyjne:** `src/usecases/profiles/find-profile.ts`, `src/usecases/profiles/get-profile-history.ts`, rozszerzenie `src/adapters/db/profiles-repo.ts`, ekran w `src/app/(operator)/profiles/`. Odpowiedź `not_found` zamiast `forbidden` przy cudzym tenancie jest celowa: `forbidden` potwierdza istnienie rekordu. Stronicowanie po kursorze (`occurred_at`, `id`), nie po `offset`, bo przy dopisywanych zdarzeniach offset gubi i dubluje wiersze.

**Testy:** integracyjny na sandboxie. Sprawdza: znalezienie profilu po adresie w innej wielkości liter i ze spacjami; stronicowanie historii bez zgubienia i bez zdublowania zdarzenia przy dopisaniu nowego między stronami; przycięcie listy wyników do 50 z jawną flagą; czas odpowiedzi przy zaszczepionych 200 tys. profilach (test oznaczony jako wolny, poza domyślnym przebiegiem). **Test izolacji cross-tenant:** wyszukanie adresu istniejącego wyłącznie w tenancie B z kontekstem tenanta A zwraca pusty wynik, a odczyt historii po jego identyfikatorze zwraca `not_found`.

---

### Story 2.3: Rejestr zgód z datą, źródłem i treścią, tylko do dopisywania

Jako właściciel systemu, chcę żeby każda zgoda i każde jej cofnięcie były osobnym, nieusuwalnym wpisem z datą ze źródła, żeby na pytanie „na jakiej podstawie wysłaliście do tej osoby" istniała odpowiedź, a nie domysł.

**Pokrywa:** FR26 | **Rządzą:** AD-16, AD-2, AD-10, AD-18 | **Jakość:** NFR3, NFR9, NFR18

**Kryteria akceptacji**

1. **Zakładając** tabelę `consents` z kolumnami tenanta, profilu, kanału, statusu (`granted` albo `revoked`), źródła, treści klauzuli, dowodu w postaci JSON, `occurred_at` i `recorded_at`, **Kiedy** wykonamy zapis bez `occurred_at`, **Wtedy** baza odrzuca wiersz, **Oraz** kolumna nie ma wartości domyślnej `now()` (AD-10, NFR3).
2. **Zakładając** wpisaną zgodę, **Kiedy** ktokolwiek wykona `update consents` albo `delete from consents`, **Wtedy** operacja kończy się błędem wywołanym przez wyzwalacz bazy, **Oraz** ten sam wyzwalacz przepuszcza zapis tylko wtedy, gdy transakcja jawnie ustawiła ustaloną flagę sesyjną zarezerwowaną dla ścieżki RODO z Epiku 7.
3. **Zakładając** profil ze zgodą z 1 marca i cofnięciem z 5 marca, **Kiedy** odpytamy o stan aktualny, **Wtedy** dostajemy `revoked` z datą 5 marca, **Oraz** oba wpisy nadal istnieją i są widoczne w historii.
4. **Zakładając** profil z cofnięciem z 5 marca i ponowną zgodą z 10 marca, **Kiedy** odpytamy o stan aktualny, **Wtedy** dostajemy `granted`.
5. **Zakładając** dwa wpisy o identycznym `occurred_at`, **Kiedy** odpytamy o stan aktualny, **Wtedy** rozstrzyga kolejno `recorded_at`, a przy remisie identyfikator, **Oraz** wynik jest powtarzalny między wywołaniami, co potwierdza test uruchamiający zapytanie dziesięć razy.
6. **Zakładając** wpis zgody, **Kiedy** obejrzymy go w interfejsie, **Wtedy** widać źródło (na przykład `import:klaviyo`, `checkout`, `manual`) i treść klauzuli, na którą osoba się zgodziła, **Oraz** pole źródła jest obowiązkowe i puste nie przechodzi walidacji.
7. **Zakładając** profil w tenancie B, **Kiedy** zapiszemy dla niego zgodę w kontekście tenanta A, **Wtedy** zapis jest odrzucony przez złożony klucz obcy `(tenant_id, profile_id)`, tak jak w `events` z migracji 0001.

**Notatki implementacyjne:** nowy plik migracji z tabelą, wyzwalaczem blokującym `update` i `delete` oraz indeksem `(tenant_id, profile_id, channel, occurred_at desc, recorded_at desc, id desc)` pod zapytanie o stan aktualny (`distinct on`). Kod: `src/domain/audience/consent.ts` (typy i reguła wyznaczania stanu), `src/adapters/db/consents-repo.ts`, `src/usecases/consents/record-consent.ts`. Kanał jako kolumna od początku, mimo że w fazie 1 jest tylko `email`: dołożenie SMS-a później nie może wymagać ruszania tabeli, której AD-16 zabrania przebudowywać. Dowód zgody trzymać jako JSON (adres URL formularza, identyfikator formularza, nazwa pliku importu), bez adresu IP w logu aplikacji.

**Testy:** integracyjny na sandboxie. Sprawdza: odrzucenie zapisu bez `occurred_at`; błąd przy `update` i przy `delete`; przejście przez flagę sesyjną jako jedyną furtkę; wyznaczenie stanu aktualnego dla sekwencji zgoda → cofnięcie → zgoda; deterministyczne rozstrzygnięcie remisu dat; odrzucenie pustego źródła. **Test izolacji cross-tenant:** zgoda profilu tenanta B nie jest widoczna w zapytaniu o stan zgody wykonanym w kontekście tenanta A, a próba jej zapisu przez tenanta A kończy się błędem klucza obcego.

---

### Story 2.4: Wykluczenia dwupoziomowe, globalne i tenanta

Jako właściciel systemu, chcę dwie listy wykluczeń, jedną chroniącą reputację całej platformy i drugą będącą listą wypisań konkretnego sklepu, żeby skarga u jednego klienta nie znikała u pozostałych, a wypisanie ze sklepu nie blokowało adresu wszystkim.

**Pokrywa:** FR28 | **Rządzą:** AD-27, AD-16, AD-2, AD-10, AD-18 | **Jakość:** NFR3, NFR9, NFR28

**Kryteria akceptacji**

1. **Zakładając** migrację, **Kiedy** zostanie zastosowana, **Wtedy** istnieje tabela `tenant_suppressions` z tenantem, znormalizowanym adresem, powodem ze zbioru (`unsubscribe`, `bounce_hard`, `complaint`, `manual`, `import`), źródłem, `occurred_at` bez wartości domyślnej i `recorded_at`, **Oraz** globalna tabela `suppressions` ma dołożone `email_normalized`, `occurred_at`, `source` i kolumnę akcji o wartościach `suppress` albo `lift`.
2. **Zakładając** że AD-16 czyni te tabele wyłącznie dopisywalnymi, **Kiedy** ten sam adres zostanie wykluczony dwa razy, **Wtedy** powstają dwa wiersze i żaden zapis nie kończy się błędem unikalności, **Oraz** stary unikalny indeks na adresie z migracji 0001 jest zdjęty nową migracją, a w jego miejsce wchodzi indeks `(email_normalized, occurred_at desc, recorded_at desc, id desc)`.
3. **Zakładając** zdarzenie od dostawcy wysyłki niosące własny identyfikator, **Kiedy** to samo zdarzenie przyjdzie dwa razy, **Wtedy** powstaje dokładnie jeden wiersz wykluczenia, **Oraz** wymusza to ograniczenie unikalności na identyfikatorze zdarzenia źródłowego działające tylko dla wierszy, które go mają (NFR28).
4. **Zakładając** adres wykluczony globalnie, **Kiedy** zapytamy o stan wykluczenia w kontekście dowolnego tenanta, **Wtedy** stan to „wykluczony" z poziomem `global`.
5. **Zakładając** adres wykluczony wyłącznie w tenancie A, **Kiedy** zapytamy o jego stan w kontekście tenanta B, **Wtedy** stan to „niewykluczony", **Oraz** to samo zapytanie w kontekście tenanta A zwraca „wykluczony" z poziomem `tenant`.
6. **Zakładając** wpis wykluczenia, **Kiedy** obejrzymy go w interfejsie, **Wtedy** widać powód, źródło i datę zdarzenia ze źródła, a nie datę zapisu, **Oraz** przy wpisie pochodzącym z importu widać nazwę przebiegu importu.
7. **Zakładając** zapis wykluczenia z adresem w postaci nieznormalizowanej, **Kiedy** przejdzie przez use-case, **Wtedy** w bazie ląduje postać znormalizowana funkcją ze Story 2.1, **Oraz** odpytanie o postać z wielkimi literami zwraca ten sam wpis.

**Notatki implementacyjne:** `src/domain/audience/suppression.ts`, `src/adapters/db/suppressions-repo.ts`, `src/usecases/suppressions/add-suppression.ts`, nowy plik migracji. Jeśli migracja 0002 z Epiku 1 utworzyła już `tenant_suppressions` w innym kształcie, brakujące kolumny dokłada nowy plik, pliku 0002 nie wolno edytować (AD-12). Świadomy koszt zdjęcia unikalnego indeksu: gwarancja „jeden adres, jeden wiersz" znika, a jej miejsce zajmuje stan wyliczany z ostatniego wiersza. To warunek konieczny, żeby Story 2.11 mogła zdjąć wykluczenie bez kasowania historii. Odczyt stanu jednym zapytaniem `distinct on` dla obu poziomów naraz, nie dwoma podróżami do bazy.

**Testy:** integracyjny na sandboxie. Sprawdza: dwa wykluczenia tego samego adresu bez błędu unikalności; jedno wykluczenie przy dwukrotnym zdarzeniu o tym samym identyfikatorze źródłowym; odczyt stanu dla adresu globalnego i dla adresu tenanckiego; zapis `occurred_at` z danych źródłowych, nie z chwili zapisu; normalizację adresu przy zapisie i przy odczycie. **Test izolacji cross-tenant:** wykluczenie w tenancie A nie zmienia stanu w tenancie B, a wykluczenie globalne zmienia stan w obu.

---

### Story 2.5: Bramka `canSendTo` jako jedyne wejście do wysyłki

Jako właściciel systemu, chcę jedną funkcję rozstrzygającą czy wolno wysłać do tej osoby, wołaną w tej samej transakcji co zmiana stanu wiadomości, żeby wypisanie w piątek nie skończyło się mailem w sobotę tylko dlatego, że listę zbudowano w czwartek.

**Pokrywa:** FR29 | **Rządzą:** AD-9, AD-25, AD-27, AD-2, AD-21 | **Jakość:** NFR9, NFR15

**Kryteria akceptacji**

1. **Zakładając** sygnaturę `canSendTo(tx, actor, { profileId, email, source })` zwracającą `{ allowed: true }` albo `{ allowed: false, reason }`, **Kiedy** decyzja jest odmowna, **Wtedy** `reason` jest wartością z zamkniętej enumeracji (`no_email`, `global_suppression`, `tenant_suppression`, `no_consent`, `consent_revoked`), **Oraz** odmowa biznesowa nigdy nie jest wyjątkiem, zgodnie z konwencją błędów z architektury.
2. **Zakładając** otwartą transakcję, w której właśnie dopisano wykluczenie tenanta dla adresu X i której jeszcze nie zatwierdzono, **Kiedy** w tej samej transakcji wywołamy `canSendTo` dla X, **Wtedy** decyzja jest odmowna z powodem `tenant_suppression`, **Oraz** wywołanie z innego połączenia przed zatwierdzeniem transakcji zwraca zgodę, co dowodzi, że funkcja pracuje na przekazanym połączeniu, a nie na własnym.
3. **Zakładając** adres wykluczony globalnie i jednocześnie w tenancie, **Kiedy** wywołamy bramkę, **Wtedy** powód to `global_suppression`, **Oraz** kolejność sprawdzeń jest ustalona i pokryta testem: brak adresu, wykluczenie globalne, wykluczenie tenanta, brak zgody, cofnięta zgoda.
4. **Zakładając** profil bez żadnego wpisu zgody, **Kiedy** wywołamy bramkę, **Wtedy** decyzja jest odmowna z powodem `no_consent`, **Oraz** brak wpisu nigdy nie jest traktowany jako zgoda domniemana.
5. **Zakładając** źródło typu `test` (wysyłka testowa operatora), **Kiedy** adres testowy nie ma wpisu zgody, **Wtedy** decyzja jest odmowna z powodem `no_consent`, **Oraz** jedyną drogą dopuszczenia adresu testowego jest wpis zgody ze źródłem `operator_test`, a nie obejście bramki (AD-9).
6. **Zakładając** profil bez adresu e-mail, **Kiedy** wywołamy bramkę, **Wtedy** powód to `no_email`, **Oraz** funkcja nie wykonuje żadnego zapytania o wykluczenia dla pustego adresu.
7. **Zakładając** przeszukanie repozytorium, **Kiedy** policzymy miejsca odpytujące tabele wykluczeń w celu podjęcia decyzji o wysyłce, **Wtedy** jest dokładnie jedno i jest nim ta funkcja, **Oraz** rozszerzenia z Epików 3 i 6 (limity, warmup, tryb równoległy) dokładają wartości do tej enumeracji, nie nową bramkę.
8. **Zakładając** kontekst tenanta A, **Kiedy** wywołamy bramkę z identyfikatorem profilu należącego do tenanta B, **Wtedy** decyzja jest odmowna, a nie przypadkowo zgodna, **Oraz** funkcja nie zwraca żadnych danych profilu tenanta B.

**Notatki implementacyjne:** `src/domain/audience/send-gate.ts` (typy decyzji i powodów), `src/usecases/audience/can-send-to.ts` (implementacja przyjmująca połączenie z zewnątrz). Argument `tx` jest obowiązkowy właśnie po to, żeby Epik 3 mógł ją wywołać wewnątrz transakcji `queued → sending` (AD-23, AD-25). Zapis odmowy do strumienia stanu wiadomości należy do wołającego z Epiku 3, bo `messages` i `message_events` jeszcze nie istnieją. Tu bramka ma zwrócić powód w kodzie maszynowym, żeby tamten zapis miał co zapisać. Jedno zapytanie sprawdzające oba poziomy wykluczeń i stan zgody, nie trzy podróże do bazy: bramka biegnie raz na odbiorcę przy każdej wysyłce.

**Testy:** integracyjny na sandboxie, bez mocków bazy. Sprawdza: kolejność powodów przy nałożonych blokadach; widoczność zapisu z tej samej nieżatwierdzonej transakcji; odmowę przy braku zgody i przy zgodzie cofniętej; przepuszczenie profilu ze zgodą i bez wykluczeń; odmowę dla profilu bez adresu; odmowę dla źródła `test` bez wpisu zgody. **Test izolacji cross-tenant:** adres wykluczony w tenancie A jest przepuszczany w tenancie B; profil tenanta B wywołany w kontekście tenanta A daje odmowę i zero danych w odpowiedzi.

---

### Story 2.6: Listy statyczne i zarządzanie ich członkami

Jako operator MidRev, chcę utworzyć listę statyczną i ręcznie dokładać oraz zdejmować z niej ludzi, żeby mieć stały zbiór odbiorców niezależny od reguł segmentu.

**Pokrywa:** FR23 | **Rządzą:** AD-2, AD-3, AD-18, AD-21 | **Jakość:** NFR9, NFR20

**Kryteria akceptacji**

1. **Zakładając** tenanta A, **Kiedy** operator utworzy listę o nazwie `Newsletter`, **Wtedy** lista istnieje w tenancie A z identyfikatorem w formie `lst_` plus UUID (AD-15), **Oraz** druga lista o tej samej nazwie w tym samym tenancie jest odrzucona kodem `list_name_taken`, a w innym tenancie przechodzi.
2. **Zakładając** listę i profil, **Kiedy** operator doda profil dwa razy, **Wtedy** członkostwo istnieje raz, **Oraz** drugi zapis nie kończy się błędem, tylko zwraca informację, że nic nie dodano.
3. **Zakładając** listę z członkami, **Kiedy** obejrzymy jej członkostwo, **Wtedy** każdy wiersz niesie datę dołączenia i źródło dołączenia (`manual`, `import`, `store_sync`), **Oraz** data dołączenia przy dopisaniu z importu pochodzi z danych źródłowych, a nie z chwili zapisu (NFR3).
4. **Zakładając** profil na liście, **Kiedy** operator zdejmie go z listy, **Wtedy** członkostwo znika, **Oraz** nie powstaje żaden wpis wykluczenia, bo zdjęcie z listy nie jest wypisaniem, **Oraz** potwierdza to test sprawdzający, że stan bramki `canSendTo` dla tego profilu się nie zmienił.
5. **Zakładając** usunięcie całej listy, **Kiedy** operator ją usunie, **Wtedy** znikają członkostwa, ale nie znika żaden profil, żadna zgoda ani żadne wykluczenie.
6. **Zakładając** listę tenanta B, **Kiedy** operator w kontekście tenanta A spróbuje dodać do niej swój profil po podanym wprost identyfikatorze listy, **Wtedy** operacja kończy się `not_found`, **Oraz** klucz obcy `(tenant_id, list_id)` po stronie bazy odrzuca taki wiersz nawet przy pominięciu use-case.

**Notatki implementacyjne:** nowa migracja z `lists` i `list_members`, w obu tenant jako pierwsza kolumna klucza, unikalność członkostwa `(tenant_id, list_id, profile_id)`, klucze obce złożone z tenantem, tak jak w `events` z 0001. Kod: `src/domain/audience/list.ts`, `src/adapters/db/lists-repo.ts`, `src/usecases/lists/*`. Liczebność listy pokazywać zapytaniem z indeksu, nie licząc członków w pamięci aplikacji.

**Testy:** integracyjny na sandboxie. Sprawdza: unikalność nazwy w obrębie tenanta przy dopuszczeniu tej samej nazwy w innym tenancie; idempotentne dodanie członka; datę dołączenia ze źródła; brak wpisu wykluczenia po zdjęciu z listy; przeżycie profili po usunięciu listy. **Test izolacji cross-tenant:** dodanie profilu tenanta A do listy tenanta B odrzucone i przez use-case, i przez klucz obcy; zestawienie list w kontekście tenanta A nie pokazuje list tenanta B.

---

### Story 2.7: Import listy z pliku CSV z obowiązkową informacją o zgodzie

Jako operator MidRev, chcę wgrać plik z kontaktami i ich zgodami, żeby przenieść listę klienta, i chcę żeby system fizycznie nie pozwolił mi wgrać listy bez zgód, bo to jest ta decyzja, której nie wolno zostawić mojej pamięci.

**Pokrywa:** FR23, FR27, FR26, FR19 | **Rządzą:** AD-16, AD-10, AD-18, AD-2 | **Jakość:** NFR1, NFR2, NFR3, NFR4, NFR6

**Kryteria akceptacji**

1. **Zakładając** plik CSV i ekran mapowania kolumn, **Kiedy** operator nie wskaże kolumny ze statusem zgody, kolumny z datą zgody albo kolumny ze źródłem zgody, **Wtedy** import zwraca `{ ok: false, error: { code: 'consent_columns_missing' } }` i **nie zapisuje ani jednego wiersza**, **Oraz** blokada siedzi w use-case, co potwierdza test wywołujący use-case bezpośrednio, z pominięciem interfejsu (FR27).
2. **Zakładając** poprawnie zmapowany plik, **Kiedy** operator uruchomi przebieg, **Wtedy** pierwszym etapem jest raport przed zapisem podający: liczbę wierszy w pliku, liczbę profili, które powstaną, liczbę profili istniejących, do których import się dopnie, liczbę wierszy odrzuconych z rozbiciem na powody, **Oraz** żaden zapis nie następuje przed potwierdzeniem przez operatora (NFR6).
3. **Zakładając** wiersz z pustą albo niepoprawną datą zgody, **Kiedy** przejdzie przez import, **Wtedy** wiersz jest odrzucony z powodem `consent_date_missing`, **Oraz** pod żadnym warunkiem nie powstaje zgoda z datą wykonania importu (NFR3).
4. **Zakładając** plik zawierający `Jan@Example.com` i `  jan@example.com ` jako dwa wiersze, **Kiedy** import się wykona, **Wtedy** powstaje jeden profil, **Oraz** powstają dwa wpisy zgody, bo rejestr zgód jest wyłącznie dopisywalny, **Oraz** stan aktualny zgody wyznacza wpis o późniejszym `occurred_at`.
5. **Zakładając** zakończony przebieg, **Kiedy** obejrzymy jego podsumowanie, **Wtedy** liczniki pokazują faktyczny wynik operacji (utworzone, dopięte, pominięte, odrzucone), **Oraz** ich suma równa się liczbie wierszy w pliku, **Oraz** przebieg, który nie zapisał niczego, pokazuje zera, a nie liczbę podjętych prób (NFR2).
6. **Zakładając** zakończony zapis, **Kiedy** import wykona kontrolę końcową, **Wtedy** odczytuje z bazy wiersze utworzone w tym przebiegu i porównuje z oczekiwaniem: liczbę profili, liczbę zgód oraz dla próbki co najmniej 20 wierszy zgodność znormalizowanego adresu i `occurred_at` zgody, **Oraz** rozjazd kończy przebieg statusem niepowodzenia z opisem różnicy, nie cichym sukcesem (NFR1).
7. **Zakładając** że każdy zapisany wiersz nosi identyfikator przebiegu importu, **Kiedy** trzeba obejrzeć albo cofnąć skutki jednego przebiegu, **Wtedy** filtruje się po tym identyfikatorze, a nie po szerokim warunku typu źródło importu obejmującym też poprzednie przebiegi (NFR4).
8. **Zakładając** wiersz z adresem, który jest w wykluczeniach globalnych albo tenanta, **Kiedy** import się wykona, **Wtedy** profil i zgoda mogą powstać, ale wykluczenie zostaje nienaruszone, **Oraz** raport wymienia liczbę takich wierszy osobno, **Oraz** test potwierdza, że `canSendTo` dla nich nadal odmawia.
9. **Zakładając** plik 50 tys. wierszy i awarię w połowie przebiegu, **Kiedy** przebieg zostanie przerwany, **Wtedy** wiersze zapisane do tego momentu są trwałe i policzone w raporcie, **Oraz** ponowne uruchomienie tego samego pliku nie tworzy duplikatów profili ani duplikatów członkostwa na liście.

**Notatki implementacyjne:** `src/usecases/lists/import-list-csv.ts` (walidacja i etap raportu), `src/jobs/import-list-csv.ts` (zapis partiami przez kolejkę, bo plik 50 tys. wierszy nie zmieści się w oknie żądania web), `src/adapters/db/import-runs-repo.ts`, nowa migracja z `import_runs` i `import_run_rows` na odrzucone wiersze wraz z powodem. Parsowanie CSV strumieniowo, bez wczytywania pliku w całość. Partie po około 500 wierszy, każda w swojej transakcji: partia to nie jest jedna wielka transakcja na cały plik, bo wtedy awaria w 49 tysiącu kasuje wszystko i przebieg jest nie do dokończenia. Pułapka wprost z historii projektu: kontrola po zapisie musi czytać **zapisany rekord z bazy**, nie strukturę z pamięci zbudowaną z pliku, bo tamta nie wykryje, że do bazy poszło coś innego.

**Testy:** integracyjny na sandboxie, na plikach z katalogu z próbkami. Sprawdza: odmowę przy braku kolumn zgody i brak jakiegokolwiek zapisu po niej; zgodność raportu przed zapisem z faktycznym wynikiem; odrzucenie wiersza bez daty zgody; scalanie duplikatów w pliku do jednego profilu przy zachowaniu dwóch wpisów zgody; sumę liczników równą liczbie wierszy; wykrycie celowo wprowadzonego rozjazdu przez kontrolę odczytem zwrotnym (test podmienia zapis tak, żeby data była inna, i oczekuje niepowodzenia przebiegu); nienaruszenie wykluczenia dla adresu z listy wykluczeń; brak duplikatów po powtórnym uruchomieniu tego samego pliku. **Test izolacji cross-tenant:** import uruchomiony w kontekście tenanta A nie dotyka profili tenanta B o tych samych adresach, a licznik „dopięte do istniejących" nie liczy profili tenanta B.

---

### Story 2.8: Eksport listy do pliku CSV

Jako operator MidRev, chcę wyeksportować listę razem z informacją o zgodach, żeby klient mógł zabrać swoje dane, a ja żebym mógł przenieść listę między środowiskami bez ręcznego dłubania w bazie.

**Pokrywa:** FR23 | **Rządzą:** AD-2, AD-3, AD-18, AD-21 | **Jakość:** NFR1, NFR2, NFR9

**Kryteria akceptacji**

1. **Zakładając** listę z członkami, **Kiedy** operator ją wyeksportuje, **Wtedy** plik zawiera kolumny: adres w postaci oryginalnej, adres znormalizowany, status zgody, data zgody, źródło zgody, treść zgody, data dołączenia do listy, **Oraz** nagłówki są dokładnie tymi nazwami, które przyjmuje import ze Story 2.7.
2. **Zakładając** wyeksportowany plik, **Kiedy** zaimportujemy go do innej listy w tym samym tenancie, **Wtedy** liczba odrzuconych wierszy wynosi zero, liczba nowych profili wynosi zero, a liczba dopięć równa się liczbie wierszy pliku.
3. **Zakładając** listę 200 tys. członków, **Kiedy** operator uruchomi eksport, **Wtedy** plik powstaje strumieniowo bez wczytywania całości do pamięci, **Oraz** zadanie idzie przez kolejkę i operator dostaje gotowy plik, nie zawieszone żądanie.
4. **Zakładając** zakończony eksport, **Kiedy** obejrzymy jego podsumowanie, **Wtedy** liczba wierszy w pliku równa się liczbie członków listy policzonej osobnym zapytaniem, **Oraz** rozjazd kończy eksport niepowodzeniem, nie plikiem niepełnym (NFR1, NFR2).
5. **Zakładając** wartość w danych zawierającą przecinek, cudzysłów albo znak nowej linii, **Kiedy** trafi do pliku, **Wtedy** jest poprawnie ocytowana, **Oraz** ponowne wczytanie pliku daje tę samą wartość.
6. **Zakładając** wartość zaczynającą się od `=`, `+`, `-` albo `@`, **Kiedy** trafi do pliku, **Wtedy** jest zabezpieczona przed wykonaniem jako formuła w arkuszu, **Oraz** import ze Story 2.7 zdejmuje to zabezpieczenie i odtwarza wartość pierwotną.

**Notatki implementacyjne:** `src/usecases/lists/export-list-csv.ts`, `src/jobs/export-list-csv.ts`, zapis pliku przez port magazynu plików z `src/adapters/`. Kursor po `(tenant_id, list_id, profile_id)`, nie `offset`. Stan zgody liczony tym samym zapytaniem co w Story 2.3, nie drugą, równoległą implementacją reguły.

**Testy:** integracyjny na sandboxie. Sprawdza: komplet i nazwy kolumn; obieg tam i z powrotem eksport → import z zerem odrzuceń i zerem nowych profili; zgodność liczby wierszy z liczbą członków; ocytowanie wartości z przecinkiem, cudzysłowem i znakiem nowej linii; zabezpieczenie wartości formułopodobnej i jej odtworzenie przy imporcie. **Test izolacji cross-tenant:** eksport listy w kontekście tenanta A nie zawiera ani jednego wiersza tenanta B, w tym profili o identycznych adresach; próba eksportu listy tenanta B z kontekstem tenanta A zwraca `not_found`.

---

### Story 2.9: Segment na zamkniętym zestawie reguł

Jako operator MidRev, chcę zbudować segment z gotowych klocków dotyczących zamówień, produktów, dat, list i zgód, żeby zrobić kampanię do „kupili w 90 dni, nie kupili od 30" bez pisania SQL-a i bez budowania generycznego kreatora, który jest robotą na fazę 3.

**Pokrywa:** FR24 | **Rządzą:** AD-18, AD-2, AD-3, AD-21 | **Jakość:** NFR9, NFR21, NFR27

**Kryteria akceptacji**

1. **Zakładając** definicję segmentu w postaci listy reguł z jednym trybem łączenia (`wszystkie` albo `dowolna`) i flagą negacji na regułę, **Kiedy** ktoś zapisze definicję z zagnieżdżoną grupą reguł, **Wtedy** walidacja zodem odrzuca ją kodem `rule_shape_unsupported`, **Oraz** komunikat wskazuje, że zagnieżdżanie wchodzi z FR31 w fazie 3.
2. **Zakładając** rejestr reguł, **Kiedy** obejrzymy zaimplementowany zestaw, **Wtedy** obejmuje: zamówienie w ostatnich N dniach, brak zamówienia od N dni, zakup wskazanego produktu, zakup z wskazanej kategorii, suma wydatków w oknie w podanym przedziale kwotowym, obecność albo brak na wskazanej liście, aktualny status zgody, data utworzenia profilu w ostatnich N dniach, **Oraz** reguły oparte na zaangażowaniu są zadeklarowane w rejestrze jako punkt rozszerzenia dla Epiku 5, a definicja ich używająca jest odrzucana kodem `rule_not_available`.
3. **Zakładając** kompilator reguł do SQL, **Kiedy** reguła niesie wartość `'; drop table profiles; --`, **Wtedy** wartość idzie do zapytania wyłącznie jako parametr wiązany, **Oraz** po wykonaniu zapytania tabela `profiles` nadal istnieje, **Oraz** żaden fragment SQL nie powstaje przez sklejanie napisów z danymi użytkownika.
4. **Zakładając** wygenerowane zapytanie, **Kiedy** obejrzymy jego treść, **Wtedy** zawiera predykat po tenancie w każdym złączeniu dotykającym danych tenanta, **Oraz** test sprawdza obecność tego predykatu dla każdej reguły z rejestru, nie tylko dla jednej.
5. **Zakładając** kwoty w regule wydatków, **Kiedy** operator poda 250 zł, **Wtedy** w bazie i w porównaniu używana jest wartość całkowita w groszach wraz z kodem waluty, **Oraz** żadna liczba zmiennoprzecinkowa nie bierze udziału w porównaniu (AD-11).
6. **Zakładając** zapisaną definicję, **Kiedy** ją zapiszemy, **Wtedy** segment przechowuje skrót definicji, **Oraz** rozwiązanie segmentu do zbioru profili zwraca ten skrót razem z wynikiem, żeby dało się stwierdzić, na jakiej wersji definicji zbudowano dany zbiór.
7. **Zakładając** zbiór odbiorców zbudowany z segmentu, **Kiedy** definicja segmentu zmieni się po jego zbudowaniu, **Wtedy** zbudowany zbiór nie zmienia się wstecz, **Oraz** wiążącą decyzją o wysyłce pozostaje `canSendTo` ze Story 2.5, nie ponowne przeliczenie segmentu (AD-25).
8. **Zakładając** segment tenanta B, **Kiedy** rozwiążemy go w kontekście tenanta A, **Wtedy** operacja kończy się `not_found`, **Oraz** żaden profil tenanta B nie trafia do wyniku.

**Notatki implementacyjne:** `src/domain/audience/segment-rules.ts` (schematy zodem i rejestr reguł: identyfikator reguły, schemat parametrów, wymagane tabele, fabryka fragmentu SQL), `src/adapters/db/segment-compiler.ts` (składanie fragmentów, wyłącznie z parametrami wiązanymi), `src/adapters/db/segments-repo.ts`, `src/usecases/segments/save-segment.ts`, `src/usecases/segments/resolve-segment.ts`, nowa migracja z tabelą `segments`. Rejestr jest jedynym miejscem, w którym powstaje SQL reguły: dołożenie reguły to nowy wpis w rejestrze, nie `if` w kompilatorze. Reguła „nie kupił od N dni" to nieobecność zamówienia w oknie, a nie zamówienie starsze niż N dni, i te dwa zdania dają różne zbiory dla klienta, który nie kupił nigdy. Ustalić to jawnie w opisie reguły i pokryć testem.

**Testy:** integracyjny na sandboxie, na danych z sandboxa WooCommerce (8 produktów, 6 klientów, 40 zamówień od lipca 2025). Sprawdza: odrzucenie definicji zagnieżdżonej i definicji z regułą niedostępną; wynik każdej reguły z rejestru na zaszczepionym, ręcznie policzonym zbiorze; rozróżnienie „nie kupił od N dni" dla klienta bez żadnego zamówienia; obecność predykatu tenanta w zapytaniu każdej reguły; nieszkodliwość wartości z ładunkiem SQL; stabilność skrótu definicji. **Test izolacji cross-tenant:** ten sam zestaw reguł uruchomiony w tenancie A nie zwraca profili tenanta B mających identyczne zamówienia i adresy; rozwiązanie segmentu tenanta B z kontekstu tenanta A zwraca `not_found`.

---

### Story 2.10: Podgląd liczebności segmentu przed wysyłką

Jako operator MidRev, chcę zobaczyć ile osób obejmuje segment, zanim go użyję, i chcę wiedzieć kiedy ta liczba została policzona, żeby nie wysłać do czterdziestu tysięcy ludzi w przekonaniu, że to czterysta.

**Pokrywa:** FR25 | **Rządzą:** AD-2, AD-18, AD-21 | **Jakość:** NFR21, NFR2, NFR9

**Kryteria akceptacji**

1. **Zakładając** zapisany segment, **Kiedy** operator otworzy jego podgląd, **Wtedy** widzi liczebność oraz moment jej policzenia, **Oraz** liczba jest wynikiem faktycznego zapytania, a nie odczytem pola zaktualizowanego przy okazji innej operacji (NFR2).
2. **Zakładając** tenanta z 200 tys. profili i 400 tys. zamówień, **Kiedy** operator poprosi o liczebność segmentu opartego na zamówieniach, **Wtedy** wynik wraca poniżej 5 sekund, **Oraz** test mierzący ten czas jest oznaczony jako wolny i uruchamiany osobno od domyślnego przebiegu (NFR21).
3. **Zakładając** policzoną liczebność, **Kiedy** definicja segmentu zostanie zmieniona, **Wtedy** poprzednia liczba nie jest pokazywana jako aktualna, bo skrót definicji się nie zgadza, **Oraz** interfejs mówi wprost, że segment wymaga przeliczenia, zamiast pokazać liczbę sprzed zmiany.
4. **Zakładając** każde policzenie liczebności, **Kiedy** się zakończy, **Wtedy** wynik ląduje w wyłącznie dopisywalnej historii liczebności segmentu wraz ze skrótem definicji i datą, **Oraz** ta historia jest podstawą blokady z FR47 budowanej w Epiku 3 i nie jest w tym epiku do niczego innego używana.
5. **Zakładając** przekroczenie 30 sekund na przeliczeniu, **Kiedy** to nastąpi, **Wtedy** zdarzenie idzie kanałem alertowym z opisem reakcji, bo to jest jawny sygnał zmiany architektury z NFR27, **Oraz** nie kończy się wpisem w `console.error` (NFR38).
6. **Zakładając** segment tenanta B, **Kiedy** poprosimy o jego liczebność w kontekście tenanta A, **Wtedy** dostajemy `not_found`, a nie liczbę.

**Notatki implementacyjne:** `src/usecases/segments/count-segment.ts`, nowa migracja z `segment_count_history`. Liczenie przez `count(*)` na tym samym zapytaniu, które zwraca członków, żeby liczebność i zbiór nie mogły się rozjechać dwiema implementacjami. Zaszczepienie 200 tys. profili do testu wydajnościowego przez `generate_series` w SQL, nie pętlą wstawek z Node'a. Nie budować pamięci podręcznej z wygaszaniem po czasie: kluczem ważności jest skrót definicji, czas służy wyłącznie do pokazania człowiekowi, jak stara jest liczba.

**Testy:** integracyjny na sandboxie. Sprawdza: zgodność liczebności z liczbą wierszy zwróconych przez rozwiązanie segmentu na tym samym zbiorze; unieważnienie liczby po zmianie definicji; dopisanie wpisu do historii przy każdym przeliczeniu; wywołanie alertu przy sztucznie spowolnionym przeliczeniu. Osobny, wolny test wydajnościowy na 200 tys. profili z progiem 5 sekund. **Test izolacji cross-tenant:** liczebność segmentu tenanta A nie zmienia się po zaszczepieniu pasujących profili w tenancie B; zapytanie o segment tenanta B z kontekstu tenanta A zwraca `not_found`.

---

### Story 2.11: Zdjęcie wykluczenia wyłącznie przez administratora

Jako administrator MidRev, chcę być jedyną osobą, która może zdjąć adres z wykluczeń, i chcę żeby to zdjęcie było wpisem w historii, a nie skasowaniem dowodu, bo to jedyna operacja w systemie zdolna jednym kliknięciem wysłać mail do kogoś, kto zgłosił skargę.

**Pokrywa:** FR30, FR28 | **Rządzą:** AD-16, AD-21, AD-27, AD-2, AD-3 | **Jakość:** NFR9, NFR12, NFR38

**Kryteria akceptacji**

1. **Zakładając** użytkownika z rolą operatora, **Kiedy** wywoła use-case zdejmujący wykluczenie, **Wtedy** dostaje `{ ok: false, error: { code: 'forbidden' } }` i w bazie nie powstaje żaden wiersz, **Oraz** sprawdzenie roli siedzi w warstwie use-case, co potwierdza test wywołujący ją z pominięciem interfejsu (AD-21).
2. **Zakładając** użytkownika klienta, **Kiedy** wywoła ten sam use-case, **Wtedy** wynik jest taki sam jak dla operatora.
3. **Zakładając** administratora i obowiązkowe uzasadnienie, **Kiedy** poda puste uzasadnienie, **Wtedy** operacja jest odrzucona kodem `reason_required`, **Oraz** przy niepustym powstaje wiersz z akcją `lift`, identyfikatorem osoby wykonującej, uzasadnieniem, `occurred_at` i `recorded_at`.
4. **Zakładając** zdjęte wykluczenie, **Kiedy** obejrzymy historię adresu, **Wtedy** poprzedni wpis wykluczający nadal tam jest, **Oraz** żaden wiersz nie został zaktualizowany ani skasowany (AD-16).
5. **Zakładając** adres zdjęty z wykluczeń, **Kiedy** wywołamy `canSendTo`, **Wtedy** decyzja jest zgodna, o ile nie blokuje jej inny powód, **Oraz** test sprawdza obie ścieżki: zdjęcie samego wykluczenia i pozostanie odmowy z powodu braku zgody.
6. **Zakładając** adres zdjęty z wykluczeń, **Kiedy** przyjdzie po tym nowa skarga od dostawcy, **Wtedy** adres jest znowu wykluczony, bo o stanie decyduje ostatni wpis, **Oraz** dowodzi tego test na sekwencji wykluczenie → zdjęcie → wykluczenie.
7. **Zakładając** wykluczenie globalne i wykluczenie tenanta na tym samym adresie, **Kiedy** administrator zdejmie tylko globalne, **Wtedy** `canSendTo` w tym tenancie nadal odmawia z powodem `tenant_suppression`, **Oraz** oba poziomy wymagają osobnej, jawnej decyzji.
8. **Zakładając** wykonane zdjęcie wykluczenia, **Kiedy** operacja się zakończy, **Wtedy** idzie powiadomienie na kanał alertowy z adresem w postaci skróconej, powodem i osobą wykonującą, **Oraz** treść alertu zawiera opis, co z tym zrobić (NFR38).

**Notatki implementacyjne:** `src/usecases/suppressions/lift-suppression.ts`, rozszerzenie `src/adapters/db/suppressions-repo.ts`, ekran w `src/app/(operator)/suppressions/`. Zdjęcie to dopisanie wiersza z akcją `lift`, nigdy `delete`, i to jest powód, dla którego Story 2.4 zdejmuje z globalnej tabeli unikalny indeks na adresie. Poziom wykluczenia (globalny albo tenanta) jest obowiązkowym argumentem, bez wartości domyślnej: domyślnie „globalny" oznaczałby, że pomyłka w interfejsie zdejmuje ochronę wszystkim tenantom naraz. W logu i w alercie nie wolno umieszczać pełnego adresu w postaci jawnej, zgodnie z konwencją logowania z architektury.

**Testy:** integracyjny na sandboxie. Sprawdza: odmowę dla roli operatora i klienta wraz z brakiem zapisu; odrzucenie pustego uzasadnienia; powstanie wiersza `lift` z kompletem pól; przetrwanie poprzedniego wpisu; zmianę decyzji `canSendTo` po zdjęciu i utrzymanie odmowy przy braku zgody; ponowne wykluczenie po skardze przychodzącej po zdjęciu; niezależność poziomu globalnego od poziomu tenanta; wywołanie alertu. **Test izolacji cross-tenant:** administrator działający w kontekście tenanta A zdejmujący wykluczenie tenanta A nie zmienia stanu tego samego adresu w tenancie B; zdjęcie wykluczenia globalnego zmienia stan w obu tenantach i to jest zachowanie oczekiwane, pokryte osobnym testem.
