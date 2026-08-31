---
epic: 3
title: 'Domena wysyłkowa i silnik wysyłki'
covers: 'FR43-FR53'
decisions: 'AD-5, AD-6, AD-7, AD-13, AD-22, AD-23, AD-25, AD-26, AD-31'
inputDocuments:
  - '_bmad-output/prd-midrev-esp-2026-08-27.md'
  - '_bmad-output/planning-artifacts/architecture/architecture-midrev-esp-2026-08-27/ARCHITECTURE-SPINE.md'
  - '_bmad-output/planning-artifacts/epics.md'
  - '../../research/wlasny-esp/RESEARCH-DOSTAWCA-WYSYLKI-2026-08-27.md'
storyCount: 18
status: 'draft'
created: '2026-08-27'
---

## Epik 3: Domena wysyłkowa i silnik wysyłki

Cel: z systemu wychodzi prawdziwy mail z zweryfikowanej domeny klienta, pod kontrolą warmupu,
limitów i progów skarg, w sposób odporny na restart procesu i na wyścig z webhookiem dostawcy.

### Zasady wspólne dla wszystkich story w tym epiku

- **Migracje.** Każda story dokłada **nowy** plik migracji o kolejnym wolnym numerze. Pliku
  `0001_init.sql` ani `0002` (AD-30, warunek wejścia) nie wolno edytować (AD-12). Jeśli tabela
  z AD-30 (`message_events`, `tenant_suppressions`) już istnieje, story dokłada brakujące kolumny
  i ograniczenia osobnym plikiem, a kryteria akceptacji sprawdzają stan bazy, nie numer pliku.
- **Testy.** Wyłącznie integracyjne na sandboxowym Postgresie (AD-20, NFR35), bez mocków warstwy
  bazy. Dostawcę wysyłki zastępuje atrapa implementująca port `EmailProvider` (story 3.2), nigdy
  prawdziwe SES. Każdy moduł dotykający danych tenanta ma test cross-tenantowy (AD-2, NFR9).
- **Zakaz SQL poza repozytorium.** Zapytania żyją w `src/adapters/db`, mutacje wyłącznie przez
  use-case (AD-3, AD-18). Warstwa web to cienkie server actions z walidacją zodem (AD-17).
- **Sekrety.** Poświadczenia dostawcy nigdy nie trafiają do logu, odpowiedzi API ani do treści
  alertu (AD-13, NFR7).
- **Kontekst SES z researchu.** Konto startuje w piaskownicy: 200 maili na dobę i 1 mail na
  sekundę, wyjście przez wniosek o production access. Izolacja per tenant zmniejsza promień
  rażenia, ale nie chroni konta, więc **nasze progi wstrzymania muszą być ostrzejsze niż progi
  dostawcy** (story 3.8 i 3.14).

### Kolejność

3.1 do 3.3 to fundament (kolejka, port, model wiadomości). 3.4 do 3.6 to domena. 3.7 i 3.8 to
limity. 3.9 i 3.10 to bramka i worker. 3.11 do 3.15 to zgodność i ochrona reputacji. 3.16 to
prawdziwy adapter. 3.17 i 3.18 to scenariusze awaryjne, które muszą mieć test. Żadna story nie
zależy od story o wyższym numerze w tym epiku.

---

### Story 3.1: Kolejka utwardzona pod wolumen i runtime workera

Jako operator MidRev, chcę kolejki, która przy milionie wiadomości miesięcznie nie zapycha bazy
i nie gubi zadań, żeby wysyłka nie stała się pierwszą awarią produkcyjną.

**Pokrywa:** infrastruktura pod FR43-FR53 | **Rządzą:** AD-5, AD-31, AD-3 | **Jakość:** NFR26, NFR27, NFR30, NFR38

**Kryteria akceptacji**

1. **Zakładając** tabelę `jobs` partycjonowaną po dniu, **kiedy** dwa workery jednocześnie
   pobierają zadania, **wtedy** żadne zadanie nie zostaje wydane obu naraz, **oraz** żaden worker
   nie czeka na drugiego (efekt `FOR UPDATE SKIP LOCKED`).
2. **Zakładając** worker pobierający partię zadań, **kiedy** trwa transakcja zajmująca zadania,
   **wtedy** wewnątrz tej transakcji nie wykonuje się żadne wywołanie sieciowe, **oraz** każde
   zadanie z partii przetwarzane jest w osobnej transakcji (AD-31).
3. **Zakładając** zadanie, którego handler rzuca błąd, **kiedy** worker je przetwarza, **wtedy**
   zadanie wraca do kolejki z `run_after` przesuniętym rosnąco (backoff wykładniczy z jitterem),
   **oraz** licznik `attempts` rośnie o jeden (NFR30).
4. **Zakładając** zadanie, które wyczerpało `max_attempts`, **kiedy** nastąpi ostatnia nieudana
   próba, **wtedy** zadanie trafia do `jobs_dead` z ostatnim błędem i liczbą prób, **oraz** na
   kanał alertowy idzie zdarzenie z opisem, co z tym zrobić (NFR30, NFR38), **oraz** nie zostaje
   ponowione samo z siebie.
5. **Zakładając** workera zabitego w trakcie przetwarzania zadania, **kiedy** minie czas dzierżawy
   (`lease`), **wtedy** zadanie staje się ponownie dostępne dla innego workera, **oraz** nie
   zostaje na stałe w stanie zajętym.
6. **Zakładając** partycje starsze niż okres retencji, **kiedy** zadanie utrzymaniowe robi
   sprzątanie, **wtedy** usuwa je przez `DROP PARTITION`, **oraz** nie wykonuje żadnego `DELETE`
   na `jobs`, **oraz** partycja na dzień następny istnieje przed północą UTC.
7. **Zakładając** zadanie zapisane dla tenanta A, **kiedy** worker działa w kontekście tenanta B,
   **wtedy** zadanie tenanta A nie jest widoczne w wyniku pobrania dla B (AD-2).

**Notatki implementacyjne**

- Migracja: `jobs` z `partition by range (run_after)`, klucz główny `(run_after, id)`, bo klucz
  główny tabeli partycjonowanej musi zawierać kolumnę partycjonującą. To jest najczęstsza
  pułapka tego zadania. `id` z `uuidv7()` (AD-15), nie `gen_random_uuid()`.
- Kolumny: `tenant_id`, `kind`, `payload jsonb`, `run_after timestamptz not null`, `attempts int`,
  `max_attempts int`, `lease_until timestamptz`, `locked_by text`, `last_error text`,
  `created_at`. Indeks pod pobieranie: `(run_after, id) where lease_until is null or lease_until < now()`.
- `alter table jobs set (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_cost_delay = 0)`
  i to samo dla `raw_events` (AD-31).
- Pliki: `src/domain/queue/job.ts` (typy, `JobKind`), `src/adapters/db/jobs-repo.ts`,
  `src/jobs/worker.ts` (pętla: claim partii, przetwarzanie po jednym), `src/jobs/registry.ts`
  (mapa `kind` na handler), `src/jobs/maintenance/partitions.ts`, `src/adapters/alerts/channel.ts`.
- Ewidencja prób należy do wiersza zadania, nie do `message_events`, bo tam obowiązuje unikalność
  `(message_id, event_type)` i druga próba nie miałaby gdzie się zapisać (AD-22).
- Log strukturalny z `tenant_id`, `job_id`, `correlation_id`, bez sekretów i bez adresów e-mail.

**Testy**

`tests/queue.test.ts` na sandboxie: dwa równoległe połączenia pobierające tę samą partię;
handler rzucający błąd trzy razy i lądujący w `jobs_dead` z zarejestrowanym alertem (kanał
alertowy jako atrapa zliczająca wywołania); rosnący odstęp między próbami; wygaśnięcie dzierżawy
po zabiciu workera (symulowane ustawieniem `lease_until` w przeszłości); `DROP PARTITION` usuwa
wczorajsze wiersze i nie rusza dzisiejszych; test cross-tenantowy na pobieraniu.

---

### Story 3.2: Port EmailProvider, poświadczenia per tenant i atrapa dostawcy

Jako inżynier, chcę jednego interfejsu dostawcy wysyłki z atrapą i zestawem testów kontraktowych,
żeby wymiana dostawcy była konfiguracją, a nie przepisaniem silnika.

**Pokrywa:** podstawa FR43-FR53 | **Rządzą:** AD-7, AD-13, AD-1 | **Jakość:** NFR7, NFR8, NFR9, NFR35

**Kryteria akceptacji**

1. **Zakładając** interfejs `EmailProvider` w `src/domain`, **kiedy** przegląda się importy,
   **wtedy** `domain` nie importuje niczego z `adapters` ani z `app`, **oraz** nazwa żadnego
   dostawcy nie pada nigdzie poza katalogiem `src/adapters/email` i modułem konfiguracji (AD-7).
2. **Zakładając** atrapę dostawcy, **kiedy** uruchamia się zestaw testów kontraktowych portu,
   **wtedy** atrapa przechodzi wszystkie przypadki, **oraz** ten sam zestaw da się uruchomić
   przeciw dowolnemu innemu adapterowi bez zmian w teście.
3. **Zakładając** poświadczenia dostawcy zapisane dla tenanta, **kiedy** obiekt poświadczeń trafia
   do `console.log`, `JSON.stringify` albo do treści alertu, **wtedy** w wyniku widnieje
   `[redacted]`, **oraz** wartość jawna nie pojawia się nigdzie poza momentem podpisania żądania
   (AD-13, NFR7).
4. **Zakładając** poświadczenia tenanta A, **kiedy** kod pyta o poświadczenia w kontekście tenanta
   B, **wtedy** dostaje odmowę, **oraz** nie dostaje danych tenanta A (AD-2, NFR9).
5. **Zakładając** adapter deklarujący `capabilities`, **kiedy** zdolność nie jest wspierana
   (na przykład `perTenantSuppression: false`), **wtedy** kod wołający dostaje jawną odmowę z kodem
   błędu, **oraz** nie dostaje cichej atrapy zachowania.
6. **Zakładając** wywołanie `send` bez `idempotencyKey`, **kiedy** kompiluje się projekt, **wtedy**
   typ nie przechodzi kompilacji, bo pole jest obowiązkowe (AD-23).

**Notatki implementacyjne**

- `src/domain/email/provider.ts`: `send(cmd: SendCommand)`, `verifyDomain(domain)`,
  `listDomainRecords(domain)`, `parseWebhook(raw, ctx)`, `quotaStatus()`,
  `lookupByIdempotencyKey(key)` oraz `capabilities`.
- `SendCommand`: `idempotencyKey` (równy identyfikatorowi wiadomości), `tenantId`, `tenantTag`,
  `from`, `replyTo`, `to`, `subject`, `html`, `text`, `headers`, `sendingDomainId`.
