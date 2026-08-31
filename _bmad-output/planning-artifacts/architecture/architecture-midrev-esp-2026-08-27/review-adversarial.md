---
name: review-adversarial-midrev-esp
type: adversarial-review
target: ARCHITECTURE-SPINE.md (AD-1..AD-20)
sources:
  - './ARCHITECTURE-SPINE.md'
  - '../../../prd-midrev-esp-2026-08-27.md'
  - '../../../../../../midrev-esp/migrations/0001_init.sql'
date: '2026-08-27'
verdict: 'spine nie zamyka budowy: 25 par modułów zgodnych z AD-1..AD-20 co do litery buduje rzeczy niekompatybilne'
holes: 25
proposed_rules: 'AD-21 .. AD-46'
---

# Recenzja adwersaryjna: ARCHITECTURE-SPINE midrev-esp

## Metoda

Dla każdej pary modułów o poziom niżej (epik albo story tego produktu) sprawdzam, czy dwaj różni implementatorzy, obaj czytający AD-1..AD-20 dosłownie i obaj przechodzący review, zbudują rzeczy, które da się złożyć. Test nie polega na szukaniu naruszeń AD. Polega na szukaniu miejsc, w których **przestrzeganie AD nie wystarcza**, bo spine nie rozstrzyga, kto jest właścicielem bytu, jaki jest kształt wspólnych danych, która ścieżka ma prawo zmienić stan i co się dzieje w oknie czasowym między dwiema operacjami.

Wynik: **25 dziur**. Każda z nich to konkretna para modułów z listy: ingest zamówień, import historyczny, import z Klaviyo, budowanie segmentu, wysyłka kampanii, webhook dostawcy, atrybucja, skrypt on-site, akceptacja przez klienta, warmup, metering, kontrola zgodności, RODO, automatyzacje.

Numeracja proponowanych reguł: AD-21 .. AD-46, żeby dało się je dopisać do spine bez renumeracji.

---

## Podsumowanie: pięć najgroźniejszych

| # | Dziura | Reguła zamykająca |
|---|---|---|
| D-8 | Port `EmailProvider` nie ma klucza idempotencji, a AD-6 nie mówi, kiedy commitować, więc worker wysyłki zabity w połowie partii wyśle tym samym ludziom drugi raz, mimo pełnej zgodności z AD-5 i AD-6 | AD-28 |
| D-15 | AD-9 sprawdza wykluczenia przy **budowie listy**, a nie przy wysyłce, więc każdy, kto wypisze się między akceptacją klienta a startem kampanii, dostaje maila mimo FR51 „natychmiast" | AD-36 |
| D-10 | Klucz idempotencji z AD-4 jest w webhooku pochodną kanału, a w imporcie historycznym pochodną czegoś innego, więc to samo zamówienie wchodzi dwa razy dwiema drogami i podwaja przychód w raporcie | AD-30 |
| D-13 | FR58 pozwala zmienić okno atrybucji, a rekord atrybucji nie nosi wersji reguły, więc raport jednej kampanii miesza dwa okna i liczba u klienta zmienia się bez wyjaśnienia | AD-33, AD-34 |
| D-6 | AD-16 zakazuje `UPDATE` na `messages`, a AD-6 wymaga przejść stanu na tym samym rekordzie: worker wysyłki i handler webhooka dostawcy piszą ten sam wiersz i przy wyścigu `sent` nadpisuje `delivered` bez błędu | AD-26 |

---

## A. Dwóch właścicieli tego samego bytu

### D-1. Kto tworzy i nadpisuje profil: ingest sklepu vs import z Klaviyo vs klik

**Moduł A: `jobs/ingest` + `adapters/store/woo` (FR12, FR19).** Zamówienie z Woo niesie `billing.email`, imię, nazwisko, telefon, miasto. Use-case `upsert-profile-from-store-customer` scala po znormalizowanym adresie (FR19), przyjmuje `tenantId` pierwszym argumentem (AD-2), zapisuje przez repozytorium (AD-3, AD-18), ustawia `occurred_at` z daty zamówienia (AD-10). Zgodny z każdym AD.

**Moduł B: `app/import` + `jobs/import` (FR62, FR64).** Eksport z Klaviyo niesie ten sam adres plus imię, telefon, kraj, datę i źródło zgody. Use-case `import-klaviyo-contact` deduplikuje po znormalizowanym adresie (FR64), `tenantId` pierwszym argumentem, `occurred_at` z daty zapisu w Klaviyo. Też zgodny z każdym AD.

**Gdzie się rozjeżdżają.** Żaden AD nie mówi, czyja wartość wygrywa, gdy oba moduły mają zdanie na temat tego samego pola. Woo mówi `Jan`, Klaviyo mówi `Janek`, telefon w Woo jest z fakturą, w Klaviyo z popupu. Wynik zależy od **kolejności uruchomienia**, a ta jest inna u każdego tenanta: u jednego operator najpierw podłącza sklep, u drugiego najpierw importuje listę. Ten sam produkt daje dwa różne profile na tych samych danych i nikt tego nie zauważy, bo obie ścieżki przeszły review. Trzeci właściciel dochodzi w fazie 3 z popupem (`popup.submitted` jest już w konwencjach spine, choć epik F jest wycięty z MVP), a czwarty to endpoint kliku, który dostaje token i profil.

**Reguła zamykająca. AD-21 (nowy):** *Każde pole profilu ma zadeklarowanego właściciela w postaci listy priorytetów źródeł (`store` > `esp_import` > `onsite` > `manual`) zapisanej w domenie, a nie w adapterze. Zapis do profilu odbywa się wyłącznie przez funkcję `mergeProfile(current, incoming, source)`, która dla każdego pola stosuje priorytet, a przy równym priorytecie wygrywa nowsze `occurred_at`, nigdy nowsze `recorded_at`. Adapter nie zapisuje profilu, tylko zwraca `ProfilePatch` z etykietą źródła. Nadpisanie wartości źródła wyższego priorytetu przez niższe jest błędem zapisu, nie cichym pominięciem.*

### D-2. Kto ustala aktualny stan zgody, skoro `consents` jest append-only

**Moduł A: `jobs/ingest`.** Checkout Woo z zaznaczonym `marketing_opt_in` produkuje wpis zgody z `occurred_at` = data zamówienia, źródło `woo_checkout`. AD-16 spełnione: tylko `INSERT`.

**Moduł B: `app/import`.** Eksport z Klaviyo produkuje wpis z `occurred_at` = data zgody w Klaviyo (starsza), źródło `klaviyo_export`. AD-16 spełnione: tylko `INSERT`.

**Gdzie się rozjeżdżają.** AD-16 mówi, jak zapisywać, i nie mówi ani słowa, **jak odczytać stan bieżący**. Moduł segmentacji (`app/segments`) policzy „ma zgodę" jako „istnieje wpis z `granted = true`", moduł wysyłki (`app/audience`) policzy jako „najnowszy wpis po `occurred_at` ma `granted = true`", a moduł raportowy jako „najnowszy po `recorded_at`". Trzy liczby, trzy różne listy odbiorców, wszystkie legalne. Przy wpisie wycofania zgody z datą historyczną (bo klient wypisał się w Klaviyo w czerwcu, a import robimy w sierpniu) różnica między `occurred_at` a `recorded_at` decyduje o tym, czy wyślemy maila do osoby wypisanej. To jest ryzyko z pierwszej trójki PRD, a spine go nie domyka.

**Reguła zamykająca. AD-22 (nowy):** *Stan zgody nie jest odczytywany zapytaniem ad hoc. Istnieje dokładnie jedna funkcja domenowa `currentConsent(profileId, channel)` oraz dokładnie jeden widok/zapytanie repozytorium, które ją realizuje: wygrywa wpis o najwyższym `occurred_at`, a przy remisie wpis odmawiający. Każdy moduł pytający o zgodę woła tę funkcję. Zapytanie o `consents` inne niż przez nią nie przechodzi review.*

