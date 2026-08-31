## Epik 1: Fundament i podłączenie sklepu

Cel: operator zakłada tenanta, podpina sklep WooCommerce i widzi zaimportowaną historię wraz z ekranem zgodności danych, a fundament (schemat, warstwy, kolejka, testy) przestaje łamać własne reguły.

### Story 1.1: Migracja 0002 - naprawa fundamentu

Jako operator, chcę żeby baza wymuszała datę zdarzenia ze źródła, żeby raporty przychodu nie pokazywały daty importu zamiast daty zamówienia.

**Pokrywa:** warunek wejścia z AD-30 | **Rządzą:** AD-10, AD-12, AD-15, AD-30 | **Jakość:** NFR3, NFR36

**Kryteria akceptacji**

**Zakładając** czystą bazę po `npm run migrate`, **kiedy** próbuję wstawić wiersz do `events` bez podania `occurred_at`, **wtedy** baza odrzuca zapis błędem `not-null violation`, **oraz** ten sam test wykonany przed migracją 0002 przechodziłby, co potwierdza, że reguła faktycznie działa.

**Zakładając** zastosowaną migrację 0002, **kiedy** wstawiam wiersz do `events` bez podania `id`, **wtedy** klucz główny jest identyfikatorem UUID w wersji 7, **oraz** dwa kolejne wstawienia dają identyfikatory rosnące leksykograficznie.

**Zakładając** repozytorium z plikiem `0001_init.sql`, **kiedy** uruchamiam migracje, **wtedy** suma kontrolna pliku 0001 jest niezmieniona, **oraz** cała naprawa mieści się w nowym pliku 0002.

**Zakładając** zastosowaną migrację 0002, **kiedy** odpytuję schemat, **wtedy** istnieją tabele `stores`, `raw_events` i `jobs` z kolumną `tenant_id` i kluczem obcym ograniczonym do tenanta.

**Notatki implementacyjne:** `migrations/0002_fundament.sql`. Kolumna `occurred_at`: `alter table events alter column occurred_at drop default`. Klucze główne: `default uuidv7()` (Postgres 18.6, sprawdzone). Nowe tabele: `stores` (tenant_id, platform, credentials_encrypted, capabilities jsonb, created_at), `raw_events` (tenant_id, source, idempotency_key unique, payload jsonb, received_at, processed_at null), `jobs` (partycjonowana po dniu wg AD-31, kolumny: tenant_id, kind, payload, run_after, attempts, locked_at, last_error). Nie dodawaj tu tabel należących do późniejszych epików.

**Testy:** `tests/migration-0002.test.ts` na sandboxie. Test wprost sprawdza odrzucenie zapisu bez `occurred_at` oraz wersję wygenerowanego UUID (bit wersji równy 7). Test izolacji: `raw_events` tenanta A nie da się powiązać z `stores` tenanta B.

### Story 1.2: Szkielet warstw i konfiguracja

Jako programista, chcę strukturę katalogów zgodną z paradygmatem i konfigurację walidowaną przy starcie, żeby kolejne moduły nie miały gdzie się rozjechać.

**Pokrywa:** fundament pod FR1-FR72 | **Rządzą:** AD-1, AD-3, AD-18 | **Jakość:** NFR35, NFR38

**Kryteria akceptacji**

**Zakładając** repozytorium, **kiedy** patrzę na `src/`, **wtedy** istnieją katalogi `domain`, `usecases`, `adapters/db`, `jobs`, **oraz** dotychczasowy `src/db.ts` żyje w `adapters/db` i istniejące testy nadal przechodzą.

**Zakładając** brak zmiennej `DATABASE_URL`, **kiedy** startuje aplikacja lub worker, **wtedy** proces kończy się błędem nazywającym brakującą zmienną, **oraz** komunikat nie zawiera żadnej wartości sekretu.

