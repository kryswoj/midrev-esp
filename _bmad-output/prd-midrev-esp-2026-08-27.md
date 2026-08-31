---
stepsCompleted: ['step-01-init', 'step-02-discovery', 'step-02b-vision', 'step-02c-executive-summary', 'step-03-success', 'step-04-journeys', 'step-05-domain', 'step-06-innovation', 'step-07-project-type', 'step-08-scoping', 'step-09-functional', 'step-10-nonfunctional', 'step-11-polish', 'step-12-complete']
inputDocuments:
  - ../../research/wlasny-esp/RESEARCH-WLASNY-ESP-2026-08-27.md
  - ../../research/wlasny-esp/PLAN-SAAS-ARCHITEKTURA-2026-08-27.md
  - ../../research/wlasny-esp/PM-PLAN-MODULY-API-2026-08-27.md
  - AGENTS.md
  - README.md
documentCounts:
  briefs: 0
  research: 3
  brainstorming: 0
  projectDocs: 2
classification:
  projectType: saas_b2b
  domain: martech_ecommerce
  complexity: medium
  complexityHotspots:
    - atrybucja przychodu (poprawność liczb, na których klient ocenia kanał)
    - odporność synchronizacji ze sklepem (ciche rozjazdy webhooków Shopify/Woo)
  projectContext: brownfield
scopeDecisions:
  - 'Narzędzie pod klientów MidRev, nie otwarty SaaS na rynek (Krystian, 27.08)'
  - 'Wysyłka na cudzym API (Elastic Email/Postmark/SES). Własny MTA poza zakresem.'
  - 'Poza zakresem: billing/Stripe metering, self-serve onboarding, Shopify public app, ciężki trust & safety'
  - 'W zakresie mimo wszystko: multi-tenancy, RODO, globalna suppression, atrybucja, limit wysyłki per tenant'
  - 'PRD nie betonuje dostawcy wysyłki. Bez odsprzedaży kryterium to dostarczalność + izolacja domen, nie white-label.'
visionDecisions:
  - 'Ster projektu to koszt licencji Klaviyo, nie przewaga funkcjonalna. Kryterium: wystarczajaco dobry, zeby nikt nie zauwazyl zmiany, i wyraznie tanszy.'
  - 'Atrybucja schodzi z roli testu hipotezy do wymogu parytetu. Dostarczalnosc rosnie do rangi ryzyka nr 1.'
  - 'Klient dostaje login (workspace, role owner/member, akceptacja kampanii). Self-serve onboarding i rejestracja z ulicy poza zakresem: tenanta zaklada MidRev.'
  - 'Multi-tenant od pierwszego dnia, zeby przejscie na SaaS nie wymagalo przepisania fundamentu.'
  - 'Pilot na WooCommerce. MySomi odpada jako pierwszy (customowa Medusa, nie reprezentuje zadnej platformy sklepowej).'
  - 'Warstwa integracji sklepu jako adapter z jednym kontraktem wewnetrznym. Pierwsze trzy platformy: WooCommerce, Shopify, Shoper.'
gapsFound:
  - 'Brak w epikach A-I: modul migracji z Klaviyo (kontakty + zgody + suppression + warmup) — warunek startu pierwszego klienta, wchodzi do MVP'
  - 'Brak w epikach A-I: akceptacja kampanii przez klienta (powiadomienie + token bez logowania) — MVP'
  - 'Brak w epikach A-I: ekran i dobowa kontrola zgodnosci danych sklep/baza + alert — MVP'
  - 'Brak w epikach A-I: tryb pracy rownoleglej z Klaviyo bez podwojnej wysylki — MVP'
  - 'Brak w epikach A-I: rejestr mozliwosci adaptera + wspolny zestaw testow akceptacyjnych platformy — Growth'
openItems:
  - 'Wzor DPA + polityka retencji do przejscia przez prawnika przed pierwszym realnym klientem.'
  - 'Shoper: zweryfikowac w fazie architektury, czy REST API daje zdarzenie porzuconego koszyka.'
  - 'E0: realny miesieczny koszt Klaviyo zsumowany po wszystkich klientach MidRev. Bramka decyzyjna przed kryteriami sukcesu (krok 3).'
  - 'Wskazac konkretny pilotazowy sklep na WooCommerce.'
  - 'Termin kamienia milowego 2 (wylaczenie Klaviyo u pierwszego sklepu) — bez daty warunek oplacalnosci nie ma kiedy zajsc.'
workflowType: 'prd'
status: 'complete'
completedAt: '2026-08-27'
---

# Product Requirements Document - midrev-esp

**Autor:** Krystian
**Data:** 2026-08-27

## Jak czytać ten dokument

Łańcuch zależności: wizja → kryteria sukcesu → ścieżki użytkownika → wymagania funkcjonalne → fazy. Każde wymaganie da się cofnąć do ścieżki, z której wynikło.

| Szukasz | Sekcja |
|---|---|
| po co to budujemy i dla kogo | Executive Summary |
| co uznajemy za sukces i przy jakich progach | Success Criteria |
| jak to wygląda od strony pracy człowieka | User Journeys |
| co narzuca prawo i rynek | Domain-Specific Requirements |
| skąd bierze się marża | Innovation & Novel Patterns |
| model tenanta, role, uprawnienia | SaaS B2B |
| co wchodzi do fazy 1, a co wypada i dlaczego | Project Scoping & Phased Development |
| kontrakt zdolności produktu (FR1–FR72) | Functional Requirements |
| progi jakości (NFR1–NFR38) | Non-Functional Requirements |

**Otwarte pozycje** (zebrane w nagłówku pliku, pole `openItems`): suma rachunków Klaviyo (E0), termin wyłączenia Klaviyo u pierwszego sklepu, wskazanie pilotażowego sklepu na Woo, weryfikacja API Shopera, wzór umowy powierzenia.

## Executive Summary

**midrev-esp** to własny ESP (email marketing automation dla ecommerce), którym MidRev obsługuje wysyłkę swoich klientów zamiast kupować im licencje Klaviyo. Pierwsi i jedyni tenanci na tym etapie to sklepy klientów agencji. Architektura jest multi-tenant od pierwszego dnia, żeby otwarcie na obcych użytkowników było decyzją biznesową, a nie przepisaniem fundamentu.

**Problem:** rachunek za Klaviyo rośnie liniowo z liczbą kontaktów każdego klienta, a wartość, za którą klient płaci, w większości dostarcza agencja, nie panel. Klient do Klaviyo nie wchodzi. Płacone są warstwy, których nikt po stronie klienta nie dotyka, plus dane sklepów siedzą u dostawcy, w modelu, którego nie da się nagiąć pod konkretny sklep.

**Użytkownicy — dwie role, nie jedna:**

- **Operator MidRev** — buduje segmenty, kampanie i flow, podpina sklepy i domeny, pilnuje dostarczalności. To jest główny użytkownik, pod niego projektujemy UI.
- **Klient (właściciel sklepu)** — wchodzi po raporty i akceptuje kampanię przed wysyłką. Widok uproszczony, bez możliwości zepsucia konfiguracji. Konto zakłada MidRev, nie ma rejestracji z ulicy.

**Zakres pierwszej wersji:** integracja sklepu (WooCommerce pierwszy), CDP profili i zdarzeń, segmentacja, kampanie z edytorem drag&drop, wysyłka przez zewnętrznego dostawcę, weryfikacja domeny wysyłkowej, suppression, atrybucja przychodu click-based, raport. Automatyzacje flow wchodzą po tym, jak kampanie i atrybucja udowodnią się na żywym ruchu.

**Poza zakresem świadomie:** własny MTA i operowanie własnymi IP, billing i metering Stripe, self-serve onboarding, Shopify public app z review App Store, ciężki system anty-nadużyciowy. Każde z tych ma jasny sygnał, po którym wraca do gry — sygnały opisane w PLAN-SAAS-ARCHITEKTURA.

**Bramka decyzyjna przed budową:** zsumowany miesięczny koszt Klaviyo po wszystkich klientach MidRev (krok E0 z researchu, wciąż niepoliczony). Skoro jedynym motorem projektu jest koszt, ta jedna liczba decyduje, czy build w ogóle ma ekonomiczny sens wobec migracji na tańszego dostawcę.

### What Makes This Special

