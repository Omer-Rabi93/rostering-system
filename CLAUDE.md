# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

pnpm + Turborepo monorepo: `apps/api` (Express + TS), `apps/web` (Vite + React + TS), `packages/shared` (Zod schemas/types, consumed as compiled `dist`, not source), `packages/ui` (component kit, same), `solver/` (Python, CP-SAT via OR-Tools, not a pnpm workspace member), `infra/` (Dockerfiles, nginx.conf), `e2e/` (Playwright, repo root). Full architecture, DB schema, and setup instructions are in `README.md` — read that first, don't duplicate it here.

**Git state**: only the initial PRD/design-doc commit exists — the entire implementation (`apps/`, `packages/`, `solver/`, `e2e/`, `infra/`) is currently uncommitted. Don't rely on `git log`/`git blame` for implementation history yet.

## Environment — non-interactive shells need explicit sourcing

Neither of these is on `PATH` by default in a non-interactive shell (only in the user's interactive `.zprofile`-sourced shell):

```bash
source ~/.nvm/nvm.sh && nvm use default   # Node 24, before any node/pnpm/npx command
source ~/.orbstack/shell/init.zsh          # OrbStack's docker/docker compose CLI (not Docker Desktop)
```

Prefix any Bash tool command that needs `node`/`pnpm`/`docker` with the relevant one.

## Commands

- `pnpm build` / `pnpm lint` / `pnpm typecheck` / `pnpm test` — Turborepo-orchestrated across all 4 workspaces (`turbo.json`: `lint`/`typecheck`/`test` all depend on `^build`, so a workspace's deps must build first — `packages/shared`/`packages/ui` are consumed as built `dist`, not source).
- Each workspace's `lint` script is `eslint . --config ../../eslint.config.js` — cwd is the workspace directory. This matters because flat-config `files` globs match against `process.cwd()`, not the config file's location — a rule scoped with a repo-root-relative glob silently never fires under a workspace's own `lint` script. See `eslint.config.js`'s `apps/api/src/engine/**` rule for the pattern to follow (both root-relative and workspace-relative glob forms listed together).
- `apps/api` build is `tsc -p tsconfig.build.json` (not the default tsconfig). `apps/web` build is `tsc --noEmit && vite build`.
- Solver tests: `cd solver && source .venv/bin/activate && python3 -m pytest tests/ -v` (see `solver/README.md` for venv setup).
- Playwright E2E (`playwright.config.ts` + `e2e/`) runs against **dev servers**, not `docker compose` — `e2e/support/globalSetup.ts` spins up its own dedicated Postgres on port 5439, isolated from both the dev-compose and production-compose databases. `fullyParallel: false, workers: 1` (one shared DB across all tests) — don't parallelize this suite.

## TypeScript

`tsconfig.base.json` is strict beyond the default `strict: true` — also `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals`/`noUnusedParameters`. `exactOptionalPropertyTypes` means an optional field must be *omitted*, never assigned `undefined` — sparse payload builders need conditional spread (`...(x ? {x} : {})`), not `{x: undefined}`. `noUncheckedIndexedAccess` means indexed/map lookups return `T | undefined` — handle the absent case explicitly (this codebase treats "absent" as meaningful, e.g. no `WorkerAvailability` row = unavailable, not "assume available"); don't reach for `!` to silence it.

ESLint (flat config) additionally enforces `no-explicit-any`, `no-non-null-assertion`, `consistent-type-imports`, and `react/no-danger` on `.tsx`. Test files (`*.test.ts(x)`, `*.spec.ts`) relax `no-unsafe-*`/`no-explicit-any` since Supertest's `response.body` is untyped.

## Testing philosophy

`apps/api` integration tests run against a **real Postgres**, never mocked (`apps/api/tests/helpers/testDb.ts` truncates+reseeds between tests). `apps/api/vitest.config.ts` sets `fileParallelism: false` for exactly this reason — parallel test files racing on one shared DB causes real flakiness, not a false positive to "fix" by re-enabling parallelism.

This repo follows the `tdd` skill (`.claude/skills/tdd`) — vertical-slice red→green, not writing a batch of tests then implementing everything. It applies to page-level logic and hooks in the frontend too, not just backend services.

## Architecture constraints — don't regress these

- **`apps/api/src/engine/**` is framework-pure**: no imports from `express`, `@prisma/client`, or `pg-boss` (enforced by ESLint `no-restricted-imports`, see the Commands section above for the glob gotcha). Pure functions over plain data only — this is what makes the scheduling engine and validator independently testable and lets `solver/solve_roster.py` share the same wire contract.
- **Worker availability is date-specific**, not a weekly recurring pattern: `WorkerAvailability` is one row per `(workerId, calendar date)`. This was a deliberate correction (see `.notes/availability-v2-date-specific-plan.md`) after the original weekly 7×3-matrix design was found not to match the actual requirements. Don't reintroduce a weekly/day-of-week availability model.
- **Solver subprocess security contract** (`apps/api/src/engine/runSolver.ts`): `spawn(python, [scriptPath], {shell: false})` with problem data written *only* to stdin — never argv, never env. No user-derived value may ever reach a shell string or argv.
- **Route-scoped body size limits**: global `express.json({limit: '100kb'})` in `apps/api/src/app.ts`, except `PUT /api/availability/:month` which needs its own wider 2mb limit (dense month-of-availability payloads can exceed 100kb). Router mount *order* in `app.ts` is what makes this work — check the existing comment there before reordering routers.
- **Public schedule endpoint lives at `/api/schedule/:token`**, not bare `/schedule/:token` — the frontend's SPA route is `/schedule/:token` (React Router only, no backend meaning). These were originally the same literal path and collided (nginx couldn't tell a browser navigation from a data fetch); keep them separate.
