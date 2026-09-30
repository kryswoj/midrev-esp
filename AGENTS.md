# AGENTS.md — midrev-esp

Osobny projekt (osobne repo git) od `my-marketingskills`. Kod tego produktu żyje tutaj;
research/decyzje produktowe zostają w `my-marketingskills/clients/midrev/research/wlasny-esp/`
(trzy dokumenty: RESEARCH, PLAN-SAAS-ARCHITEKTURA, PM-PLAN-MODULY-API — czytać przed
robotą nad którymkolwiek modułem, tam są uzasadnienia, nie tylko lista).

## Metoda pracy — BMAD Method

Plugin `bmad@bmad-method` zainstalowany (scope: user, marketplace PabloLION/bmad-plugin).
`_bmad/core/config.yaml` już skonfigurowany dla tego projektu (27.08.2026).

Dostępne persony/agenty z pluginu: `analyst`, `pm`, `architect`, `sm` (scrum master),
`dev`, `qa`, `ux-designer`, `tech-writer`, plus skille `bmad-create-prd`,
`bmad-create-architecture`, `bmad-create-epics-and-stories`, `bmad-create-story`,
`bmad-dev-story`, `bmad-code-review`, `bmad-sprint-planning`, `bmad-sprint-status`,
`bmad-testarch-*` (framework/ci/automate/test-design/nfr/trace/atdd — infrastruktura
testowa, użyć PRZED pisaniem pierwszego prawdziwego modułu, nie po).

**Ważne — plugin ładuje się na starcie sesji.** Jeśli te skille/agenty nie pojawiają się
w bieżącej sesji Claude Code, otwórz nową sesję w tym katalogu (`cd midrev-esp && claude`).

**Sugerowany pierwszy realny przebieg pracy (do zrobienia w nowej sesji):**
1. `pm` / `bmad-create-prd` — PRD na bazie `PM-PLAN-MODULY-API-2026-08-27.md` (epiki A-I
   już tam rozpisane, nie zaczynać od zera)
2. `architect` / `bmad-create-architecture` — architektura na bazie
   `PLAN-SAAS-ARCHITEKTURA-2026-08-27.md`
3. `bmad-testarch-framework` + `bmad-testarch-ci` — fundament testowy PRZED pierwszym
   modułem (już jest zalążek: `tests/cdp.test.ts`, Vitest, sandbox Postgres)
4. `sm` / `bmad-create-epics-and-stories` — rozbicie na story
5. `dev` / `bmad-dev-story` — implementacja story po story

## Rytm pracy per moduł (z PM-PLAN-MODULY-API, obowiązuje niezależnie od BMAD)

1. Spec (1 strona, BMAD story albo ręcznie)
2. Budowa — Codex do mechanicznej roboty w kodzie, Claude/BMAD agenty do orkiestracji
   i decyzji architektonicznych
3. **Review Codeksem OBOWIĄZKOWE przed mergem** (`git diff main | codex --profile review
   exec`, z kontekstem: co to robi, historia błędów, na czym się skupić)
4. Triage → druga runda review → dopiero wtedy moduł zamknięty

## Zasada twarda: migracji nie edytuje się po zastosowaniu

`migrations/0001_init.sql` był edytowany w miejscu 27.08 (dwie rundy review Codeksa) —
dopuszczalne WYŁĄCZNIE dlatego, że projekt jeszcze nie miał żadnego realnego wdrożenia i
jedyny wolumen sandboxa został przy okazji skasowany (`docker compose down -v`). Od
pierwszego realnego użycia (nawet przez jedną osobę na drugiej maszynie) — **każda zmiana
schematu to NOWY plik migracji**, nigdy edycja istniejącego. `scripts/migrate.ts` i tak to
wymusi (porównuje checksum, rzuca błąd przy rozjeździe), ale nie ratuje to kogoś, kto ma
stary wolumen z czasu przed dodaniem tabeli `schema_migrations` — taki wolumen trzeba
świadomie skasować i zmigrować od zera, nie ufać "applied" bez sprawdzenia realnych
constraintów.

## Zasada twarda: testy jako specyfikacja

Żaden moduł nie jest "zrobiony" bez testu, który realnie sprawdza zachowanie opisane w
spec (nie testu-atrapy). `tests/cdp.test.ts` jest wzorcem: integracyjny test na sandboxie,
nie mock.

## Sandbox — co jest, a czego jeszcze nie ma

- Postgres (Epik A2 — CDP: tenants/profiles/events, suppressions) — DZIAŁA
- Dittofeed (Epik E — flow engine) — NIE dodany jeszcze do docker-compose, dołożyć przy
  starcie Epiku E, nie wcześniej (niepotrzebny ciężar dla samego fundamentu)
- Elastic Email / Postmark (Epik D — wysyłka) — brak w sandboksie, wymaga prawdziwego
  konta zewnętrznego; do Epiku D użyć trybu testowego dostawcy, nie produkcyjnych kluczy