**Różnicownikiem nie jest funkcja, tylko koszt i kontrola.** Produkt nie musi wygrywać z Klaviyo możliwościami. Musi być na tyle dobry, żeby po migracji nikt nie zauważył zmiany, i wyraźnie tańszy w utrzymaniu niż suma licencji. To odwraca ciężar dowodu w całym PRD: kryterium akceptacji brzmi „parytet w tym, co klient widzi", a nie „przewaga".

**Insight, na którym to stoi:** Klaviyo nie zarabia na wysyłce. Wysłanie miliona maili kosztuje u dostawcy od 200 do 2000 zł. Marża siedzi w segmentacji, flow, edytorze i raportach — czyli w warstwach, które przy modelu „obsługuje agencja" są w połowie nieużywane, bo obsługuje je jeden operator dla wielu sklepów naraz. Ten sam zestaw funkcji rozłożony na dziesięć sklepów kosztuje dziesięć razy tyle co u jednego, mimo że pracę wykonuje ten sam człowiek.

**Warstwa integracji jako adapter, nie jako trzy osobne integracje.** Jeden wewnętrzny kontrakt (zamówienie, klient, produkt, koszyk) i wymienne adaptery pod platformę: WooCommerce, Shopify, Shoper. Konsekwencja jest nie tylko techniczna — Shoper i polskie platformy sklepowe nie mają wsparcia w Klaviyo, więc to jest jedyne miejsce, w którym ten produkt może być obiektywnie lepszy od oryginału, a nie tylko tańszy. Przy ewentualnym przejściu na SaaS to jest wejście na rynek, którego Klaviyo nie obsługuje.

**Pakiet zamiast licencji.** Klient płaci dziś osobno za ESP i osobno agencji za jego obsługę. MidRev może dać jedno i drugie taniej niż suma, bo krańcowy koszt kolejnego sklepu we własnym narzędziu jest ułamkiem licencji. Rozwinięcie w sekcji Innovation & Novel Patterns.

**Kontrola nad modelem danych.** Segment liczony na własnym Postgresie może uwzględniać cokolwiek, co siedzi w bazie klienta, a nie tylko to, co dostawca zgodził się wystawić. Przy sklepach z nietypowym modelem (subskrypcje, kursy, usługi, wielorynkowość) to jest różnica między „da się" a „nie da się".

## Project Classification

| Wymiar | Wartość |
|---|---|
| Typ projektu | `saas_b2b` — multi-tenant, workspace per klient, role, integracje |
| Domena | `martech_ecommerce` (poza katalogiem BMAD, wpisana ręcznie) |
| Złożoność | średnia, z dwiema strefami wysokiego ryzyka |
| Kontekst | brownfield |

**Strefy wysokiego ryzyka:** (1) dostarczalność przy migracji klienta z Klaviyo — tu różnicę widać natychmiast i to ona zabija projekt; (2) odporność synchronizacji ze sklepem — webhooki padają po cichu, a rozjazd danych nikogo nie budzi.

**Stan wyjściowy (brownfield):** repo `midrev-esp` ma sandbox Postgres na dockerze, migrację `0001_init.sql` z izolacją cross-tenant po dwóch rundach review Codeksa, mechanizm śledzenia migracji z kontrolą sum kontrolnych oraz integracyjny test CDP jako wzorzec. Epik A2 jest częściowo ruszony. PRD traktuje to jako punkt wyjścia, nie planuje od zera.

## Success Criteria

> Dwie wartości pozostają otwarte i muszą zostać uzupełnione przez Krystiana: **E0** (suma miesięcznych rachunków Klaviyo po wszystkich klientach MidRev) oraz **termin kamienia milowego 2** (wyłączenie Klaviyo u pierwszego sklepu). Do tego czasu warunek opłacalności jest formułą, nie progiem.

**Ustalenie porządkujące kolejność prac:** MVP nie oszczędza ani złotówki. Oszczędność pojawia się dopiero przy wyłączeniu Klaviyo u klienta, a to wymaga przeniesienia flow (porzucony koszyk, welcome, post-purchase), bo tam u sklepu ecommerce siedzi większość przychodu z automatyzacji. Kampanie i atrybucja są warunkiem koniecznym, ale to Epik E jest momentem, w którym rachunek znika. Stąd dwa osobne kamienie milowe zamiast jednego.

### User Success

**Operator MidRev** (główny użytkownik):

