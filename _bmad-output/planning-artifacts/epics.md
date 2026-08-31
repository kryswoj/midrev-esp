---
stepsCompleted: ['step-01-validate-prerequisites', 'step-02-design-epics']
inputDocuments:
  - '_bmad-output/prd-midrev-esp-2026-08-27.md'
  - '_bmad-output/planning-artifacts/architecture/architecture-midrev-esp-2026-08-27/ARCHITECTURE-SPINE.md'
  - 'AGENTS.md'
  - 'migrations/0001_init.sql'
  - 'sandbox/woo/README.md'
scope: 'Faza 1 (MVP) - parytet kampanii na jednym sklepie WooCommerce'
---

# midrev-esp - Rozbicie na epiki

## Przegląd

Rozbicie fazy 1 z PRD na epiki i story. Faza 1 kończy się w momencie, w którym jeden sklep na
WooCommerce wysyła kampanie z midrev-esp równolegle do Klaviyo, a raport przychodu zgadza się
z panelem sklepu. Klaviyo pozostaje włączone, oszczędność wynosi zero i to jest zamierzone.

Numeracja FR i NFR pochodzi z PRD, numeracja AD z architektury. Każda story cytuje te numery,
żeby dało się cofnąć każdą linijkę kodu do wymagania i do decyzji architektonicznej.

## Inwentarz wymagań

### Wymagania funkcjonalne w fazie 1

Pełne brzmienie w PRD, sekcja Functional Requirements. W fazie 1 obowiązują wszystkie wymagania
oznaczone tam znacznikiem **[1]**, czyli FR1-FR6, FR8-FR14, FR18-FR30, FR32-FR41, FR43-FR53,
FR54-FR60, FR62-FR65, FR70-FR72. Poza fazą 1 zostają: FR7, FR15-FR17, FR31, FR42, FR61 (faza 3)
oraz FR66-FR69 (faza 2).

### Wymagania niefunkcjonalne

NFR1-NFR38 z PRD obowiązują w całości od pierwszej story. Grupy o największym wpływie na
kształt story: poprawność danych (NFR1-NFR6), bezpieczeństwo (NFR7-NFR13), niezawodność
(NFR14-NFR19), utrzymywalność (NFR35-NFR38).

### Wymagania dodatkowe z architektury

- **Migracja 0002 jest warunkiem wejścia** (AD-30): usuwa `default now()` z `occurred_at`,
  ustawia `uuidv7()`, dodaje `tenant_suppressions`, `message_events`, `attribution_rules`.
  Bez niej baza łamie AD-10, a testy tego nie wykrywają.
- Struktura katalogów wg AD-1: `domain`, `usecases`, `adapters`, `jobs`, `app` (Next),
  `site-script` osobno. Nazwa `src/app/` należy do Next.js.
- Stack: Node 24, Next 16.3.3, React 19.2.8, Tailwind 4.3.3, TypeScript 6.0.3, PostgreSQL 18.6,
  pg 8.23, zod 4.4.3, vitest 4.1.11, uuid 14, `@maily-to/core` 0.3.7 + `@maily-to/render` 0.2.3.
- Kolejka w Postgresie z `SKIP LOCKED`, partycjonowana po dniu, bez wywołań sieciowych
  w transakcji zajmującej zadanie (AD-5, AD-31).
- Porty: `StorePlatform` (AD-8), `EmailProvider` (AD-7), `TemplateEditor` (AD-32). Adapter
  deklaruje możliwości, interfejs nie oferuje funkcji niedostępnych na danej platformie.
- Dostawca wysyłki: Amazon SES eu-central-1 z funkcją Tenants jako pierwszy adapter,
  EmailLabs jako drugi tor. Wyjście z piaskownicy SES i warmup domeny to proces czekania,
  nie kodowania: przy Black Friday start najpóźniej na początku października.
- Sandbox WooCommerce (`sandbox/woo`) jest środowiskiem testowym każdego story dotykającego
  adaptera sklepu: 8 produktów, 6 klientów, 40 zamówień od lipca 2025.

### Wymagania UX

