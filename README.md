# midrev-esp

Własny ESP (email/SMS marketing automation dla ecommerce) budowany w ramach MidRev.
Kontekst produktowy, architektura i uzasadnienia decyzji: `../research/wlasny-esp/`
w repo `my-marketingskills` (poza tym repo, bo to jest osobny kod, nie treść marketingowa).

## Sandbox (lokalny dev)

```bash
npm install
cp .env.example .env
npm run sandbox:up      # Postgres na localhost:5433
npm run migrate         # aplikuje migrations/*.sql
npm test                # Vitest — integracyjne testy na sandboxie
```

## Metoda pracy

Ten projekt używa BMAD Method (plugin Claude Code, marketplace `bmad-method`) do
strukturyzowania pracy agentów — patrz `AGENTS.md`.
