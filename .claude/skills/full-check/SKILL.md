---
name: full-check
description: Run this repo's complete verification suite - Turborepo build/lint/typecheck/test across all 4 pnpm workspaces, plus the Python solver's pytest suite, with an optional Playwright E2E pass. Use before considering any change to apps/api, apps/web, packages/shared, packages/ui, or solver/ done, or when asked to "verify everything" / "run the full check" for this repo.
---

Run the full verification suite for the rostering-system monorepo, in this order, stopping to report clearly if any step fails rather than continuing past a red step.

## 1. Environment

Non-interactive shells need explicit sourcing (not on `PATH` by default):

```bash
source ~/.nvm/nvm.sh && nvm use default
source ~/.orbstack/shell/init.zsh   # only if a step below needs docker
```

## 2. TypeScript/JS workspaces (api, web, shared, ui)

```bash
pnpm turbo run build lint typecheck test
```

This must be run from the repo root. It's Turborepo-orchestrated across all 4 workspaces; `lint`/`typecheck`/`test` all depend on `^build` since `packages/shared`/`packages/ui` are consumed as compiled `dist` by the other workspaces, not source. `apps/api`'s integration tests hit a real Postgres (`apps/api/tests/helpers/testDb.ts` truncates+reseeds between tests) — if this step fails with connection errors, check whether `docker-compose.dev.yml`'s Postgres container is running (`docker compose -f docker-compose.dev.yml ps`) and start it if not (`docker compose -f docker-compose.dev.yml up -d`).

Use `--force` to bypass Turborepo's cache when you need to confirm a fix actually re-ran (e.g. after editing something Turborepo might not detect as a dependency change).

## 3. Python solver

```bash
cd solver && source .venv/bin/activate && python3 -m pytest tests/ -v
```

If `.venv` doesn't exist yet, set it up per `solver/README.md` first (`python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt -r requirements-dev.txt`).

## 4. Playwright E2E (optional — ask before running if not explicitly requested)

This spins up its own dedicated Postgres on port 5439 (isolated from the dev/prod compose databases) and dev servers for api+web — it's slower than steps 2-3 and not always necessary for a small change. Ask the user whether to include it unless they've already asked for "full"/"everything"/E2E explicitly.

```bash
pnpm exec playwright test
```

Runs `fullyParallel: false, workers: 1` (one shared DB across all tests, by design — don't try to speed this up by parallelizing) across chromium/firefox/webkit.

## Reporting

Summarize pass/fail per step (workspace build/lint/typecheck/test, solver pytest, E2E if run) rather than dumping raw output. If something fails, show the specific failure, not the whole log.