Brak osobnego dokumentu UX. Warstwa wizualna stoi na brandzie MidRev (ciemny panel operatora,
jasny widok klienta, ten sam fiolet) i na NFR32-NFR34. Formalny spine UX powstaje równolegle
do epików 1-3, zanim ruszy Epik 5 (kampanie), bo to tam jest najwięcej interfejsu.

## Mapa pokrycia wymagań

| Epik | Wymagania funkcjonalne | Kluczowe decyzje |
|---|---|---|
| 1. Fundament i podłączenie sklepu | FR1-FR6, FR8-FR14 | AD-1, AD-2, AD-3, AD-4, AD-8, AD-10, AD-21, AD-24, AD-29, AD-30 |
| 2. Odbiorcy, zgody i wykluczenia | FR18-FR30 | AD-9, AD-16, AD-18, AD-25, AD-27 |
| 3. Domena wysyłkowa i silnik wysyłki | FR43-FR53 | AD-5, AD-6, AD-7, AD-22, AD-23, AD-26, AD-31 |
| 4. Kampanie i akceptacja klienta | FR32-FR41 | AD-3, AD-17, AD-25, AD-32 |
| 5. Atrybucja i raporty | FR54-FR60 | AD-11, AD-14, AD-19, AD-28, AD-33 |
| 6. Migracja z dotychczasowego ESP | FR62-FR65 | AD-10, AD-24, AD-25, AD-26 |
| 7. Nadzór, zgodność i rozliczenie | FR6, FR21, FR22, FR70-FR72 | AD-12, AD-13, AD-16, AD-31 |

## Lista epików

**Epik 1 — Fundament i podłączenie sklepu.** Operator zakłada tenanta, podpina sklep
WooCommerce i widzi zaimportowaną historię wraz z ekranem zgodności danych. Zamyka dług
techniczny z migracji 0001 i stawia szkielet aplikacji, kolejki i testów. Po tym epiku system
ma prawdziwe dane prawdziwego sklepu i da się na nich pracować.

**Epik 2 — Odbiorcy, zgody i wykluczenia.** Operator buduje listy i segmenty, widzi ich
liczebność, a system prowadzi rejestr zgód i dwie listy wykluczeń. Po tym epiku wiadomo, do
kogo wolno wysłać, zanim powstanie cokolwiek, co wysyła.

**Epik 3 — Domena wysyłkowa i silnik wysyłki.** Klient weryfikuje własną domenę, system
wysyła przez adapter dostawcy z warmupem, limitami i obsługą odbić i skarg. Po tym epiku
z systemu wychodzi prawdziwy mail, ale jeszcze bez kampanii jako produktu.

**Epik 4 — Kampanie i akceptacja klienta.** Operator składa kampanię w edytorze, wybiera
odbiorców, wysyła test, planuje wysyłkę, a klient akceptuje ją bez logowania. Po tym epiku
istnieje pełna ścieżka od pomysłu do wysyłki.

**Epik 5 — Atrybucja i raporty.** Kliknięcia są śledzone własnym tokenem, przychód wiązany
z kampanią w wersjonowanym oknie, a operator i klient widzą raport. Po tym epiku da się
odpowiedzieć na jedyne pytanie, które decyduje o losie projektu: czy liczby się zgadzają.

**Epik 6 — Migracja z dotychczasowego ESP.** Operator przenosi kontakty ze zgodami,
wykluczenia i historię, a system pilnuje, żeby w trybie równoległym nikt nie dostał tego
samego maila dwa razy. Po tym epiku można wpuścić prawdziwego klienta.

**Epik 7 — Nadzór, zgodność i rozliczenie.** Dobowa kontrola zgodności danych, alerty do
człowieka, log dostępu do danych osobowych, eksport i usunięcie profilu, liczniki zużycia.
Po tym epiku system nadaje się do postawienia przy prawdziwych danych osobowych.

**Kolejność jest wiążąca w zakresie 1 → 2 → 3 → 4 → 5.** Epik 6 może iść równolegle do 4,
bo dotyka innych plików. Epik 7 dokłada się kawałkami do wcześniejszych epików wszędzie tam,
gdzie powstaje pierwszy zapis danych osobowych, ale ma osobne story, żeby nie zniknął.
