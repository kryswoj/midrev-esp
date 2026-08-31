# Audyt luk produktowych midrev-esp wobec codziennej pracy agencji — 2026-08-31

Perspektywa: MidRev ma na tym REALNIE obsłużyć klienta ecommerce na WooCommerce
(pilot, docelowo ~1 mln maili/mies., Black Friday). Punkt odniesienia: Klaviyo,
czyli to, do czego przyzwyczajony jest operator i klient.

Metoda: PRD (FR1–FR72, NFR1–NFR38) i epiki 1–7 przeczytane, potem **grep po `src/`
i migracjach** — liczy się to, co jest w kodzie, nie to, co zaplanowano.

## Co realnie istnieje (zweryfikowane w kodzie)

- **Kampanie**: draft → treść (textarea HTML + podgląd iframe) → test na adres →
  akceptacja klienta tokenem bez logowania (`akceptacja/[token]`) → „wyślij teraz"
  przez worker (kolejka Postgres SKIP LOCKED, stany append-only w `message_events`,
  idempotencja AD-26). Wysyłka **tylko przez lokalny SMTP/Mailpit** (`adapters/email/smtp.ts`
  sam mówi: „to NIE jest adapter produkcyjny").
- **Bramka odbiorców** (`policz-odbiorcow.ts` + `can-send-to.ts`): zgody z rejestru,
  suppression globalna + lokalna, rozbicie kandydaci/wykluczeni — porządnie zrobione.
- **Segmenty**: 5 zamkniętych reguł zakupowych (`domain/segmenty.ts`), jedna reguła
  na segment (formularz `utworzSegmentAkcja` przyjmuje jeden typ + wartość).
- **Automatyzacje**: journey = 1 trigger (tylko `popup.submitted` / `order.created`)
  + opóźnienie + 1 mail. Bez warunków, bez gałęzi, bez porzuconego koszyka.
- **Atrybucja**: last-click, okno z `attribution_rules` (domyślnie 120 h), przebiegi
  wersjonowane, raport per kampania dla operatora — uruchamiana **ręcznie przyciskiem**.
- **Popupy** z kodem rabatowym, wypisy one-click (RFC 8058 w nagłówkach), listy,
  import Woo (REST + zgodność sklep/baza jako ekran na żądanie), webhook Woo
  (HMAC + idempotencja; **rejestracji webhooka w Woo brak**).
- **Auth**: role admin/operator/client, membership per tenant, limit dobowy wysyłki
  (domyślnie 500).

**Czego NIE ma w kodzie mimo tabel/planów**: `sending_domains` (tabela z migracji 0005
— zero użyć w src), warmup, FR47 (guard „segment spuchł"), alerty (ALERT_WEBHOOK_URL
zdefiniowany w config, nigdzie nie wywoływany — wszystko idzie na `console.error`),
import z Klaviyo (Epik 6 — brak choćby pliku stories), metering, harmonogram wysyłki
(kolumna `scheduled_at` jest i UI ją pokazuje, ale **nic jej nie dispatchuje**),
anulowanie/wstrzymanie wysyłki, eksport/usunięcie profilu (FR21/22), edytor Maily.to
(`@maily-to/*` nie ma nawet w package.json — „port TemplateEditor" to interfejs
w architekturze, nie kod), A/B, pixel otwarć, szablony, widoki klienta (raport
uproszczony), tryb równoległy z Klaviyo (FR65).

---

## POZIOM 1 — blokuje obsłużenie pierwszego prawdziwego klienta

Bez tych rzeczy żaden mail nie dojdzie do prawdziwej skrzynki albo nie wolno go wysłać.
Uwaga zegarowa: epiki same mówią, że wyjście z piaskownicy SES + warmup domeny to
tygodnie czekania — **przy Black Friday start najpóźniej na początku października**,
czyli decyzje z tej sekcji mają ~4–5 tygodni zapasu.

| Luka | Dlaczego blokuje | Minimalny zakres | Rozmiar |
|---|---|---|---|
| **Produkcyjny dostawca wysyłki (SES) + webhooki bounce/complaint** | Jedyny adapter to Mailpit na localhost. Zero maili do prawdziwych skrzynek. Bez ingestu bounce/complaint suppression nie rośnie z rzeczywistości → wysyłka do martwych adresów pali domenę klienta (FR48–49, ryzyko nr 1 z PRD). Schemat `message_events` już to przewiduje — brakuje tylko adaptera i endpointu. | Adapter `DostawcaWysylki` na SES API (port już istnieje, 1 metoda), konfiguracja SNS → endpoint `/api/webhooks/ses` zapisujący bounced/complained do `message_events` + auto-wpis do suppression. Wniosek o wyjście z sandboxa SES **w tym tygodniu**, bo to czekanie, nie kodowanie. | **M** (kod), ale lead time L (proces SES) |
| **Domeny wysyłkowe per tenant: SPF/DKIM/DMARC + blokada wysyłki (FR43–45)** | `MAIL_FROM` to globalny `kampanie@midrev-esp.local`, nadawca zahardkodowany „Sklep Testowy MidRev". Klient musi wysyłać ze SWOJEJ domeny, a Gmail/Yahoo odrzucą cokolwiek bez SPF+DKIM+DMARC. Tabela `sending_domains` istnieje, kod — nie. | Ekran: dodaj domenę → SES CreateEmailIdentity → pokaż rekordy DNS → przycisk „sprawdź" (status z SES) → twarda blokada wysyłki bez zielonego statusu, z jawnym powodem. Instrukcje per rejestrator później. | **M** |
| **Import z Klaviyo: profile + zgody + suppression (Epik 6, FR62–64)** | Każdy klient MidRev startuje z bazą w Klaviyo. FR27 (słusznie) zakazuje importu bez zgody — więc bez mapowania pól zgody z eksportu CSV Klaviyo lista klienta w ogóle nie wejdzie do systemu. Pominięcie importu suppression = wysyłka do ludzi, którzy już raz zgłosili spam. Kodu zero, nie ma nawet pliku stories. | Import CSV: mapowanie kolumn (email, imię, data+źródło zgody), deduplikacja po znormalizowanym adresie, **osobny obowiązkowy krok** importu unsubscribes/spam do suppression, licznik faktycznych zapisów (NFR1–2). Bez API Klaviyo — CSV wystarczy na pilota. | **M** |
| **Planowanie wysyłki na godzinę + anulowanie/wstrzymanie w trakcie (FR36–37)** | Kampanie wysyła się o 10:00 we wtorek, nie „kiedy operator kliknie". `scheduled_at` jest w bazie i w UI, ale żaden proces go nie czyta — obietnica bez silnika. Anulowania nie ma wcale, a to jedyny ratunek po zauważeniu błędu w wysłanej połowie (ścieżka 2 z PRD). | Worker: co minutę `campaigns where status='approved' and scheduled_at <= now()` → job `wyslij_kampanie`. Przycisk „wstrzymaj": status `paused` sprawdzany w pętli `wyslijPartie` między partiami + „odwołaj" dla zaplanowanych. | **S/M** |
| **Rejestracja webhooków w Woo przy podłączaniu sklepu** | Endpoint z HMAC jest, ale nikt nie tworzy webhooka po stronie Woo → po imporcie dane sklepu **po cichu stają w miejscu**: nowe zamówienia nie wpadają, atrybucja liczy na starych danych, journey `order.created` nie strzela. Dokładnie ta klasa awarii, którą PRD nazywa ryzykiem nr 2. | W `podlacz-sklep.ts`: POST `/wp-json/wc/v3/webhooks` (order.created/updated, customer) z sekretem, weryfikacja że webhook aktywny; status widoczny na ekranie sklepu. | **S** |
| **Alerty do człowieka (FR71, NFR38) + dobowa kontrola zgodności jako automat (NFR5)** | Wszystko krytyczne (wyczerpane próby jobów, rozjazd danych) idzie do `console.error` workera — czyli donikąd. Ekran zgodności działa tylko, gdy ktoś na niego wejdzie. Własna checklista repo (pkt 10) wprost tego zakazuje. | Funkcja `alert()` → Discord webhook (ALERT_WEBHOOK_URL już w configu); wpięcie w `odlozZadanie` (wyczerpane próby), dobowy job `sprawdzZgodnosc` per sklep z alertem >0,5%, alert przy complaint. | **S** |
| **Warmup + progi complaint z automatycznym wstrzymaniem (FR46, FR49)** | Świeża domena + pełna lista pierwszego dnia = spalona reputacja, nieodwracalnie. Po migracji „tarcza Klaviyo" znika — awaria dostarczalności to relacja z klientem. Jest tylko płaski limit dobowy 500. | Plan warmupu: rosnący limit dobowy per **domena** (tabela + harmonogram 14 dni), wymuszony przy nowej domenie; licznik complaint per tenant z progu 0,3% → status `paused` + alert. Targetowanie „najbardziej zaangażowanych" na start może być ręczne (segment „kupił w 90 dni"). | **M** |
| **RODO: eksport i usunięcie profilu (FR21–22)** | Z chwilą wpuszczenia prawdziwej bazy MidRev staje się procesorem. Pierwsze żądanie „usuńcie mnie" nie może kończyć się ręcznym DELETE w prod (historia szkód w repo mówi, czym to grozi). DPA i tak tego wymaga. | Na profilu: „eksportuj" (JSON: profil, zdarzenia, zgody, wysyłki) i „usuń" (anonimizacja z zachowaniem przychodu, wpis do logu dostępu). Bez UI dla klienta — wystarczy operatorowi. | **S/M** |

## POZIOM 2 — blokuje skalę (3+ sklepów, 1 mln maili/mies., Black Friday)

| Luka | Dlaczego blokuje | Minimalny zakres | Rozmiar |
|---|---|---|---|
| **Flow z warunkami i wieloma krokami + porzucony koszyk** | Journey = 1 trigger + delay + 1 mail. Nie zbudujesz welcome 3-mailowego, win-backu ani **porzuconego koszyka** — a to koszyk jest największym flow przychodowym ecommerce i warunkiem wyłączenia Klaviyo (kamień milowy 2: bez tego oszczędność = 0). Woo nie emituje zdarzenia koszyka bez wtyczki — to też praca. | Sekwencja kroków w jednym journey (mail → delay → mail) + warunek wyjścia „kupił od triggera" (jeden if, nie generyczny graf). Zdarzenie koszyka: skrypt on-site (`s/[tenantId]` już istnieje) albo wtyczka. Edytor graficzny flow — nie teraz. | **L** |
| **Throughput wysyłki** | `zbudujWiadomosciKampanii` robi SELECT+INSERT per profil, `wyslijPartie` wysyła szeregowo po jednej wiadomości. Przy 100 tys. odbiorców to godziny; NFR23 (10 tys. < 30 min) nieudowodnione, NFR25 zakłada 500 tys./mies. — cel 1 mln go przekracza. Na BF kampania musi wyjść w okno, nie „do jutra". | Budowa wiadomości jednym INSERT...SELECT (bez pętli), wysyłka partiami z ograniczoną współbieżnością (SES przyjmuje kilkadziesiąt/s), pomiar czasu kampanii w raporcie. | **M** |
| **Segmentacja po zachowaniu mailowym (kliknięcia) + łączenie reguł** | 5 reguł zakupowych, jedna na segment. Nie zrobisz „kliknął w 30 dni AND nie kupił" — chleba powszedniego agencji (sunset, win-back, engaged na warmup). Dane są (tabela `clicks`), reguł brak. | 2 nowe reguły: `klikal_w_ostatnich(dni)`, `nie_klikal_od(dni)` + AND wielu reguł w segmencie (schemat `rules` to już tablica — brakuje UI i kompilacji wielu reguł naraz). | **S/M** |
| **Tryb równoległy z Klaviyo bez podwójnej wysyłki (FR65)** | Plan migracji zakłada 2 tygodnie pracy obu systemów. Bez rejestru „kto co dostał" klient dostaje 2× tę samą kampanię → skargi w najgorszym możliwym momencie (świeża domena). | Widok/eksport listy odbiorców kampanii (dane są w `messages`) + import „dostali w Klaviyo" jako wykluczenie kampanii. Proces, nie automat. | **S** |
| **Edytor treści maila** | Textarea z surowym HTML + podgląd. Działa, bo MidRev i tak składa maile w pipeline (email-builder), ale: brak przełącznika desktop/mobile w podglądzie, brak obrazków (FR33 — nie ma uploadu!), każda poprawka literówki = runda przez plik HTML. Maily.to (`@maily-to/*`) nie jest nawet zainstalowane — pełna integracja (dokument JSON, render, port AD-32) to tygodnie. | **Wariant minimalny zamiast portu Maily.to**: zostawić HTML jako źródło prawdy, dołożyć (1) upload obrazków do `/public` lub S3 + wstawianie URL, (2) podgląd mobile 375 px obok desktopu, (3) CodeMirror zamiast gołej textarei. Maily.to wraca, gdy kampanie zacznie składać ktoś poza pipeline. | **S** (wariant min.) / **L** (Maily.to) |
| **Raportowanie: widok klienta, wykresy, dashboard zbiorczy** | Raport per kampania (wysłane/kliki/przychód) jest — dla operatora, na podstronie kampanii. Klient (FR60) nie ma nic, a to on płaci; operator przy 3+ sklepach nie ma widoku zbiorczego. Atrybucja liczona ręcznie przyciskiem — raport „nie starszy niż 15 min" (NFR24) nie zachodzi. | Job atrybucji po każdej wysyłce + dobowo; strona raportu dla roli client (te same liczby + zdanie o metodologii okna); dashboard zbiorczy i wykresy — dopiero przy 3 sklepach. | **M** |
| **Pixel otwarć** | PRD **celowo** nie raportuje open rate (Apple MPP — słuszna decyzja dla atrybucji). Ale w praktyce agencji otwarcia są potrzebne nie jako KPI, tylko jako sygnał higieny listy (sunset „nie otworzył nic od 180 dni") i porównania z historią Klaviyo, o które klient ZAPYTA. Koszt jest śmieszny wobec dyskusji, którą ucina. | Endpoint `/o/[token]` 1×1 gif → `message_events('opened')`; w raporcie z adnotacją „orientacyjne (Apple MPP)", nigdy jako miara sukcesu. | **S** |
| **Zarządzanie szablonami** | Każda kampania od zera albo kopiuj-wklej HTML. Przy kampanii/tydzień/sklep operator traci czas na stopki i nagłówki, które się nie zmieniają. | „Duplikuj kampanię" (jeden INSERT...SELECT) — pokrywa 80% potrzeby. Biblioteka szablonów per tenant później. | **S** |
| **Metering (FR70)** | Bez licznika maili/profili per tenant nie policzysz rentowności klienta — a to JEDYNA metryka, która uzasadnia istnienie projektu (warunek < 50% E0). Historii nie da się dorobić wstecz. | Dobowy zapis do tabeli `usage`: wysłane (z `message_events`), aktywne profile. Sam zapis, bez UI. | **S** |
| **Konta i dostępy klienta** | Rola `client` istnieje w schemacie, ale nie ma UI zakładania użytkownika klientowi ani widoków, które klient miałby oglądać (poza akceptacją tokenem). Multi-user per tenant (FR4) nieużywalny. | Formularz „dodaj użytkownika klienta" u admina + routing roli client wyłącznie na raporty. | **S/M** |

## POZIOM 3 — nice-to-have (nie blokuje pilota ani skali 3 sklepów)

| Luka | Uwaga | Rozmiar |
|---|---|---|
| **A/B testy tematów** | Klaviyo-parity, ale przy modelu „operator agencji" A/B da się zrobić ręcznie dwiema kampaniami na losowych połówkach listy. Automat (split, okno, auto-winner) dopiero, gdy wolumen kampanii urośnie. | M |
| Guard FR47 „segment spuchł ×100" | Cenny bezpiecznik, ale ekran `policzOdbiorcow` już pokazuje liczbę przed wysyłką — operator ją widzi. Automat: porównanie z poprzednią wysyłką + wymuszona zgoda. | S |
| Generyczny builder segmentów (FR31), bloki produktowe (FR42) | Świadomie wycięte z MVP w PRD — podtrzymać. | L |
| Adaptery Shopify/Shoper + rejestr możliwości | Faza 3, dopiero po udowodnieniu Woo. | L |
| Kolejka per domena odbiorcy (throttling Gmail/WP/Onet) | Wróci jako problem przy realnym wolumenie PL (wp.pl/o2 są drażliwe), ale nie przed pierwszym klientem. | M |
| Log dostępu operatora do danych (FR6, NFR12) | Wymóg formalny; przy jednym operatorze może poczekać do DPA. | S |
| Backup z testem odtworzenia (NFR13, NFR18) | Nie kod produktu, ale przed realnymi zgodami musi istnieć choćby dobowy pg_dump poza maszynę — wpisać do checklisty go-live. | S |
| Preheader w wysyłanym mailu, dark mode, testy renderowania klientów pocztowych | Kosmetyka jakości; pipeline email-builder MidRev częściowo to pokrywa. | S |

## Kolejność proponowana (ścieżka krytyczna do pilota)

1. **SES: wniosek o produkcję + adapter + webhooki bounce/complaint** — start natychmiast, bo lead time jest poza naszą kontrolą.
2. **Domeny wysyłkowe + blokada** (bez tego SES i tak nie wyśle z domeny klienta).
3. **Import z Klaviyo (CSV: zgody + suppression)** — równolegle do czekania na SES.
4. **Harmonogram + anulowanie; rejestracja webhooków Woo; alerty** — trzy małe rzeczy domykające codzienną pętlę pracy.
5. **Warmup + progi complaint** — musi działać w dniu pierwszej wysyłki z nowej domeny.

Dopiero po tym: throughput, flow porzuconego koszyka (warunek wyłączenia Klaviyo
i pierwszej złotówki oszczędności), segmenty behawioralne, raport klienta.

---
*Audyt: przegląd PRD + epików + grep całego `src/` i `migrations/` (stan repo
na branchu `feat/somifocus-moduly-5-6`, 2026-08-31). Bez zmian w kodzie.*