**Zakładając** kod w `src/domain`, **kiedy** uruchamiam kontrolę zależności, **wtedy** żaden plik z `domain` nie importuje niczego z `adapters`, `jobs` ani `app`, **oraz** naruszenie tej reguły przerywa budowanie.

**Notatki implementacyjne:** `src/config.ts` z zodem, jedyne miejsce dotykające `process.env`. Kontrola kierunku zależności: reguła w konfiguracji lintera albo prosty test skanujący importy (wystarczy test, byle był wymuszony w CI). TypeScript 6.0.3, Node 24.

**Testy:** test kontroli zależności jako zwykły test w `tests/`, żeby łamanie AD-1 wywalało zestaw testów, a nie tylko sumienie autora.

### Story 1.3: Kolejka i worker

Jako system, chcę kolejkę zadań w bazie z bezpiecznym zajmowaniem, żeby ciężka praca nie działa się w cyklu żądania.

**Pokrywa:** fundament pod FR10, FR12, FR48 | **Rządzą:** AD-5, AD-31 | **Jakość:** NFR14, NFR22, NFR30

**Kryteria akceptacji**

**Zakładając** dwa workery pracujące równolegle, **kiedy** w kolejce leży jedno zadanie, **wtedy** wykonuje je dokładnie jeden worker, **oraz** drugi nie widzi go jako dostępnego.

**Zakładając** zadanie, którego handler rzuca wyjątkiem, **kiedy** worker je przetwarza, **wtedy** zadanie wraca do kolejki z rosnącym odstępem, **oraz** po wyczerpaniu prób trafia do stanu błędu z zapisanym powodem i wywołuje alert.

**Zakładając** handler wykonujący wywołanie sieciowe, **kiedy** przeglądam kod zajmowania zadania, **wtedy** wywołanie sieciowe znajduje się poza transakcją zajmującą, **oraz** test to potwierdza przez pomiar czasu trzymania blokady.

**Zakładając** zadanie przetworzone wczoraj, **kiedy** uruchamiam sprzątanie, **wtedy** stara partycja jest odłączana, **oraz** nie wykonuje się masowy `DELETE`.

**Notatki implementacyjne:** `src/jobs/queue.ts` (zajmowanie partiami, `FOR UPDATE SKIP LOCKED`), `src/jobs/worker.ts`. Handler dostaje `ActorContext` z `tenantId` z zadania, nie z sesji.

Trzy rzeczy wykryte przy migracji 0002, których nie wolno tu zgubić:
1. Zajmowanie zadania to **jeden atomowy `UPDATE ... WHERE (id, created_at) IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`**, nigdy `SELECT`, a potem `UPDATE`.
2. Tożsamość zadania to para `(id, created_at)`, a `created_at` ma w Postgresie mikrosekundy, których `Date` w JavaScripcie nie utrzyma. Token zadania krąży jako tekst prosto z bazy i nigdy nie przechodzi przez `Date`, inaczej worker nie domknie zadania.
3. Partycje dzienne zakłada zadanie utrzymaniowe **z wyprzedzeniem**, a każda nowa partycja musi dostać własne progi autovacuum. Wiersz w `jobs_default` jest alarmem, nie normalnym stanem.

**Testy:** test współbieżności na sandboxie (dwa równoległe zajęcia), test ponowienia z odstępem, test odłączenia partycji.

### Story 1.4: Konta, tenanty i kontekst działającego

Jako administrator MidRev, chcę zakładać tenantów i nadawać do nich dostęp, żeby każdy sklep miał odizolowane dane, a operator mógł pracować na wielu naraz.

**Pokrywa:** FR1, FR2, FR3, FR4, FR5 | **Rządzą:** AD-2, AD-21, AD-15 | **Jakość:** NFR9, NFR12

**Kryteria akceptacji**

**Zakładając** zalogowanego administratora, **kiedy** zakłada tenanta, **wtedy** powstaje workspace z identyfikatorem prefiksowanym `ten_`, **oraz** administrator ma do niego dostęp bez dodatkowej czynności.