### D-3. Tożsamość anonimowa: skrypt on-site tworzy stan, którego CDP nie umie przyjąć

**Moduł A: `site-script` + `api/track` (FR56, AD-19).** Skrypt wiąże sesję z profilem na podstawie znacznika z linku. Kiedy znacznika nie ma (odbiorca wszedł z Google), skrypt ma sesję bez tożsamości. Zgodnie z AD-19 kontrakt danych jest wstecznie zgodny i wersjonowany.

**Moduł B: `jobs/ingest` (FR19).** Scala zdarzenia w profil **po znormalizowanym adresie e-mail**. Zdarzenie bez adresu nie ma do czego się przykleić.

**Gdzie się rozjeżdżają.** `events.profile_id` w istniejącym `0001_init.sql` jest nullowalny, więc zdarzenia anonimowe wylądują w tabeli luzem. Kiedy ta sama osoba złoży zamówienie, ktoś musi je przypiąć wstecz, czyli wykonać `UPDATE events SET profile_id = ...`. To nie jest zabronione przez AD-16 (events nie są na liście chronionej), ale ma trzy skutki, których żaden AD nie przewiduje: liczebność segmentu zmienia się wstecz bez zdarzenia wyzwalającego, job atrybucji (AD-14) mógł już przelecieć po kliknięciu nieprzypisanym i zapisać brak atrybucji, a kontrola zgodności (NFR5) porównuje ruchomy cel. Dwa moduły, obydwa zgodne z AD, jeden zostawia stan, którego drugi nie umie odczytać deterministycznie.

**Reguła zamykająca. AD-23 (nowy):** *Tożsamość anonimowa jest osobnym bytem (`identities`: `anonymous_id`, opcjonalny `profile_id`), a nie profilem z pustym adresem. Zdarzenia wskazują na `identity_id`, nigdy bezpośrednio na profil. Zszycie tożsamości z profilem jest zapisem zdarzenia `identity.linked` z `occurred_at` momentu zszycia, a nie wstecznym `UPDATE` zdarzeń. Każda projekcja czytająca zdarzenia profilu (segment, atrybucja, raport) czyta je przez rozwiązanie łańcucha tożsamości, dzięki czemu wynik jest ten sam niezależnie od tego, kiedy nastąpiło zszycie.*

---

## B. Sprzeczne kształty wspólnych danych

### D-4. Słownik nazw zdarzeń jest otwarty, więc segment na Shoperze po cichu zwraca zero

**Moduł A: `adapters/store/woo`.** Deweloper mapuje webhooki Woo na `order.created`, `order.updated`, `order.refunded`, `cart.abandoned`. Nazwy w formie `rzeczownik.czas_przeszły`, zgodnie z konwencją. Deklaruje `capabilities` (AD-8). Komplet.

**Moduł B: `adapters/store/shoper` (faza 3, FR16).** Shoper nie ma webhooka zwrotu i prawdopodobnie nie ma porzuconego koszyka (`Deferred` w spine to potwierdza). Deweloper mapuje to, co jest: `order.created`, `order.status_changed`. Nazwy w tej samej formie, `capabilities` zadeklarowane, wspólne testy akceptacyjne z AD-8 przechodzą, bo one sprawdzają kontrakt `Customer/Order/Product`, a nie słownik zdarzeń.

**Gdzie się rozjeżdżają.** Konwencja mówi „nazwa zdarzenia jest kontraktem, zmiana wymaga nowej nazwy", ale nie mówi, **kto ten słownik ustala i czy jest zamknięty**. Adapter jest naturalnym miejscem, w którym powstaje nazwa, bo tylko adapter wie, co platforma przysyła. Efekt: segment „zwrócił zamówienie w 90 dni" napisany na Woo (`order.refunded`) na Shoperze zwraca pustkę. Nie błąd. Pustkę. Operator wysyła kampanię do zera osób i dowiaduje się o tym po raporcie. FR17 obiecuje, że operator zobaczy, czego platforma nie dostarcza, ale bez zamkniętego słownika nie ma czego z czym porównać.

**Reguła zamykająca. AD-24 (nowy):** *Słownik nazw zdarzeń jest zamknięty i mieszka w `domain/events/catalog.ts` jako typ sumaryczny. Adapter platformy nie wprowadza nazwy: mapuje sygnał platformy na istniejącą nazwę albo deklaruje w `capabilities`, że jej nie dostarcza. Dołożenie nazwy do katalogu to zmiana w domenie, przechodząca przez przegląd wpływu na segmenty i automatyzacje. Adapter emitujący nazwę spoza katalogu nie przechodzi wspólnych testów akceptacyjnych.*

**Reguła zamykająca. AD-25 (nowy):** *Definicja segmentu i definicja automatyzacji deklarują wprost zbiór nazw zdarzeń, których wymagają. Przy zapisaniu reguły system porównuje ten zbiór z `capabilities` adaptera tenanta. Reguła wymagająca zdarzenia, którego platforma nie dostarcza, jest odrzucana jako błąd konfiguracji z nazwaniem brakującego zdarzenia. Pusty wynik nigdy nie jest dopuszczalną odpowiedzią na brak możliwości platformy.*

### D-5. `payload` zdarzenia to `jsonb` bez schematu, więc dwa adaptery wkładają tam co innego

**Moduł A: `adapters/store/woo`.** `payload` zamówienia: `{ total: 12300, currency: "PLN", line_items: [{ product_id, qty, price }] }`. AD-11 spełnione, bo kwota jest integerem w groszach.

**Moduł B: `adapters/store/shoper`.** Shoper zwraca kwoty jako napisy z kropką i osobno netto/brutto. Deweloper wkłada `{ total_gross: "123.00", vat: "23.00", currency: "PLN", products: [...] }`. AD-11 formalnie **nie jest naruszone**: mówi o „zamówieniach, przychodzie, atrybucji, meteringu", a to jest surowy payload zdarzenia, nie encja `orders`. Zod na granicy adaptera (konwencja walidacji) waliduje własny schemat adaptera, więc też przechodzi.

**Gdzie się rozjeżdżają.** Segmenty (AD-18, ręczny SQL) sięgają do `payload` po atrybuty, na których nie ma kolumn: kategoria produktu, kod rabatowy, kanał zamówienia. SQL napisany na kształcie Woo (`payload->'line_items'`) na Shoperze zwraca null i cicho nie kwalifikuje nikogo. Ten sam problem dotyczy zdarzeń dostawcy wysyłki: `email.bounced` z jednym dostawcą niesie `bounce_type`, z innym `reason_code`, a AD-7 mówi tylko, że port ma `parseWebhook`, nie mówi, na jaki kształt.

**Reguła zamykająca. AD-25a, zapisana jako AD-25 rozszerzone o kształt (nowy fragment):** *Każda nazwa zdarzenia z katalogu ma przypisany schemat zodowy payloadu w `domain/events/schemas/` z numerem wersji (`v1`, `v2`). Adapter mapuje na ten schemat i jego wynik jest walidowany przed zapisem do loga domenowego. Rozszerzanie schematu jest wyłącznie dodawaniem pól opcjonalnych; zmiana typu albo znaczenia pola wymaga nowej wersji, a stara wersja pozostaje odczytywalna. Zapytania segmentacyjne odwołują się do pól schematu, nigdy do surowego kształtu platformy, który zostaje w `raw_events`.*

---

## C. Dwie ścieżki mutacji tego samego stanu

### D-6. AD-16 kontra AD-6, czyli status wiadomości. Rozstrzygnięcie: sprzeczność jest realna

**Moduł A: `jobs/send`.** Po udanym wywołaniu dostawcy ustawia `sent`. AD-6 mówi wprost: „stan zmienia się jednokierunkowo `queued → sent → delivered|bounced|complained`". Implementacja: `UPDATE messages SET status = 'sent' WHERE id = $1`.