- Wynik zgodny z konwencją: `{ ok: true, data: { providerMessageId } }` albo
  `{ ok: false, error: { code, message, retryable } }`. Rozdzielenie `retryable` od terminalnego
  jest kluczowe dla story 3.10 i 3.17, więc musi być w typie, nie w komentarzu.
- `capabilities`: `tenantIsolation`, `perTenantSuppression`, `oneClickUnsubscribeHeader`,
  `idempotentSend`, `dedicatedIp`, `sandbox`.
- Sekrety: typ `Secret<T>` z nadpisanym `toJSON` i `Symbol.for('nodejs.util.inspect.custom')`,
  szyfrowanie symetryczne kluczem z modułu konfiguracji. Tabela `tenant_provider_credentials`
  (`tenant_id`, `provider`, `ciphertext`, `created_at`), odczyt wyłącznie przez repozytorium
  przyjmujące `tenantId` pierwszym argumentem.
- Atrapa `src/adapters/email/fake/`: deterministyczna, z wstrzykiwaniem awarii (throttle, błąd
  terminalny, timeout po akceptacji), deduplikacja po `idempotencyKey` i licznik wywołań per klucz.
  Ta deduplikacja jest później podstawą testów w 3.10, 3.17 i 3.18.
- Zestaw kontraktowy jako eksportowana funkcja `runEmailProviderContract(makeProvider)` w
  `tests/contracts/email-provider.contract.ts`.

**Testy**

`tests/email-provider-fake.test.ts`: zestaw kontraktowy przeciw atrapie; test redakcji sekretu
(przechwycony log nie zawiera wartości); test cross-tenantowy na repozytorium poświadczeń
(prawdziwa baza, nie mock); test odmowy przy nieobsługiwanej zdolności.

---

### Story 3.3: Wiadomość jako niemutowalna jednostka wysyłki ze strumieniem stanu

Jako operator, chcę żeby każda wiadomość powstawała w bazie przed wywołaniem dostawcy i miała
stan w strumieniu zdarzeń, żeby restart procesu ani webhook nie mogły podwoić ani zgubić wysyłki.

**Pokrywa:** podstawa FR48-FR51 | **Rządzą:** AD-6, AD-22, AD-26, AD-16, AD-10 | **Jakość:** NFR2, NFR15, NFR18, NFR29

**Kryteria akceptacji**

1. **Zakładając** tenanta, źródło (`campaign`, `journey` albo `test`) i profil, **kiedy** próbuje
   się utworzyć drugą wiadomość dla tej samej trójki, **wtedy** baza odrzuca zapis ograniczeniem
   `unique (tenant_id, source_type, source_id, profile_id)` (AD-26), **oraz** dotyczy to tak samo
   automatyzacji, gdzie `campaign_id` byłby `NULL`.
2. **Zakładając** wiadomość w stanie `queued`, **kiedy** zapisuje się zdarzenie `sending` dwa razy,
   **wtedy** w `message_events` istnieje jeden wiersz dzięki `unique (message_id, event_type)`,
   **oraz** druga próba nie jest błędem zabijającym zadanie, tylko rozpoznanym powtórzeniem.
3. **Zakładając** wiadomość ze stanem `bounced`, **kiedy** przychodzi spóźnione zdarzenie
   `delivered`, **wtedy** projekcja `current_state` nie cofa się (warunek `state_rank < nowy_rank`),
   **oraz** oba zdarzenia są obecne w strumieniu (NFR29).
4. **Zakładając** wiersz w `message_events`, **kiedy** wykona się na nim `UPDATE` albo `DELETE`,
   **wtedy** operacja kończy się błędem z bazy (AD-16), **oraz** to samo dotyczy `DELETE` na
   `messages`.
5. **Zakładając** zapis zdarzenia bez `occurred_at`, **kiedy** wykonuje się `INSERT`, **wtedy**
   baza go odrzuca, bo kolumna jest `not null` i **nie ma wartości domyślnej** (AD-10, NFR3).
6. **Zakładając** 100 kandydatów, z których 30 ma już wiadomość dla tego źródła, **kiedy** use-case
   tworzy wiadomości, **wtedy** log i wynik pokazują 70 utworzonych, czyli faktyczny wynik operacji,
   nie liczbę prób (NFR2).
7. **Zakładając** wiadomość tenanta A, **kiedy** repozytorium czyta w kontekście tenanta B,
   **wtedy** wiadomość nie jest widoczna (AD-2).

**Notatki implementacyjne**

- `messages`: `id uuid pk default uuidv7()`, `tenant_id`, `source_type`, `source_id`, `profile_id`,
  `sending_domain_id`, `to_email_normalized`, `current_state text`, `state_rank int`,
  `provider_message_id text`, `created_at`. Kolumna `click_token` (AD-33) należy do Epiku 5,
  tutaj jej nie dodawaj.
- `message_events`: `id`, `message_id`, `tenant_id`, `event_type`, `occurred_at timestamptz not null`
  (bez `default`), `recorded_at timestamptz not null default now()`, `payload jsonb`,
  `unique (message_id, event_type)`. FK złożony `(tenant_id, message_id)` na wzór `events` z 0001,
  żeby zdarzenie tenanta A nie mogło wisieć na wiadomości tenanta B.
- Drabina rang: `queued` 10, `refused` 15, `sending` 20, `failed` 25, `sent` 30, `delivered` 40,
  rangi 50 i 60 zarezerwowane dla `opened` i `clicked` z Epiku 5, `bounced` 70, `complained` 80,
  `unsubscribed` 90.
- Dwa stany terminalne po naszej stronie (`refused`, `failed`) aktualizują projekcję z dodatkowym
  warunkiem na stan poprzedni (`and current_state = 'queued'` oraz `and current_state = 'sending'`),
  bo sama monotoniczność by ich nie ochroniła. Stany od dostawcy idą wyłącznie po randze.
- **Reguła do zapisania w kodzie:** logika biznesowa (wykluczenia, raporty, progi skarg) czyta
  `message_events`, a `current_state` służy do prezentacji i do sprawdzenia przez workera, czy
  już coś zrobił. Inaczej `unsubscribed` z rangą 90 przykryłby `complained` w raporcie.
- Append-only wymuszone triggerem `raise exception` na `UPDATE`/`DELETE` w `message_events`
  i na `DELETE` w `messages`; na `messages` dozwolony `UPDATE` wyłącznie kolumn
  `current_state`, `state_rank`, `provider_message_id` (sprawdzenie w triggerze).
- Pliki: `src/domain/message/message.ts` (stany i rangi w jednym miejscu),
  `src/adapters/db/messages-repo.ts`, `src/usecases/send/enqueue-messages.ts`.

**Testy**

`tests/messages.test.ts`: podwójny insert dla tej samej trójki (osobno dla `campaign` i dla
`journey`); podwójny zapis tego samego typu zdarzenia; `delivered` po `bounced`; `UPDATE` na
`message_events` kończący się wyjątkiem z bazy; `INSERT` bez `occurred_at`; licznik 70 z 100;
test cross-tenantowy.

---

### Story 3.4: Domena wysyłkowa: dodanie i komplet rekordów DNS z instrukcją dla rejestratorów

Jako operator, chcę dodać domenę wysyłkową klienta i dostać komplet rekordów DNS z instrukcją pod
jego rejestratora, żeby klient ustawił je sam, bez telefonu do mnie.

**Pokrywa:** FR43 | **Rządzą:** AD-7, AD-2, AD-13 | **Jakość:** NFR9, NFR20, NFR32, NFR33

**Kryteria akceptacji**

1. **Zakładając** tenanta z podpiętym dostawcą, **kiedy** operator dodaje domenę wysyłkową
   `mail.sklep.pl`, **wtedy** system zwraca komplet rekordów: SPF (TXT), DKIM (wg zdolności
   adaptera), DMARC (TXT na `_dmarc`), rekordy domeny zwrotnej MAIL FROM oraz **CNAME domeny
   trackingowej tenanta**, **oraz** każdy rekord ma typ, nazwę pełną, nazwę względną, wartość, TTL
   i jedno zdanie o tym, po co jest.
2. **Zakładając** wygenerowane rekordy, **kiedy** operator wybiera instrukcję, **wtedy** dostaje
   osobny opis dla **OVH, home.pl i Cloudflare**, **oraz** każdy opis zawiera pułapkę właściwą
   temu panelowi (OVH i home.pl doklejają domenę do nazwy rekordu, więc wpisuje się nazwę
   względną; w Cloudflare CNAME trackingu i CNAME DKIM muszą mieć wyłączony proxy, czyli szarą
   chmurkę, inaczej kliknięcia i podpis przestają działać).
3. **Zakładając** dodaną domenę, **kiedy** operator chce ją przekazać klientowi, **wtedy** może
   skopiować albo pobrać komplet rekordów jako tekst, **oraz** tekst nie zawiera żadnego sekretu.
4. **Zakładając** domenę już dodaną w tenancie, **kiedy** ktoś dodaje ją drugi raz, **wtedy** zapis
   jest odrzucony z czytelnym komunikatem, **oraz** ta sama domena w innym tenancie jest dozwolona.
5. **Zakładając** domenę dodaną w tenancie A, **kiedy** operator pracuje w kontekście tenanta B,
   **wtedy** domena nie jest widoczna ani na liście, ani po identyfikatorze (AD-2, NFR9).
6. **Zakładając** adaptera deklarującego DKIM jako trzy CNAME-y, **kiedy** zmieni się adapter na
   taki, który zwraca jeden rekord TXT, **wtedy** zestaw rekordów zmienia się bez zmiany kodu poza
   adapterem (AD-7).
7. **Zakładając** status domeny na ekranie, **kiedy** ogląda go osoba nierozróżniająca kolorów,
   **wtedy** status jest podany słowem, nie tylko kolorem (NFR33).

**Notatki implementacyjne**

- Tabela `sending_domains`: `id`, `tenant_id`, `domain`, `tracking_host`, `provider`,
  `dkim_selector`, `mail_from_host`, `expected_records jsonb`, `status`, `created_at`,
  `verified_at`, `unique (tenant_id, lower(domain))`.