**Zakładając** operatora z dostępem do tenantów A i B, **kiedy** przełącza kontekst na B, **wtedy** widzi wyłącznie dane B, **oraz** nie musi się ponownie logować.

**Zakładając** operatora z dostępem wyłącznie do tenanta A, **kiedy** żądanie zawiera identyfikator tenanta B w ciele lub w parametrach, **wtedy** żądanie kończy się odmową, **oraz** wartość z żądania jest w ogóle ignorowana, bo kontekst pochodzi z sesji.

**Zakładając** użytkownika po stronie klienta, **kiedy** próbuje otworzyć widok konfiguracji sklepu, **wtedy** dostaje odmowę zgodną z macierzą uprawnień z PRD.

**Notatki implementacyjne:** tabele `users`, `memberships` (user_id, tenant_id, role), sesja w podpisanym ciasteczku. Hasło hashowane algorytmem pamięciożernym, nigdy w logu. `ActorContext { userId, tenantId, role }` przekazywany do każdego use-case jako pierwszy argument.

**Testy:** test cross-tenant (operator A nie odczyta profilu tenanta B nawet przy podaniu jego identyfikatora), test odmowy dla roli klienta, test że `tenantId` z ciała żądania nie ma żadnego wpływu.

### Story 1.5: Port StorePlatform i wspólny zestaw testów platformy

Jako programista, chcę jeden kontrakt danych sklepowych i wspólny zestaw testów, żeby dołożenie Shopify albo Shopera nie oznaczało nowego modelu danych.

**Pokrywa:** fundament pod FR8-FR17 | **Rządzą:** AD-8, AD-29, AD-1 | **Jakość:** NFR35

**Kryteria akceptacji**

**Zakładając** port w `src/domain`, **kiedy** czytam jego definicję, **wtedy** obejmuje `connect`, `verifyCredentials`, `capabilities`, `fetchCustomers`, `fetchOrders`, `fetchProducts`, `parseWebhook`, `buildIdempotencyKey`, **oraz** żaden typ w porcie nie pochodzi z biblioteki konkretnej platformy.

**Zakładając** kontrakt koszyka z AD-29, **kiedy** adapter go nie obsługuje, **wtedy** deklaruje to w `capabilities`, **oraz** interfejs nie pokazuje operatorowi funkcji opartych na koszyku dla tej platformy.

**Zakładając** wspólny zestaw testów akceptacyjnych platformy, **kiedy** uruchamiam go przeciwko adapterowi, **wtedy** wymusza on te same niezmienniki dla każdej platformy: kwoty w groszach, `occurred_at` ze źródła, klucz idempotencji w ustalonym kształcie.

**Notatki implementacyjne:** `src/domain/store/port.ts`, `src/domain/store/contract.ts` (Customer, Order, Product, Cart, StoreEvent), `tests/platform-suite.ts` jako funkcja przyjmująca adapter.

**Testy:** sam zestaw jest testem. Do tego test, że adapter deklarujący brak koszyka nie przechodzi testów koszykowych, bo są pomijane świadomie, a nie po cichu.

### Story 1.6: Podłączenie sklepu WooCommerce z walidacją uprawnień

Jako operator, chcę podłączyć sklep na podstawie kluczy od merchanta i od razu wiedzieć, czego te klucze nie obejmują, żeby nie odkryć tego dopiero przy pustym imporcie.

**Pokrywa:** FR8, FR9 | **Rządzą:** AD-8, AD-13, AD-2 | **Jakość:** NFR7, NFR31

**Kryteria akceptacji**

**Zakładając** poprawne klucze do sandboxa, **kiedy** operator podpina sklep, **wtedy** połączenie zostaje zapisane, **oraz** poświadczenia są w bazie zaszyfrowane i nie pojawiają się w żadnym logu ani w odpowiedzi API.