**Moduł B: `api/webhooks/esp` + `jobs/ingest-esp` (FR48).** Dostawca przysyła `delivered`, potem ewentualnie `bounced` albo `complained`. Implementacja: `UPDATE messages SET status = 'delivered' WHERE id = $1`.

**Rozstrzygnięcie sprzeczności.** AD-16 mówi: „brak `UPDATE` i `DELETE` na tych tabelach poza ścieżką RODO", a `messages` jest na liście objętych. Jednokierunkowa zmiana stanu **jest** `UPDATE`. To nie jest sprzeczność pozorna. Da się ją rozbroić tylko przez rozdzielenie bytów, a spine tego nie robi, więc każdy implementator rozbroi ją po swojemu: jeden uzna, że AD-16 dotyczy „treści wiadomości, nie statusu", drugi doda kolumnę `status` i nie pomyśli o AD-16 w ogóle, trzeci zrobi log zdarzeń, a status wyliczy. Trzy niekompatybilne schematy.

**Gdzie się rozjeżdżają operacyjnie.** Wyścig jest realny, nie teoretyczny. Postmark i SES potrafią dostarczyć webhook `delivered` w kilkadziesiąt milisekund od przyjęcia wiadomości. Worker wysyłający partię wywołuje API dla 200 odbiorców i commituje statusy po pętli (bo tak jest wydajniej i AD nie zabrania). Webhook `delivered` przychodzi w międzyczasie i zapisuje `delivered`, a chwilę potem worker nadpisuje go na `sent`. Wiadomość jest w bazie na zawsze w stanie wcześniejszym niż faktyczny, żaden błąd nie jest zgłoszony, oba zapisy były zgodne z AD-6. Ten sam mechanizm zjada `bounced`, czyli **wpis do wykluczeń jest, ale historia wysyłki mówi `sent`** i kontrola zgodności tego nie wychwyci.

**Reguła zamykająca. AD-26 (zaostrzenie AD-6 i AD-16, zastępuje sporne zdanie w obu):** *`messages` jest niemutowalny: wiersz powstaje raz, z `id`, `campaign_id`, `profile_id`, `email_hash`, `created_at`, i nigdy nie jest aktualizowany ani kasowany. Stan wiadomości żyje wyłącznie w append-only `message_events (message_id, event_type, occurred_at, provider_id, payload)` z unikalnością `(message_id, event_type)`. Kolumna `messages.current_state` może istnieć wyłącznie jako projekcja utrzymywana przez jeden use-case `record-message-event`, zapisem `UPDATE ... WHERE state_rank < $new_rank`, gdzie ranga stanów jest monotoniczna i zadeklarowana w domenie. Żaden inny kod nie pisze do tej kolumny. Zdarzenie o randze niższej niż bieżąca jest zapisywane do loga i pomijane w projekcji, nigdy nie cofa stanu.*

### D-7. Słownik stanów wiadomości jest niepełny, więc licznik w raporcie kłamie

**Moduł A: `app/audience/build-recipients` (AD-9).** Odsiewa wykluczonych. Odsianych nigdzie nie zapisuje, bo AD-6 zna tylko `queued → sent → delivered|bounced|complained` i nie ma stanu na „odsiany".

**Moduł B: `app/reports` (FR59, NFR2).** Raportuje wysyłkę kampanii. Liczy wiersze w `messages`.

**Gdzie się rozjeżdżają.** Kampania na segment 10 000 osób, z czego 900 jest na wykluczeniach, 300 nie ma zgody, 1 200 nie zmieściło się w dobowym limicie warmupu, a 40 odbił dostawca twardym błędem po wyczerpaniu prób. Zgodnie z AD-6 nie ma stanu dla żadnej z tych czterech grup. Implementator albo nie utworzy dla nich wierszy (i wtedy FR65 „operator widzi, którzy odbiorcy otrzymali daną kampanię" nie ma odpowiedzi dla trybu równoległego, a NFR2 „licznik pokazuje faktyczny wynik" jest złamane), albo utworzy je w `queued` i zostawi na zawsze (i wtedy raport pokaże 10 000 „wysłanych", z czego wyszło 7 560). To jest dokładnie punkt 4 z listy kontrolnej projektu: „log ma mówić prawdę".

**Reguła zamykająca. AD-27 (zaostrzenie AD-6):** *Słownik stanów wiadomości jest pełny i zamknięty: `queued`, `held` (z powodem i warunkiem zwolnienia), `suppressed` (z powodem i zasięgiem), `sending`, `sent`, `delivered`, `bounced`, `complained`, `failed` (z kodem po wyczerpaniu prób), `cancelled`. Każdy adresat rozważany w kampanii ma dokładnie jeden wiersz w `messages` niezależnie od tego, czy wiadomość wyszła. Raport i metering liczą stany, nigdy liczbę adresatów ani liczbę prób, a suma stanów zawsze równa się liczebności listy w momencie budowy.*

### D-8. Port `EmailProvider` bez klucza idempotencji, więc restart w połowie partii wysyła drugi raz

**Moduł A: `jobs/send`.** Handler idempotentny w rozumieniu AD-5: przy ponowieniu bierze tylko wiersze w stanie `queued`, więc „nie wyśle drugi raz". Rekord powstaje przed wywołaniem dostawcy, zgodnie z AD-6. Unikalność `(campaign_id, profile_id)` w bazie. Pełna zgodność.

**Moduł B: `adapters/email/{dostawca}`.** Implementuje port z AD-7: `send`, `verifyDomain`, `listDomainRecords`, `parseWebhook`, `quotaStatus`. `send` przyjmuje adres, temat, treść i wywołuje API dostawcy. Pełna zgodność z AD-7, bo AD-7 wylicza sygnatury i nie wspomina o idempotencji.

**Gdzie się rozjeżdżają.** Sekwencja per odbiorca to: wywołaj dostawcę, potem zapisz `sent`. Proces ginie między jednym a drugim (deploy, OOM, restart hosta, którego wybór jest w spine odłożony). Po podniesieniu wiersz jest nadal w `queued`, więc „idempotentny" handler wyśle ponownie. Po stronie dostawcy nie ma nic, co by to zatrzymało, bo `send` nie przekazał klucza idempotencji. NFR15 („żaden odbiorca nie dostaje wiadomości dwa razy") jest niewykonalne przy porcie w kształcie z AD-7. Wariant z commitowaniem całej partii po pętli pogarsza to o dwa rzędy wielkości: ginie 200 wysyłek naraz.

**Reguła zamykająca. AD-28 (zaostrzenie AD-6 i AD-7):** *`EmailProvider.send` przyjmuje obowiązkowy `idempotencyKey` równy publicznemu identyfikatorowi wiadomości (`msg_<uuid>`), a adapter ma obowiązek przekazać go dostawcy w polu, które dostawca honoruje; dostawca bez obsługi idempotencji nie kwalifikuje się do wyboru i jest to kryterium w otwartym researchu kosztowym. Cykl jednej wiadomości to jedna transakcja: przejście `queued → sending` z zapisem `attempt_no` i `claimed_at` następuje przed wywołaniem, a `sending → sent` z `provider_id` bezpośrednio po nim. Partia nigdy nie jest jedną transakcją. Wiadomość zastana w `sending` dłużej niż limit jest przed ponowieniem sprawdzana u dostawcy po `idempotencyKey`, a nie wysyłana w ciemno.*

### D-9. Odwołanie kampanii w trakcie nie zatrzymuje partii już pobranej przez workera

**Moduł A: `app/campaigns/cancel-campaign` (FR37).** Ustawia kampanię na `cancelled`. `campaigns` nie jest na liście chronionej AD-16, więc `UPDATE` jest legalny. Mutacja przez use-case (AD-3), z server action (AD-17). Komplet.