## Bezpieczeństwo / dane

Ten projekt na razie NIE dotyka żadnej prawdziwej infrastruktury produkcyjnej (Railway
MySomi, Cloudflare, itd.) — cała praca lokalna na sandboxie. Gdy dojdzie do pierwszego
prawdziwego wdrożenia (Railway/Supabase realny projekt), obowiązują zasady z
`my-marketingskills/CLAUDE.md` (tokeny infra, zapis do produkcji, Codex review) —
przeczytać ZANIM padnie pierwsza decyzja o realnym deployu.

## Testy

`npm test` (= `npx vitest run`) chodzi na **osobnej bazie `midrev_esp_test`** w tym samym
kontenerze Postgresa, nie na `midrev_esp`. Serwera dev :3005 ani workera nie trzeba
zatrzymywać: nie widzą danych testów, a testy nie widzą ich danych.

- **Zakładanie i migracje — same.** `tests/global-setup.ts` (globalSetup vitest) zakłada bazę,
  jeśli jej nie ma, i puszcza wszystkie migracje tym samym `scripts/migrate.ts` co dev
  (z ochroną checksum). Nowa migracja w `migrations/` wchodzi przy następnym `npm test`.
- **Adres:** `TEST_DATABASE_URL` (środowisko albo `.env`), domyślnie
  `postgresql://midrev:midrev@localhost:5433/midrev_esp_test`. Nigdy nie jest wyprowadzany
  z `DATABASE_URL`.
- **Twarde zabezpieczenie:** `tests/setup-env.ts` bezwarunkowo nadpisuje `DATABASE_URL`
  adresem bazy testowej, a globalSetup i setup-env odmawiają startu, jeśli nazwa bazy nie
  kończy się na `_test` (`tests/baza-testowa.ts`). Testy kasują dane (`delete from tenants
  where name like ...`); na dev albo produkcji by je zniszczyły.
- **Rozjazd checksum** (ktoś poprawił niezacommitowaną migrację, którą baza testowa już
  ma): `npm run test:reset` kasuje `midrev_esp_test` i zakłada ją od zera. Działa tylko na
  bazie `*_test`.
- Pliki idą po kolei (`fileParallelism: false`), bo dzielą jedną bazę testową. Dwa
  równoległe `npm test` na tej samej maszynie dalej mogą sobie wchodzić w drogę.

### Testy z żywym WooCommerce (`npm run test:woo`)

`sklepy`, `webhooki-klient` i `import-pelny` rozmawiają z sandboxem Woo (:8091, klucze
w `sandbox/woo/.woo-credentials`; bez nich się pomijają). Też chodzą na bazie testowej.

Dostawa webhooka ze sklepu **nie idzie na serwer dev :3005** (on pisze do bazy dev, a sklep
z bazy testowej dostałby tam 404). Na czas testu `tests/odbiornik-webhookow.ts` stawia mały
serwer HTTP na `172.22.0.1:3015` z **tym samym handlerem trasy** co produkcja
(`src/app/api/webhooks/woo/[storeId]/route.ts`), piszący do bazy testowej. Kod produkcyjny
bez zmian; mu-plugin sandboxa (`sandbox/woo/mu-sandbox-ssl.php`) dopuszcza port 3015 obok 3005.

Testy czekające na dostawę (zamówienie/klient z Woo w `raw_events`) są w `npm test`
**pomijane** i idą tylko w `npm run test:woo` (`TEST_WOO_DOSTAWA=1`), bo wymagają, żeby
kontener Woo dosięgnął hosta na porcie 3015. Na VPS-ie ufw wpuszcza tylko porty z listy,
więc potrzebna jest jednorazowa reguła (tylko z sieci dockera sandboxa, nie z internetu):

```bash
sudo ufw allow in on br-f72b08e32e0b from 172.22.0.0/16 to 172.22.0.1 port 3015 proto tcp \
  comment 'midrev-esp testowy odbiornik webhookow Woo'
```

Bez niej `test:woo` padnie na teście „zamowienie zlozone w sklepie dociera webhookiem”.
Reszta testów Woo (zakładanie webhooków, import historii) idzie w zwykłym `npm test`.

### Resztki starych testów w bazie dev

Do 25.09 testy chodziły na `midrev_esp`. `npm run sprzatnij-resztki-testow` pokazuje
(podgląd, domyślnie) tenanty testowe po jawnej liście prefiksów nazw; `-- --wykonaj` je
usuwa (tylko lokalny sandbox, odczyt zwrotny w transakcji). Tenant demo
`01a043a1-472a-7769-a85f-a919ca2395fd` nie jest usuwany nigdy; kampanie „Test …” w nim
są tylko raportowane. Nowy prefiks tenanta w testach = dopisz go do `WZORCE` w skrypcie.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
