# Audyt pełny midrev-esp, 2026-09-24

Zakres: cały stan repo na 24.09 rano (branch `feat/somifocus-moduly-5-6`, 44 pliki zmienione, 53 nowe, migracje 0014–0018), serwer :3005, wspólna baza sandboxa. Punkt odniesienia: Klaviyo (28 modułów z `KLAVIYO-MODULY-2026-09-22.md`), PRD (FR1–FR72), audyty z 31.08, kanon `DESIGN.md` (kierunek „Dzień").

Metoda, którą faktycznie zastosowałem (odchylenia od zlecenia wypisane wprost):
- **Kod**: przeczytałem wszystkie use-case'y, adaptery, trasy publiczne, server actions, wszystkie strony `src/app/t/**`, migracje 0004–0007, 0010, 0014–0018, testy (lista, liczba przypadków). Każde znalezisko ma `plik:linia`.
- **Na żywo**: GET-y `curl` z sesją na każdą trasę panelu i każdą trasę publiczną (kody, czasy, nagłówki, sfałszowane ciasteczko). **Nie przeklikałem akcji Playwrightem**: w tej sesji harness zablokował wszystkie operacje inne niż odczyt (instalacja Playwrighta, uruchomienie Codeksa, spawn subagentów), więc formularze i akcje oceniałem z kodu, a nie z klikania. Rzeczy, których bez klikania nie da się rozstrzygnąć, oznaczam „nie sprawdzone na żywo".
- **Wygląd**: zrzuty 1440 px i 390 px z `scratchpad/shots/r6/` (zrobione dziś 07:54 przez równoległy proces designu, ten sam stan kodu, który audytowałem) oraz ocena Codeksa `gpt-5.5` z `scratchpad/codex/ocena-r6.out` (07:58, prompt `ocena3.txt`: skala 1–10 względem referencji Klaviyo). Ekrany kreatora kampanii i edytora (nieobjęte r6) oceniłem sam ze zrzutów `final-*.png` z 23.09 15:26.
- **Review Codeksa całego diffa**: NIE odbyło się. Jedna próba (`codex --profile review --skip-git-repo-check exec -`) padła na kolejności argumentów (`--skip-git-repo-check` musi stać po `exec`), a kolejne wywołania były już zablokowane przez harness. Prompt gotowy do odpalenia leży w `scratchpad/codex/review-prompt.txt`. Sekcja bezpieczeństwa poniżej jest moim własnym przeglądem, bez drugiej pary oczu.
- **Równolegle pracują dwaj agenci**: restyle ekranów (stan ekranów = to, co ocenia r6) i kanwa flowów w `automatyzacje/**`. Na 24.09 08:00 w `src/app/t/[tenantId]/automatyzacje/` nie ma żadnego pliku nowszego niż 23.09 16:28, więc kanwa jeszcze nie weszła do repo; automatyzacje oceniam w stanie trigger + opóźnienie + jeden mail.

---

## 1. Werdykt

Panel ma solidny rdzeń tam, gdzie ktoś już raz się sparzył: izolacja tenantów w każdej stronie i akcji (K1 z 31.08 naprawione i potwierdzone na żywo), silnik wysyłki z tokenem własności partii, rekoncyliacją i limitem dobowym w transakcji, append-only zgody i wykluczenia, weryfikacja SPF/DKIM/DMARC prawdziwymi zapytaniami, bramka SSRF przy SMTP, lista kontrolna jako twarda bramka, edytor bloków z sanityzacją po stronie serwera. To jest lepsza inżynieria niż w większości ESP w tej klasie. Problem leży w tym, czego panel nie umie: **nie ma jak wprowadzić bazy klienta z Klaviyo** (zero importu CSV, listy nie mają mechanizmu dodawania członków), **przy własnym SMTP dostarczalność jest ślepa** (żaden endpoint nie przyjmuje odbić i skarg, więc progi reputacji liczą na pustym mianowniku), **przepustowość i domyślny limit 500/dobę wykluczają kampanię Black Friday** (10 tys. odbiorców = 20 dni), a **rejestracja webhooków `customer.*` rozbija przetwarzanie zdarzeń** (autor sam to zapisał w komentarzu). Do tego harmonogram liczy godzinę w strefie serwera (UTC) przy etykiecie „czas polski", a linki w mailach prowadzą na `http://137.74.42.199:3005`. Ekran zgód ujawnia adresy z odbić innych klientów agencji każdemu użytkownikowi.

**Działa: 5/10.** Pętla szkic → akceptacja → wysyłka → raport chodzi i jest odporna na awarie, ale pilot na prawdziwym sklepie zatrzyma się na pierwszym kroku (skąd wziąć odbiorców) i na trzecim (kto powie, że domena płonie).
**Wygląda: 7/10.** Codex daje 6–8 per ekran (mediana 7), ja podobnie: system „Dzień" jest spójny i czysty, profil osoby i przegląd są blisko 8, kampanie (lista) i wysyłka/domeny to 6, na 390 px lista kampanii jest ucięta tabelą z przewijaniem. Do „dziesięć na dziesięć" brakuje warstwy produktowej (akcje przy wierszach, filtry, menu kontekstowe, gęstość), nie tokenów.

---

## 2. TOP 20 braków (posortowane po wpływie na pilota)

| # | Co | Dowód | Skutek dla klienta | Rozmiar | Blokuje BF |
|---|---|---|---|---|---|
| 1 | **Brak importu bazy z Klaviyo** (profile, zgody, wypisy, skargi): FR62, FR63, FR27 | `grep -rin csv src` = 0; jedyne źródła profili to import zamówień Woo bez zgody (`src/usecases/importuj-historie.ts:113-131`) i popup (`src/usecases/popupy/zglos-popup.ts:69-111`) | Klient migrujący z Klaviyo nie ma w panelu ani jednego subskrybenta ze zgodą; bramka `canSendTo` (`src/usecases/wysylka/can-send-to.ts:43-57`) słusznie odrzuci wszystkich z importu Woo. Wysyłka do zera osób. | L | **TAK** |
| 2 | **Listy nie mają członków**: FR23 to tylko „utwórz listę" | żaden plik w `src/` nie wstawia do `list_members` (jedynie `scripts/zasiej-marketing.ts:56` i testy); `src/app/t/[tenantId]/listy/page.tsx:65-81` ma tylko formularz nazwy i opisu | Lista zawsze pokazuje 0 profili; kampania „do listy" nie ma dokąd pójść. | S/M | **TAK** (z #1) |
| 3 | **Dostarczalność ślepa przy własnym SMTP**: FR48, FR49 to atrapy w tej ścieżce | `zapiszZgloszenieDostawcy` (`src/usecases/wysylka/zdarzenia-dostawcy.ts:105`) woła wyłącznie `tests/odbicia.test.ts`; brak trasy/IMAP/DSN; `wskaznikiReputacji` (`src/usecases/wysylka/zaangazowanie.ts:263-291`) ma w mianowniku `delivered`, które nigdy nie powstaje; `sprawdzProgiReputacji` (`src/usecases/wysylka/reputacja.ts:113-189`) liczy na zerach | Twarde odbicia nie trafiają do wykluczeń, skargi nie wstrzymują tenanta, wskaźniki w kodzie nigdy nie zapalą progu. Spalenie domeny klienta bez żadnego sygnału. | M (parser DSN + IMAP) / L (SES) | **TAK** |
| 4 | **Webhooki `customer.*` rozbijają fazę 2 i kolidują kluczami z zamówieniami** | `src/adapters/store/webhooki.ts:22-28` (komentarz autora); klucz z zaszytym `order` niezależnie od tematu: `src/app/api/webhooks/woo/[storeId]/route.ts:79`; `przetworzZdarzenie` mapuje każdy payload jako zamówienie: `src/usecases/przetworz-zdarzenie.ts:23` → `naGrosze(undefined)` rzuca (`src/domain/kwoty.ts:9`) | Rejestracja B3 włącza 4 tematy (`webhooki.ts:30-35`), więc każdy nowy klient w sklepie = 5 nieudanych prób joba + alert; klient nr 8 i zamówienie nr 8 z tą samą datą dzielą klucz idempotencji, drugie zostanie po cichu odrzucone jako duplikat. | S | **TAK** |
| 5 | **Przepustowość i limit 500/dobę bez UI** | budowa wiadomości SELECT+INSERT per profil: `src/usecases/wysylka/wyslij-kampanie.ts:170-208`; wysyłka szeregowa, nowy transport TCP+TLS+AUTH na każdą wiadomość: `src/adapters/email/nodemailer.ts:163-186,229,264`; `testujPolaczenie()` przed każdą partią 25: `src/usecases/wysylka-konfiguracja/nadawca.ts:121`; limit 500 tylko w silniku: `wyslij-kampanie.ts:287-292`, `grep tenant_send_limits src/app` = 0 | Kampania BF do 10 tys. osób: przy 500/dobę wychodzi 20 dni; bez limitu, przy ~0,5–1 s/mail i jednym workerze, 1,5–3 h (NFR23: 30 min). Google Workspace/M365 dodatkowo odrzucą tysiące połączeń. | M | **TAK** |
| 6 | **Plan wysyłki w strefie serwera, nie polskiej** | `new Date(surowa)` z `datetime-local`: `src/app/akcje.ts:471`; etykieta „albo zaplanuj na (czas polski)": `src/app/t/[tenantId]/kampanie/[campaignId]/page.tsx:390`; host w UTC (znaczniki plików i logów `+0000`), dev startuje bez `TZ` (`scratchpad/restart-dev-3005.sh:17`) | Operator planuje 10:00, mail wychodzi 12:00 (CEST). Przy BF o 8:00 rano klient dostaje maila w południe. Nie sprawdzone na żywo (brak możliwości POST), wynika z kodu. | S | **TAK** |
| 7 | **Linki w mailach na `http://137.74.42.199:3005`** | domyślne `APP_URL`: `src/config.ts:14`; na żywo `GET /r/nieistniejacy` → `307 http://137.74.42.199:3005/`; `.env` nie ustawia `APP_URL`; ciasteczko `secure` zależy od `APP_URL` (`src/app/logowanie/akcje.ts:54`) | Redirect kliknięć, wypis, pixel, akceptacja klienta i webhooki Woo po http na gołym IP: filtr antyspamowy, brak TLS na sesji panelu, WordPress odmówi dostawy webhooka na port 3005 (`src/adapters/store/woo/adapter.ts:192-196`). | S (domena + TLS + reverse proxy) | **TAK** |
| 8 | **Wypis na GET wypisuje na prefetch** (S4 z 31.08 nienaprawione) | `src/app/u/[token]/route.ts:56-64`; komentarz `:12-14` przyznaje | Skanery Microsoft/Barracuda otwierają każdy link przed człowiekiem; przy bazie B2B odpływ subskrybentów bez ich wiedzy, dokładnie w pierwszej kampanii. | S | częściowo |
| 9 | **Wyciek cross-tenant: adresy z odbić i skarg wszystkich klientów widoczne dla każdego** | `wykluczeniaGlobalne()` bez `tenant_id`: `src/adapters/db/repozytoria.ts:296-302`; renderowane każdemu, także roli `client`: `src/app/t/[tenantId]/zgody/page.tsx:41,206-210` | Klient A widzi e-maile klientów sklepu B. MidRev jako procesor ujawnia dane osobowe między administratorami. | S | **TAK** (prawnie) |
| 10 | **Anonimizacja RODO zostawia dane osobowe** | `anonimizujProfil` czyści `profiles`, `orders.raw`, `messages.email`, `clicks.user_agent`, `list_members` (`src/usecases/profil-rodo.ts:182-210`), a nie rusza `raw_events.payload` (pełny JSON zamówienia z adresem dostawy i telefonem), `message_engagement.ip/user_agent`, `tenant_suppressions.email`; eksport też ich nie wydaje (`:57-109`) | Po „usunięciu" pełne dane osoby dalej leżą w `raw_events`. Pierwsze żądanie z art. 17 obsłużone nieprawdziwie, z wpisem w logu, że zrobione. | S | nie, ale obowiązek |
| 11 | **Flow = trigger + opóźnienie + jeden mail; edycji nie ma** (P14 z 31.08 nienaprawione) | `src/usecases/automatyzacje/journeye.ts:8-11,45-75`; `migrations/0010_automatyzacje.sql`; akcje tylko utwórz/przełącz: `src/app/t/[tenantId]/automatyzacje/akcje.ts`; Woo nie emituje koszyka: `src/adapters/store/woo/adapter.ts:129` | Nie zbudujesz powitania 3-mailowego, win-backu ani porzuconego koszyka; literówka w mailu = nowa automatyzacja. Kanwa w trakcie u drugiego agenta, jeszcze nie w repo. | L | nie (kampanie), TAK dla wyłączenia Klaviyo |
| 12 | **Segmenty: 5 reguł zakupowych, jedna na segment, zero reguł mailowych; zapis nadpisuje istniejący segment o tej nazwie** | `src/domain/segmenty.ts:10-15`; `segmenty/page.tsx:89`; `utworzSegment` `on conflict (tenant_id, name) do update set rules`: `src/adapters/db/repozytoria.ts:253-260`; **nieznany `typ` z formularza tworzy regułę, którą kompilator ignoruje** (`src/app/akcje.ts:80-93` bez walidacji, `src/adapters/db/segmenty.ts:17-53` switch bez `default`) → segment obejmuje wszystkich profili tenanta | Brak segmentu „zaangażowani" na rozgrzewkę i „nie klikał 180 dni" na sunset; segment z literówką w typie = cała baza. | M | częściowo |
| 13 | **Import historii ucina po 2000 zamówień i raportuje sukces; brak importu klientów, zgód z checkoutu i zakresu dat** (S5, N7 z 31.08 nienaprawione) | pętla `strona <= 20` × 100 w planie i wykonaniu: `src/usecases/importuj-historie.ts:45,103`; plan liczony tym samym sufitem, więc `rozbieznosc = null` (`:212-215`); `pobierzZamowienia` bez `response.ok` (`src/adapters/store/woo/adapter.ts:166-167`); parametr `od` adaptera nieużywany | Sklep z 8 tys. zamówień dostanie 2 tys. i zielony komunikat; przychód w przeglądzie zaniżony bez ostrzeżenia; błąd 5xx Woo = crash akcji. | M | **TAK** (raport przychodu) |
| 14 | **Brak modułu obrazów (FR33)** | edytor przyjmuje wyłącznie URL https (zrzut `scratchpad/final-3-edytor.png`, panel „Obraz musi leżeć pod publicznym adresem"); `grep -rn "upload\|multipart" src` = 0 | Operator potrzebuje własnego CDN na każdą grafikę; klient bez hostingu nie zbuduje maila. | M | częściowo |
| 15 | **Rola `client` bez ekranów, użytkownicy klienta bez UI, raport dla klienta nie istnieje** (FR4, FR7, FR60) | `nadajDostep` (`src/adapters/db/auth.ts:98`) nieużywany w `src/app`; konta zakładane skryptem (`scripts/zasiej-operatora.ts`); jedyne rozróżnienie roli: `src/app/akcje.ts:27`, `src/app/page.tsx:66,112` | Klient loguje się do pełnego panelu operatora (może wysyłać, usuwać dane) albo nie loguje się wcale. | M | nie |
| 16 | **„Wyślij teraz" bez transakcji** (S9 z 31.08 nienaprawione) | UPDATE `status='sending'` (`src/app/akcje.ts:415-424`) i `dodajZadanie` (`:444`) w dwóch krokach; dispatcher (`src/usecases/wysylka/sterowanie.ts:115-134`) i wznowienie (`:265-286`) robią to poprawnie w jednej | Awaria między krokami = kampania „w wysyłce" bez joba, na zawsze, bez alertu; nie da się jej wstrzymać ani wysłać ponownie. | S | nie |
| 17 | **500 na śmieciowym identyfikatorze; akcje kampanii bez walidacji UUID** (N4 częściowo) | na żywo `GET /t/{tenant}/profile/nie-uuid` → **500** (`src/usecases/profil.ts:133` bez walidacji); `String(formularz.get("campaignId"))` bez `wymaganaKampania` w `src/app/akcje.ts:315,385,451,465,517,535,546`; `storeId` w `src/app/t/[tenantId]/sklepy/akcje.ts:21` | Błąd Postgresa zamiast 404; spreparowany POST kończy się pięćsetką i śladem w logu. | S | nie |
| 18 | **Atrybucja tylko ręcznym przyciskiem** (NFR24 niespełniony) | handler `atrybucja` istnieje (`src/jobs/worker.ts:137-140`), nikt go nie kolejkuje (`grep '"atrybucja"' src` = 0 poza handlerem); przycisk: `kampanie/[campaignId]/page.tsx:205-212` | Przegląd pokazuje przychód z ostatniego ręcznego przeliczenia (dziś: 23.09); klient patrzy na nieaktualną liczbę i nie wie o tym. | S | nie |
| 19 | **Alerty idą donikąd; cisza sklepów i dobowa zgodność niewpięte** (FR71, NFR5, NFR38) | `.env` ma tylko `DATABASE_URL`, `SECRETS_KEY`, `SMTP_HOSTY_DEWELOPERSKIE` (bez `ALERT_WEBHOOK_URL`); `sprawdzCiszeSklepow` woła tylko test (`src/usecases/cisza-sklepow.ts:98-100` przyznaje); `sprawdzZgodnosc` liczona tylko przy wejściu na ekran (`src/app/t/[tenantId]/zgodnosc/page.tsx:18`); `worker.log` z ostatniej doby: 0 alertów | Wstrzymanie tenanta, przeterminowany plan, `held` po awarii SMTP: wszystko zostaje w `console.error` workera. | S | **TAK** |
| 20 | **Brak duplikowania kampanii, biblioteki szablonów kampanii, kalendarza, A/B, tagów, usuwania szkiców** | `kopiuj.tsx` to przycisk schowka; lista z 13 szkicami „Test edytora" bez akcji przy wierszu (zrzut `shots/r6/kampanie-d.png`); anulowanie zostawia rekord (`sterowanie.ts:305-345`) | Każda kampania od zera; po miesiącu lista jest śmietnikiem, którego nie da się sprzątnąć. | M | nie |

Poza dwudziestką, ale warte zapisania: UTM dla analityki klienta (FR38) nie istnieje (`grep utm_ src` = 0); nazwa sklepu wchodzi do HTML maila bez escapowania (`src/usecases/wysylka/renderuj.ts:89`, N3 z 31.08); `przepiszLinki` łapie tylko `href="http` w podwójnych cudzysłowach (`renderuj.ts:47`; lista kontrolna to uczciwie pokazuje); atrapa `role="radio"` „Infrastruktura MidRev (SES): w przygotowaniu" na ekranie wysyłki (`ustawienia/wysylka/page.tsx:148-167`) łamie zasadę „zero atrap" z DESIGN.md; dev-mikrocopy w produkcji („Tu trafia do Mailpita": `kampanie/[campaignId]/page.tsx:499`; nazwa zmiennej `SMTP_HOSTY_DEWELOPERSKIE` na ekranie: `ustawienia/wysylka/page.tsx:58`); skrypt popupu renderuje ciemną kartę w stylu „Noc" (`src/app/s/[tenantId]/route.ts:99-138`), niekonfigurowalną.

---

## 3. Pokrycie 28 modułów Klaviyo

| Moduł (pilot wg tabeli) | Stan | Dowód | Co mamy / czego brakuje |
|---|---|---|---|
| Account / Settings (tak) | częściowo | `migrations/0017:54-83`, `ustawienia/wysylka/page.tsx` | Nadawca, reply-to, serwer, domena. Brak: strefa czasu, adres firmy do stopki (FR53), użytkownicy, polityka śledzenia jako UI (kolumny 0014:276-280 bez ekranu). |
| Profiles CDP (tak) | częściowo | `src/usecases/profil.ts`, `profile/[profileId]/page.tsx` | Kartoteka z osią czasu, zgodami, bramką, RODO. Brak: wyszukiwarka (lista 200 bez filtra `profile/page.tsx:20`), edycja pól, własne właściwości, scalanie, telefon/SMS bez źródła. |
| Metrics (tak) | brak | `events.event_type` zamknięte: `order.created`, `popup.submitted`, `rodo.*` (`przetworz-zdarzenie.ts:88`, `zglos-popup.ts:120`, `profil-rodo.ts:133,230`) | Brak katalogu zdarzeń, autodiscovery schematu, własnych metryk. |
| Events (tak) | częściowo | `migrations/0002` (append-only, `occurred_at` bez defaultu) | Strumień istnieje, ale zasilany tylko 2 typami; brak API/importu zdarzeń, `$value` tylko przy zamówieniu. |
| Lists (tak) | częściowo | `repozytoria.ts:235-243` | Tworzenie listy. Brak członków, importu, eksportu, `opt_in_process`. |
| Segments (tak) | częściowo | `domain/segmenty.ts`, `adapters/db/segmenty.ts` | 5 reguł zakupowych, 1 na segment, licznik na żywo. Brak AND/OR, reguł mailowych, podglądu członków, gotowych segmentów. |
| Campaigns (tak) | częściowo | `kampanie/**`, `sterowanie.ts` | Kreator 4 kroki, harmonogram, wstrzymaj/wznów/odwołaj, akceptacja klienta, lista kontrolna, filtr i sort. Brak: klonowanie, A/B, kalendarz, tagi, akcje masowe, usuwanie, UTM. |
| Flows (tak) | częściowo, **w trakcie** | `journeye.ts`, `migrations/0010` | 2 triggery, opóźnienie, 1 mail, atrybucja per journey (0018). Brak warunków, gałęzi, wyjścia, edycji, koszyka. |
| Templates (tak) | częściowo | `src/domain/email/bloki/szablony.ts`, `render-blokow.ts` | Szablony startowe w edytorze + własny HTML. Brak biblioteki per tenant, zapisu własnych szablonów, języka szablonów (personalizacja `{{imie}}` nie istnieje). |
| Universal content (potem) | brak | `grep -ri "universal\|blok zapisany" src` = 0 | |
| Images (tak) | brak | brak uploadu; tylko URL (`schemat.ts:76-86`) | |
| Catalogs (potem) | brak | `pobierzProdukty` w adapterze (`woo/adapter.ts:174`) bez tabeli i bez wywołania | Blok „produkt" wypełniany ręcznie (`schemat.ts:135-147`). |
| Coupons (potem) | częściowo | kod w popupie (`zarzadzaj.ts:50`), blok „kod" (`schemat.ts:149-157`) | Jeden statyczny kod; brak puli kodów i integracji z Woo. |
| Web feeds (nie) | brak | | poza zakresem |
| Forms (tak) | częściowo | `s/[tenantId]/route.ts`, `api/popup/**`, `popupy/page.tsx` | 1 popup z opóźnieniem, textContent (bezpieczny), rate limit, licznik zapisów. Brak: targetowanie, częstotliwość, wersje, metryki wyświetleń, stylowanie (ciemna karta na sztywno), double opt-in. |
| Reviews (nie) | brak | | poza zakresem |
| Tags (potem) | brak | `grep -ri "tag" migrations` = 0 | |
| Webhooks wychodzące (potem) | brak | | |
| Webhook jako akcja flow (tak) | brak | journey ma tylko akcję „mail" | |
| Tracking settings (tak) | częściowo | `migrations/0014:276-289`, `src/usecases/wysylka/zgody.ts` | Polityka open/click per tenant i zgoda per profil, migawka na wiadomości. Brak UI polityki, brak UTM. |
| Reporting (tak) | częściowo | `raport-przegladu.ts`, `raport-zaangazowania.tsx`, `przelicz-atrybucje.ts` | Przegląd z przychodem sklepu i przypisanym, raport kampanii z rozdziałem ludzkie/maszynowe, per journey. Brak: raport zbiorczy w czasie, per link, per domena odbiorcy, eksport, dostarczalność, raport dla klienta. |
| Bulk jobs (tak) | brak | import Woo synchroniczny w server action (`akcje.ts:65-75`) | Przy dużym sklepie akcja przekroczy timeout; brak postępu, brak wznowienia. |
| Mobile push (nie) | nie dotyczy | | |
| Deliverability Hub (potem) | brak | dane zdefiniowane (0014 A2/A3), ingest nie istnieje (#3) | |
| Benchmarks (nie) | brak | | |
| Predictive analytics (potem) | brak | | |
| RFM (potem) | brak | reguły `wydal_powyzej`/`liczba_zamowien_min` to namiastka | |
| AI i agenci (potem) | brak | | |
| Customer Hub / Helpdesk (nie) | nie dotyczy | | |
| Integracje (tak) | częściowo | `adapters/store/woo/**` | Tylko WooCommerce (REST + webhooki z rejestracją i odczytem zwrotnym). Shopify/Shoper brak. |

Bilans dla modułów „pilot = tak" (16): mamy w całości 0, częściowo 11, brak 5 (Metrics, Images, Webhook jako akcja flow, Bulk jobs, Flows liczę do częściowo).

---

## 4. Pokrycie FR1–FR72 (sprawdzane w kodzie)

Legenda: **tak** = silnik + wejście dla użytkownika; **częściowo** = tabela/UI bez silnika, silnik bez UI albo część zakresu; **brak** = zero kodu.

| FR | Stan | Dowód i komentarz |
|---|---|---|
| FR1 | tak | `src/app/akcje.ts:21-36` |
| FR2 | tak | `src/app/t/[tenantId]/layout.tsx:57`, `przelacznik.tsx` |
| FR3 | częściowo | `nadajDostep` `src/adapters/db/auth.ts:98-108` bez UI; admin/operator mają dostęp globalny z roli (0006:11-14), „odebrać" nie istnieje |
| FR4 | częściowo | tylko `scripts/zasiej-operatora.ts`, `scripts/ustaw-haslo.ts`; brak formularza |
| FR5 | tak (z wyjątkiem) | `src/app/autoryzacja.ts:45-53` w każdej stronie i akcji; na żywo sfałszowane ciasteczko → 307; wyjątek: wykluczenia globalne (#9) |
| FR6 | częściowo | ślad tylko przy eksporcie i anonimizacji (`profil-rodo.ts:126-136,228-232`); przeglądanie profilu nielogowane |
| FR7 | brak | `memberships.role check (role in ('client'))` `migrations/0006:49` |
| FR8 | tak | `src/usecases/podlacz-sklep.ts:44-96` |
| FR9 | tak | `src/adapters/store/woo/adapter.ts:74-120` |
| FR10 | częściowo | tylko zamówienia; bez klientów, katalogu i zakresu dat; sufit 2000 (`importuj-historie.ts:45,103`) |
| FR11 | tak | `importuj-historie.ts:169`, `woo/adapter.ts:35` |
| FR12 | częściowo | zamówienia tak; klienci padają (#4); koszyka Woo nie ma (`adapter.ts:129`) |
| FR13 | tak | HMAC + timingSafeEqual `api/webhooks/woo/[storeId]/route.ts:54-63` |
| FR14 | tak | `sprawdz-zgodnosc.ts`, ekran `zgodnosc/page.tsx`; tylko na żądanie |
| FR15 | brak | |
| FR16 | brak | |
| FR17 | częściowo | kafle uprawnień `sklepy/page.tsx:105-113`; nie blokuje budowy automatyzacji na brakującym zdarzeniu |
| FR18 | tak | `src/usecases/profil.ts:224-269` |
| FR19 | tak | unikalność `lower(btrim(email))` (0001), `przetworz-zdarzenie.ts:32-48` |
| FR20 | częściowo | kartoteka jest; wyszukiwarki po e-mailu brak (`profile/page.tsx`) |
| FR21 | tak (z luką) | `profile/[profileId]/eksport/route.ts`; bez `raw_events` i `message_engagement` |
| FR22 | tak (z luką) | `profil-rodo.ts:162-287`; luka #10 |
| FR23 | częściowo | tylko utworzenie listy (#2) |
| FR24 | częściowo | 5 reguł, bez zaangażowania, 1 na segment |
| FR25 | tak | `policzSegment`, `odbiorcy/page.tsx:83-137` |
| FR26 | tak | `consents` append-only (0004:50-65), `zglos-popup.ts:107-111` |
| FR27 | częściowo | bramka wysyłki odrzuca bez zgody; importu z informacją o zgodzie w ogóle nie ma |
| FR28 | tak | `suppressions` (0001) + `tenant_suppressions` (0004:69-81) |
| FR29 | tak | `wyslij-kampanie.ts:402-409`; automatyzacje tym samym silnikiem (`przetworz-zdarzenia.ts:155`) |
| FR30 | brak | brak akcji `released`; brak sprawdzenia roli admin |
| FR31 | brak | |
| FR32 | tak | `tresc/edytor/**`, `render-blokow.ts` |
| FR33 | brak | tylko URL https |
| FR34 | tak | `odbiorcy-kampanii.ts`, `policz-odbiorcow.ts` |
| FR35 | tak | widok desktop/mobile w edytorze (`edytor.tsx:79-83`), test z edytora i z karty |
| FR36 | tak (błąd strefy) | `sterowanie.ts:110-145`; #6 |
| FR37 | tak | `sterowanie.ts:224-345` |
| FR38 | brak | `grep utm_ src` = 0 |
| FR39 | częściowo | link generowany, powiadomienia mailem do klienta nie ma (`akcje.ts:374-377`) |
| FR40 | tak | `akceptacja/[token]/**` |
| FR41 | tak | bramka w `wyslijTerazAkcja` i w dispatcherze; alert przeterminowanego planu |
| FR42 | częściowo | blok „produkt" ręczny, nie z katalogu |
| FR43 | częściowo | rekordy DNS do wklejenia (`weryfikacja-dns.ts:637-651`); instrukcji per rejestrator brak |
| FR44 | tak | `weryfikacja-dns.ts`, `domeny.ts:225-278` |
| FR45 | tak | `nadawca.ts:100-107`, `lista-kontrolna.ts:141-158` |
| FR46 | brak | `grep -ri warmup src migrations` = 0 (świadomie poza zakresem, PLAN blok B) |
| FR47 | brak | |
| FR48 | częściowo | klasyfikacja i zapis gotowe, ingestu brak (#3); `dropped` przy handoffie działa (`wyslij-kampanie.ts:525-531`) |
| FR49 | częściowo | progi i wstrzymanie zakodowane (`reputacja.ts`), dane nie napływają |
| FR50 | tak | `nodemailer.ts:232-236`, `renderuj.ts:90` |
| FR51 | tak | `u/[token]/route.ts:16-30` |
| FR52 | tak (bez UI) | `wyslij-kampanie.ts:415-421`, `tenant_send_usage` |
| FR53 | częściowo | stopka silnika: nazwa sklepu + wypis (`renderuj.ts:87-91`); adres firmy tylko gdy operator wstawi blok |
| FR54 | tak | `click_token` per wiadomość (`wyslij-kampanie.ts:184-206`) |
| FR55 | tak | `zaangazowanie.ts:159-172` |
| FR56 | brak | brak skryptu wiążącego sesję sklepu z tokenem; atrybucja idzie po `profile_id` klika i e-mailu zamówienia |
| FR57 | tak | `przelicz-atrybucje.ts:100-124` |
| FR58 | częściowo | `attribution_rules.window_hours` w bazie, bez UI; zmiana tylko SQL-em |
| FR59 | tak | `raportKampanii`, `raport-zaangazowania.tsx` |
| FR60 | brak | |
| FR61 | częściowo | lista tenantów z przychodem (`src/app/page.tsx:22-25`), bez wyników kampanii |
| FR62 | brak | |
| FR63 | brak | |
| FR64 | tak | dla źródeł, które istnieją |
| FR65 | częściowo | dane w `messages`; brak ekranu/eksportu „kto dostał tę kampanię" (krok `odbiorcy` to wybór źródeł) |
| FR66 | częściowo | bez warunków, opóźnień wielokrotnych i gałęzi |
| FR67 | tak | `SZABLONY` welcome/postpurchase (`journeye.ts:104-134`); koszyka brak |
| FR68 | brak | `TRIGGERY` zamknięte na 2 (`journeye.ts:8-11`) |
| FR69 | tak | ten sam silnik i bramki |
| FR70 | częściowo | wysłane per tenant per dzień w `tenant_send_usage`; aktywnych profili i UI brak |
| FR71 | częściowo | `wyslijAlert` z webhookiem; `ALERT_WEBHOOK_URL` nieustawione; rozjazd danych niewpięty |
| FR72 | brak | |

**Bilans:** tak 35, częściowo 22, brak 15.
Faza [1] (61 FR): tak 33, częściowo 18, brak 10 (FR30, 33, 38, 46, 47, 56, 60, 62, 63, 72).
Faza [2] (4 FR): tak 2 (FR67, 69), częściowo 1 (FR66), brak 1 (FR68).
Faza [3] (7 FR): częściowo 3 (FR17, 42, 61), brak 4 (FR7, 15, 16, 31).

NFR, które można ocenić z kodu: NFR1/2 spełnione w nowych modułach (odczyt zwrotny w `zapisz-tresc.ts:220-235`, `serwer.ts:228-253`, `profil-rodo.ts:236-270`, `przelicz-atrybucje.ts:128-147`); NFR3 spełniony (0014 zdjęło default z `message_events.occurred_at`); NFR5 niespełniony (tylko ekran); NFR7 spełniony (AES-256-GCM, `Sekret`, echo bez hasła); NFR8 niespełniony w tym deploymencie (http); NFR9 brak dedykowanych testów izolacji per moduł; NFR10 spełniony; NFR11 spełniony (18 B CSPRNG, sha256 dla pixela); NFR12 częściowo; NFR15/16 spełnione w silniku; NFR20 na żywo: karta kampanii 0,6 s, profil 0,8 s, lista kampanii 1,4 s, `/u` 4,1 s (zimny start Turbopack, nie miarodajne); NFR22 spełniony w kodzie (zapis + job w jednej transakcji, odpowiedź 200); NFR23 niespełniony (#5); NFR24 niespełniony (#18); NFR32 spełniony (akceptacja i `/u` responsywne); NFR33 spełniony (plakietki z kształtem); NFR36 spełniony (brak edycji zastosowanych migracji w `git status`, checksum w `scripts/migrate.ts:38-44`); NFR37 w tej rundzie nie odbył się (patrz metoda).

---

## 5. Oceny wyglądu per ekran

Źródło ocen: Codex `gpt-5.5`, `scratchpad/codex/ocena-r6.out` (24.09 07:58) na zrzutach `scratchpad/shots/r6/*.png` (24.09 07:54, 1440 px `-d`, 390 px `-m`). Referencje Klaviyo: `scratchpad/klaviyo-ref/`. Kolumna „moje" to moja ocena po obejrzeniu tych samych zrzutów; tam, gdzie Codex nie oceniał, jest tylko moja.

| Ekran | Zrzut | Codex | Moje | Najważniejsze różnice wobec Klaviyo |
|---|---|---|---|---|
| Szkielet + nawigacja | `shots/r6/start-d.png` | 7 | 7 | Sidebar „admin template": liczniki doklejone, lockup logo roboczy, aktywny stan poprawny. Brak prawej strefy akcji w nagłówku (zakres dat, wyszukiwarka globalna), które Klaviyo ma na każdym ekranie. |
| Przegląd desktop | `start-d.png` | 7 | 8 | Pieniądz na górze jak w Klaviyo, onboarding składany. Karta przychodu zbyt pocięta liniami, dwie kolumny źródeł z pustką w środku, tabele bez hover/akcji. |
| Przegląd telefon | `start-m.png` | 7 | 7 | Karta przychodu za długa, onboarding spycha dashboard; listy poprawne. |
| Logowanie | `logowanie-d.png`, `logowanie-m.png` | 7 | 7 | Czyste, generyczne; brak charakteru poza przyciskiem. |
| Wybór sklepu | `wybor-d.png`, `wybor-m.png` | 7 | 7 | Ekran administracyjny, duże ikony, pusta dolna karta. |
| Profil osoby desktop | `profil-d.png` | 8 | 8 | Najmocniejszy ekran: oś czasu, zgody z klauzulą, bramka wysyłki, RODO. Header rozrzucony, historia wysyłek „wciśnięta" pod oś, czerwona strefa RODO ciąży. |
| Profil telefon | `profil-m.png` | 7 | 7 | Długi ekran, URL-e w osi psują rytm; zwijana karta „Dane profilu" dobra. |
| Kampanie lista desktop | `kampanie-d.png` | 6 | 6 | Kolumny o tej samej wadze, prawy panel „Nowa kampania" doklejony, brak akcji przy wierszu, brak usuwania szkiców. Klaviyo: 7 kolumn, tagi, klonowanie, kalendarz. |
| Kampanie lista telefon | `kampanie-m.png` | (nie oceniał) | **4** | Tabela desktopowa ściśnięta w kontenerze `overflow-x-auto` (`kampanie/page.tsx:164`): kolumny „Plan wysyłki", „Ostatnia zmiana", „Odbiorcy" ucięte za krawędzią, wbrew DESIGN.md („nie ściskaj tabeli desktopowej", `ResponsiveTable`). Jedyny ekran, który na 390 px łamie kanon. |
| Kreator: przegląd i wysyłka | `scratchpad/final-7-przeglad.png` (23.09) | (nie oceniał) | 8 | Lista kontrolna z powodami, dwie kolumny decyzji, powód przy zablokowanym przycisku. Kalendarz `datetime-local` w formacie przeglądarki (`mm/dd/yyyy`), etykieta „czas polski" nieprawdziwa (#6). |
| Kreator: edytor bloków | `final-3-edytor.png`, `final-4-mobile.png` | (nie oceniał) | 8 | Paleta, płótno, panel właściwości, podgląd mobile z ramką telefonu, cofnij/ponów, autozapis. Brak obrazów z uploadu, brak personalizacji, przycisk „Wyślij test" zablokowany bez powodu obok (zrzut). |
| Kreator: odbiorcy | `scratchpad/final-1-odbiorcy.png` | (nie oceniał) | 8 | Pomiń/Wyślij/Wyklucz per źródło z rachunkiem po prawej, jak Klaviyo „Send to / Don't send to". |
| Kreator: temat i nadawca | `scratchpad/final-6-temat.png` | (nie oceniał) | 8 | Podgląd skrzynki odbiorczej z licznikami znaków. |
| Automatyzacje | `automatyzacje-d.png`, `automatyzacje-m.png` | 7 | 6 | Lista uboga, szablony jak placeholdery, formularz z surową `textarea` HTML zamiast edytora bloków (który już istnieje w kampaniach). Codex zauważa też, że lista mobilna gubi temat i „wysłane" (`review-1-znaleziska.txt`). W trakcie u drugiego agenta. |
| Segmenty | `segmenty-d.png`, `segmenty-m.png` | 7 | 7 | Reguły jako tokeny czytelne; kreator to formularz jednej reguły, przypis o „jednej regule" jako techniczna stopka. |
| Listy | `listy-d.png`, `listy-m.png` | (nie oceniał) | 6 | Poprawna karta, ale ekran obiecuje „import z pliku, ręczny dobór" (`listy/page.tsx:30`), których nie ma. |
| Zgody i wykluczenia | `zgody-d.png`, `zgody-m.png` | 7 | 7 | Spójne plakietki z kształtem; brak filtrów i eksportu; karta „Wykluczenia globalne" (poza estetyką) ujawnia cudze dane (#9). |
| Sklep i integracje | `sklepy-d.png`, `sklepy-m.png` | 7 | 7 | Dużo tekstu o tej samej wadze; alert webhooków dominuje; kafle uprawnień jako surowa siatka. |
| Zamówienia | `zamowienia-d.png`, `zamowienia-m.png` | (nie oceniał) | 7 | Czysta tabela; mobilna lista gubi e-mail klienta (Codex, `review-1-znaleziska.txt`). Brak filtrów i paginacji (limit 200). |
| Zgodność danych | `zgodnosc-d.png`, `zgodnosc-m.png` | (nie oceniał) | 7 | Trzy liczby i plakietka; brak historii w czasie. |
| Wysyłka i domeny | `wysylka-d.png`, `wysylka-m.png` | 6 | 6 | Panel diagnostyczny: rekordy w tabeli i osobno w kartach, formularz SMTP długi, atrapa wyboru SES, nazwa zmiennej środowiskowej w mikrocopy. Werdykt na górze to dobry ruch. |
| Formularze zapisu | `popupy-d.png`, `popupy-m.png` | (nie oceniał) | 7 | Poprawny ekran; sam popup na stronie sklepu jest ciemny i niestylowalny. |
| Akceptacja klienta `/akceptacja` | brak zrzutu r6; kod `akceptacja/[token]/page.tsx` | (nie oceniał) | 8 | Karta z tematem, preheaderem, podglądem w `iframe sandbox` i dwoma przyciskami; działa na telefonie. |
| Strona wypisu `/u` | kod `u/[token]/route.ts:37-48` | (nie oceniał) | 7 | Jedna karta, spójna z „Dzień". |

Średnia Codeksa dla 13 ocenionych ekranów: 6,9. Moja średnia dla 24 ekranów: 6,9. Wniosek dla właściciela: system tokenów i komponentów jest dobry i spójny, ekrany są „poprawne", a nie „zajebiste", bo brakuje im warstwy operacyjnej (akcje przy wierszach, filtry, menu kontekstowe, stany hover, gęstość) i produktowej pewności siebie (lockup marki, nagłówki z akcjami). To praca na tydzień w komponentach, nie przebudowa.

---

## 6. Znaleziska bezpieczeństwa

### P1
1. **Cross-tenant PII w ekranie zgód.** `wykluczeniaGlobalne()` (`src/adapters/db/repozytoria.ts:296-302`) czyta `suppressions` bez `tenant_id` i pokazuje 50 najnowszych adresów z odbić i skarg wszystkich sklepów każdemu zalogowanemu, także roli `client` (`src/app/t/[tenantId]/zgody/page.tsx:41,206-210`). Poprawka: pokazywać wyłącznie przecięcie z profilami tenanta (join po `lower(btrim(email))` z `profiles where tenant_id`), a pełną listę tylko adminowi.
2. **Anonimizacja RODO niekompletna** (#10): `raw_events.payload` z pełnym JSON-em zamówienia, `message_engagement.ip/user_agent`, `tenant_suppressions.email` zostają po „usunięciu"; log RODO twierdzi, że zrobione. Poprawka: dopisać czyszczenie tych trzech tabel do tej samej transakcji i do kontroli zwrotnej (`profil-rodo.ts:236-270`).
3. **Brak ingestu odbić/skarg = brak supresji z rzeczywistości** (#3). Nie jest to dziura w sensie ataku, ale jest to jedyne zabezpieczenie reputacji, które PRD nazywa ryzykiem nr 1, i nie działa.

### P2
4. **Wypis na GET** (`u/[token]/route.ts:56-64`): skanery prefetchujące wypisują ludzi. Poprawka: GET pokazuje stronę z jednym przyciskiem POST; POST RFC 8058 zostaje natychmiastowy.
5. **Transport: http, gołe IP, brak nagłówków.** `APP_URL` domyślnie `http://137.74.42.199:3005` (`src/config.ts:14`); ciasteczko sesji bez `Secure` w tej konfiguracji (`logowanie/akcje.ts:54`); na żywo odpowiedzi mają tylko `Cache-Control` i `X-Powered-By: Next.js`, brak `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy` (`next.config.ts` bez `headers()`). Panel z danymi osobowymi da się osadzić w ramce i podsłuchać.
6. **Otwarte przekierowanie po akcji**: `wrocDo` z formularza trafia do `redirect()` bez walidacji (`src/app/akcje.ts:567,580-586`). Wektor ograniczony (Next sprawdza `Origin` przy server actions), ale wzorzec `powrotKampanii` (`akcje.ts:132-138`) już istnieje i powinien być użyty.
7. **Limitery w pamięci procesu** (logowanie `src/usecases/auth/limiter.ts:5-8`, popup `api/popup/[popupId]/route.ts:23-35`) i brak jakiegokolwiek limitu na `/u`, `/r`, `/api/o`, `/akceptacja`: każdy GET to zapytanie do bazy; `zapiszNieblokujaco` ogranicza czas, nie liczbę. Tokeny są nieodgadywalne (18–32 B CSPRNG, sha256 dla akceptacji i pixela), więc zagrożeniem jest DoS na bazę, nie enumeracja. Popup: `X-Forwarded-For` ufany bez proxy, limit globalny 120/min pozwala jednym floodem wyłączyć popupy wszystkim tenantom (autor to wie, `:27-30`).
8. **Segment z nieznanym typem reguły = cała baza tenanta.** `utworzSegmentAkcja` nie waliduje `typ` (`src/app/akcje.ts:80-93`), kompilator ignoruje nieznane (`src/adapters/db/segmenty.ts:17-53`, brak `default`), więc spreparowany albo zepsuty formularz tworzy segment obejmujący wszystkich. S2 z 31.08 nienaprawione.
9. **„Wyślij teraz" bez transakcji** (#16) i **500 na śmieciowych identyfikatorach** (#17, potwierdzone na żywo dla `/profile/nie-uuid`).
10. **`journey_runs` bez `tenant_id`** (`migrations/0010:35-41`, S6 z 31.08): FK pojedyncze; poprawność trzyma się unikalności `journey.id`. `attributions`/`clicks` naprawione w 0018.
11. **Testy dzielą bazę z serwerem dev** (`tests/setup-env.ts` ładuje `.env`, `vitest.config.ts` wyłącza równoległość „bo sprzątanie jednego pliku wywracało dane drugiego"): `npm test` w trakcie pracy operatora na :3005 modyfikuje te same tabele. Potrzebna osobna baza testowa (`DATABASE_URL_TEST`).

### P3
12. Nazwa sklepu do HTML maila bez escapowania (`renderuj.ts:89`; wejście od admina/operatora; podglądy w `iframe sandbox=""`).
13. `X-Powered-By` w odpowiedziach; `/warianty` martwy wpis w `middleware.ts:23` (N5).
14. Sesja 14 dni bez rotacji, sprzątanie wygasłych tylko per użytkownik przy logowaniu (`zaloguj.ts:80`; S11).
15. Hasło bez górnego limitu długości przed scryptem (`zaloguj.ts`, `hasla.ts`; N8): 1 MB hasła = 1 MB do scrypt na każdą próbę do limitu 10/kwadrans.
16. `naGrosze` ucina trzeci znak ułamka (`src/domain/kwoty.ts:14`; N2), `mapujZamowienieWoo` bez sprawdzenia `date_created_gmt` (`adapter.ts:35`; N6).
17. `as any`: 16 wystąpień (`woo/adapter.ts` 4, `wyslij-kampanie.ts` 2, `importuj-historie.ts` 2, `akcje.ts` 2, po 1 w `zapisz-tresc.ts`, `wysylka-testowa.ts`, `lista-kontrolna.ts`, `przetworz-zdarzenia.ts`, `kampanie/[campaignId]/page.tsx`, `akceptacja/[token]/page.tsx`), prawie wszystkie na `content.html` i surowym payloadzie Woo. Jeden typ `TrescKampanii` zdejmuje 8 z nich.
18. Połknięte błędy bez logu: `domeny.ts:210` (kontekst SPF), `podlacz-sklep.ts:262-270`, `kopiuj.tsx:19-22`; `przetworz-zdarzenie.ts:104` rollback bez `catch` (N1 częściowo).
19. Indeksy: gorące ścieżki mają pokrycie (`click_token`, `unsubscribe_token`, `open_token` unikalne; `message_events (tenant_id, occurred_at) where sent`; `message_engagement` po źródle; `campaigns_zaplanowane_idx`). Do sprawdzenia w 0002/0003 (nie czytałem): indeks pod `events (tenant_id, event_type, occurred_at)` dla tiku automatyzacji co minutę per tenant (`przetworz-zdarzenia.ts:64-86`) i `orders (tenant_id, profile_id, occurred_at)` dla atrybucji.
20. Migracje: brak edycji zastosowanych plików (`git status` bez `M migrations/*`), checksum egzekwowany (`scripts/migrate.ts:38-44`). Stan webhooków trzymany w `stores.capabilities` jsonb zamiast tabeli (`stan-webhookow.ts:12-14`, dług jawny).

Nie zweryfikowałem wartości `SECRETS_KEY` w `.env` (guard tylko przy `NODE_ENV=production`, `config.ts:52-55`).

---

## 7. Co z audytów 31.08 zostało niezałatwione

### Audyt kodu (K/W/S/N)
| Znalezisko | Stan 24.09 | Dowód |
|---|---|---|
| K1 strefa `/t` bez sesji | **naprawione** | `wymaganyTenant` w 30 plikach; na żywo sfałszowane ciasteczko → 307 |
| W1–W6, W8 silnik i kolejka | naprawione (wg statusu z 31.08; kod spójny: `claimed_at`, `attempts`, rekoncyliacja, heartbeat, `tenant_send_usage`) | `wyslij-kampanie.ts`, `rekoncyliacja.ts`, `kolejka.ts:63-70`, 0011 |
| W7 ciało webhooka bez limitu | naprawione | `przeczytajOgraniczone` 1 MB (`route.ts:23,32`) |
| W9 akceptacja bez strażnika stanu | naprawione | `zdecydujAkcja` `status = 'awaiting_approval'` (`akceptacja/[token]/akcje.ts:40-44`) |
| S1 `SECRETS_KEY` z zer | naprawione warunkowo | guard tylko przy production (`config.ts:52-55`) |
| S2 segment bez walidacji typu | **nie** | `akcje.ts:80-93` (P2 nr 8) |
| S3 odbiorcy przeliczani przy wznowieniu | **nie** | `zbudujWiadomosciKampanii` woła `policzOdbiorcow` w każdym jobie (`wyslij-kampanie.ts:162`) |
| S4 `/u` GET wypisuje | **nie** | `u/[token]/route.ts:56` |
| S5 import: sufit 20 stron | **nie**, pogorszone (plan ma ten sam sufit, więc alarm rozbieżności nie zapala się) | `importuj-historie.ts:45,103,212` |
| S6 `journey_runs`/`clicks` bez FK tenantowych | częściowo (clicks: 0018; journey_runs: nie) | `0010:35-41`, `0018:29,108-110` |
| S7 indeks `clicks(message_id)` | naprawione | 0011 |
| S8 okno 48 h | naprawione | `przetworz-zdarzenia.ts:70-78` |
| S9 `sending` bez joba przy crashu | **nie** w „Wyślij teraz" (naprawione w dispatcherze i wznowieniu) | `akcje.ts:415-444` vs `sterowanie.ts:115-134` |
| S10 test raportuje sukces zawsze | naprawione | `wysylka-testowa.ts:60-96` |
| S11 sprzątanie sesji | **nie** | `zaloguj.ts:80` tylko per użytkownik |
| S12 tik automatyzacji rzuca przy limicie | naprawione | `handlery-automatyzacje.ts:23-28` |
| S13 test omija zgody | udokumentowane | `wyslij-kampanie.ts:402-404` |
| N1 rollback bez catch | częściowo | nowe pliki mają `.catch(() => {})`; `przetworz-zdarzenie.ts:104` nie |
| N2 `naGrosze` ucina | **nie** | `kwoty.ts:14` |
| N3 nazwa sklepu bez escapowania | **nie** | `renderuj.ts:89` |
| N4 500 na nie-UUID | częściowo | tenant → 404, kampania → 404, **profil → 500** (na żywo), akcje bez walidacji |
| N5 `/warianty` martwy | **nie** | `middleware.ts:23` |
| N6 brak `date_created_gmt` → Invalid Date | **nie** | `adapter.ts:35` |
| N7 Woo bez `response.ok` | **nie** dla `pobierzZamowienia/Klientow/Produkty` (naprawione dla webhooków) | `adapter.ts:139-187` vs `:209-219` |
| N8 hasło bez limitu długości | **nie** | `hasla.ts`, `zaloguj.ts` |
| N9 testy w limicie dobowym | świadome | test idzie przez `wyslijPartie` |
| N10 send OK + tx2 błąd | naprawione | `wyslij-kampanie.ts:571-583` |
| N12 `limit` interpolowany | **nie** | `adapters/db/segmenty.ts:77` |
| N13 `APP_URL` z IP | **nie** | `config.ts:14`, na żywo redirect |

### Audyt UX (B/P/S)
| Znalezisko | Stan 24.09 |
|---|---|
| B1–B5 (tokeny, przyciski, formularze, walidacja, cisza) | naprawione (system „Dzień", `Button`, `useActionState`, komunikaty zawsze na stronie źródłowej) |
| P1 wylogowanie i „kto zalogowany" | naprawione (`layout.tsx:74-84`) |
| P2 edycja po akceptacji | naprawione (`zapisz-tresc.ts:195-216`) |
| P3 link akceptacji tylko w banerze | naprawione (historia akceptacji na karcie, `page.tsx:471-492`) |
| P4 tabele bez kontenera na telefonie | częściowo: `ResponsiveTable`/`MobileList` wszędzie poza **listą kampanii** (`kampanie/page.tsx:164`, zrzut `kampanie-m.png`) |
| P5 atrapa wykresu | naprawione |
| P6 surowe enumy | naprawione (`stany.ts`, `statusy.ts`, `NAZWY_TEMATOW`) |
| P7, P8, P9, P10, P11, P12, P13 | naprawione (`Powod`, `daty.ts`, `odmien`, `wykluczony`, `error.tsx`, `aria-current`) |
| P14 automatyzacji nie da się edytować | **nie** (szablon wstawia link sklepu zamiast placeholdera, ale edycji dalej nie ma) |
| S1, S2, S5, S6, S8, S9 | naprawione |
| S3 dev-szczegóły w mikrocopy | **nie** („Tu trafia do Mailpita", `SMTP_HOSTY_DEWELOPERSKIE` na ekranie) |
| S4 komunikat w URL bez zamknięcia | **nie** (`?ok=` w adresie, `Komunikat` bez przycisku zamknięcia) |
| S7 liczniki tylko przy części pozycji | **nie** (Zgodność, Sklep, Wysyłka bez licznika, `layout.tsx:72`) |

Z audytu luk produktowych (poziom 1, 8 pozycji): zrobione 4 (domeny + blokada, harmonogram + anulowanie, rejestracja webhooków, RODO), zrobione połowicznie 2 (alerty: funkcja jest, kanał nie; progi skarg: kod jest, dane nie), niezrobione 2 (dostawca produkcyjny + webhooki odbić, import z Klaviyo). Świadomie odłożony 1 (warmup).

---

## 8. Kolejność prac na najbliższe 2 tygodnie

Cel: 30.10 pierwsza prawdziwa kampania. Zostało 5 tygodni, z czego 2 na tę listę. Poniżej wyłącznie rzeczy, bez których pilot nie rusza albo rusza niebezpiecznie; kanwa flowów i restyle idą równolegle u swoich agentów.

**Tydzień 1: żeby był do kogo i skąd wysłać**
1. Import CSV z Klaviyo (profile + data i źródło zgody) oraz osobny, obowiązkowy import wypisanych i skarg do wykluczeń; deduplikacja po `lower(btrim)`; liczniki z odczytu zwrotnego (#1, FR62–64). Rozmiar M, razem z ekranem.
2. Członkowie list: dodanie z importu CSV i z profilu, eksport CSV (#2). S.
3. Naprawa `customer.*`: mapowanie po temacie w `przetworzZdarzenie`, klucz idempotencji z bytem (`customer`/`order`) w trasie webhooka, test na payload klienta (#4). S. Bez tego rejestracja B3 zasypie alertami pierwszego dnia.
4. Import: paginacja do końca (`x-wp-totalpages`), `response.ok`, klienci i zgoda z checkoutu, zakres dat; uczciwy komunikat przy ucięciu (#13). M.
5. Konfiguracja wdrożenia: domena + TLS + reverse proxy, `APP_URL` https, `ALERT_WEBHOOK_URL` na kanał techniczny, `TZ=Europe/Warsaw` dla procesów albo strefa wpisana w parsowanie planu (#6, #7, #19). S, ale bez tego nic z listy nie ma sensu.

**Tydzień 2: żeby wysyłka przeżyła pierwszy dzień**
6. Ingest odbić przy własnym SMTP: skrzynka Return-Path czytana przez IMAP, parser DSN (RFC 3464) → `zapiszZgloszenieDostawcy`; do tego `delivered` liczone jako `sent` bez odbicia po 24 h, żeby progi B5 miały mianownik (#3). M. Alternatywa: przyspieszyć blok D (SES + SNS), ale to lead time poza kontrolą.
7. Przepustowość: `zbudujWiadomosciKampanii` jednym `INSERT … SELECT`; pula połączeń SMTP na partię (nodemailer `pool: true`, `maxConnections`), `testujPolaczenie` raz na job, nie na partię; ekran ustawienia limitu dobowego i podniesienie domyślnego (#5). M.
8. Wypis na GET jako strona z przyciskiem (#8), wyciek wykluczeń globalnych (#9), anonimizacja `raw_events` (#10), walidacja typu reguły segmentu i UUID w akcjach (#12, #17), „Wyślij teraz" w transakcji (#16). Każde S, razem jeden dzień.
9. Job atrybucji po zakończeniu kampanii i co 15 min (#18); job ciszy sklepów co godzinę i dobowej zgodności z alertem (#19). S.
10. Widok „kto dostał tę kampanię" z eksportem CSV (FR65), potrzebny do dwóch tygodni równoległej pracy z Klaviyo. S.

Po tych dwóch tygodniach: usuwanie/duplikowanie kampanii i lista mobilna kampanii (P4), edytor bloków w automatyzacjach zamiast `textarea`, UI limitu okna atrybucji, raport dla klienta. Warmup zostaje ręczny na `daily_limit`, zgodnie z decyzją z PLAN-DOWIEZIENIA.

---

*Audyt: przegląd kodu i migracji na branchu `feat/somifocus-moduly-5-6` (stan 24.09 ok. 08:00), GET-y na :3005, zrzuty i ocena Codeksa z równoległego procesu designu. Bez zmian w repo. Cross-review Codeksa diffa nie odbył się (harness); prompt w `scratchpad/codex/review-prompt.txt` do odpalenia z `codex --profile review exec --skip-git-repo-check -`.*