**Moduł B: `jobs/send`.** Pobrał job partii przez `SELECT ... FOR UPDATE SKIP LOCKED` (AD-5), przetwarza 500 odbiorców. Żaden AD nie każe mu w trakcie pętli sprawdzać, czy kampania nadal żyje.

**Gdzie się rozjeżdżają.** Operator klika „wstrzymaj", panel pokazuje „wstrzymana", a maile lecą dalej do końca bieżącej partii i wszystkich partii już zakolejkowanych. Przy scenariuszu ze ścieżki 2 PRD („kampania idzie w spam, complaint rate przekracza próg") to jest różnica między zatrzymaniem na 2 000 a wysłaniem 40 000, czyli między uratowaną a spaloną domeną. FR49 (automatyczne wstrzymanie po progu skarg) ma dokładnie ten sam problem, bo zapisuje ten sam stan.

**Reguła zamykająca. AD-29 (nowy):** *Wstrzymanie jest bramką sprawdzaną per wiadomość, nie per job. Przejście `queued → sending` z AD-28 odbywa się w transakcji, która w tym samym zapytaniu sprawdza `campaigns.stop_requested_at is null` oraz stan wstrzymania tenanta; niespełniony warunek zapisuje `cancelled` z powodem zamiast wysyłać. Partia ma górny limit rozmiaru zapisany w konfiguracji, a interfejs pokazuje „zatrzymywanie" do momentu, w którym worker potwierdzi zamknięcie ostatniej pobranej partii, nigdy „wstrzymana" na podstawie samego zapisu intencji.*

### D-25. AD-4 każe odpowiedzieć 200, a FR13 każe odrzucić niepodpisane

**Moduł A: `api/webhooks/woo`.** AD-4: „endpoint zapisuje surowe zdarzenie do niezmiennego logu z kluczem idempotencji i odpowiada 200". Implementator pisze to dosłownie: zapis, potem 200, weryfikacja HMAC przeniesiona do joba, bo NFR22 daje 500 ms i weryfikacja miałaby się nie zmieścić.

**Moduł B: `app/security/verify-store-webhook` (FR13).** „System weryfikuje autentyczność przychodzących zdarzeń sklepowych i odrzuca niepodpisane". Implementator odrzuca przed zapisem.

**Gdzie się rozjeżdżają.** Adres webhooka jest publiczny. W wariancie A niezmienny log (którego z definicji nie czyścimy) przyjmuje wszystko, co ktoś wyśle na ten URL, łącznie z zalewem od bota. Kontrola zgodności z NFR5 zaczyna liczyć śmieci, a AD-4 nie przewiduje ścieżki usunięcia z niezmiennego logu. W wariancie B tracimy log żądań z zepsutym podpisem, czyli jedyny materiał do diagnozy, gdy merchant zmieni sekret. Dwóch implementatorów, dwa różne zachowania endpointu tej samej klasy, obydwa dają się obronić literą spine.

**Reguła zamykająca. AD-46 (zaostrzenie AD-4):** *Weryfikacja podpisu i rozpoznanie tenanta poprzedzają zapis do loga surowego. Żądanie odrzucone trafia do osobnej, rotowanej tabeli `rejected_webhooks` z limitem retencji i licznikiem per źródło, nigdy do `raw_events`, a odpowiedź to 401. 200 z AD-4 dotyczy wyłącznie żądania uwierzytelnionego. Wzrost odrzuceń powyżej progu jest alertem (NFR38), bo w praktyce oznacza rotację sekretu po stronie sklepu, czyli cichą utratę zdarzeń.*

---

## D. Stan, który przetrwa restart w niespójnej postaci

### D-23. Warmup i limit dobowy kontra kampania utworzona w całości

**Moduł A: `jobs/send` (AD-6).** Tworzy wiersze `messages` dla całego segmentu z góry, bo unikalność `(campaign_id, profile_id)` ma chronić przed duplikatem po restarcie i musi istnieć przed pierwszym wywołaniem dostawcy.

**Moduł B: `app/deliverability/warmup` (FR46, FR52).** Wymusza rosnący limit dobowy dla nowej domeny i limit wolumenu tenanta w oknie.

**Gdzie się rozjeżdżają.** Kampania na 10 000 przy dobowym limicie warmupu 1 500 zostawia 8 500 wierszy w `queued`, których żaden stan nie tłumaczy. Po restarcie procesu nie da się odróżnić „czeka na jutrzejszą kwotę" od „nigdy nie wystartowała" ani od „worker padł w połowie". NFR23 (10 tys. w 30 minut) i FR46 (warmup) wypowiadają sprzeczne oczekiwania i spine nie mówi, które wygrywa. Raport pokazuje 10 000 „w kampanii" i klient widzi liczbę, która nie ma pokrycia.

**Reguła zamykająca. AD-44 (nowy):** *Limit warmupu i limit dobowy tenanta są rezerwowane w transakcji przejścia `queued → sending`, nie przy budowie partii. Wiadomość, dla której kwoty brakuje, przechodzi w `held` z powodem `warmup_quota` i jawnym `release_after`, i jest to stan trwały, czytelny po restarcie. NFR23 obowiązuje wyłącznie dla wysyłki nieograniczonej planem warmupu i jest tak zapisane w raporcie. Kampania wielodobowa jest tym nazwana w interfejsie od momentu startu, z prognozą daty zakończenia.*

---

## E. Reguły, które kolidują ze sobą

### D-16. FR30 pozwala adminowi zdjąć wykluczenie, AD-16 zakazuje `DELETE` na `suppressions`

**Moduł A: `app/suppressions/remove-entry` (FR30).** „Administrator może usunąć wpis z listy wykluczeń; operator i klient nie mogą". Naturalna implementacja to `DELETE FROM suppressions WHERE ...` z kontrolą roli.

**Moduł B: strażnik AD-16.** „Brak `UPDATE` i `DELETE` na tych tabelach poza ścieżką RODO".

**Gdzie się rozjeżdżają.** To jest wprost sprzeczność między spine a PRD, nie między dwoma modułami. Rozstrzygnięcie: rację ma AD-16, ale FR30 opisuje realną potrzebę (adres trafił na wykluczenia przez pomyłkę operatora albo przez fałszywą skargę). Jedyne wyjście, które zachowuje jedno i drugie, to zapis odwracający zamiast kasowania. Bez zapisania tego w spine implementator wybierze `DELETE`, a wtedy odpowiedź na pytanie „dlaczego wysłaliśmy do kogoś, kto zgłosił skargę" przestaje istnieć w bazie.

**Reguła zamykająca. AD-37 (zaostrzenie AD-16 i doprecyzowanie FR30):** *Zdjęcie wykluczenia nie kasuje wpisu. Jest zapisem zdarzenia `suppression.lifted` z identyfikatorem admina, powodem i `occurred_at`, w tej samej append-only tabeli. Stan bieżący wykluczenia to projekcja: adres jest wykluczony, jeśli ostatnie zdarzenie dla pary (zasięg, adres) to nałożenie. Zdjęcie wykluczenia założonego z powodu skargi (`complaint`) wymaga dodatkowo jawnego potwierdzenia i idzie alertem na kanał techniczny.*

### D-17. Wykluczenie bez zasięgu: wypisanie u tenanta A blokuje wysyłkę u tenanta B, nieodwracalnie

**Moduł A: `api/unsubscribe` (FR50, FR51).** Wypisanie natychmiastowe, jednym kliknięciem. Zapisuje do `suppressions`.

**Moduł B: `api/webhooks/esp` (FR48).** Twarde odbicie i skarga też zapisują do `suppressions`.

**Gdzie się rozjeżdżają.** Istniejący `0001_init.sql` ma `suppressions` **bez `tenant_id`**, z `unique (lower(btrim(email)))` i komentarzem, że globalność jest decyzją celową. Diagram ERD w spine pokazuje `TENANTS ||--o{ SUPPRESSIONS`, czyli per tenant. PRD FR28 wymaga obu list naraz. Trzy dokumenty, trzy modele. Skutek przy modelu z migracji: ta sama osoba jest klientką dwóch sklepów obsługiwanych przez MidRev, wypisuje się z newslettera sklepu A i przestaje dostawać maile ze sklepu B, na które ma ważną zgodę. Jest to jednocześnie strata dla klienta B i błąd zgodności w drugą stronę (przetwarzamy zgodę, której nie honorujemy). AD-16 sprawia, że nie da się tego cofnąć bez ścieżki z D-16. Odwrotny wariant, w którym wszystko jest per tenant, oddaje reputację platformy: adres, który wypalił się skargą u jednego tenanta, dostaje maila od kolejnego.

**Reguła zamykająca. AD-38 (nowy, wymaga migracji 0002):** *Wykluczenie ma obowiązkowy zasięg i powód. Zasięg `tenant` obejmuje wypisanie i ręczne dodanie przez operatora. Zasięg `global` obejmuje twarde odbicie, skargę na spam i trafienie w spamtrap, czyli wszystko, co jest sygnałem o adresie, a nie o relacji z jednym sklepem. Unikalność to `(scope, tenant_id, email_hash)` z `tenant_id` pustym dla zasięgu globalnego. Bramka wysyłki z AD-9 sprawdza oba zasięgi jednym zapytaniem. Zmiana klasyfikacji powodu na inny zasięg wymaga migracji i przeliczenia, nigdy edycji wpisu.*

### D-18. RODO kontra append-only: adres w plaintekście, którego nie wolno skasować

**Moduł A: `app/gdpr/erase-profile` (FR22).** Anonimizuje profil, zostawia przychód zanonimizowany. AD-16 to wprost dopuszcza jako „ścieżkę RODO".

**Moduł B: `suppressions`.** Trzyma `email` jako tekst z unikalnym indeksem po `lower(btrim(email))` i zgodnie z AD-16 nie wolno go skasować.

**Gdzie się rozjeżdżają.** Po realizacji żądania usunięcia adres e-mail osoby, która o to poprosiła, zostaje w bazie w postaci jawnej, w tabeli objętej zakazem usuwania i ciągłą ochroną z odtwarzaniem do punktu w czasie. To nie jest teoretyczne: jest to pierwsze pytanie, które zada audytor po stronie klienta przy podpisywaniu umowy powierzenia. Druga strona tej samej dziury: osoba usunięta wraca do sklepu, kupuje, ingest zakłada jej nowy profil, wykluczenie po adresie nadal działa, a historia zgody została przy poprzedniej tożsamości, więc nikt w systemie nie umie wyjaśnić, dlaczego świeżo zapisana osoba nie dostaje maili.

**Reguła zamykająca. AD-39 (zaostrzenie AD-16 i FR22):** *Wykluczenia przechowują wyłącznie nieodwracalny skrót znormalizowanego adresu (HMAC-SHA256 z kluczem instancji) w kolumnie `email_hash`, nigdy adresu jawnego; bramka wysyłki porównuje skróty. Dzięki temu wpis wykluczenia przestaje być daną osobową do usunięcia i zakaz kasowania z AD-16 nie koliduje z prawem do bycia zapomnianym. Anonimizacja profilu zostawia `email_hash` w profilu, więc powrót tego samego adresu jest rozpoznawany: system tworzy nowy profil i pokazuje operatorowi, że dla tego skrótu istnieje wcześniejsza, zanonimizowana tożsamość wraz z jej stanem wykluczenia.*

### D-21. Fundament oznaczony `[ADOPTED]` łamie AD-10 i AD-15, a AD-12 zabrania go poprawić

**Moduł A: dowolny moduł piszący zdarzenia.** Zgodnie z AD-10 podaje `occurred_at` jawnie i zgodnie z AD-15 generuje UUIDv7 po stronie aplikacji.

**Moduł B: dowolny inny moduł piszący zdarzenia.** Pomija `id` i `occurred_at` w `INSERT`, bo `0001_init.sql` ma `id uuid primary key default gen_random_uuid()` oraz `occurred_at timestamptz not null default now()`. Kod się kompiluje, testy przechodzą, review nie widzi braku, bo brak jest niewidoczny.

**Gdzie się rozjeżdżają.** AD-10 mówi „zapis bez `occurred_at` jest błędem, nie wartością domyślną", a baza aktywnie zapewnia wartość domyślną. To jest ten sam mechanizm, który w historii projektu wpisał 72 zamówieniom datę backfillu zamiast historycznej, tyle że tym razem zabezpieczenie jest w dokumencie, a baza działa przeciwko niemu. Równolegle klucze będą mieszanką v4 i v7, więc każde założenie o monotoniczności identyfikatorów (jedyny powód wyboru v7) jest nieprawdziwe, a `[ADOPTED]` w AD-12 zabrania edycji `0001_init.sql`.

**Reguła zamykająca. AD-42 (nowy, wykonawczy):** *Migracja `0002` zdejmuje `default gen_random_uuid()` z każdej tabeli objętej AD-15 oraz `default now()` z każdej kolumny `occurred_at` objętej AD-10 i dodaje ograniczenie sprawdzające, że `occurred_at` mieści się w dopuszczalnym zakresie z AD-35. Do czasu jej zastosowania żaden moduł nie może polegać na monotoniczności identyfikatorów, a `recorded_at` pozostaje jedyną kolumną z wartością domyślną z bazy. Migracja jest warunkiem wejścia do Epiku B, nie zadaniem porządkowym.*

### D-19. Podgląd liczebności i budowa listy odbiorców jako dwa różne zapytania

**Moduł A: `app/segments/preview-count` (FR25, NFR21).** Ma zwrócić liczebność dla 200 tys. profili poniżej 5 sekund, więc implementator pisze zapytanie zoptymalizowane pod `count`, z pominięciem złączeń, które i tak nie zmieniają liczby.

**Moduł B: `app/audience/build-recipients` (AD-9).** Zwraca wiersze z adresami, po wykluczeniach i po sprawdzeniu zgody. Inne zapytanie, bo potrzebuje innych kolumn.

**Gdzie się rozjeżdżają.** Dwa ręcznie pisane SQL-e (AD-18) opisujące tę samą regułę rozjeżdżą się przy pierwszej zmianie definicji segmentu. Operator widzi 400, wysyła do 40 000 albo do 40. Ironia polega na tym, że FR47 (zatrzymanie wysyłki do segmentu nietypowo większego) jest zabezpieczeniem przed tym scenariuszem, a jego własna definicja jest nieokreślona: „nietypowo większy niż poprzednie" nie ma bazy odniesienia przy pierwszej wysyłce nowej kampanii, czyli dokładnie wtedy, kiedy jest potrzebny.

**Reguła zamykająca. AD-40 (nowy):** *Definicja segmentu kompiluje się do dokładnie jednej funkcji budującej zapytanie; podgląd liczebności i budowa listy odbiorców wołają tę samą funkcję, różniąc się wyłącznie projekcją (`count(*)` kontra kolumny) i nakładką wykluczeń. Drugi, „szybszy" wariant zapytania nie przechodzi review. Podgląd zwraca liczebność wraz ze znacznikiem czasu i identyfikatorem wersji definicji, a wysyłka odmawia startu, jeśli definicja zmieniła się po ostatnim podglądzie. Progiem z FR47 jest ostatnia wysyłka do tego samego segmentu, a przy jej braku bezwzględny próg z konfiguracji tenanta.*

---

## F. Luki czasowe

### D-10. Klucz idempotencji zależny od kanału: webhook i import historyczny wpuszczają to samo zamówienie dwa razy

**Moduł A: `api/webhooks/woo` (AD-4, FR12).** Klucz idempotencji buduje z tego, co ma pod ręką w żądaniu: nagłówka `X-WC-Webhook-Delivery-ID` albo skrótu ciała. Zgodne z AD-4 i NFR28.

**Moduł B: `jobs/import-history` (FR10, FR11).** Nie ma żadnych nagłówków webhooka, bo czyta REST-em po stronach. Klucz buduje z `woo:order:{id}:{date_modified}`. Też zgodne z AD-4 i NFR28.

**Gdzie się rozjeżdżają.** Operator podpina sklep i uruchamia import 12 miesięcy. Import trwa godzinę. W tym czasie przychodzą webhooki bieżących zamówień. Zamówienie złożone w trakcie importu może wejść oboma drogami, z dwoma różnymi kluczami, i **oba przejdą kontrolę idempotencji**, bo klucze porównuje się w jednej przestrzeni tekstowej. Efekt: podwójne zamówienie, podwójny przychód w raporcie kampanii, podwójny metering, a kontrola zgodności z NFR5 pokaże, że w bazie jest **więcej** zamówień niż w sklepie, co jest sytuacją, której nikt nie przewidział w scenariuszu „webhooki padły po cichu" i którą łatwo zignorować jako błąd pomiaru.

**Reguła zamykająca. AD-30 (zaostrzenie AD-4):** *Klucz idempotencji jest funkcją bytu źródłowego, nie kanału dostarczenia, i ma stały kształt `{platform}:{tenant_id}:{entity}:{external_id}:{source_version}`, gdzie `source_version` to `date_modified` albo odpowiednik z platformy. Ten sam byt przybyły webhookiem i importem daje ten sam klucz. Identyfikator dostarczenia (delivery id) zapisuje się obok, do diagnostyki, i nigdy nie jest częścią klucza. Adapter platformy dostarcza funkcję budującą klucz i jest ona wołana przez obie ścieżki.*

### D-11. Import historyczny nadpisuje świeższy stan, bo nie ma reguły „nowsza wersja wygrywa"

**Moduł A: `jobs/ingest` (webhook).** Zamówienie 1234 przechodzi w `completed` z kwotą po zwrocie. Zapis z `occurred_at` ze źródła (AD-10). Poprawnie.

**Moduł B: `jobs/import-history`.** Ta sama strona wyników REST została pobrana pięć minut wcześniej, gdy zamówienie było `processing` z pełną kwotą. Job zapisuje ją później, bo kolejka szła po kolei. `occurred_at` ze źródła, czyli data złożenia zamówienia. Też poprawnie.

**Gdzie się rozjeżdżają.** NFR29 mówi wprost „system nie zakłada kolejności przychodzących zdarzeń", ale spine nie daje żadnego mechanizmu, który by tę deklarację realizował przy **projekcji stanu bytu**. Starszy odczyt nadpisuje nowszy i zamówienie zostaje w bazie z kwotą sprzed zwrotu. AD-10 nie pomaga, bo `occurred_at` obu zapisów jest identyczne (to data złożenia zamówienia), a różni je wersja źródła, której nikt nie zapisuje.

**Reguła zamykająca. AD-31 (nowy):** *Każdy byt odwzorowany z platformy zewnętrznej ma kolumnę `source_version` (`date_modified` albo licznik wersji platformy). Zapis projekcji wykonuje się wyłącznie warunkowo: `... WHERE source_version < $incoming`. Zapis odrzucony jako starszy jest zliczany w metryce `stale_writes_skipped` i widoczny w podsumowaniu przebiegu, nigdy cicho porzucony. Platforma nieudostępniająca wersji wymaga jawnej decyzji zapisanej w `capabilities` adaptera, a nie domyślnego „ostatni zapis wygrywa".*

### D-13. Zmiana okna atrybucji w trakcie kampanii: jeden raport, dwa okna, brak śladu

**Moduł A: `app/settings/set-attribution-window` (FR58).** Operator zmienia okno tenanta z 5 na 14 dni. Mutacja przez use-case, przez server action, z walidacją. Komplet.

**Moduł B: `jobs/attribution` (AD-14).** „Job po zamówieniu szuka kwalifikującego kliknięcia w oknie tenanta i zapisuje rekord atrybucji". Czyta bieżącą wartość okna w momencie przetwarzania zamówienia. Komplet.

**Gdzie się rozjeżdżają.** Kampania wysłana w poniedziałek generuje zamówienia przez dwa tygodnie. Okno zmienione w środę sprawia, że zamówienia z poniedziałku i wtorku mają atrybucję liczoną na 5 dni, a od środy na 14. Raport kampanii sumuje jedno z drugim i nie ma żadnego pola, które by to ujawniło, mimo że FR60 obiecuje klientowi wyjaśnienie sposobu liczenia. AD-14 mówi „zmiana okna przelicza projekcję jawnie", ale nie mówi, co przelicza (wszystko wstecz? tylko kampanie trwające?), ani co widzi klient, który wczoraj miał 42 tys. przychodu, a dziś ma 61 tys. Przy produkcie, którego jedynym kryterium akceptacji jest „parytet z Klaviyo", to jest strzał w fundament zaufania.

**Reguła zamykająca. AD-33 (zaostrzenie AD-14):** *Okno atrybucji jest bytem wersjonowanym (`attribution_rules`: `tenant_id`, `window_days`, `effective_from`, `id`), a nie polem w ustawieniach tenanta. Każdy rekord atrybucji przechowuje `rule_id`, z którym powstał. Kampania, która rozpoczęła wysyłkę, ma regułę zamrożoną: zmiana okna nie działa wstecz na kampanie już wysłane, dopóki nie zostanie uruchomione jawne przeliczenie.*

**Reguła zamykająca. AD-34 (zaostrzenie AD-14):** *Przeliczenie atrybucji tworzy nowy `attribution_run` z zakresem, `rule_id` i znacznikiem czasu, i zapisuje nowe rekordy zamiast kasować stare; bieżący jest ten run, który jest oznaczony jako aktywny dla zakresu. Raport zawsze pokazuje okno i datę przeliczenia. Przeliczenie zmieniające przychód kampanii, którą klient już widział, wymaga potwierdzenia operatora i zostawia w raporcie widoczną adnotację ze starą i nową liczbą.*

### D-14. `occurred_at` z przeglądarki, czyli AD-10 wykonane dosłownie przeciwko sobie

**Moduł A: `api/click` (FR55).** Przekierowanie po stronie serwera. `occurred_at` to czas serwera, bo serwer jest źródłem tego zdarzenia. Zgodne z AD-10.

**Moduł B: `site-script` + `api/track` (FR56, AD-19).** Skrypt w przeglądarce raportuje zdarzenie sesji ze znacznikiem. AD-10 mówi „`occurred_at` pochodzi ze źródła i jest obowiązkowy przy zapisie", a źródłem jest przeglądarka, więc implementator przekazuje `Date.now()` klienta. Litera AD-10 spełniona.

**Gdzie się rozjeżdżają.** Zegar przeglądarki bywa przesunięty o godziny, a bywa o lata (urządzenia po resecie, kioski, boty). Job atrybucji (AD-14) pyta o kliknięcie w oknie N dni od zamówienia, więc zdarzenie z datą 2019 wypada z okna, a z datą 2027 wpada do każdego okna na zawsze. Do tego AD-19 mówi, że kontrakt skryptu zmienia się wyłącznie wstecznie zgodnie, więc raz wypuszczony zły kształt pola zostaje w przeglądarkach odbiorców na lata. Dwa moduły, dwie interpretacje słowa „źródło", jedna z nich zatruwa liczbę, na której stoi cały produkt.

**Reguła zamykająca. AD-35 (zaostrzenie AD-10):** *Czas pochodzący z niezaufanego źródła (przeglądarka, ciało żądania publicznego endpointu) nigdy nie jest `occurred_at`. Dla zdarzeń on-site `occurred_at` ustala serwer w chwili przyjęcia, a czas zgłoszony przez klienta ląduje w payloadzie jako `client_reported_at` i służy wyłącznie do diagnostyki. Dla źródeł zaufanych (API platformy sklepowej, webhook z poprawnym podpisem) `occurred_at` spoza zakresu od daty najstarszego dopuszczalnego importu do `now() + 5 min` jest odrzucane z alertem, nie zapisywane.*

### D-15. AD-9 sprawdza wykluczenia w złym momencie

**Moduł A: `app/audience/build-recipients` (AD-9, FR25, FR34).** „Jeden use-case buduje listę odbiorców i tylko on odpytuje wykluczenia". Lista powstaje przy planowaniu kampanii, bo operator musi zobaczyć liczebność przed wysłaniem do akceptacji (FR25, FR39).

**Moduł B: `api/unsubscribe` (FR51).** Wypisanie natychmiastowe, wpis do wykluczeń, zero opóźnienia.

**Gdzie się rozjeżdżają.** Ścieżka 3 z PRD zakłada, że klient akceptuje kampanię, a token żyje 7 dni (NFR10). Między budową listy a startem wysyłki mija realnie od kilku godzin do kilku dni, a sama wysyłka trwa do 30 minut (NFR23) albo kilka dni przy warmupie. Każda osoba, która wypisze się w tym oknie, dostanie maila, bo lista została odpytana wcześniej. FR51 obiecuje coś, czego AD-9 w tym kształcie nie realizuje. Skutek jest asymetryczny: kliknięcie „to spam" po wypisaniu się to najdroższy pojedynczy sygnał, jaki ten produkt może wygenerować.

Druga część tej samej dziury: AD-9 nazywa wykluczenia „jedyną bramą", ale odsiew ma **co najmniej pięć źródeł**: wykluczenie globalne, wykluczenie tenanta, brak zgody, rejestr trybu równoległego z Klaviyo (FR65) i limit warmupu (FR46). Trzy ostatnie nie są wykluczeniami, więc implementator z czystym sumieniem umieści je gdzie indziej, i „jedyna brama" przestaje być jedyna, zanim ktokolwiek naruszy AD-9.

**Reguła zamykająca. AD-36 (zaostrzenie AD-9):** *Lista odbiorców jest kandydatem, nie decyzją. Ostateczne sprawdzenie odbywa się w tej samej transakcji, w której wiadomość przechodzi `queued → sending` (AD-28), i tylko ono ma moc wiążącą. Sprawdzenie obejmuje jednym wywołaniem `canSendTo(tenantId, profileId, campaignId)` wszystkie źródła odsiewu: wykluczenie globalne, wykluczenie tenanta, stan zgody z AD-22, rejestr wysyłek trybu równoległego i limity z AD-44. Odmowa zapisuje `suppressed` albo `held` z powodem, nigdy ciche pominięcie. Nie istnieje drugi mechanizm odsiewu poza tą funkcją.*

### D-20. Kontrola zgodności liczy inaczej niż ingest, więc alarm z NFR5 zostanie wyciszony

**Moduł A: `jobs/monitor/reconcile` (FR14, NFR5).** Pyta Woo o liczbę zamówień w dobie i porównuje z bazą. Rozjazd powyżej 0,5 procent idzie alertem.

**Moduł B: `jobs/ingest`.** Zapisuje zamówienia, pomijając statusy `trash`, `draft` i `checkout-draft`, bo one nie są sprzedażą.

**Gdzie się rozjeżdżają.** Trzy niezależne przesunięcia, każde wystarczające samo w sobie. Po pierwsze doba: baza liczy w UTC (AD-10), a sklep w `Europe/Warsaw`, więc granica dnia różni się o dwie godziny i przy typowym rozkładzie zamówień wieczornych daje stały rozjazd rzędu kilku procent. Po drugie filtr statusów, którego kontrola nie zna, bo pyta o wszystko. Po trzecie moment pomiaru: zamówienia zmieniające status po północy migrują między dobami. Efekt jest gorszy niż brak kontroli: alarm dzwoni codziennie bez powodu, ktoś podnosi próg do 5 procent albo wycisza kanał, i wtedy realne padnięcie webhooków (ryzyko numer dwa w PRD) przechodzi niezauważone. Zabezpieczenie, które kłamie codziennie, jest gorsze niż jego brak, bo daje poczucie kontroli.

**Reguła zamykająca. AD-41 (nowy):** *Kontrola zgodności porównuje ten sam byt liczony tą samą definicją po obu stronach. Definicja (filtr statusów, pole daty, strefa czasowa sklepu) żyje w adapterze platformy jako jedna funkcja i jest wołana zarówno przez ingest, jak i przez kontrolę. Okno porównania jest wyrażone w strefie sklepu i domknięte co najmniej 6 godzin wstecz, żeby wykluczyć migrację statusów na granicy doby. Alert wyzwala wyłącznie rozjazd utrzymujący się po powtórnym odpytaniu, a raport kontroli podaje liczby po obu stronach i użytą definicję, nie sam procent.*

### D-12. Metering: dwa moduły, dwie definicje jednostki, licznik nieidempotentny

**Moduł A: `jobs/send`.** Po wysłaniu inkrementuje licznik tenanta: `UPDATE usage_counters SET sent = sent + 1`. `usage_counters` nie jest na liście AD-16, `UPDATE` jest legalny, handler „idempotentny" w rozumieniu implementatora, bo powtórne uruchomienie po prostu „doda jeszcze raz to, co trzeba".

**Moduł B: `app/usage` (FR70).** Liczy wysłane wiadomości i „aktywne profile" per tenant.

**Gdzie się rozjeżdżają.** Po pierwsze, `sent = sent + 1` nie jest idempotentne, a AD-5 gwarantuje dostarczenie at-least-once, więc każde ponowienie joba zawyża rachunek. To jest ta klasa błędu, którą AD-5 ma zapobiegać, i jednocześnie ta, którą jego własne brzmienie („każdy handler idempotentny") przepuszcza, bo słowo „idempotentny" nie zostało zdefiniowane operacyjnie. Po drugie, nikt nie ustalił jednostki rozliczeniowej: czy liczymy `sent`, czy `delivered`, czy `queued`? Worker policzy przy `sent`, a handler webhooka dostawcy przy `delivered`, i dwie liczby dla tego samego miesiąca będą się różnić o odbicia. Po trzecie, „aktywny profil" nie ma definicji, a to jest metryka, na której PRD opiera weryfikację całego modelu biznesowego („bez niego nie policzycie rentowności klienta"), przy czym historii zużycia nie da się odtworzyć wstecz.

**Reguła zamykająca. AD-32 (nowy):** *Liczniki zużycia są projekcją z niemutowalnego loga, nie inkrementem. Jednostką rozliczeniową jest zdarzenie `sent` w `message_events` (AD-26), liczone przez `count` po kluczu `(message_id, 'sent')`, więc powtórzenie joba nie zmienia wyniku. „Aktywny profil" ma jedną definicję zapisaną w domenie: profil, który w danym miesiącu ma zgodę i co najmniej jedno zdarzenie albo jedną wiadomość. Migawka zużycia jest zapisywana raz na dobę jako niemutowalny wiersz z `occurred_at`, żeby historia istniała niezależnie od możliwości przeliczenia.*

### D-22. Harmonogram bez strefy intencji i bez odpowiedzi na spóźnioną akceptację

**Moduł A: `app/campaigns/schedule` (FR36).** Zapisuje moment wysyłki. AD-10 mówi „zawsze UTC", więc implementator zapisuje `timestamptz` i tyle.

**Moduł B: `app/campaigns/approve` (FR39, FR40, FR41).** Klient akceptuje tokenem, bez logowania. FR41: kampania bez akceptacji nie wychodzi o zaplanowanej porze, a operator dostaje powiadomienie.

**Gdzie się rozjeżdżają.** Po pierwsze strefa: operator ustawia „wtorek 10:00" myśląc o odbiorcach w Polsce. Przy zapisie samego momentu UTC kampania po zmianie czasu wyjdzie o godzinę obok, a przy kampanii cyklicznej w fazie 2 rozjazd stanie się trwały. AD-10 zakazuje przechowywania czasu lokalnego i słusznie, ale nie każe przechowywać **intencji**, a to dwie różne rzeczy. Po drugie, FR41 kończy się na „nie wysyła i powiadamia" i nie mówi, co dalej. Implementator A zrobi tak, że akceptacja zwalnia wysyłkę natychmiast, więc klient klikający o 23:40 wyśle kampanię o 23:41. Implementator B zrobi tak, że kampania wymaga nowego terminu i zostanie niewysłana na zawsze, o czym nikt się nie dowie. Po trzecie, token jest jednorazowy (NFR10), a FR40 daje klientowi dwa przyciski: „zgłoś uwagi" zużywa token, więc po poprawkach potrzebny jest nowy, a stary podgląd pokazuje nieaktualną kreację, którą klient może w dobrej wierze zaakceptować.

**Reguła zamykająca. AD-43 (nowy):** *Zaplanowany moment zapisuje się jako para: chwila w UTC oraz strefa intencji w postaci identyfikatora IANA. Chwila jest przeliczana ze strefy intencji przy każdej zmianie definicji harmonogramu i przy zmianie czasu. Kampania, której okno startu minęło bez akceptacji, przechodzi w stan `expired_schedule` i nie startuje po późniejszej akceptacji: wymaga nowego terminu ustawionego przez operatora. Token akceptacji jest związany z wersją kreacji; zgłoszenie uwag unieważnia token i wersję, a nowa prośba o akceptację niesie nowy token i nową wersję. Akceptacja wersji innej niż bieżąca jest odrzucana z komunikatem.*

### D-24. Domena trackingowa per tenant kontra AD-2: skąd endpoint kliku bierze tenanta

**Moduł A: `app/onboarding/sending-domains` (FR43).** Zgodnie z sekcją Technical Constraints w PRD każdy tenant dostaje własny CNAME pod kliknięcia, bo wspólna domena trackingowa psuje dostarczalność wszystkim naraz.

**Moduł B: `api/click` (FR54, FR55, NFR11).** Publiczny endpoint bez sesji. Rozpoznaje wiadomość i profil po nieodgadywalnym znaczniku z linku, potem woła repozytorium, które zgodnie z AD-2 wymaga `tenantId` pierwszym argumentem.

**Gdzie się rozjeżdżają.** `tenantId` musi skądś przyjść, a jedyne dostępne wejścia to znacznik z URL-a i nagłówek `Host`. AD-2 mówi, że `tenantId` jest parametrem obowiązkowym, i milczy o tym, że **na ścieżkach publicznych pochodzi on z danych niezaufanych**. Implementator weźmie go ze znacznika i uzna sprawę za zamkniętą, bo test cross-tenantowy z AD-2 sprawdza repozytorium, a nie źródło argumentu. Skutek: znacznik tenanta A użyty na domenie trackingowej tenanta B odczyta i zapisze dane tenanta A, czyli izolacja jest formalnie zachowana w warstwie danych i faktycznie złamana na wejściu. Ten sam kształt dotyczy `api/unsubscribe` i tokenu akceptacji kampanii.

**Reguła zamykająca. AD-45 (zaostrzenie AD-2):** *Na ścieżkach publicznych (kliknięcie, wypisanie, akceptacja kampanii, endpoint skryptu on-site) `tenantId` nigdy nie pochodzi z parametru wejściowego wprost. Znacznik jest podpisany kluczem instancji i zawiera `tenant_id`, `message_id` i termin ważności; serwer weryfikuje podpis, a następnie porównuje `tenant_id` ze znacznika z domeną z nagłówka `Host` przypisaną do tenanta. Niezgodność jest odrzuceniem żądania z alertem, nigdy cichym przekierowaniem. Test cross-tenantowy z AD-2 obejmuje w każdym module również wejście publiczne, nie tylko warstwę repozytorium.*

---

## Zestawienie proponowanych reguł

| Reguła | Zamyka | Typ |
|---|---|---|
| AD-21 własność pól profilu i funkcja scalania | D-1 | nowa |
| AD-22 stan zgody jako jedna funkcja domenowa | D-2 | nowa |
| AD-23 tożsamość anonimowa jako osobny byt | D-3 | nowa |
| AD-24 zamknięty katalog nazw zdarzeń w domenie | D-4 | nowa |
| AD-25 deklaracja wymaganych zdarzeń + schemat payloadu per nazwa | D-4, D-5 | nowa |
| AD-26 `messages` niemutowalne, stan jako projekcja z `message_events` | D-6 | zastępuje sporne zdania AD-6 i AD-16 |
| AD-27 pełny słownik stanów wiadomości, raport liczy stany | D-7 | zaostrza AD-6 |
| AD-28 klucz idempotencji w porcie, transakcja per wiadomość | D-8 | zaostrza AD-6, AD-7 |
| AD-29 wstrzymanie jako bramka per wiadomość | D-9 | nowa |
| AD-30 klucz idempotencji funkcją bytu, nie kanału | D-10 | zaostrza AD-4 |
| AD-31 `source_version` i warunkowy zapis projekcji | D-11 | nowa |
| AD-32 metering jako projekcja z loga, definicja aktywnego profilu | D-12 | nowa |
| AD-33 okno atrybucji jako byt wersjonowany, `rule_id` w rekordzie | D-13 | zaostrza AD-14 |
| AD-34 przeliczenie jako `attribution_run`, bez kasowania | D-13 | zaostrza AD-14 |
| AD-35 czas z niezaufanego źródła nie jest `occurred_at` | D-14 | zaostrza AD-10 |
| AD-36 wiążące sprawdzenie w transakcji `queued → sending` | D-15 | zaostrza AD-9 |
| AD-37 zdjęcie wykluczenia jako zdarzenie odwracające | D-16 | zaostrza AD-16, doprecyzowuje FR30 |
| AD-38 zasięg wykluczenia (`global` / `tenant`) | D-17 | nowa, wymaga migracji 0002 |
| AD-39 wykluczenia po skrócie adresu, powrót tożsamości | D-18 | zaostrza AD-16, FR22 |
| AD-40 jedna kompilacja segmentu, baza odniesienia dla FR47 | D-19 | nowa |
| AD-41 jedna definicja liczenia po obu stronach kontroli zgodności | D-20 | nowa |
| AD-42 migracja 0002 zdejmuje `default now()` i `gen_random_uuid()` | D-21 | wykonawcza, zaostrza AD-10, AD-15 |
| AD-43 strefa intencji w harmonogramie, wygasły termin, wersja kreacji | D-22 | nowa |
| AD-44 rezerwacja kwoty warmupu przy `sending`, stan `held` | D-23 | nowa |
| AD-45 tenant na ścieżkach publicznych z podpisanego znacznika | D-24 | zaostrza AD-2 |
| AD-46 weryfikacja podpisu przed zapisem do loga surowego | D-25 | zaostrza AD-4 |

## Kolejność wdrożenia reguł

Reguły, bez których nie warto zaczynać Epiku B, bo wymuszają zmianę schematu i późniejsza migracja kosztuje przepisanie modułów: AD-26, AD-27, AD-38, AD-39, AD-42, AD-23, AD-31.

Reguły do domknięcia przed Epikiem D (wysyłka), bo dotyczą nieodwracalnych skutków u odbiorcy: AD-28, AD-29, AD-36, AD-44.

Reguły do domknięcia przed pierwszym raportem pokazanym klientowi: AD-33, AD-34, AD-32, AD-41.

Reszta może wejść równolegle z modułami, których dotyczy, ale AD-24 i AD-25 muszą powstać przed pierwszym adapterem innym niż WooCommerce, bo po dwóch adapterach katalog zdarzeń jest już faktem, nie decyzją.