**Zakładając** klucze bez uprawnienia do zamówień, **kiedy** operator podpina sklep, **wtedy** proces kończy się komunikatem nazywającym brakujące uprawnienie, **oraz** sklep nie zostaje zapisany jako gotowy do importu.

**Zakładając** błędny adres sklepu, **kiedy** operator podpina sklep, **wtedy** dostaje komunikat rozróżniający brak odpowiedzi od odpowiedzi z błędem uwierzytelnienia.

**Notatki implementacyjne:** `src/adapters/store/woo/`. Uwierzytelnianie Basic po HTTPS. Sandbox lokalny udaje HTTPS dla ścieżek `/wp-json/`, adapter nie ma o tym wiedzieć.

**Testy:** przeciwko `sandbox/woo`. Test na klucze o zawężonych uprawnieniach (utwórz drugi klucz tylko do odczytu produktów i sprawdź komunikat).

### Story 1.7: Import historii z prawdziwymi datami i uczciwym licznikiem

Jako operator, chcę zaimportować historię sklepu z wybranego zakresu, żeby segmenty i raporty stały na prawdziwych danych.

**Pokrywa:** FR10, FR11 | **Rządzą:** AD-10, AD-24, AD-11 | **Jakość:** NFR1, NFR2, NFR3, NFR6

**Kryteria akceptacji**

**Zakładając** sandbox z 40 zamówieniami od lipca 2025, **kiedy** operator importuje pełny zakres, **wtedy** w bazie jest 40 zamówień, **oraz** najstarsze ma `occurred_at` równe dacie ze sklepu, a nie dacie importu.

**Zakładając** zakończony import, **kiedy** patrzę na raport przebiegu, **wtedy** licznik pokazuje liczbę faktycznie zapisanych rekordów odczytaną z bazy, **oraz** liczba prób jest raportowana osobno, jeśli się różni.

**Zakładając** import uruchomiony po raz drugi na tym samym zakresie, **kiedy** się kończy, **wtedy** nie powstaje ani jeden duplikat, **oraz** licznik nowych rekordów wynosi zero.

**Zakładając** import, który utworzy profile nieistniejące wcześniej, **kiedy** operator go uruchamia, **wtedy** przed startem widzi liczbę profili, które powstaną, **oraz** może się wycofać.

**Zakładając** zamówienie na kwotę 187,00 PLN, **kiedy** sprawdzam zapis, **wtedy** kwota jest zapisana jako 18700 w groszach z kodem waluty, **oraz** nigdzie nie występuje liczba zmiennoprzecinkowa.

**Notatki implementacyjne:** `src/usecases/import/import-store-history.ts`, wykonanie w kolejce. Odczyt zwrotny po zapisie partii i porównanie z oczekiwaniem w tym samym przebiegu (NFR1).

**Testy:** pełny import z sandboxa, ponowny import (idempotencja), test daty najstarszego zamówienia, test kwoty w groszach, test liczby profili zapowiedzianej przed startem.

### Story 1.8: Ingest webhooków w dwóch fazach

Jako system, chcę przyjmować zdarzenia sklepowe bez ryzyka ich utraty i bez podwójnego liczenia, żeby dane nie rozjeżdżały się po cichu.

**Pokrywa:** FR12, FR13 | **Rządzą:** AD-4, AD-24, AD-31 | **Jakość:** NFR14, NFR22, NFR28, NFR29

**Kryteria akceptacji**

**Zakładając** poprawnie podpisany webhook, **kiedy** wpada na endpoint, **wtedy** surowe zdarzenie zostaje zapisane i odpowiedź wraca poniżej 500 ms, **oraz** przetworzenie dzieje się w kolejce.

**Zakładając** zdarzenie o tym samym kluczu idempotencji przysłane dwa razy, **kiedy** oba zostaną przyjęte, **wtedy** powstaje jeden rekord domenowy, **oraz** drugie przyjęcie jest odnotowane jako duplikat, a nie jako błąd.

