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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