- Wysłanie kampanii do istniejącego segmentu: od zalogowania do wysyłki poniżej 20 minut, bez zaglądania do dokumentacji. Parytet z codzienną pracą w Klaviyo — jeśli będzie wolniej, operator wróci do Klaviyo pierwszego dnia, w którym się spieszy.
- Podpięcie nowego sklepu WooCommerce: poniżej 30 minut, samodzielnie, bez pisania kodu i bez wchodzenia do bazy.
- Zbudowanie segmentu behawioralnego („kupił kategorię X w ostatnich 60 dniach, nie kupił od 30"): bez SQL-a, w interfejsie.
- Moment „aha": pierwszy raport przychodu per kampania, który zgadza się z panelem sklepu. Wtedy operator przestaje sprawdzać go ręcznie.

**Klient (właściciel sklepu):**

- Akceptacja kampanii przed wysyłką w dwóch kliknięciach z maila powiadamiającego, bez logowania się do panelu, jeśli nie chce.
- Raport zrozumiały bez tłumaczenia przez agencję: ile poszło, ile kliknięć, ile przychodu, w jakim oknie atrybucji.
- Weryfikacja domeny wysyłkowej: dostaje rekordy DNS z instrukcją pod swojego rejestratora i ustawia je bez telefonu do MidRev.

### Business Success

| Horyzont | Co ma być prawdą |
|---|---|
| Kamień milowy 1 — parytet kampanii | Jeden sklep na Woo wysyła kampanie z midrev-esp **równolegle** do Klaviyo, przez minimum 2 tygodnie, z porównywalnymi wynikami. Klaviyo dalej płacone. Oszczędność: zero. |
| Kamień milowy 2 — wyłączenie Klaviyo | Ten sam sklep ma przeniesione flow, Klaviyo wyłączone. **Pierwsza realna oszczędność** równa jego rachunkowi. Pierwszy moment, w którym projekt zarabia. |
| Kamień milowy 3 — skala | Trzy sklepy obsługiwane, w tym jeden na innej platformie niż Woo (Shopify albo Shoper). Adapter udowodniony, nie zadeklarowany. |
| Warunek opłacalności | Koszt utrzymania (infra + dostawca wysyłki + **czas operatora i utrzymania kodu**) poniżej połowy sumy rachunków Klaviyo (E0). Bez pozycji „czas ludzki" ta liczba kłamie. |

### Technical Success

**Dostarczalność** (ryzyko nr 1, widoczne natychmiast):

- Complaint rate poniżej 0,1% przy twardym progu 0,3%, powyżej którego Gmail karze całą domenę
- Bounce rate poniżej 2%
- SPF, DKIM i DMARC zweryfikowane przed pierwszą wysyłką. Bez zielonego statusu system nie pozwala wysłać kampanii
- List-Unsubscribe one-click (RFC 8058) w każdym mailu, bez wyjątku i bez przełącznika
- Click rate na tym samym sklepie i segmencie nie gorszy niż 15% poniżej historycznego z Klaviyo. Porównujemy kliknięcia, nie otwarcia — połowa otwarć to Apple MPP

**Odporność synchronizacji** (ryzyko nr 2, niewidoczne):

- Codzienna kontrola zgodności: liczba zamówień w bazie wobec liczby w sklepie za ostatnią dobę. Rozjazd powyżej 0,5% idzie alertem na kanał techniczny, nie do `console.error`
- Webhook, który zwrócił 200 i nic nie zrobił, musi być wykrywalny — licznik przetworzonych zdarzeń, nie licznik prób
- Backfill historii przy podpinaniu sklepu ustawia daty historyczne z danych źródłowych, nie datę importu

**Atrybucja:**

- Przychód przypisany kampanii rozjeżdża się z panelem sklepu o mniej niż 5% na tym samym zbiorze zamówień
- Model jawnie click-based, last-touch, okno konfigurowalne, domyślnie 5 dni. Rozbieżność wobec GA4 jest oczekiwana i opisana w interfejsie

**Fundament:** wymagania dotyczące testów, migracji i review są progami jakości, nie kryteriami sukcesu produktu — pełny zapis w NFR35–NFR38.

### Measurable Outcomes

| Metryka | Próg | Kiedy mierzona |
|---|---|---|
| Czas wysyłki kampanii przez operatora | < 20 min | kamień milowy 1 |
| Czas podpięcia sklepu Woo | < 30 min | kamień milowy 1 |
| Complaint rate | < 0,1% | ciągle, alert przy 0,3% |
| Bounce rate | < 2% | ciągle |
| Click rate wobec Klaviyo | nie gorzej niż −15% | kamień milowy 1, ten sam segment |
| Zgodność raportu przychodu z panelem sklepu | < 5% rozjazdu | kamień milowy 1 |
| Rozjazd liczby zamówień sklep/baza | < 0,5% dobowo | ciągle, alert |
| Koszt utrzymania wobec rachunków Klaviyo | < 50% E0 | kamień milowy 3 |

## Product Scope

Zakres faz jest rozstrzygnięty w sekcji **Project Scoping & Phased Development**, razem z uzasadnieniem każdego cięcia. W skrócie: faza 1 dowodzi parytetu kampanii na jednym sklepie Woo przy działającym równolegle Klaviyo, faza 2 przenosi automatyzacje i dopiero wtedy znika rachunek za Klaviyo, faza 3 dokłada kolejne platformy sklepowe, faza 4 otwiera produkt na obcych klientów.

## User Journeys

Dwa typy użytkowników mają login (operator MidRev, klient sklepu). Trzeci uczestnik nie loguje się nigdy, a decyduje o powodzeniu projektu: **odbiorca maila**, czyli klient sklepu klienta. Jego ścieżka to wypisanie się i skarga na spam — dwa zdarzenia, które przy złej obsłudze kończą projekt.

### 1. Operator — podpięcie sklepu i pierwsza kampania (ścieżka główna)

Agata dostaje nowego klienta na WooCommerce. Zakłada mu workspace, wkleja klucze REST wygenerowane przez merchanta, wybiera zakres synchronizacji historycznej (12 miesięcy). System zaciąga klientów, zamówienia i katalog produktów, pokazując pasek postępu i licznik przetworzonych rekordów — nie „trwa import", tylko konkretne liczby, bo po nich widać, czy coś stanęło.

Po imporcie od razu widzi ekran zgodności: ile zamówień jest w sklepie, ile w bazie, jaka różnica. Zgadza się — przechodzi dalej. Dodaje domenę wysyłkową klienta, dostaje rekordy DNS i wysyła je klientowi z instrukcją pod jego rejestratora. Do czasu zielonego statusu przycisk wysyłki jest zablokowany, z jawnym powodem, nie wyszarzony bez wyjaśnienia.

Buduje segment („kupili w ostatnich 90 dniach, nie kupili od 30"), widzi jego liczebność natychmiast, składa kampanię w edytorze drag&drop, wysyła test na własny adres, ustawia harmonogram. Klient dostaje maila z prośbą o akceptację.

**Co może pójść źle:** merchant wygeneruje klucze bez uprawnień do zamówień (import przechodzi, ale pusty — system musi to nazwać wprost, nie pokazać zera); historia w sklepie jest większa niż limit importu; domena już wysyła przez Klaviyo i ustawienie nowego DKIM-a zepsuje tamten strumień.

**Wymusza zdolności:** onboarding sklepu z walidacją uprawnień · import historyczny z licznikiem faktycznych zapisów · ekran zgodności danych · weryfikacja DNS z blokadą wysyłki · budowanie segmentu z podglądem liczebności · edytor kampanii · wysyłka testowa · powiadomienie o akceptacji.

### 2. Operator — sytuacje awaryjne (ścieżka brzegowa)

Trzy scenariusze, które zdarzą się na pewno:

**Segment spuchł.** Reguła segmentu została zmieniona i zamiast 400 osób obejmuje 40 tysięcy. Operator klika wyślij. System zatrzymuje wysyłkę, pokazuje: „ten segment jest 100× większy niż przy ostatniej wysyłce tej kampanii, potwierdź świadomie". To nie jest ochrona przed spamerem, tylko przed sobą — i to jedyny moment, w którym da się to cofnąć.

**Kampania idzie w spam.** Complaint rate przekracza próg w trakcie wysyłki. System sam wstrzymuje resztę kolejki i alarmuje na kanał techniczny. Operator widzi, których domen odbiorców dotyczy problem, i decyduje: wznowić czy odwołać.

**Webhook przestał przychodzić.** Sklep zmienił hosting, webhooki padły po cichu. Nikt tego nie zauważa, dopóki ktoś nie porówna liczb — więc porównuje je codzienny automat, a rozjazd powyżej 0,5% idzie alertem, nie do logu.

**Wymusza zdolności:** limit i potwierdzenie nietypowej wysyłki · automatyczne wstrzymanie przy complaint rate · alerty na kanał techniczny · dobowa kontrola zgodności · możliwość odwołania kampanii w trakcie.

### 3. Klient sklepu — akceptacja i raport

Właściciel sklepu dostaje maila: „kampania Wrześniowa Wyprzedaż czeka na akceptację". W mailu podgląd i dwa przyciski. Klika „akceptuję", nie logując się nigdzie. Jeśli chce zmian, klika „zgłoś uwagi" i pisze je w jednym polu — trafiają do operatora, kampania zostaje wstrzymana.

Dzień po wysyłce wchodzi do panelu i widzi jeden ekran: ile poszło, ile kliknięć, ile przychodu, w jakim oknie atrybucji. Pod spodem jedno zdanie wyjaśniające, dlaczego ta liczba nie zgadza się z GA4 — bo inaczej zapyta o to za każdym razem, a odpowiadanie na to pytanie kosztuje agencję więcej niż zbudowanie tego ekranu.

**Co może pójść źle:** klient nie akceptuje przez trzy dni i harmonogram mija (system musi przypomnieć i nie wysłać po cichu); klient nie rozumie okna atrybucji i uznaje, że kampania nie działa.

**Wymusza zdolności:** powiadomienie z podglądem · akceptacja bez logowania (token jednorazowy) · uwagi wracające do operatora · wstrzymanie harmonogramu przy braku akceptacji · uproszczony raport z wyjaśnieniem metodologii.

### 4. Operator — migracja klienta z Klaviyo (ścieżka, której nie ma w epikach)

To jest ścieżka, od której zaczyna się każdy klient, a której nie ma w PM-PLANie. Bez niej pierwszy sklep nie wystartuje.

Agata eksportuje z Klaviyo listę subskrybentów wraz z **datą i źródłem zgody** — bez tego nie wolno do nich wysłać ani jednego maila, bo rejestr zgód jest wymogiem, a nie polem opcjonalnym. Importuje też listę wypisanych i osób, które zgłosiły spam, do suppression. Ta druga jest ważniejsza od pierwszej: pominięcie jej oznacza wysyłkę do kogoś, kto już raz zgłosił skargę, czyli natychmiastowe uderzenie w reputację nowej domeny.

Potem warmup: pierwsze wysyłki idą do najbardziej zaangażowanego wycinka listy, wolumen rośnie stopniowo przez kilkanaście dni. Przez ten czas Klaviyo dalej działa równolegle.

**Co może pójść źle:** eksport z Klaviyo nie zawiera daty zgody (trzeba wtedy podjąć decyzję, czy w ogóle wolno wysyłać); import wprowadza duplikaty; ktoś wysyła pełną listę pierwszego dnia i pali domenę.

**Wymusza zdolności:** import kontaktów z mapowaniem pól zgody · import suppression jako osobny, obowiązkowy krok · deduplikacja po znormalizowanym adresie · plan warmupu z rosnącym limitem dobowym · tryb pracy równoległej z Klaviyo bez podwójnej wysyłki do tej samej osoby.

### 5. Odbiorca maila — wypisanie się i skarga

Nie loguje się nigdy. Ma dokładnie dwie interakcje z systemem i obie są krytyczne.

Klika „wypisz" w kliencie pocztowym (jednym kliknięciem, nagłówkiem List-Unsubscribe) albo w stopce maila. Musi być wypisany natychmiast, bez ekranu logowania, bez ankiety „czy na pewno", bez opóźnienia „do 48 godzin". Jeśli dostanie kolejnego maila po wypisaniu, klika „to spam" — i to kosztuje reputację całej domeny, nie tylko tej kampanii.

**Wymusza zdolności:** List-Unsubscribe one-click w każdym mailu · natychmiastowy zapis do suppression · sprawdzenie suppression przed każdą wysyłką, także przez flow · obsługa webhooków complaint od dostawcy · rejestr zgód z datą, źródłem i historią zmian.

### 6. Deweloper — dołożenie nowej platformy sklepowej

Krystian dokłada Shopera do obsługiwanych platform. Nie dotyka CDP, segmentów ani kampanii — implementuje adapter pod istniejący kontrakt: mapowanie klienta, zamówienia, produktu i koszyka na wewnętrzny model, plus odbiór webhooków tej platformy. Testy adaptera są zbudowane na tym samym zestawie przypadków co Woo, więc od razu widać, czego platforma nie potrafi (np. brak zdarzenia porzuconego koszyka).

**Co może pójść źle:** platforma nie ma zdarzenia, na którym stoi jeden z presetów flow — trzeba to zadeklarować w opisie adaptera, żeby interfejs nie oferował klientowi funkcji, która u niego nie zadziała.

**Wymusza zdolności:** jeden wewnętrzny kontrakt danych sklepowych · rejestr możliwości adaptera (co ta platforma potrafi, a czego nie) · wspólny zestaw testów akceptacyjnych dla każdego adaptera · interfejs ukrywający funkcje niedostępne na danej platformie.

### Journey Requirements Summary

| Zdolność | Z jakiej ścieżki wynika | Gdzie w epikach |
|---|---|---|
| Onboarding sklepu z walidacją uprawnień | 1 | A3 |
| Import historyczny z licznikiem faktycznych zapisów | 1, 4 | A3 |
| Ekran zgodności danych sklep/baza + alert dobowy | 1, 2 | **nowe** → FR14, FR71, NFR5 |
| Weryfikacja DNS z twardą blokadą wysyłki | 1 | D2 |
| Segment z podglądem liczebności przed wysyłką | 1 | B2 |
| Edytor kampanii i wysyłka testowa | 1 | C1, C5 |
| Powiadomienie i akceptacja kampanii przez klienta | 1, 3 | **nowe** → FR39–FR41 |
| Limit i potwierdzenie nietypowo dużej wysyłki | 2 | I2 (okrojone) |
| Automatyczne wstrzymanie przy complaint rate | 2 | D3 + I2 |
| Odwołanie kampanii w trakcie wysyłki | 2 | C4 |
| Uproszczony raport dla klienta z wyjaśnieniem metodologii | 3 | G2, G3 |
| Migracja z Klaviyo: kontakty, zgody, suppression, warmup | 4 | **nowe** → FR62–FR64, FR46 |
| Praca równoległa z Klaviyo bez podwójnej wysyłki | 4 | **nowe** → FR65 |
| List-Unsubscribe one-click i natychmiastowa suppression | 5 | I1, B3 |
| Rejestr zgód z datą, źródłem i historią | 4, 5 | I1 |
| Kontrakt adaptera + rejestr możliwości platformy | 6 | A3 (rozszerzone) |
| Wspólny zestaw testów akceptacyjnych adaptera | 6 | **nowe** → FR17, NFR35 |

**Sześć zdolności nie ma odpowiednika w epikach A–I.** Cztery z nich (ekran zgodności, akceptacja kampanii, migracja z Klaviyo, praca równoległa) są warunkiem uruchomienia pierwszego klienta, więc wchodzą do MVP, nie do backlogu.

## Domain-Specific Requirements

Domena `martech_ecommerce` nie ma odpowiednika w katalogu BMAD, więc wymagania poniżej są wyprowadzone z materiału wejściowego i z realiów rynku PL/EU, na którym działają klienci MidRev.

### Compliance & Regulatory

**RODO — zmiana roli.** Dziś MidRev jest użytkownikiem cudzego narzędzia. Po uruchomieniu midrev-esp staje się **podmiotem przetwarzającym dane osobowe klientów swoich klientów**. Administratorem pozostaje sklep, MidRev jest procesorem, a dostawca wysyłki (Elastic Email / Postmark / SES) subprocesorem. Wynika z tego:

- umowa powierzenia (DPA) z każdym sklepem, z listą subprocesorów i obowiązkiem informowania o jej zmianie
- rejestr czynności przetwarzania po stronie MidRev
- prawo do usunięcia i eksportu danych pojedynczego profilu, obsłużone w produkcie, nie ręcznie w bazie
- retencja: polityka usuwania nieaktywnych profili i surowych zdarzeń, uzgodniona ze sklepem

**Podstawa prawna wysyłki marketingowej w Polsce.** Od 10 listopada 2024 obowiązuje Prawo komunikacji elektronicznej, które zastąpiło art. 172 Prawa telekomunikacyjnego i art. 10 ustawy o świadczeniu usług drogą elektroniczną jednym reżimem zgody na marketing bezpośredni. Praktyczna konsekwencja dla produktu: **zgoda musi być udokumentowana zanim poleci pierwszy mail**, a dokumentacja to data, źródło i treść zgody, nie sam fakt obecności adresu na liście. Dlatego import kontaktów bez pola zgody nie może być możliwy technicznie — to nie jest ostrzeżenie w interfejsie, tylko blokada.

**Wymogi masowych nadawców (Gmail, Yahoo, od lutego 2024)** — nie są prawem, ale skutek ich złamania jest natychmiastowy i dotkliwszy niż kara urzędu:

- SPF, DKIM i DMARC wymagane łącznie dla domeny nadawcy
- List-Unsubscribe one-click (RFC 8058), wypisanie obsłużone w ciągu 2 dni (u nas: natychmiast)
- complaint rate poniżej 0,3%, co przy tej skali oznacza cel poniżej 0,1%

**Odbiorcy w USA.** Jeśli któryś ze sklepów wysyła do Stanów, dochodzi CAN-SPAM: fizyczny adres nadawcy w każdym mailu i wypisanie działające przez 30 dni po ostatniej wysyłce. To jedno pole w konfiguracji tenanta, ale musi istnieć od początku, bo doklejanie go później oznacza migrację wszystkich szablonów.

### Technical Constraints

**Izolacja danych między tenantami** to nie jest kwestia wygody, tylko wymóg umowy powierzenia. Fundament już to uwzględnia (klucze obce scoped per tenant po dwóch rundach review Codeksa). Każde nowe zapytanie i każdy nowy endpoint muszą to zachować, a test cross-tenantowy jest częścią definicji ukończenia modułu.

**Sekrety klientów.** Klucze REST sklepów, tokeny OAuth i klucze API dostawcy wysyłki to dane, których wyciek kompromituje sklep klienta, nie tylko MidRev. Szyfrowanie w spoczynku, brak w logach, brak w odpowiedziach API.

**Ślad dostępu operatora.** Operator MidRev widzi dane osobowe klientów sklepu. Przy jednym operatorze to wygląda na przesadę, przy trzech i pytaniu klienta „kto oglądał moją bazę" to jedyna odpowiedź. Log dostępu do danych profilowych, przechowywany krócej niż same dane.

**Idempotencja i autentyczność webhooków.** Woo i Shopify potrafią wysłać to samo zdarzenie dwa razy, a endpoint bez weryfikacji podpisu przyjmie zdarzenie od kogokolwiek. Weryfikacja HMAC plus klucz idempotencji per zdarzenie, zanim cokolwiek trafi do bazy.

**Domena trackingowa per tenant.** Click tracking przez wspólną domenę psuje dostarczalność wszystkim naraz i szybciej trafia na listy blokujące. Każdy tenant dostaje własny CNAME pod klik, tak samo jak własny DKIM. To dokłada jeden rekord DNS do onboardingu i trzeba to przewidzieć w ekranie weryfikacji, a nie dokładać później.

**Odtwarzalność.** Baza trzyma zgody, historię wysyłek i przypisany przychód — rzeczy, których nie da się odtworzyć z żadnego innego źródła. Backup z regularnym testem odtworzenia, bo backup, którego nikt nigdy nie odtworzył, jest założeniem, nie zabezpieczeniem.

### Integration Requirements

| Kierunek | Co | Uwagi |
|---|---|---|
| WooCommerce → CDP | REST API + webhooki zamówień, klientów, koszyka | klucze generuje merchant, brak procesu review |
| Shopify → CDP | Admin API + webhooki, custom app per sklep | HMAC obowiązkowy; public app dopiero przy otwarciu na rynek |
| Shoper → CDP | REST API, do zweryfikowania w fazie architektury | brak potwierdzonego wsparcia zdarzenia porzuconego koszyka — jeśli go nie ma, preset flow oparty na koszyku nie może być oferowany na tej platformie |
| midrev-esp → dostawca wysyłki | API wysyłki + subkonta/izolacja domen | wybór dostawcy otwarty, PRD go nie betonuje |
| dostawca → midrev-esp | webhooki bounce i complaint | wejście do suppression, twarda bramka przed każdą wysyłką |
| Sklep klienta → atrybucja | skrypt on-site czytający token kliknięcia | wymaga wklejenia jednego skryptu; przy Shopify docelowo automatycznie |

### Risk Mitigations

| Ryzyko | Jak zaadresowane w produkcie |
|---|---|
| Import listy bez zgód (kupionej albo starej) | brak możliwości importu bez pola daty i źródła zgody |
| Podwójna wysyłka w okresie pracy równoległej z Klaviyo | tryb równoległy z rejestrem, kto dostał którą kampanię, i blokada powtórzenia |
| Spalenie nowej domeny pełną wysyłką pierwszego dnia | plan warmupu z rosnącym limitem dobowym, wymuszony przy nowej domenie |
| Ciche padnięcie webhooków | dobowa kontrola zgodności liczby zamówień, alert na kanał techniczny |
| Zła data przy imporcie historii | data zdarzenia zawsze z danych źródłowych, kontrola odczytem zwrotnym po zapisie |
| Otwarcia jako metryka sukcesu | raport nie pokazuje open rate jako miary skuteczności; atrybucja wyłącznie click-based |
| Jeden tenant psujący reputację pozostałym | complaint rate liczony per tenant, automatyczne wstrzymanie po przekroczeniu progu |
| Utrata rejestru zgód | backup z testem odtworzenia; zgody nie do odtworzenia z żadnego innego źródła |

**Do domknięcia poza PRD:** wzór umowy powierzenia i polityka retencji wymagają przejścia przez prawnika przed pierwszym realnym klientem. Produkt ma być na to gotowy technicznie, ale treść dokumentów nie jest decyzją PM-a.

## Innovation & Novel Patterns

### Detected Innovation Areas

Nowatorstwo tego projektu nie leży w technologii, tylko w **modelu sprzedaży: usługa i narzędzie w jednej cenie**.

Klient ecommerce płaci dziś dwa rachunki. Pierwszy do ESP, który przy dużych listach dochodzi do 100 tys. zł rocznie. Drugi do agencji za obsługę tego ESP. MidRev może dać jedno i drugie za mniej niż suma, bo krańcowy koszt obsłużenia kolejnego sklepu we własnym narzędziu to wysyłka (grosze za tysiąc maili) plus ułamek dzielonej infrastruktury.

Dlaczego nikt inny tego nie robi na tym rynku:

- **Klaviyo nie może**, bo nie jest agencją i nie będzie konkurować z własnym ekosystemem partnerów
- **Agencje nie mogą**, bo nie mają narzędzia i odsprzedają cudzą licencję z zerową marżą
- W skali świata to nie jest nowe (istnieją agencje na white-label ESP), ale w Polsce, przy tym poziomie obsługi, to jest wolne pole

Konsekwencja dla pozycjonowania: MidRev nie sprzedaje ESP. Sprzedaje email marketing jako usługę, w której narzędzie jest wliczone i niewidoczne. Klient nie porównuje go z Klaviyo funkcja po funkcji, bo nie kupuje narzędzia.

### Market Context & Competitive Landscape

- Cennik Klaviyo rośnie liniowo z liczbą kontaktów. Przy listach powyżej 100 tys. kontaktów rachunek roczny idzie w dziesiątki tysięcy złotych, niezależnie od tego, ile kampanii faktycznie wysłano
- Koszt krańcowy kolejnego tenanta w midrev-esp: wysyłka u dostawcy plus dzielona infrastruktura. Nie rośnie z liczbą kontaktów w sposób, w jaki rośnie licencja
- Efekt: marża agencji rośnie bez podnoszenia ceny klientowi, a klient płaci mniej niż płacił za sumę dwóch rachunków. Obie strony wygrywają na tej samej różnicy

### Validation Approach

Test modelu jest prostszy niż test produktu i wcześniejszy: **pierwszy klient po migracji płaci nie więcej niż wcześniej za sumę (licencja + retainer), a marża MidRev na tym kliencie rośnie.** Jeśli ten warunek nie zachodzi, model nie działa niezależnie od tego, jak dobre będzie narzędzie.

Miara: marża na kliencie przed migracją i po niej, licząc w koszcie czas operatora i utrzymanie kodu.

### Risk Mitigation

**Tarcza znika.** Dziś przy problemie z dostarczalnością winne jest Klaviyo. Po migracji winne jest MidRev. Ta sama awaria kosztuje relację z klientem, nie tylko czas na naprawę. To jest twardy argument za tym, żeby warmup, progi complaint rate i automatyczne wstrzymanie wysyłki były w MVP, a nie w backlogu.

**Lock-in działa w dwie strony.** Klient odchodzący od MidRev musi móc zabrać kontakty, zgody i historię wysyłek. Bez eksportu żaden większy klient nie podpisze umowy, a przy RODO to i tak obowiązek, nie uprzejmość.

**Koncentracja ryzyka.** Awaria narzędzia to awaria u wszystkich klientów naraz, w tym samym momencie. Przy Klaviyo ryzyko było rozproszone na cudzy zespół SRE. Wniosek dla architektury: pojedynczy punkt awarii w wysyłce jest droższy niż wygląda na etapie pilota.

## SaaS B2B — wymagania specyficzne dla typu projektu

### Project-Type Overview

Produkt jest wielotenantową aplikacją SaaS obsługiwaną przez operatora agencji, z ograniczonym dostępem klienta końcowego. Nie ma rejestracji z ulicy, nie ma tierów cenowych w produkcie, ale multi-tenancy i metering są od pierwszego dnia, żeby otwarcie na rynek nie wymagało przepisania fundamentu.

### Model tenanta

Odstępstwo od typowego SaaS, które trzeba zapisać wprost: w zwykłym SaaS użytkownik należy do jednego workspace. Tutaj **operator MidRev ma dostęp do wielu tenantów naraz**, przełącza się między nimi w kilka sekund i widzi listę wszystkich sklepów w jednym miejscu. Klient przeciwnie: widzi wyłącznie swój.

```
organizacja MidRev (operator)
  └─ dostęp do wielu tenantów
tenant (= workspace = sklep klienta)
  ├─ users (klient i jego ludzie)
  ├─ stores (adapter + klucze)
  ├─ sending_domains (SPF/DKIM/DMARC + CNAME trackingu)
  ├─ profiles → events
  ├─ segments / lists
  ├─ campaigns → messages
  └─ consents / suppressions (per tenant)
suppression globalna — ponad tenantami, po znormalizowanym adresie
```

Izolacja: klucze obce ograniczone do tenanta (już w `0001_init.sql`), docelowo RLS w Postgresie jako druga warstwa. Test cross-tenantowy w definicji ukończenia każdego modułu, nie raz na koniec.

### Macierz uprawnień

| Operacja | MidRev admin | MidRev operator | Klient (owner) | Klient (viewer) |
|---|---|---|---|---|
| Zakładanie tenanta, dostęp do wszystkich | tak | nie | nie | nie |
| Podpięcie sklepu, klucze API | tak | tak | nie | nie |
| Domena wysyłkowa i DNS | tak | tak | podgląd statusu | podgląd statusu |
| Segmenty i listy | tak | tak | podgląd | podgląd |
| Tworzenie i edycja kampanii | tak | tak | nie | nie |
| Akceptacja kampanii | tak | tak | **tak** | nie |
| Wysyłka i odwołanie w trakcie | tak | tak | nie | nie |
| Raporty | tak | tak | tak | tak |
| Eksport danych osobowych, usunięcie profilu | tak | tak | tak | nie |
| Suppression: podgląd | tak | tak | tak | tak |
| Suppression: ręczne usunięcie wpisu | tak | nie | nie | nie |

Dwie decyzje w tej tabeli są celowe. **Klient nie edytuje kampanii, tylko akceptuje** — inaczej wracamy do modelu wymagającego pełnego self-serve UX. **Nikt poza adminem nie zdejmuje wpisu z suppression**, bo to jedyna operacja, która potrafi jednym kliknięciem wysłać maila do kogoś, kto zgłosił skargę.

### Metering zamiast tierów

Tierów cenowych nie ma w MVP, bo rozliczenie idzie retainerem. Ale **metering wchodzi od pierwszego dnia** i to nie jest to samo co billing:

1. Bez niego nie policzycie rentowności klienta, czyli nie zweryfikujecie modelu z sekcji Innovation
2. Bez niego nie wiadomo, kiedy klient przerósł swój retainer
3. Billing dokładany później potrzebuje historii zużycia, a historii nie da się odtworzyć wstecz

Metering to jedna tabela i licznik przy wysyłce. Billing (Stripe, plany, limity, faktury) zostaje w Vision.

### Lista integracji

| Integracja | Kiedy | Status |
|---|---|---|
| WooCommerce (REST + webhooki) | MVP | pilot stoi na tym |
| Dostawca wysyłki (API + webhooki bounce/complaint) | MVP | wybór otwarty, decyzja architekta |
| DNS klienta (SPF, DKIM, DMARC, CNAME trackingu) | MVP | instrukcje pod OVH, home.pl, Cloudflare |
| Kanał alertów technicznych (Discord/Slack) | MVP | bez tego alerty nie docierają do człowieka |
| Shopify (Admin API + webhooki, custom app per sklep) | Growth | HMAC obowiązkowy |
| Shoper (REST) | Growth | do weryfikacji: czy jest zdarzenie porzuconego koszyka |
| Stripe (metering i faktury) | Vision | dopiero przy obcych klientach |

### Wymagania zgodności

Pełne wymagania w sekcji Domain-Specific Requirements. Tu to, co przekłada się wprost na architekturę: rejestr zgód jako tabela pierwszej klasy (nie pole w profilu), eksport i usunięcie profilu jako funkcja produktu, log dostępu operatora do danych osobowych, szyfrowanie kluczy sklepów w spoczynku.

### Implementation Considerations

**Pomijane zgodnie z katalogiem dla `saas_b2b`:** interfejs CLI i podejście mobile-first. Wyjątek wynikający ze ścieżki 3: akceptacja kampanii i raport dla klienta muszą działać na telefonie, bo tam zostaną otwarte. Reszta panelu jest narzędziem pracy operatora przy biurku.

**Kolejka na Postgresie, nie osobny broker.** Przy jednym do trzech sklepów dokładanie Redisa czy RabbitMQ to koszt utrzymania bez korzyści. Sygnał do zmiany: wysyłka jednej kampanii przestaje mieścić się w oknie, w którym klient jej oczekuje.

**Skrypt on-site to osobny artefakt wdrożeniowy**, wersjonowany niezależnie od aplikacji. Jego wersja siedzi w przeglądarkach odbiorców i nie da się jej wycofać jednym deployem.

## Project Scoping & Phased Development

> **Założenie o zasobach:** buduje to Krystian z Codeksem i Claude'em, obok prowadzenia agencji, bez dedykowanego dewelopera na etacie. Cały scoping stoi na tym założeniu. Wejście kontraktora na stałe unieważnia część cięć poniżej.

### MVP Strategy & Philosophy

**Podejście: MVP dowodzące parytetu, nie MVP przychodowe.** Cel fazy 1 to jeden sklep na Woo wysyłający kampanie równolegle z Klaviyo przez dwa tygodnie, z porównywalnymi wynikami. Klaviyo nadal płacone, przychodu z projektu zero. To jest świadome: próba zarobienia już w fazie 1 wymusiłaby wyłączenie Klaviyo przed przeniesieniem flow, czyli utratę największych automatyzacji klienta.

**Najszybsza ścieżka do zweryfikowanej wiedzy:** pierwsza kampania wysłana z własnej domeny klienta, trafiająca do skrzynki odbiorczej w tym samym stopniu co Klaviyo, której przychód zgadza się z panelem sklepu. Wszystko, co nie jest potrzebne do tego zdania, wypada z fazy 1.

**Zasoby:** jedna osoba plus agenci. Fazy idą sekwencyjnie, równoległość tylko tam, gdzie moduły naprawdę się nie dotykają.

### MVP Feature Set (Phase 1)

**Obsługiwane ścieżki:** 1 (podpięcie i kampania), 2 (sytuacje awaryjne), 4 (migracja z Klaviyo), 5 (wypisanie i skarga). Ścieżka 3 częściowo: akceptacja tak, raport dla klienta w wersji minimalnej. Ścieżka 6 nie, bo w fazie 1 jest jeden adapter.

| Zdolność | Zakres w fazie 1 |
|---|---|
| Auth i tenanty | operator MidRev z dostępem do wielu, jeden użytkownik po stronie klienta |
| CDP (profile, zdarzenia) | częściowo gotowe, do dokończenia |
| Adapter WooCommerce | sync klientów, zamówień, katalogu + webhooki |
| Import z Klaviyo | kontakty ze zgodami, suppression, deduplikacja |
| Listy i segmenty | ograniczony zestaw reguł, nie generyczny builder |
| Suppression | globalna i per tenant, sprawdzana przed każdą wysyłką |
| Kampania i edytor | Unlayer bez customowych bloków produktowych |
| Wysyłka | dostawca, routing domen, bounce/complaint, limit dobowy |
| Domena wysyłkowa | SPF, DKIM, DMARC, CNAME trackingu, blokada wysyłki bez zieleni |
| Warmup | wymuszony plan przy nowej domenie |
| Akceptacja przez klienta | mail z podglądem, token bez logowania |
| Click tracking i atrybucja | token per odbiorca i wiadomość, okno 5 dni, last-touch |
| Raport | przychód per kampania dla operatora, wersja uproszczona dla klienta |
| Kontrola zgodności danych | dobowe porównanie sklep/baza + alert |
| Unsubscribe i rejestr zgód | one-click, natychmiastowy, data i źródło zgody |
| Metering | licznik maili i aktywnych profili per tenant |
| Tryb równoległy z Klaviyo | rejestr wysyłek, blokada podwójnego maila |

**Wycięte z MVP świadomie:**

| Co | Dlaczego można później | Co ryzykujemy |
|---|---|---|
| Generyczny builder reguł segmentacji | operator zna SQL i bazę, ograniczony zestaw reguł pokrywa realne kampanie | ręczna obsługa nietypowego segmentu |
| Customowe bloki produktowe w mailu | MidRev i tak dziś składa maile ręcznie | wolniejsze składanie kampanii produktowych |
| Rola viewer po stronie klienta | w fazie 1 klient to jedna osoba | dołożenie roli to mała migracja |
| Zaawansowana kolejka per domena odbiorcy | przy jednym sklepie limit dobowy wystarczy | wróci jako problem przy trzech sklepach |
| Dashboard ogólny (G3) | raport per kampania odpowiada na pytanie klienta | brak widoku zbiorczego dla operatora |
| Popupy (epik F) | osobny podsystem, nie dotyka hipotezy | klient zostaje przy dotychczasowym narzędziu |
| Flow i automatyzacje (epik E) | faza 1 testuje parytet, nie oszczędność | Klaviyo zostaje włączone, oszczędność zero |

### Post-MVP Features

**Faza 2 — tu znika rachunek za Klaviyo.** Silnik flow, presety (porzucony koszyk, welcome, post-purchase), triggery z CDP, edytor wizualny flow. Dopiero po tej fazie pierwszy klient wyłącza Klaviyo i pojawia się pierwsza realna oszczędność.

**Faza 3 — skala i platformy.** Adapter Shopify, adapter Shoper, rejestr możliwości adaptera, wspólne testy akceptacyjne platform, dashboard zbiorczy, bloki produktowe, pełny builder segmentów, popupy.

**Faza 4 — otwarcie na rynek.** Billing i faktury, self-serve onboarding, Shopify public app, SMS, własny MTA. Tylko po decyzji o sprzedaży obcym.

### Risk Mitigation Strategy

**Ryzyko techniczne — dostarczalność.** Najtrudniejszy element fazy 1, skutek widać natychmiast u klienta. Zabezpieczenia wypisane w tabeli Risk Mitigations (sekcja Domain-Specific Requirements) i utrwalone w FR46–FR49. Kluczowy jest mechanizm wyjścia: gorsza dostarczalność oznacza powrót na Klaviyo bez strat dla klienta, i to jest cały sens pracy równoległej przez dwa tygodnie.

**Ryzyko rynkowe — model nie domyka się finansowo.** Weryfikacja tańsza niż build: policzyć E0 i marżę na pierwszym kliencie przed migracją i po niej. Jeśli różnica nie pokrywa czasu utrzymania, alternatywą jest odsprzedaż taniego ESP z narzutem, bez własnego kodu.

**Ryzyko zasobowe — jedna para rąk.** Faza 1 wycięta do minimum testującego hipotezę. Moduły idą sekwencyjnie i każdy zamyka się osobno, więc przerwanie prac zostawia działający fragment, a nie połowę systemu. Codex bierze mechaniczną robotę; review przed każdym mergem zostaje obowiązkowe mimo presji czasu — to jest ostatnia rzecz do cięcia, nie pierwsza.

## Functional Requirements

Znaczniki faz: **[1]** faza 1 (MVP) · **[2]** faza 2 (automatyzacje) · **[3]** faza 3 (skala i platformy). Wymagania bez znacznika fazy 4 celowo nie występują — billing i self-serve wracają dopiero po decyzji o otwarciu na rynek.

### Dostęp, tenanty i role

- FR1: Administrator MidRev może założyć tenanta reprezentującego sklep klienta. **[1]**
- FR2: Operator MidRev może przełączać się między tenantami, do których ma dostęp, bez ponownego logowania. **[1]**
- FR3: Administrator może nadać i odebrać operatorowi dostęp do konkretnego tenanta. **[1]**
- FR4: Administrator może dodać użytkownika po stronie klienta do jego tenanta. **[1]**
- FR5: Użytkownik klienta widzi wyłącznie dane swojego tenanta. **[1]**
- FR6: System odnotowuje dostęp operatora do danych osobowych profili. **[1]**
- FR7: Administrator może nadać po stronie klienta rolę z samym podglądem, bez prawa akceptacji kampanii. **[3]**

### Połączenie sklepu

- FR8: Operator może podłączyć sklep WooCommerce na podstawie poświadczeń wygenerowanych przez merchanta. **[1]**
- FR9: System weryfikuje zakres uprawnień poświadczeń przed zakończeniem podłączenia i nazywa brakujące uprawnienia. **[1]**
- FR10: Operator może zaimportować historię zamówień, klientów i katalog produktów z wybranego zakresu czasu. **[1]**
- FR11: Import zapisuje datę zdarzenia z danych źródłowych, nie datę wykonania importu. **[1]**
- FR12: System przyjmuje zdarzenia sklepowe na bieżąco (zamówienie, klient, koszyk) i odrzuca duplikaty tego samego zdarzenia. **[1]**
- FR13: System weryfikuje autentyczność przychodzących zdarzeń sklepowych i odrzuca niepodpisane. **[1]**
- FR14: Operator widzi porównanie liczby zamówień w sklepie i w bazie za wskazany okres. **[1]**
- FR15: Operator może podłączyć sklep Shopify. **[3]**
- FR16: Operator może podłączyć sklep Shoper. **[3]**
- FR17: Operator widzi, których rodzajów zdarzeń dana platforma sklepowa nie dostarcza, zanim zbuduje na nich kampanię lub automatyzację. **[3]**

### Profile i zdarzenia

- FR18: System utrzymuje profil odbiorcy wraz z historią jego zdarzeń w obrębie tenanta. **[1]**
- FR19: System scala zdarzenia z różnych źródeł w jeden profil po znormalizowanym adresie e-mail. **[1]**
- FR20: Operator może wyszukać profil po adresie e-mail i obejrzeć jego pełną historię. **[1]**
- FR21: Operator lub klient może wyeksportować komplet danych pojedynczego profilu. **[1]**
- FR22: Operator lub klient może usunąć dane profilu, z zachowaniem historii przychodu w postaci zanonimizowanej. **[1]**

### Odbiorcy: listy, segmenty, zgody, wykluczenia

- FR23: Operator może utworzyć listę statyczną i zarządzać jej członkami, w tym importem i eksportem. **[1]**
- FR24: Operator może zdefiniować segment na podstawie reguł dotyczących zamówień, produktów, dat i zaangażowania. **[1]**
- FR25: Operator widzi liczebność segmentu, zanim użyje go do wysyłki. **[1]**
- FR26: System rejestruje zgodę marketingową wraz z datą, źródłem i treścią, oraz historię jej zmian. **[1]**
- FR27: System uniemożliwia import kontaktów pozbawionych informacji o zgodzie. **[1]**
- FR28: System utrzymuje listę wykluczeń globalną (ponad tenantami) i lokalną dla tenanta. **[1]**
- FR29: System sprawdza wykluczenia przed każdą wysyłką, niezależnie od tego, czy pochodzi z kampanii czy z automatyzacji. **[1]**
- FR30: Administrator może usunąć wpis z listy wykluczeń; operator i klient nie mogą. **[1]**
- FR31: Operator może zbudować segment na dowolnym atrybucie profilu i zdarzenia, bez ograniczenia do gotowego zestawu reguł. **[3]**

### Kampanie

- FR32: Operator może utworzyć kampanię i zredagować jej treść w edytorze wizualnym. **[1]**
- FR33: Operator może wgrać do kampanii materiały graficzne. **[1]**
- FR34: Operator może określić odbiorców jako zbiór list i segmentów wraz z wykluczeniami. **[1]**
- FR35: Operator może obejrzeć podgląd kampanii w wersji na komputer i telefon oraz wysłać wersję testową na wskazany adres. **[1]**
- FR36: Operator może zaplanować wysyłkę na wskazany moment albo wysłać natychmiast. **[1]**
- FR37: Operator może odwołać kampanię zaplanowaną i wstrzymać kampanię będącą w trakcie wysyłki. **[1]**
- FR38: System dokłada do linków kampanii parametry śledzenia przeznaczone dla zewnętrznej analityki klienta. **[1]**
- FR39: Klient otrzymuje powiadomienie o kampanii oczekującej na akceptację, zawierające podgląd treści. **[1]**
- FR40: Klient może zaakceptować kampanię albo zgłosić uwagi bez logowania się do panelu. **[1]**
- FR41: Kampania bez akceptacji nie zostaje wysłana o zaplanowanej porze, a operator jest o tym powiadamiany. **[1]**
- FR42: Operator może wstawić do kampanii blok prezentujący produkty pobrane ze sklepu. **[3]**

### Wysyłka i dostarczalność

- FR43: Operator może dodać domenę wysyłkową tenanta i otrzymać komplet rekordów DNS do ustawienia, wraz z instrukcją dla popularnych rejestratorów. **[1]**
- FR44: System weryfikuje poprawność konfiguracji domeny wysyłkowej i pokazuje jej status. **[1]**
- FR45: System blokuje wysyłkę z niezweryfikowanej domeny i podaje powód blokady. **[1]**
- FR46: System stosuje plan stopniowego zwiększania wolumenu dla nowo dodanej domeny. **[1]**
- FR47: System zatrzymuje wysyłkę do segmentu nietypowo większego niż poprzednie i wymaga świadomego potwierdzenia. **[1]**
- FR48: System przyjmuje od dostawcy wysyłki informacje o odbiciach i skargach i zapisuje je do wykluczeń. **[1]**
- FR49: System wstrzymuje wysyłkę tenanta po przekroczeniu progu skarg i powiadamia o tym operatora. **[1]**
- FR50: Każda wysłana wiadomość zawiera mechanizm wypisania działający jednym kliknięciem, również z poziomu klienta pocztowego. **[1]**
- FR51: Wypisanie skutkuje natychmiastowym wykluczeniem odbiorcy, bez dodatkowych kroków z jego strony. **[1]**
- FR52: System ogranicza wolumen wysyłki pojedynczego tenanta w oknie czasowym. **[1]**
- FR53: Każda wiadomość zawiera dane nadawcy wymagane w kraju odbiorcy. **[1]**

### Atrybucja i raporty

- FR54: System nadaje każdej parze odbiorca-wiadomość unikalny znacznik służący do przypisania kliknięcia. **[1]**
- FR55: System rejestruje kliknięcie w link z wiadomości i wiąże je z profilem. **[1]**
- FR56: System wiąże sesję odbiorcy na stronie sklepu z jego profilem na podstawie znacznika z linku. **[1]**
- FR57: System przypisuje przychód z zamówienia do ostatniej kampanii klikniętej w oknie atrybucji. **[1]**
- FR58: Operator może zmienić długość okna atrybucji dla tenanta. **[1]**
- FR59: Operator widzi raport kampanii obejmujący wysyłkę, kliknięcia i przypisany przychód. **[1]**
- FR60: Klient widzi uproszczony raport kampanii wraz z wyjaśnieniem sposobu liczenia przychodu. **[1]**
- FR61: Operator widzi zbiorczy widok wyników wszystkich tenantów, do których ma dostęp. **[3]**

### Migracja i praca równoległa z dotychczasowym ESP

- FR62: Operator może zaimportować kontakty z dotychczasowego ESP wraz z informacją o zgodzie. **[1]**
- FR63: Operator może zaimportować z dotychczasowego ESP listę wypisanych i zgłaszających skargi jako wykluczenia. **[1]**
- FR64: Import rozpoznaje duplikaty po znormalizowanym adresie i nie tworzy kopii istniejącego profilu. **[1]**
- FR65: Operator widzi, którzy odbiorcy otrzymali daną kampanię, żeby nie powtórzyć wysyłki z dotychczasowego ESP. **[1]**

### Automatyzacje

- FR66: Operator może zbudować automatyzację reagującą na zdarzenie, obejmującą warunki, opóźnienia i gałęzie. **[2]**
- FR67: Operator może uruchomić automatyzację z gotowego wzorca (porzucony koszyk, powitanie, po zakupie). **[2]**
- FR68: Operator może użyć dowolnego zdarzenia zebranego w profilu jako wyzwalacza automatyzacji. **[2]**
- FR69: Automatyzacje podlegają tym samym regułom wykluczeń, limitów i zgód co kampanie. **[2]**

### Nadzór, zgodność i rozliczenie

- FR70: System zlicza wysłane wiadomości i aktywne profile w podziale na tenantów. **[1]**
- FR71: System powiadamia zespół na kanale technicznym o rozjeździe danych, przekroczeniu progu skarg i wstrzymaniu wysyłki. **[1]**
- FR72: Operator może wyeksportować komplet danych tenanta na potrzeby zakończenia współpracy. **[1]**

## Non-Functional Requirements

Kategorie nieistotne dla tego produktu zostały pominięte celowo. Dołożona jedna spoza standardowego katalogu — poprawność danych — bo przy produkcie liczącym przychód i pilnującym zgód znaczy więcej niż wydajność.

### Poprawność danych

Najważniejsza grupa w całym dokumencie. Błąd tutaj nie wygląda na awarię: system działa, liczby są, tylko nieprawdziwe.

- NFR1: Każda operacja masowo zapisująca dane (import, backfill, naprawa) po zapisie odczytuje zapisany rekord i porównuje go z oczekiwaniem, w tym samym przebiegu.
- NFR2: Licznik w logu i raporcie pokazuje faktyczny wynik operacji, nie liczbę podjętych prób.
- NFR3: Data zdarzenia pochodzi z danych źródłowych. Zapis bez jawnie ustawionej daty historycznej jest błędem, nie zachowaniem domyślnym.
- NFR4: Operacja masowej zmiany ogranicza zakres do identyfikatorów bieżącego przebiegu, nie do szerokiego warunku obejmującego poprzednie operacje.
- NFR5: Rozjazd między liczbą zamówień w sklepie a w bazie powyżej 0,5% w dobie generuje alert do człowieka, nie wpis w logu.
- NFR6: Przed uruchomieniem operacji tworzącej dane pochodne (profile, zamówienia) znana jest i zaraportowana liczba rekordów, które powstaną.

### Bezpieczeństwo

- NFR7: Poświadczenia sklepów i dostawców są szyfrowane w spoczynku, nie pojawiają się w logach ani w odpowiedziach API.
- NFR8: Cała komunikacja z systemem i do systemów zewnętrznych idzie po TLS.
- NFR9: Izolacja tenantów jest weryfikowana testem automatycznym w każdym module dotykającym danych tenanta, nie jednorazowym audytem.
- NFR10: Token akceptacji kampanii jest jednorazowy, wygasa po 7 dniach i nie daje dostępu do niczego poza akceptacją tej jednej kampanii.
- NFR11: Znacznik śledzenia kliknięcia jest nieodgadywalny i nie zawiera w sobie adresu e-mail odbiorcy w żadnej odwracalnej postaci.
- NFR12: Log dostępu operatora do danych osobowych jest przechowywany 12 miesięcy i nie jest edytowalny z poziomu aplikacji.
- NFR13: Kopie zapasowe są szyfrowane, a odtworzenie z kopii jest testowane co kwartał. Kopia nieodtworzona ani razu nie liczy się jako zabezpieczenie.

### Niezawodność

- NFR14: Przyjęte zdarzenie sklepowe jest zapisywane trwale przed przetworzeniem. Awaria przetwarzania nie może oznaczać utraty zdarzenia.
- NFR15: Wysyłka kampanii jest odporna na restart procesu: żaden odbiorca nie dostaje wiadomości dwa razy i żaden nie zostaje pominięty.
- NFR16: Niedostępność dostawcy wysyłki wstrzymuje kampanię i pozwala ją wznowić bez duplikatów.
- NFR17: Niedostępność sklepu do 24 godzin nie powoduje trwałej utraty danych — po powrocie synchronizacja nadrabia zaległości.
- NFR18: Odtworzenie systemu z kopii zapasowej zajmuje nie więcej niż 4 godziny, przy dopuszczalnej utracie danych do 24 godzin. Dla rejestru zgód i historii wysyłek ta utrata jest nieakceptowalna, więc te dane wymagają ciągłego zabezpieczenia, nie dobowego.
- NFR19: Niedostępność panelu operatora nie zatrzymuje przyjmowania zdarzeń ani obsługi wypisań.

### Wydajność

- NFR20: Interaktywne akcje w panelu operatora kończą się poniżej 2 sekund.
- NFR21: Podgląd liczebności segmentu dla tenanta z 200 tys. profili zwraca wynik poniżej 5 sekund.
- NFR22: Przyjęcie zdarzenia webhookowego jest potwierdzane poniżej 500 ms; przetwarzanie odbywa się asynchronicznie.
- NFR23: Kampania do 10 tys. odbiorców zostaje w całości wysłana w oknie poniżej 30 minut, o ile nie ogranicza jej plan warmupu.
- NFR24: Dane w raporcie przychodu nie są starsze niż 15 minut względem zamówień w sklepie.

### Skalowalność

- NFR25: Faza 1 obsługuje 1–3 tenantów, łącznie do 200 tys. profili i 500 tys. wiadomości miesięcznie.
- NFR26: Model danych i architektura wytrzymują 10 tenantów, 1 mln profili i 3 mln wiadomości miesięcznie bez przepisywania fundamentu.
- NFR27: Sygnały do zmiany architektury są jawne: przeliczenie segmentu powyżej 30 sekund, kolejka wysyłki niemieszcząca się w oknie kampanii, wolumen zdarzeń przerastający pojedynczą bazę.

### Integracje

- NFR28: Odbiór zdarzeń jest idempotentny — powtórzone zdarzenie o tym samym identyfikatorze nie tworzy drugiego rekordu.
- NFR29: System nie zakłada kolejności przychodzących zdarzeń.
- NFR30: Nieudane wywołanie do systemu zewnętrznego jest ponawiane z rosnącym odstępem, a po wyczerpaniu prób trafia do kolejki błędów z alertem.
- NFR31: Limity zapytań platform sklepowych są respektowane, a ich przekroczenie nie powoduje utraty danych, tylko spowolnienie synchronizacji.

### Dostępność interfejsu

- NFR32: Ekrany przeznaczone dla klienta (akceptacja kampanii, raport) działają na telefonie i są czytelne bez powiększania.
- NFR33: Informacja o stanie nie jest przekazywana wyłącznie kolorem.
- NFR34: Zgodność z WCAG na poziomie AA nie jest zobowiązaniem fazy 1. To świadoma decyzja przy zamkniętym gronie znanych użytkowników, do rewizji przed otwarciem na rynek.

### Utrzymywalność

Osobna kategoria, bo produkt utrzymuje jedna osoba obok prowadzenia agencji.

- NFR35: Każdy moduł ma test integracyjny sprawdzający zachowanie ze specyfikacji na sandboxie, nie atrapę.
- NFR36: Zmiana schematu bazy to nowy plik migracji. Edycja zastosowanej migracji jest niedopuszczalna od pierwszego realnego użycia.
- NFR37: Każda zmiana kodu przechodzi review Codeksa przed mergem, z kontekstem i historią błędów projektu, a po poprawkach drugą rundę.
- NFR38: Każde zdarzenie wymagające reakcji człowieka ma zdefiniowany kanał alertu i opis, co z nim zrobić. Alert bez procedury to alert, który zostanie zignorowany.