**Zakładając** to samo zamówienie, które wpada jednocześnie webhookiem i importem historycznym, **kiedy** obie ścieżki się zakończą, **wtedy** w bazie jest jedno zamówienie, **oraz** klucz idempotencji obu ścieżek jest identyczny, bo buduje go ta sama funkcja adaptera.

**Zakładając** webhook z niepoprawnym podpisem, **kiedy** wpada, **wtedy** zostaje odrzucony, **oraz** nie powstaje żaden rekord.

**Zakładając** błąd w przetwarzaniu zdarzenia, **kiedy** job pada, **wtedy** surowe zdarzenie nadal istnieje i da się je przetworzyć ponownie.

**Notatki implementacyjne:** endpoint w `src/app/api/webhooks/woo/route.ts`, przetwarzanie w `src/jobs/ingest`. Weryfikacja HMAC przed zapisem. Kolejność zdarzeń nie może być zakładana (NFR29).

**Testy:** test podwójnego zdarzenia, test wyścigu import kontra webhook (uruchom import i wstrzyknij webhook w trakcie), test złego podpisu, test ponownego przetworzenia po awarii.

### Story 1.9: Ekran zgodności danych

Jako operator, chcę widzieć różnicę między liczbą zamówień w sklepie a w bazie, żeby cicho padający webhook nie został odkryty dopiero przy raporcie dla klienta.

**Pokrywa:** FR14 | **Rządzą:** AD-4 | **Jakość:** NFR5

**Kryteria akceptacji**

**Zakładając** zgodne dane, **kiedy** operator otwiera ekran zgodności za wybrany okres, **wtedy** widzi obie liczby i różnicę równą zero.

**Zakładając** rozjazd powyżej 0,5% w dobie, **kiedy** wykonuje się dobowa kontrola, **wtedy** powstaje alert na kanale technicznym z nazwą tenanta, okresem i obiema liczbami, **oraz** alert nie jest wyłącznie wpisem w logu.

**Zakładając** niedostępny sklep, **kiedy** kontrola się wykonuje, **wtedy** wynik jest oznaczony jako nieustalony, **oraz** nie jest raportowany jako rozjazd.

**Notatki implementacyjne:** job dobowy w `src/jobs/monitor`, widok w panelu operatora. Kanał alertowy konfigurowany zmienną środowiskową.

**Testy:** test progu (0,4% nie alarmuje, 0,6% alarmuje), test niedostępnego sklepu, test treści alertu.

### Story 1.10: Panel operatora - szkielet i tożsamość wizualna

Jako operator, chcę panel, w którym widzę swoje sklepy i przełączam się między nimi, żeby praca na kilku klientach nie wymagała trzech okien.

**Pokrywa:** FR2, FR5 | **Rządzą:** AD-17, AD-21 | **Jakość:** NFR20, NFR32, NFR33

**Kryteria akceptacji**

**Zakładając** zalogowanego operatora, **kiedy** otwiera panel, **wtedy** widzi listę tenantów, do których ma dostęp, **oraz** przełączenie kontekstu zajmuje jedno kliknięcie i mniej niż 2 sekundy.

**Zakładając** widok listy sklepów, **kiedy** sklep ma niezweryfikowaną domenę albo rozjazd danych, **wtedy** stan jest pokazany etykietą tekstową, **oraz** kolor jest wyłącznie wzmocnieniem, nie jedynym nośnikiem informacji.

**Zakładając** widok klienta, **kiedy** otwieram go na szerokości telefonu, **wtedy** treść jest czytelna bez powiększania, **oraz** nie ma poziomego przewijania.

**Notatki implementacyjne:** `src/app/(operator)` i `src/app/(klient)`, tokeny brandu MidRev (ciemny panel operatora, jasny widok klienta). Mutacje wyłącznie przez server actions opakowujące use-case (AD-17).

**Testy:** test dostępu (operator nie widzi tenanta bez uprawnienia) plus zrzuty ekranu w dwóch szerokościach jako dowód do przeglądu przez człowieka.