- SPF ograniczony do subdomeny wysyłkowej, nie do domeny głównej klienta, żeby nie ruszać jego
  poczty firmowej ani strumienia, który nadal idzie przez Klaviyo (ścieżka z PRD: „domena już
  wysyła przez Klaviyo i ustawienie nowego DKIM-a zepsuje tamten strumień"). To ma być napisane
  wprost w instrukcji.
- DMARC startowo `p=none` z adresem `rua`, z notatką, że zaostrzenie polityki następuje po
  zakończeniu warmupu. Zaostrzanie w trakcie warmupu to gotowy sposób na utratę wysyłki.
- Domena trackingowa per tenant jest wymogiem z PRD (Technical Constraints), nie opcją, więc jest
  w komplecie rekordów od pierwszego ekranu.
- Pliki: `src/domain/sending-domain/`, `src/usecases/domains/add-sending-domain.ts`,
  `src/adapters/db/sending-domains-repo.ts`, `src/app/(operator)/domeny/`,
  `src/domain/sending-domain/registrar-guides.ts` (treści instrukcji jako dane, nie JSX).

**Testy**

`tests/sending-domains.test.ts`: dodanie domeny daje komplet pięciu rodzajów rekordów; nazwa
względna nie zawiera apeksu; podwójne dodanie w tenancie odrzucone, w innym tenancie przyjęte;
test cross-tenantowy na odczycie po identyfikatorze; zmiana atrapy adaptera na wariant z DKIM TXT
zmienia zestaw rekordów; test treści instrukcji sprawdzający obecność trzech rejestratorów
i ostrzeżenia o szarej chmurce w Cloudflare.

---

### Story 3.5: Weryfikacja domeny: SPF, DKIM, DMARC i CNAME trackingu ze statusem per rekord

Jako operator, chcę widzieć, który konkretnie rekord DNS jest ustawiony, a który nie, żeby nie
zgadywać, dlaczego domena nie jest zielona.

**Pokrywa:** FR44 | **Rządzą:** AD-7, AD-1, AD-5 | **Jakość:** NFR20, NFR33, NFR38

**Kryteria akceptacji**

1. **Zakładając** domenę z kompletem poprawnie ustawionych rekordów, **kiedy** uruchamia się
   weryfikacja, **wtedy** status domeny to `verified`, **oraz** każdy rekord ma status `ok`.
2. **Zakładając** domenę bez rekordu DKIM, **kiedy** uruchamia się weryfikacja, **wtedy** status
   domeny to `partial`, **oraz** powód nazywa brakujący rekord po nazwie i typie, **oraz** status
   nie jest `verified`.
3. **Zakładając** rekord z literówką w wartości, **kiedy** uruchamia się weryfikacja, **wtedy**
   status rekordu to `mismatch`, **oraz** ekran pokazuje wartość znalezioną obok wartości
   oczekiwanej, żeby dało się zobaczyć różnicę.
4. **Zakładając** poprawne rekordy DNS, ale dostawcę zgłaszającego identyfikator jako
   niezweryfikowany, **kiedy** kończy się weryfikacja, **wtedy** domena **nie** jest `verified`,
   **oraz** powód mówi, że czeka na potwierdzenie po stronie dostawcy (AD-7).
5. **Zakładając** domenę w statusie `verified`, **kiedy** cykliczna kontrola nie znajduje już
   rekordu DMARC, **wtedy** status spada na `failed` z powodem, **oraz** idzie alert na kanał
   techniczny z opisem reakcji (NFR38), **oraz** wysyłka z tej domeny jest od tego momentu
   blokowana (bramka ze story 3.6).
6. **Zakładając** domenę czekającą na weryfikację, **kiedy** zadanie sprawdzające jest już
   zaplanowane, **wtedy** ponowne żądanie sprawdzenia nie tworzy drugiego zadania w kolejce,
   **oraz** ręczne „sprawdź teraz" działa natychmiast i nie czeka na harmonogram.
7. **Zakładając** operatora patrzącego na listę domen, **kiedy** ładuje się ekran, **wtedy**
   odpowiedź przychodzi poniżej 2 sekund, bo czyta zapisany wynik weryfikacji, a nie odpytuje DNS
   w trakcie renderowania (NFR20).

**Notatki implementacyjne**

- Port `DnsResolver` w `src/domain/dns/` (`resolveTxt`, `resolveCname`, `resolveMx`), adapter na
  `node:dns/promises` w `src/adapters/dns/`. Atrapa resolvera w testach jest legalna, bo to
  zewnętrzny system, a nie baza.
- Normalizacja przy porównaniu: TXT bywa dzielony na fragmenty i trzeba je skleić przed
  porównaniem; wartości porównuj po zdjęciu cudzysłowów i spacji nadmiarowych; CNAME porównuj bez
  końcowej kropki i bez rozróżniania wielkości liter. To są trzy najczęstsze fałszywe negatywy.
- Harmonogram ponowień: co 10 minut przez pierwszą godzinę, potem co godzinę przez dobę, potem raz
  dziennie; po 7 dniach bez sukcesu alert do człowieka. Domena `verified` sprawdzana raz na dobę,
  żeby wykryć regres (ktoś przebudował DNS).
- Status w bazie w `sending_domains.status` plus `expected_records` wzbogacone o `observed_value`
  i `record_status`, żeby ekran nie musiał liczyć niczego w locie.
- Pliki: `src/jobs/verify-sending-domain.ts`, `src/usecases/domains/verify-sending-domain.ts`.

**Testy**

`tests/sending-domain-verify.test.ts` z atrapą resolvera i atrapą dostawcy: komplet rekordów daje
`verified`; brak DKIM daje `partial` z nazwą rekordu w powodzie; literówka daje `mismatch`
z wartością znalezioną; DNS ok plus dostawca `pending` nie daje `verified`; zniknięcie DMARC na
domenie `verified` daje `failed` i jeden alert; drugie żądanie sprawdzenia nie mnoży zadań;
test cross-tenantowy.

---

### Story 3.6: Twarda blokada wysyłki z niezweryfikowanej domeny z podaniem powodu

Jako operator, chcę żeby system nie pozwolił wysłać z domeny, która nie przeszła weryfikacji,
i powiedział mi dlaczego, żeby nie spalić domeny klienta pierwszą kampanią.

**Pokrywa:** FR45 | **Rządzą:** AD-25, AD-3, AD-9 | **Jakość:** NFR33, NFR38

**Kryteria akceptacji**

1. **Zakładając** domenę w statusie innym niż `verified`, **kiedy** operator uruchamia wysyłkę
   kampanii z tej domeny, **wtedy** operacja kończy się odmową z kodem `domain_not_verified`,
   **oraz** komunikat wymienia brakujące albo błędne rekordy, **oraz** nie powstaje ani jedna
   wiadomość.
2. **Zakładając** kampanię, która wystartowała z domeny `verified`, **kiedy** w trakcie wysyłki
   domena spada na `failed`, **wtedy** kolejne wiadomości dostają stan `refused` z powodem,
   **oraz** wiadomości już wysłane pozostają nietknięte, **oraz** operator dostaje alert (NFR38).
3. **Zakładając** wysyłkę testową, **kiedy** domena nie jest zweryfikowana, **wtedy** test też jest
   zablokowany tym samym kodem, bo bramka jest jedna dla wszystkich ścieżek (AD-9).
4. **Zakładając** zablokowany przycisk wysyłki w panelu, **kiedy** operator na niego patrzy,
   **wtedy** widzi powód blokady tekstem obok przycisku, **oraz** przycisk nie jest po prostu
   wyszarzony bez wyjaśnienia (wprost z PRD, ścieżka użytkownika).
5. **Zakładając** domenę tenanta A w statusie `verified`, **kiedy** tenant B próbuje jej użyć jako
   domeny nadawcy, **wtedy** operacja kończy się odmową (AD-2).

**Notatki implementacyjne**

- `src/usecases/send/assert-domain-sendable.ts` zwracające
  `{ ok: false, error: { code: 'domain_not_verified', message, missingRecords } }`.
- Wołane w trzech miejscach: server action startu kampanii, wysyłka testowa, oraz bramka
  `canSendTo` ze story 3.9 (tam jako jeden z warunków). Nie duplikuj logiki, wystaw jedną funkcję.
- Sprawdzenie na starcie kampanii nie zwalnia ze sprawdzenia per wiadomość, bo między akceptacją
  klienta a wysyłką mijają dni (AD-25).

**Testy**

`tests/domain-gate.test.ts`: odmowa z listą braków przy `partial`; brak jakiejkolwiek wiadomości
w bazie po odmowie; degradacja domeny w trakcie wysyłki (zmiana statusu między partiami) kończy
resztę kolejki stanem `refused` i nie rusza wysłanych; wysyłka testowa blokowana tym samym kodem;
test cross-tenantowy na domenie nadawcy.

---

### Story 3.7: Plan warmupu domeny z rosnącym limitem dobowym

Jako operator, chcę żeby nowa domena miała wymuszony plan warmupu z rosnącym limitem dobowym,
żeby nikt (łącznie ze mną) nie mógł wysłać pełnej listy pierwszego dnia.

**Pokrywa:** FR46 | **Rządzą:** AD-25, AD-5, AD-10 | **Jakość:** NFR23, NFR38

**Kryteria akceptacji**

1. **Zakładając** nowo dodaną domenę wysyłkową, **kiedy** przechodzi ona w status `verified`,
   **wtedy** system tworzy jej plan warmupu z krokiem pierwszym, **oraz** domena bez planu nie może
   wysłać ani jednej wiadomości (bramka zamknięta domyślnie).
2. **Zakładając** krok warmupu z limitem dobowym 1000, **kiedy** w danej dobie UTC z tej domeny
   wysłano już 1000 wiadomości, **wtedy** kolejne dostają odmowę z kodem `warmup_daily_cap`,
   **oraz** komunikat podaje limit, zużycie i porę zresetowania, **oraz** wiadomości nie są
   kasowane, tylko przesunięte na kolejną dobę.
3. **Zakładając** krok o zasięgu odbiorców `engaged_30d`, **kiedy** kandydatem jest profil bez
   zdarzenia zaangażowania w ostatnich 30 dniach, **wtedy** dostaje odmowę z kodem
   `warmup_audience_scope`, **oraz** odmowa jest zapisana z powodem, nie przemilczana.
4. **Zakładając** zakończony krok, w którym wskaźnik skarg był poniżej 0,1 procent, a odbić poniżej
   5 procent, **kiedy** dobowe zadanie ocenia plan, **wtedy** plan przechodzi na krok następny
   z wyższym limitem, **oraz** przejście jest zapisane z datą i z liczbami, na których podstawie
   zapadło.
5. **Zakładając** krok, w którym przekroczono próg skarg albo odbić, **kiedy** zadanie ocenia plan,
   **wtedy** plan cofa się o jeden krok (nie czeka na poprawę na tym samym kroku), **oraz** idzie
   alert do człowieka z opisem reakcji (NFR38).
6. **Zakładając** administratora, **kiedy** świadomie podnosi limit ponad plan, **wtedy** zmiana
   jest możliwa, **oraz** zapisuje się kto, kiedy, jaka wartość i z jakim uzasadnieniem, **oraz**
   operator bez roli administratora tego nie może.
7. **Zakładając** kampanię do 10 tysięcy odbiorców, **kiedy** plan warmupu przewiduje limit niższy,
   **wtedy** okno wysyłki z NFR23 nie obowiązuje, a system jawnie pokazuje, że to warmup ogranicza
   tempo, nie awaria.

**Notatki implementacyjne**

- `warmup_plans` (`id`, `tenant_id`, `sending_domain_id`, `started_on`, `current_step`, `status`,
  `override_daily_cap`, `override_actor`, `override_reason`, `override_at`) oraz `warmup_steps`
  (`plan_id`, `step_no`, `daily_cap`, `audience_scope`, `max_complaint_rate`, `max_bounce_rate`,
  `min_hours_in_step`).
- Plan domyślny prosto z researchu: krok 1 rzędu tysiąca dziennie i wyłącznie najbardziej
  zaangażowani (30 dni), podwajanie co 2 do 3 dni przy spełnionych progach, pełna lista dopiero
  po około czterech tygodniach. Progi twarde: skargi poniżej 0,1 procent, odbicia poniżej 5 procent.
- Doba liczona w UTC (AD-10), bo inaczej zmiana czasu w Polsce raz w roku podnosi albo obniża limit
  o godzinę wysyłki.
- Zużycie liczone ze zdarzeń `sent` w `message_events` dla wiadomości z tej domeny, nie z licznika
  trzymanego osobno, bo licznik i zdarzenia rozjadą się przy pierwszym restarcie.
- Zaangażowanie liczone z `events` (istnieje od migracji 0001): kliknięcie, otwarcie albo
  zamówienie w oknie kroku. Gdy tenant nie ma **żadnych** zdarzeń zaangażowania (świeży import),
  bramka odmawia z powodem zamiast po cichu przepuścić całą listę. To jest celowe: świeżo
  zaimportowana lista bez historii to dokładnie ten przypadek, który pali domenę.
- Funkcja `warmupAllowance(domainId, dayUtc)` w `src/domain/warmup/`, wołana przez bramkę 3.9.

**Testy**

`tests/warmup.test.ts`: automatyczne utworzenie planu po weryfikacji domeny; domena bez planu nie
wysyła; przekroczenie limitu dobowego odmawia z liczbami i przesuwa na kolejną dobę; granica doby
UTC zeruje zużycie; profil spoza zasięgu zaangażowania odmówiony z osobnym kodem; awans kroku przy
dobrych wskaźnikach; cofnięcie kroku plus jeden alert przy przekroczeniu progu; nadpisanie limitu
tylko przez administratora i z zapisanym śladem; test cross-tenantowy.

---

### Story 3.8: Limit wolumenu tenanta w oknie czasowym i respektowanie kwoty dostawcy

Jako operator, chcę twardego limitu wolumenu per tenant i tempa zgodnego z kwotą dostawcy, żeby
jeden klient nie zjadł kwoty pozostałym i żeby SES nie zaczął odrzucać naszych wywołań.

**Pokrywa:** FR52 | **Rządzą:** AD-25, AD-7, AD-31 | **Jakość:** NFR23, NFR25, NFR31

**Kryteria akceptacji**

1. **Zakładając** tenanta z limitem 5000 wiadomości w oknie kroczącym 24 godzin, **kiedy** limit
   został wyczerpany, **wtedy** kolejne wiadomości dostają odmowę z kodem `tenant_rate_limit`,
   **oraz** komunikat podaje limit, zużycie i moment zwolnienia najstarszego zapisu.
2. **Zakładając** przekroczony limit, **kiedy** worker obsługuje zadania, **wtedy** żadna wiadomość
   nie ginie, tylko zadanie wraca do kolejki z późniejszym `run_after` (NFR31), **oraz** raport
   z przebiegu podaje liczbę przesuniętych, nie liczbę prób (NFR2).
3. **Zakładając** dostawcę deklarującego `maxSendRate` równy 1 na sekundę, **kiedy** wysyłamy 50
   wiadomości, **wtedy** w żadnym oknie jednej sekundy nie wychodzi więcej niż 1 wywołanie,
   **oraz** wszystkie 50 zostaje ostatecznie wysłanych, **oraz** żadna nie zostaje wysłana dwa razy.
4. **Zakładając** konto dostawcy w piaskownicy (`quotaStatus().sandbox === true`), **wtedy** system
   przyjmuje twardy pułap 200 wiadomości na dobę i 1 na sekundę niezależnie od ustawień tenanta,
   **oraz** w panelu widnieje jawna informacja, że konto dostawcy jest w piaskownicy i co trzeba
   zrobić, żeby z niej wyjść.
5. **Zakładając** kwotę dobową dostawcy w oknie kroczącym 24 godzin, **kiedy** zużycie zbliża się do
   kwoty, **wtedy** system rezerwuje zapas (domyślnie 10 procent kwoty) i zatrzymuje wysyłkę przed
   pułapem dostawcy, **oraz** nie dopuszcza do sytuacji, w której to dostawca odrzuca wywołanie,
   bo dostawca odrzuca, a nie kolejkuje.
6. **Zakładając** dwóch tenantów na jednym koncie dostawcy, **kiedy** jeden wyczerpał swój limit,
   **wtedy** drugi wysyła dalej bez przeszkód (AD-2).
7. **Zakładając** odczyt `quotaStatus`, **kiedy** wywołuje go wiele zadań naraz, **wtedy** wynik
   jest buforowany na krótkie okno (rzędu minuty), **oraz** odpytywanie kwoty nie odbywa się
   wewnątrz transakcji zajmującej zadanie (AD-31).

**Notatki implementacyjne**

- `tenant_send_limits`: `tenant_id`, `window` (`rolling_24h`, `hour`), `max_messages`,
  `max_rate_per_second`, `updated_by`, `updated_at`. Domyślne wartości ustawiane przy zakładaniu
  tenanta, fail closed: brak wiersza oznacza limit zerowy, nie nieskończony.
- Zużycie w oknie kroczącym liczone ze zdarzeń `sent` w `message_events`; potrzebny indeks
  `(tenant_id, event_type, occurred_at desc)`, inaczej to zapytanie wykona się przy każdej
  wiadomości i zabije wydajność przy 3 milionach miesięcznie.
- Tempo: kubełek żetonów w procesie workera plus zapis w bazie na potrzeby wielu workerów. Przy
  jednym workerze w fazie 1 wystarcza kubełek w pamięci, ale interfejs ma zakładać wiele procesów,
  bo NFR26 mówi o dziesięciu tenantach.
- Piaskownica SES to nie tryb testowy, tylko domyślny stan nowego konta. Widoczny komunikat w
  panelu jest częścią story, bo z researchu wynika, że to jest termin do załatwienia z datą,
  a nie krok konfiguracyjny.
- Wiadomość odrzucona przez throttling dostawcy zostaje w stanie `sending`, a ponowienie liczone
  jest na wierszu zadania. Nie próbuj cofać stanu do `queued`, bo projekcja jest monotoniczna
  (AD-22), a pojednanie takich wiadomości należy do story 3.17.

**Testy**

`tests/send-limits.test.ts` z atrapą dostawcy: wyczerpany limit odmawia z liczbami; przesunięte
zadania wracają i wszystkie wiadomości ostatecznie wychodzą; pomiar znaczników czasu wywołań
atrapy potwierdza, że w żadnej sekundzie nie było więcej niż `maxSendRate`; `sandbox: true` narzuca
200 na dobę mimo limitu tenanta 5000; rezerwa 10 procent zatrzymuje wysyłkę przed kwotą dostawcy;
tenant B wysyła, gdy A stoi; brak wiersza limitu blokuje wysyłkę zamiast ją przepuścić.

---

### Story 3.9: Bramka canSendTo jako wiążące sprawdzenie w transakcji wysyłki

Jako właściciel produktu, chcę jednej bramki sprawdzanej tuż przed wysyłką, żeby żadna ścieżka nie
mogła wysłać do osoby wypisanej, bez zgody albo ponad limit.

**Pokrywa:** FR45, FR46, FR51, FR52 | **Rządzą:** AD-25, AD-9, AD-27, AD-22 | **Jakość:** NFR9, NFR15, NFR33

**Kryteria akceptacji**

1. **Zakładając** profil na globalnej liście wykluczeń, **kiedy** bramka ocenia wysyłkę, **wtedy**
   odmawia z kodem `global_suppression`, **oraz** odmowa dotyczy każdego tenanta (AD-27).
2. **Zakładając** profil na liście wykluczeń tenanta A, **kiedy** bramka ocenia wysyłkę tenanta B
   do tego samego adresu, **wtedy** wysyłka jest dozwolona, **oraz** w tenancie A odmówiona
   (dwupoziomowość z AD-27).
3. **Zakładając** profil bez udokumentowanej zgody, **kiedy** bramka ocenia wysyłkę, **wtedy**
   odmawia z kodem `no_consent`.
4. **Zakładając** wpis w rejestrze trybu równoległego mówiący, że ten profil dostał już tę kampanię
   z poprzedniego ESP, **kiedy** bramka ocenia wysyłkę, **wtedy** odmawia z kodem
   `parallel_send_duplicate`, **oraz** przy pustym rejestrze ten warunek nie blokuje niczego.
5. **Zakładając** tenanta z ustawioną flagą wstrzymania wysyłki, **kiedy** bramka ocenia wysyłkę,
   **wtedy** odmawia z kodem `tenant_sending_paused` i podaje zapisany powód wstrzymania.
6. **Zakładając** dowolną odmowę, **kiedy** bramka ją zwraca, **wtedy** wiadomość dostaje stan
   `refused` ze zdarzeniem niosącym kod i komunikat, **oraz** bramka nigdy nie kończy się milczeniem
   (AD-25).
7. **Zakładając** wywołanie bramki, **kiedy** ogląda się kod wywołujący, **wtedy** wykonuje się ona
   na tym samym połączeniu i w tej samej transakcji co zapis przejścia `queued` na `sending`,
   **oraz** nie istnieje ścieżka wysyłki omijająca bramkę (kampania, automatyzacja, test).
8. **Zakładając** kolejność sprawdzeń, **kiedy** spełnionych jest kilka warunków odmowy naraz,
   **wtedy** zwracany jest pierwszy z ustalonej kolejności, **oraz** kolejność jest stała i opisana
   w kodzie, żeby komunikaty były przewidywalne.

**Notatki implementacyjne**

- `src/usecases/send/can-send-to.ts` z sygnaturą przyjmującą klienta transakcji, `tenantId`,
  `profileId` i `source`. Kolejność sprawdzeń: wstrzymanie tenanta, domena (story 3.6), wykluczenie
  globalne, wykluczenie tenanta, zgoda, rejestr trybu równoległego, zasięg i limit warmupu
  (story 3.7), limit tenanta (story 3.8).
- Ta story dokłada kolumny `tenants.sending_paused_at` i `tenants.sending_paused_reason` oraz
  minimalną tabelę `parallel_send_registry` (`tenant_id`, `external_campaign_ref`, `profile_id`,
  `sent_at`). Wypełnia je Epik 6 i story 3.14, ale punkt sprawdzenia powstaje tutaj, żeby później
  nikt nie musiał otwierać bramki.
- Normalizacja adresu identyczna jak w indeksie z migracji 0001: `lower(btrim(email))`. **Nie**
  usuwaj kropek ani aliasów po plusie: to scaliłoby różne osoby w jedną i wprowadziło ciche
  pomijanie odbiorców.
- Bramka czyta i nie zapisuje niczego poza zdarzeniem odmowy. Kasowanie wiadomości jest zakazane
  (AD-16), odmowa to stan.

**Testy**

`tests/can-send-to.test.ts`: osobny przypadek na każdy kod odmowy; wykluczenie tenanta A nie blokuje
tenanta B, a globalne blokuje obu; pusty rejestr trybu równoległego nie blokuje; odmowa zapisuje
zdarzenie z kodem; test sprawdzający, że wysyłka testowa i automatyzacja przechodzą tą samą bramką
(dwa wywołania, ten sam use-case); stała kolejność kodów przy kilku warunkach naraz.

---

### Story 3.10: Worker wysyłki z idempotencją od końca do końca

Jako operator, chcę workera, który po restarcie nie wyśle nikomu drugi raz i nikogo nie pominie,
żeby awaria procesu nie kosztowała reputacji domeny klienta.

**Pokrywa:** FR52, podstawa FR43-FR53 | **Rządzą:** AD-23, AD-6, AD-22, AD-25, AD-31 | **Jakość:** NFR15, NFR16, NFR23, NFR30

**Kryteria akceptacji**

1. **Zakładając** wiadomość w stanie `queued`, **kiedy** worker ją obsługuje, **wtedy** przejście
   `queued` na `sending` zapisuje się **przed** wywołaniem dostawcy, **oraz** wywołanie dostawcy
   odbywa się poza jakąkolwiek otwartą transakcją (AD-23, AD-31).
2. **Zakładając** udane wywołanie dostawcy, **kiedy** worker domyka pracę, **wtedy** zapisuje
   zdarzenie `sent` wraz z identyfikatorem wiadomości u dostawcy, **oraz** `idempotencyKey` przekazany
   dostawcy jest równy identyfikatorowi wiadomości.
3. **Zakładając** partię 100 wiadomości, **kiedy** worker zostaje zabity po przetworzeniu 10,
   **wtedy** te 10 pozostaje w stanie `sent` (partia nie jest jedną transakcją), **oraz** pozostałe
   90 zostaje obsłużonych po restarcie.
4. **Zakładając** 1000 odbiorców i restart workera w trakcie, **kiedy** przebieg się kończy,
   **wtedy** atrapa dostawcy odnotowuje dokładnie jedno przyjęte wywołanie na każdy klucz
   idempotencji, **oraz** żadna wiadomość nie zostaje w stanie `queued` (NFR15).
5. **Zakładając** dostawcę zwracającego błąd oznaczony jako `retryable`, **kiedy** worker go
   dostaje, **wtedy** zadanie wraca do kolejki z backoffem, **oraz** kampania jest oznaczona jako
   wstrzymana z powodem „dostawca niedostępny", **oraz** po powrocie dostawcy wysyłka wznawia się
   bez duplikatów (NFR16).
6. **Zakładając** dostawcę zwracającego błąd terminalny (na przykład odrzucony adres), **kiedy**
   worker go dostaje, **wtedy** wiadomość dostaje stan `failed` z powodem, **oraz** zadanie nie jest
   ponawiane.
7. **Zakładając** odmowę bramki `canSendTo`, **kiedy** worker obsługuje wiadomość, **wtedy** nie
   dochodzi do żadnego wywołania dostawcy, **oraz** wiadomość kończy w stanie `refused` z powodem.
8. **Zakładając** wiadomość, która jest już w stanie `sent`, **kiedy** to samo zadanie zostanie
   wykonane ponownie, **wtedy** worker rozpoznaje stan i kończy bez wywołania dostawcy
   (idempotencja handlera z AD-5).

**Notatki implementacyjne**

- `src/jobs/send-message.ts`, jedno zadanie na jedną wiadomość. Rozbicie kampanii na zadania robi
  osobny handler `src/jobs/dispatch-campaign.ts` czytający kandydatów partiami.
- Przebieg: transakcja 1 (blokada wiersza wiadomości, sprawdzenie stanu, `canSendTo`, zapis
  `sending`), commit, wywołanie dostawcy, transakcja 2 (zapis `sent` z identyfikatorem dostawcy).
  Żadnego I/O sieciowego w transakcji 1 ani 2.
- Nie licz prób w `message_events`: unikalność `(message_id, event_type)` na to nie pozwoli.
  Licznik prób żyje na wierszu zadania (story 3.1).
- Kampania wstrzymana z powodu dostawcy nie kasuje zadań, tylko przesuwa `run_after`. Wznowienie
  polega na tym, że zadania same wracają, a nie na ponownym zbudowaniu listy odbiorców, bo lista
  zbudowana ponownie mogłaby objąć kogoś, kto już dostał wiadomość.

**Testy**

`tests/send-worker.test.ts` z atrapą dostawcy zliczającą wywołania per klucz: przebieg 1000
wiadomości z wymuszonym restartem (proces workera uruchamiany jako dwie sekwencyjne pętle,
z przerwaniem w środku); zliczenie kluczy równe liczbie odbiorców; brak wiadomości w `queued`
po zakończeniu; błąd `retryable` na pierwszych 50 i wznowienie; błąd terminalny kończący jako
`failed`; odmowa bramki bez wywołania dostawcy; ponowne wykonanie zadania na wiadomości `sent`
bez wywołania dostawcy.

---

### Story 3.11: Nagłówek List-Unsubscribe one-click i dane nadawcy wymagane w kraju odbiorcy

Jako odbiorca, chcę móc wypisać się jednym kliknięciem z klienta pocztowego i widzieć, kto do mnie
napisał, żeby nie musieć klikać „to spam".

**Pokrywa:** FR50, FR53 | **Rządzą:** AD-32, AD-13 | **Jakość:** NFR11, NFR32, NFR33

**Kryteria akceptacji**

1. **Zakładając** zbudowaną wiadomość, **kiedy** ogląda się jej nagłówki, **wtedy** zawiera
   `List-Unsubscribe` z adresem HTTPS oraz `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
   zgodnie z RFC 8058, **oraz** adres w nagłówku jest tym samym adresem, który obsługuje endpoint
   wypisania.
2. **Zakładając** token wypisania, **kiedy** analizuje się jego postać, **wtedy** ma co najmniej
   128 bitów entropii, **oraz** nie jest identyfikatorem wiadomości, **oraz** nie zawiera adresu
   e-mail w żadnej odwracalnej postaci (NFR11).
3. **Zakładając** dwie wiadomości do tego samego odbiorcy, **kiedy** porównuje się ich tokeny,
   **wtedy** tokeny są różne.
4. **Zakładając** odbiorcę w Polsce, **kiedy** buduje się wiadomość, **wtedy** stopka zawiera
   nazwę i dane identyfikujące nadawcę pobrane z konfiguracji tenanta, **oraz** widoczny link
   wypisania niezależny od nagłówka.
5. **Zakładając** odbiorcę w USA, **kiedy** buduje się wiadomość, **wtedy** stopka zawiera fizyczny
   adres pocztowy nadawcy (wymóg CAN-SPAM), **oraz** brak takiego adresu w konfiguracji kończy się
   odmową z kodem `missing_sender_identity`, a nie wysyłką bez adresu.
6. **Zakładając** tenanta bez żadnej skonfigurowanej tożsamości nadawcy, **kiedy** próbuje się
   wysłać cokolwiek, **wtedy** operacja jest odmówiona z powodem, **oraz** panel wskazuje, które
   pole trzeba uzupełnić.
7. **Zakładając** treść przygotowaną w edytorze, **kiedy** buduje się wiadomość, **wtedy** stopka
   zgodności i link wypisania są doklejane przez kod, **oraz** nie zależą od tego, czy autor szablonu
   o nich pamiętał.

**Notatki implementacyjne**

- Tabela `tenant_sender_identities`: `tenant_id`, `country_scope` (`default`, `US`, `PL`, ...),
  `legal_name`, `postal_address`, `contact_email`, `updated_at`. Wybór: dopasowanie po kraju
  odbiorcy, w braku dopasowania wpis `default`, w braku `default` odmowa.
- Kraj odbiorcy pochodzi z profilu (adres z zamówienia). Gdy nieznany, stosuj wariant najostrzejszy,
  czyli z adresem pocztowym, bo brak adresu przy odbiorcy z USA jest naruszeniem, a nadmiar danych
  w stopce nie jest.
- Token wypisania: kolumna `messages.unsubscribe_token` (osobny sekret, ta sama zasada co AD-33 dla
  tokenu kliknięcia), generowany losowo 32 bajtami, unikalny globalnie.
- Adres z nagłówka budowany z konfiguracji (`APP_PUBLIC_URL`), nie sklejany w kilku miejscach.
  Sam endpoint powstaje w story 3.12; tutaj tylko adres i token.
- Nagłówki idą do dostawcy przez `SendCommand.headers`, więc adapter musi je przepuścić bez zmian
  (zdolność `oneClickUnsubscribeHeader` z story 3.2).

**Testy**

`tests/message-compliance.test.ts`: obecność i składnia obu nagłówków; token o właściwej długości,
różny dla dwóch wiadomości, nierozszyfrowywalny do adresu; token rozwiązuje się do właściwego
wiersza w bazie; odbiorca z USA dostaje adres pocztowy; brak tożsamości dla USA kończy odmową;
brak jakiejkolwiek tożsamości blokuje wysyłkę; stopka obecna nawet przy szablonie, który jej nie
zawiera.

---

### Story 3.12: Wypisanie jednym kliknięciem i natychmiastowe wykluczenie

Jako odbiorca, chcę żeby kliknięcie „wypisz" działało od razu, bez logowania i bez ankiety, żeby
nie musiałem zgłaszać maila jako spam.

**Pokrywa:** FR51 | **Rządzą:** AD-9, AD-27, AD-16 | **Jakość:** NFR19, NFR22, NFR32

**Kryteria akceptacji**

1. **Zakładając** ważny token wypisania, **kiedy** przychodzi `POST` z klienta pocztowego, **wtedy**
   wpis w `tenant_suppressions` istnieje **przed** odpowiedzią 200, **oraz** odpowiedź przychodzi
   poniżej 500 ms.
2. **Zakładając** ten sam token, **kiedy** żądanie przychodzi drugi raz, **wtedy** odpowiedź to
   nadal 200, **oraz** nie powstaje drugi wpis wykluczenia, **oraz** nie ma błędu.
3. **Zakładając** odbiorcę klikającego link w stopce, **kiedy** otwiera adres w przeglądarce
   (`GET`), **wtedy** jest wypisany natychmiast bez ekranu logowania, bez pytania „czy na pewno"
   i bez komunikatu o 48 godzinach, **oraz** widzi potwierdzenie czytelne na telefonie (NFR32).
4. **Zakładając** wypisanie, **kiedy** patrzy się na wiadomość, z której przyszło, **wtedy** w jej
   strumieniu jest zdarzenie `unsubscribed` z datą zdarzenia, **oraz** wiadomość nie jest kasowana
   ani modyfikowana poza projekcją (AD-16, AD-22).
5. **Zakładając** wypisanie odbiorcy, **kiedy** zaraz potem bramka `canSendTo` ocenia wysyłkę do
   niego w tym tenancie, **wtedy** odmawia z kodem `tenant_suppression`.
6. **Zakładając** wypisanie w tenancie A, **kiedy** sprawdza się tenanta B, **wtedy** odbiorca nie
   jest tam wykluczony (wypisanie to lista tenanta, nie globalna, AD-27).
7. **Zakładając** nieznany albo uszkodzony token, **kiedy** przychodzi żądanie, **wtedy** odpowiedź
   to 404 bez ujawniania, czy taki token kiedykolwiek istniał, **oraz** nic nie jest zapisywane.
8. **Zakładając** niedostępny panel operatora, **kiedy** odbiorca się wypisuje, **wtedy** wypisanie
   działa, bo ścieżka nie zależy od sesji ani od modułów panelu (NFR19).

**Notatki implementacyjne**

- Route handler w `src/app/u/[token]/route.ts` obsługujący `POST` (one-click z klienta pocztowego)
  i `GET` (klik ze stopki). Zero zależności od sesji i od kodu panelu.
- Cała operacja w jednej transakcji: wstawienie wykluczenia tenanta z `on conflict do nothing`,
  zapis zdarzenia `unsubscribed` na wiadomości, anulowanie zadań wysyłki dla tego profilu (patrz
  story 3.18, tam jest test tego wyścigu; tutaj wystarczy sam zapis anulowania).
- `occurred_at` z chwili żądania, jawnie ustawiony (AD-10).
- Nie loguj adresu e-mail w treści logu (konwencja logów), loguj identyfikator profilu.
- One-click z RFC 8058 nie może prowadzić do formularza. Klient pocztowy wysyła `POST` i nie
  interpretuje odpowiedzi, więc każdy dodatkowy krok oznacza, że odbiorca uważa się za wypisanego,
  a system tak nie uważa. To jest ta sytuacja, która kończy się skargą.

**Testy**

`tests/unsubscribe.test.ts`: `POST` tworzy wykluczenie widoczne natychmiast po odpowiedzi; drugi
`POST` bez duplikatu; `GET` bez sesji; zdarzenie `unsubscribed` na wiadomości; bramka odmawia po
wypisaniu; wypisanie w tenancie A nie dotyka B; nieznany token daje 404 i zero zapisów; pomiar
czasu odpowiedzi poniżej 500 ms na sandboxie.

---

### Story 3.13: Webhooki odbić i skarg dostawcy jako wejście do wykluczeń

Jako właściciel platformy, chcę żeby odbicia i skargi od dostawcy wpadały do wykluczeń, żeby nikt
nie wysyłał drugi raz na martwy adres ani do kogoś, kto zgłosił spam.

**Pokrywa:** FR48 | **Rządzą:** AD-4, AD-7, AD-24, AD-27 | **Jakość:** NFR14, NFR19, NFR22, NFR28, NFR29, NFR30

**Kryteria akceptacji**

1. **Zakładając** webhook dostawcy z poprawnym podpisem, **kiedy** trafia na endpoint, **wtedy**
   surowe zdarzenie zapisuje się do niezmiennego logu z kluczem idempotencji **przed**
   przetworzeniem, **oraz** odpowiedź 200 przychodzi poniżej 500 ms, **oraz** przetworzenie wykonuje
   osobne zadanie (AD-4, NFR14, NFR22).
2. **Zakładając** to samo zdarzenie dostarczone dwa razy, **kiedy** trafia na endpoint ponownie,
   **wtedy** powstaje jeden wpis w logu surowym, **oraz** powstaje jedno wykluczenie, **oraz**
   odpowiedź to nadal 200 (NFR28).
3. **Zakładając** webhook z błędnym albo brakującym podpisem, **kiedy** trafia na endpoint, **wtedy**
   odpowiedź to 401, **oraz** nic nie zostaje zapisane.
4. **Zakładając** odbicie twarde, **kiedy** zadanie je przetwarza, **wtedy** adres trafia na listę
   globalną `suppressions` **i** na listę tenanta `tenant_suppressions` z powodem `hard_bounce`,
   **oraz** adres jest znormalizowany tak jak w indeksie z migracji 0001.
5. **Zakładając** odbicie miękkie, **kiedy** zadanie je przetwarza, **wtedy** zdarzenie jest
   zapisane przy wiadomości, **oraz** adres **nie** trafia na żadną listę wykluczeń.
6. **Zakładając** skargę, **kiedy** zadanie ją przetwarza, **wtedy** adres trafia na obie listy
   z powodem `complaint`, **oraz** zdarzenie jest widoczne w strumieniu wiadomości dla story 3.14.
7. **Zakładając** zdarzenie dotyczące wiadomości, której jeszcze nie ma w bazie, **kiedy** zadanie
   je przetwarza, **wtedy** zadanie jest ponawiane z backoffem, **oraz** po wyczerpaniu prób trafia
   do kolejki błędów z alertem, **oraz** surowe zdarzenie nie ginie (NFR29, NFR30).
8. **Zakładając** skargę zgłoszoną w tenancie A, **kiedy** sprawdza się listy, **wtedy** wpis
   globalny obowiązuje wszystkich, a wpis tenanta istnieje tylko w A (AD-27).
9. **Zakładając** niedostępny panel operatora, **kiedy** przychodzi webhook, **wtedy** jest przyjęty
   i zapisany (NFR19).

**Notatki implementacyjne**

- Endpoint `src/app/webhooks/email/[provider]/route.ts`. Weryfikacja podpisu **w adapterze**
  (`parseWebhook` z kontekstem), nie w route (AD-7). Route zna tylko port.
- Klucz idempotencji w kształcie z AD-24: `provider : tenant_id : entity : external_id : source_version`,
  budowany jedną funkcją adaptera, tą samą co przy ewentualnym imporcie zdarzeń historycznych.
- Rozróżnienie odbicia twardego od miękkiego jest sednem tej story. Wrzucenie miękkiego odbicia na
  listę wykluczeń kasuje kontakty klienta po jednej awarii jego serwera pocztowego, a tego nie da
  się odkręcić, bo wykluczenia zdejmuje wyłącznie administrator.
- Przetwarzanie zdarzeń bez znanej wiadomości: park i ponowienie, nigdy odrzucenie. Dostawca potrafi
  przysłać zdarzenie szybciej, niż my zapiszemy `sent` (wyścig ze story 3.18).
- Pliki: `src/jobs/process-provider-event.ts`, `src/usecases/suppressions/record-provider-event.ts`.

**Testy**

`tests/provider-webhooks.test.ts` z atrapą dostawcy generującą ładunki: podwójna dostawa jednego
zdarzenia; zły podpis; odbicie twarde na obu listach; odbicie miękkie bez wykluczenia; skarga na obu
listach; zdarzenie dla nieistniejącej wiadomości ponawiane i kończące w kolejce błędów z alertem;
odpowiedź poniżej 500 ms przy pustej kolejce; test cross-tenantowy na `tenant_suppressions`.

---

### Story 3.14: Automatyczne wstrzymanie tenanta po przekroczeniu progu skarg

Jako właściciel platformy, chcę żeby tenant z rosnącym wskaźnikiem skarg został wstrzymany przez
nas, zanim zareaguje dostawca, żeby jeden klient nie zabrał reputacji pozostałym.

**Pokrywa:** FR49, FR71 | **Rządzą:** AD-25, AD-5, AD-16 | **Jakość:** NFR2, NFR5, NFR38

**Kryteria akceptacji**

1. **Zakładając** tenanta ze wskaźnikiem skarg powyżej progu twardego w oknie kroczącym, **kiedy**
   zadanie kontrolne liczy wskaźniki, **wtedy** ustawia `tenants.sending_paused_at` z powodem,
   **oraz** pozostałe wiadomości w kolejce dostają odmowę `tenant_sending_paused` (bramka ze story
   3.9), **oraz** wiadomości już wysłane nie są ruszane.
2. **Zakładając** próg dostawcy równy 0,1 procent, **kiedy** wskaźnik tenanta osiąga 0,09 procent,
   **wtedy** tenant jest już wstrzymany po naszej stronie, bo nasz próg twardy jest **ostrzejszy**
   niż próg dostawcy (research: izolacja per tenant nie chroni konta).
3. **Zakładając** okno z liczbą doręczeń poniżej progu istotności (domyślnie 500), **kiedy** pojawi
   się pojedyncza skarga, **wtedy** tenant **nie** jest wstrzymany z tytułu wskaźnika procentowego,
   **oraz** obowiązuje osobny wyzwalacz liczby bezwzględnej (domyślnie 3 skargi), żeby mała, ale
   toksyczna lista też została zatrzymana.
4. **Zakładając** przekroczony próg odbić (domyślnie 5 procent), **kiedy** zadanie liczy wskaźniki,
   **wtedy** tenant jest wstrzymany tak samo jak przy skargach, z osobnym powodem.
5. **Zakładając** wstrzymanie, **kiedy** ono nastąpi, **wtedy** na kanał techniczny idzie alert
   zawierający tenanta, okno, wskaźnik faktyczny, próg i **opis, co z tym zrobić**, **oraz** alert
   nie jest wpisem w `console.error` (NFR38, FR71).
6. **Zakładając** wstrzymanego tenanta, **kiedy** administrator go odwiesza, **wtedy** zapisuje się
   kto, kiedy i z jakim uzasadnieniem, **oraz** odwieszenie nie następuje automatycznie po czasie,
   **oraz** operator bez roli administratora tego nie może.
7. **Zakładając** wstrzymanie tenanta A, **kiedy** tenant B wysyła, **wtedy** wysyłka B idzie dalej
   bez zakłóceń (AD-2).
8. **Zakładając** raport z zadania kontrolnego, **kiedy** czyta się jego log, **wtedy** liczby
   pokazują faktyczny wynik (ilu tenantów sprawdzono, ilu wstrzymano), a nie liczbę prób (NFR2).

**Notatki implementacyjne**

- Wskaźniki liczone ze zdarzeń w `message_events`: skargi i odbicia dzielone przez doręczenia
  w oknie kroczącym 24 godzin oraz 7 dni, osobno per tenant i per domena wysyłkowa. Domena, bo to
  ona ma reputację, a tenant może mieć ich więcej niż jedną.
- Progi w konfiguracji tenanta z wartościami domyślnymi: ostrzeżenie 0,05 procent, wstrzymanie
  0,08 procent, odbicia 5 procent, próg istotności 500 doręczeń, wyzwalacz bezwzględny 3 skargi.
  Cel z PRD to poniżej 0,1 procent przy twardym progu Gmaila 0,3 procent, więc nasze wstrzymanie
  musi zadziałać wyraźnie wcześniej.
- Zadanie cykliczne co 5 minut w trakcie aktywnej wysyłki, plus ocena po każdej zakończonej partii,
  bo przy dużej kampanii 5 minut to kilkadziesiąt tysięcy wiadomości.
- Wstrzymanie zapisuje się na tenancie (kolumny z story 3.9), a nie w pamięci procesu, bo restart
  workera musi je zastać.
- Odwieszenie jest zawsze decyzją człowieka. Automatyczne odwieszenie po czasie oznacza, że przy
  realnym problemie z listą system sam wznowi palenie domeny.

**Testy**

`tests/complaint-threshold.test.ts`: przekroczenie progu wstrzymuje tenanta i odmawia reszcie
kolejki; przy progu dostawcy 0,1 procent i naszym 0,08 procent stan przy 0,09 procent to
wstrzymany; mała próbka nie wstrzymuje procentowo, ale wstrzymuje po trzech skargach; próg odbić
z osobnym powodem; alert zawiera próg, wartość, okno i procedurę; odwieszenie wymaga roli
administratora i zapisuje ślad; tenant B niewzruszony; licznik w logu równy faktycznej liczbie
wstrzymań.

---

### Story 3.15: Zatrzymanie wysyłki do segmentu nietypowo większego niż poprzednie

Jako operator, chcę żeby system zatrzymał wysyłkę do segmentu wyraźnie większego niż dotychczasowe
i kazał mi to potwierdzić, żeby pomyłka w segmencie nie stała się największą wysyłką w historii domeny.

**Pokrywa:** FR47 | **Rządzą:** AD-25, AD-3, AD-17 | **Jakość:** NFR2, NFR20, NFR38

**Kryteria akceptacji**

1. **Zakładając** tenanta z historią wysyłek o medianie 10 tysięcy odbiorców, **kiedy** operator
   uruchamia wysyłkę do 12 tysięcy, **wtedy** wysyłka rusza bez dodatkowego kroku.
2. **Zakładając** tę samą historię, **kiedy** operator uruchamia wysyłkę do 25 tysięcy, **wtedy**
   wysyłka zatrzymuje się w stanie oczekiwania na potwierdzenie, **oraz** komunikat podaje liczbę
   bieżącą, wartość odniesienia i krotność, **oraz** nie powstaje żadna wiadomość.
3. **Zakładając** zatrzymaną wysyłkę, **kiedy** operator ją potwierdza, **wtedy** wysyłka rusza,
   **oraz** zapisuje się kto potwierdził, kiedy i na jaką liczbę odbiorców.
4. **Zakładając** potwierdzenie na 25 tysięcy, **kiedy** przed startem zaplanowanej wysyłki liczba
   odbiorców urosła o więcej niż próg tolerancji (domyślnie 10 procent), **wtedy** potwierdzenie
   traci ważność i wymagane jest nowe, **oraz** operator dostaje o tym informację. To jest ten
   przypadek, w którym segment rośnie sam między akceptacją a wysyłką.
5. **Zakładając** tenanta bez żadnej zakończonej wysyłki, **kiedy** uruchamia się pierwszą kampanię,
   **wtedy** potwierdzenie jest wymagane zawsze, bo nie ma wartości odniesienia.
6. **Zakładając** potwierdzenie wystawione dla kampanii tenanta A, **kiedy** próbuje się nim
   odblokować kampanię tenanta B, **wtedy** operacja jest odrzucona (AD-2).
7. **Zakładając** wstrzymanie z tego powodu, **kiedy** ono nastąpi, **wtedy** idzie powiadomienie do
   operatora z opisem, co zrobić, żeby ruszyć dalej (NFR38).

**Notatki implementacyjne**

- Wartość odniesienia: mediana liczby odbiorców z ostatnich 5 zakończonych wysyłek tenanta, nie
  średnia, bo jedna wielka wysyłka podniosłaby średnią i wyłączyła zabezpieczenie na przyszłość.
- Domyślna krotność progu: 2,0. Wartość konfigurowalna per tenant, bo sklep sezonowy ma inny profil
  niż sklep o stałym rytmie.
- Tabela `send_size_confirmations`: `campaign_id`, `tenant_id`, `confirmed_recipient_count`,
  `actor_id`, `confirmed_at`, `invalidated_at`, `invalidated_reason`.
- Sprawdzenie liczby odbiorców tuż przed startem, nie tylko w momencie planowania. Z researchu:
  pierwsza kampania Black Friday będzie jednocześnie największą wysyłką w historii domeny
  i pierwszym prawdziwym testem kolejki, więc ta bramka ma być wdrożona przed sezonem.

**Testy**

`tests/send-size-guard.test.ts`: 12 tysięcy przy medianie 10 tysięcy przechodzi; 25 tysięcy
zatrzymuje z liczbami w komunikacie i bez tworzenia wiadomości; potwierdzenie odblokowuje i zapisuje
ślad; wzrost liczby odbiorców o 30 procent po potwierdzeniu wymaga nowego; pierwsza kampania zawsze
wymaga potwierdzenia; potwierdzenie z tenanta A nie działa w B.

---

### Story 3.16: Adapter Amazon SES (eu-central-1, funkcja Tenants) na porcie EmailProvider

Jako właściciel produktu, chcę adaptera SES spełniającego ten sam kontrakt co atrapa, żeby wysyłka
poszła realną infrastrukturą bez zmiany czegokolwiek poza konfiguracją.

**Pokrywa:** FR43, FR44, FR48, FR52 | **Rządzą:** AD-7, AD-13, AD-1 | **Jakość:** NFR7, NFR8, NFR28, NFR31, NFR35

**Kryteria akceptacji**

1. **Zakładając** adapter SES, **kiedy** uruchamia się zestaw testów kontraktowych portu ze story
   3.2, **wtedy** adapter przechodzi wszystkie przypadki przeciw lokalnej atrapie punktu końcowego
   AWS, **oraz** test nie wykonuje żadnego wywołania do prawdziwego AWS.
2. **Zakładając** wywołanie `listDomainRecords`, **kiedy** adapter obsługuje domenę, **wtedy** zwraca
   trzy rekordy CNAME Easy DKIM, rekordy domeny MAIL FROM (MX i TXT SPF) oraz oczekiwane wpisy SPF
   i DMARC, **oraz** zestaw ten zasila ekran ze story 3.4 bez zmian w warstwie wyżej.
3. **Zakładając** wysyłkę dla tenanta, **kiedy** adapter woła SES, **wtedy** żądanie niesie nazwę
   tenanta SES (`TenantName` w API), **oraz** nagłówki `List-Unsubscribe` i `List-Unsubscribe-Post`
   przechodzą do wiadomości bez modyfikacji, **oraz** wywołanie idzie do regionu `eu-central-1`.
4. **Zakładając** konto bez production access, **kiedy** adapter czyta `quotaStatus`, **wtedy**
   zwraca `sandbox: true` wraz z `max24h` równym 200 i `maxSendRate` równym 1, **oraz** warstwa
   limitów ze story 3.8 stosuje twardy pułap piaskownicy.
5. **Zakładając** powiadomienie SNS o odbiciu lub skardze, **kiedy** adapter je parsuje, **wtedy**
   weryfikuje podpis, **oraz** obsługuje osobno potwierdzenie subskrypcji SNS, **oraz** zwraca
   zdarzenia w kształcie domenowym bez wyciekania typów AWS poza adapter (AD-1).
6. **Zakładając** brak natywnej idempotencji wysyłki w SES, **kiedy** deklaruje się zdolności,
   **wtedy** adapter podaje `idempotentSend: false`, **oraz** implementuje `lookupByIdempotencyKey`
   przez wyszukanie zdarzenia wysyłki po własnym nagłówku `X-MidRev-Message-Id`, **oraz** gdy nie
   potrafi rozstrzygnąć, zwraca `unknown`, a nie zgaduje.
7. **Zakładając** poświadczenia AWS tenanta, **kiedy** adapter podpisuje żądanie, **wtedy** klucz nie
   pojawia się w logu, w treści błędu ani w alercie (AD-13, NFR7), **oraz** komunikacja idzie po TLS
   (NFR8).
8. **Zakładając** odpowiedź SES z kodem ograniczenia tempa, **kiedy** adapter ją mapuje, **wtedy**
   błąd jest oznaczony jako `retryable`, **oraz** odpowiedzi o odrzuconym adresie są oznaczone jako
   terminalne (NFR31, wejście do story 3.10).

**Notatki implementacyjne**

- `src/adapters/email/ses/`. Preferowany oficjalny klient `@aws-sdk/client-sesv2` zamknięty w tym
  katalogu; własne podpisywanie SigV4 tylko wtedy, gdy dodanie zależności zostanie odrzucone.
  Decyzja nie ma prawa wyciec poza adapter.
- Tenanty SES są **per region** i nie replikują się między regionami. Zapisz region przy tenancie,
  bo późniejsza zmiana oznacza nowy warmup, nie zmianę pola.
- Suppression po stronie SES ustawiona na `SuppressionScope = TENANT`, ale nasza własna lista
  wykluczeń pozostaje źródłem prawdy. Lista dostawcy to druga siatka, nie zamiennik.
- Piaskownica: pozwala wysyłać wyłącznie na zweryfikowane adresy. Do testów akceptacyjnych z realnym
  kontem trzeba mieć zweryfikowaną skrzynkę odbiorczą, inaczej wysyłka kończy się błędem, który
  wygląda jak błąd naszego kodu.
- Wyjście z piaskownicy i podniesienie kwoty to zadanie z datą po stronie właściciela, nie krok
  konfiguracyjny w tej story. Kod ma działać poprawnie w obu stanach.

**Testy**

`tests/ses-adapter.test.ts`: zestaw kontraktowy przeciw lokalnemu serwerowi HTTP udającemu punkt
końcowy SES; kształt rekordów DNS; obecność nazwy tenanta i przepuszczenie nagłówków w żądaniu;
`ProductionAccessEnabled: false` daje `sandbox: true` z pułapem 200 i 1; parsowanie powiadomienia
SNS oraz potwierdzenia subskrypcji; odrzucenie ładunku z błędnym podpisem; mapowanie kodu
ograniczenia tempa na `retryable`, a odrzuconego adresu na błąd terminalny; test redakcji sekretu.

---

### Story 3.17: Wznowienie po awarii: pojednanie wiadomości zastanych w stanie sending i ponowienie zadania

Jako operator, chcę żeby wiadomość zastana w stanie `sending` po zabiciu procesu została
rozstrzygnięta u dostawcy, a nie wysłana w ciemno drugi raz.

**Pokrywa:** FR52, ochrona FR43-FR53 | **Rządzą:** AD-23, AD-5, AD-22 | **Jakość:** NFR15, NFR16, NFR30, NFR38

**Kryteria akceptacji**

1. **Zakładając** workera zabitego **po** przyjęciu wysyłki przez dostawcę, ale **przed** zapisem
   `sent`, **kiedy** zadanie pojednania sprawdza wiadomość po kluczu idempotencji, **wtedy** dostawca
   potwierdza przyjęcie, **oraz** system zapisuje `sent` z identyfikatorem dostawcy, **oraz** nie
   dochodzi do drugiego wywołania wysyłki (AD-23, NFR15).
2. **Zakładając** workera zabitego **po** zapisie `sending`, ale **przed** wywołaniem dostawcy,
   **kiedy** pojednanie sprawdza wiadomość, **wtedy** dostawca nie zna klucza, **oraz** po upływie
   okna zdarzeń dostawcy wiadomość jest wysyłana dokładnie raz, **oraz** odbiorca nie zostaje
   pominięty.
3. **Zakładając** dostawcę, który nie potrafi rozstrzygnąć klucza (odpowiedź `unknown`), **kiedy**
   pojednanie kończy pracę, **wtedy** wiadomość **nie** jest wysyłana ponownie, **oraz** po
   ustalonej liczbie cykli idzie alert do człowieka z informacją o możliwym pominięciu (NFR38).
   Ten kompromis jest świadomy: podwójna wysyłka kosztuje reputację, pominięcie kosztuje jeden mail
   i jest widoczne dla człowieka.
4. **Zakładając** zadanie ponowione po błędzie przejściowym, **kiedy** worker wykonuje je drugi raz,
   **wtedy** licznik prób rośnie na wierszu zadania, **oraz** w `message_events` nie powstaje drugie
   zdarzenie `sending`, **oraz** dostawca odnotowuje jedno przyjęte wywołanie na klucz.
5. **Zakładając** zadanie, które wyczerpało próby, **kiedy** kończy się ostatnia, **wtedy** wiadomość
   dostaje stan `failed` z powodem, **oraz** nie zostaje po cichu w stanie `sending`, **oraz**
   zadanie ląduje w `jobs_dead` z alertem (NFR30).
6. **Zakładając** niedostępność dostawcy przez cały przebieg i powrót po czasie, **kiedy** wysyłka
   się wznawia, **wtedy** wszystkie wiadomości zostają wysłane dokładnie raz (NFR16).
7. **Zakładając** wiadomość w stanie `sending` krócej niż próg pojednania, **kiedy** zadanie
   pojednania się uruchamia, **wtedy** jej nie rusza, żeby nie wejść w drogę pracującemu workerowi.

**Notatki implementacyjne**

- `src/jobs/reconcile-stuck-sending.ts`, uruchamiane cyklicznie. Próg wieku wiadomości w stanie
  `sending` musi być większy niż czas dzierżawy zadania ze story 3.1, inaczej pojednanie zacznie
  ścigać się z żywym workerem.
- Okno zdarzeń dostawcy: zdarzenia SES potrafią przyjść z opóźnieniem, więc decyzja o ponownej
  wysyłce zapada dopiero po jego upływie (rzędu 15 minut). Wcześniejsza decyzja to gotowy duplikat.
- Odpowiedź `unknown` z `lookupByIdempotencyKey` jest stanem pierwszej kategorii, nie błędem.
  Polityka: nie wysyłamy ponownie, alarmujemy człowieka. Zapisz tę decyzję w komentarzu przy kodzie,
  bo bez uzasadnienia ktoś ją kiedyś odwróci.
- Alert musi nieść identyfikator wiadomości, tenanta i to, czego nie dało się rozstrzygnąć, oraz
  instrukcję sprawdzenia po stronie dostawcy (NFR38).

**Testy**

`tests/send-recovery.test.ts` z atrapą dostawcy z wstrzykiwaniem awarii:
- atrapa przyjmuje wysyłkę, po czym handler rzuca przed zapisem `sent`; po pojednaniu jeden zapis
  `sent` i jedno wywołanie na klucz;
- zapis `sending` i awaria przed wywołaniem; po pojednaniu dokładnie jedno wywołanie;
- atrapa odpowiadająca `unknown`; brak ponownej wysyłki i jeden alert po ustalonej liczbie cykli;
- ponowienie po błędzie przejściowym: jedno zdarzenie `sending`, jedno wywołanie, rosnący licznik
  prób;
- wyczerpanie prób: `failed` z powodem plus wpis w `jobs_dead` plus alert;
- dostawca niedostępny przez cały przebieg i powrót: wszystkie wiadomości wysłane dokładnie raz;
- świeża wiadomość w `sending` nietknięta przez pojednanie.

---

### Story 3.18: Wyścigi silnika wysyłki: webhook przed zapisem sent i wypisanie między listą a wysyłką

Jako właściciel produktu, chcę żeby spóźniony webhook i wypisanie w ostatniej chwili nie psuły
stanu wiadomości ani nie kończyły się mailem do osoby wypisanej.

**Pokrywa:** FR48, FR51 | **Rządzą:** AD-22, AD-25, AD-9 | **Jakość:** NFR15, NFR19, NFR28, NFR29

**Kryteria akceptacji**

1. **Zakładając** wiadomość w stanie `sending`, **kiedy** webhook doręczenia przychodzi **przed**
   zapisem `sent`, **wtedy** zdarzenie `delivered` zostaje zapisane, **oraz** późniejszy zapis
   `sent` nie obniża projekcji stanu, **oraz** oba zdarzenia istnieją w strumieniu (AD-22, NFR29).
2. **Zakładając** wiadomość, dla której najpierw przyszło `bounced`, **kiedy** dopiero potem
   zapisuje się `sent`, **wtedy** `current_state` pozostaje `bounced`, **oraz** raport liczy odbicie,
   bo czyta strumień, a nie projekcję.
3. **Zakładając** zdarzenie dostawcy dotyczące wiadomości, której wiersz jeszcze nie istnieje,
   **kiedy** zadanie je przetwarza, **wtedy** zdarzenie zostaje odłożone i ponowione, **oraz** po
   pojawieniu się wiadomości zostaje zastosowane, **oraz** nie zostaje odrzucone.
4. **Zakładając** to samo zdarzenie dostawcy dostarczone dwa razy w tym samym momencie z dwóch
   równoległych połączeń, **kiedy** oba zadania się wykonują, **wtedy** w `message_events` powstaje
   jeden wiersz, **oraz** żadne z zadań nie kończy się nieobsłużonym błędem (NFR28).
5. **Zakładając** odbiorcę, który wypisuje się **po** zbudowaniu listy kandydatów, a **przed**
   otwarciem transakcji wysyłki, **kiedy** worker obsługuje jego wiadomość, **wtedy** bramka
   odmawia z kodem `tenant_suppression`, **oraz** nie dochodzi do wywołania dostawcy (AD-25).
6. **Zakładając** wypisanie, **kiedy** zapisuje się wykluczenie, **wtedy** w tej samej transakcji
   anulowane są zadania wysyłki dla tego profilu, które jeszcze nie ruszyły, **oraz** ich wiadomości
   dostają stan `refused` z powodem. To jest właściwe zabezpieczenie, bo samo sprawdzenie w bramce
   zawęża okno, ale go nie zamyka.
7. **Zakładając** wypisanie, które nastąpiło **po** przyjęciu wysyłki przez dostawcę, **kiedy**
   worker domyka pracę, **wtedy** wiadomość kończy jako `sent`, **oraz** odbiorca jest wykluczony
   z każdej kolejnej wysyłki, **oraz** system nie udaje, że tamtego maila nie było.
8. **Zakładając** dwa równoległe workery obsługujące tę samą wiadomość, **kiedy** oba wejdą w
   transakcję wysyłki, **wtedy** tylko jeden zapisuje `sending`, **oraz** drugi kończy bez wywołania
   dostawcy (blokada wiersza plus warunek na stan).

**Notatki implementacyjne**

- To jest story, w której testy są produktem, a kod to głównie domknięcie ścieżek zbudowanych
  wcześniej. Przypadki muszą być odtwarzalne, więc pisz je na **prawdziwych równoległych
  połączeniach** do sandboxa, sterując kolejnością przez ręcznie otwierane transakcje, a nie przez
  `setTimeout`.
- Pułapka izolacji: przy `READ COMMITTED` odczyt bramki widzi zapisy zatwierdzone przed jego
  wykonaniem, ale nie te zatwierdzone później, w trakcie trwania transakcji. Dlatego odczyt bramki
  ma być **ostatnim** poleceniem przed zapisem `sending`, a prawdziwą gwarancją jest anulowanie
  zadań przy wypisaniu (kryterium 6). Napisz to w komentarzu przy bramce, bo bez tego ktoś przesunie
  odczyt wyżej „dla czytelności".
- Granica jest jasna i trzeba ją nazwać w kodzie: po przyjęciu wysyłki przez dostawcę mail jest już
  poza nami. Wypisanie działa od następnej wiadomości, a nie wstecz.
- Idempotencja przy równoległej dostawie tego samego zdarzenia opiera się na
  `unique (message_id, event_type)` i obsłudze konfliktu, nie na sprawdzeniu „czy istnieje" przed
  zapisem, bo między sprawdzeniem a zapisem mieści się drugi proces.

**Testy**

`tests/send-races.test.ts`, wszystkie na sandboxie, z co najmniej dwoma połączeniami:
- `delivered` przed `sent`: projekcja nie cofa się, oba zdarzenia w strumieniu;
- `bounced` przed `sent`: `current_state` pozostaje `bounced`;
- zdarzenie dla nieistniejącej wiadomości: odłożone, potem zastosowane;
- dwie równoległe dostawy tego samego zdarzenia: jeden wiersz, zero nieobsłużonych błędów;
- wypisanie po zbudowaniu listy: odmowa bramki i zero wywołań dostawcy;
- wypisanie anulujące zadania: wiadomości w `refused`, zadania zdjęte z kolejki;
- wypisanie po przyjęciu przez dostawcę: `sent` zostaje, kolejna wysyłka odmówiona;
- dwa workery na tej samej wiadomości: jedno `sending`, jedno wywołanie dostawcy.
