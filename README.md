# Rostering System

A full-stack workforce rostering system for a 24/7 security-staffing operation: HR management
(companies, workers, contracts), a constraint-solver rostering engine that generates a month's
shift schedule respecting date-specific worker availability, manual roster editing with hard/soft
validation, CSV import/export, background job processing, and a React SPA — all containerized
behind a single nginx entrypoint.

## Table of contents

- [System architecture](#system-architecture)
- [Database schema](#database-schema)
- [Setup & run instructions](#setup--run-instructions)
- [CSV schema](#csv-schema)
- [Bonus features](#bonus-features)

## System architecture

### Monorepo layout

```
apps/
  api/        Express REST API + pg-boss background worker (same package, two entrypoints)
  web/        React SPA (Vite, Redux Toolkit Query, React Router)
packages/
  shared/     Zod schemas, domain constants/types, pure validation helpers — imported by both api and web
  ui/         Presentational component kit (Modal, FormField, Table, ...) used by apps/web
solver/       Standalone Python CP-SAT scheduling engine (OR-Tools), invoked as a subprocess
infra/        Dockerfiles (api, worker, web/nginx) + infra/nginx.conf
docs/         Design doc + CSV schema reference
samples/      Sample CSV files matching the seed data
```

This is a pnpm workspace managed by Turborepo (`turbo.json`): `packages/shared` builds first
(pure domain logic, zero framework dependencies), then `apps/api` and `apps/web` build against
its compiled output. `packages/ui` builds independently and is only consumed by `apps/web`.

### Request flow

```
Browser ──► nginx (:80, only published port)
              ├─ / ─────────────────► serves the built SPA (history-mode fallback to index.html;
              │                       this is what owns /schedule/:token, the frontend route)
              ├─ /api/schedule ─────► upstream "api" (least_conn), rate-limited (public token route)
              └─ /api ──────────────► same upstream, no edge rate limit

api replicas ──► Postgres (single instance, internal network only)
              └─► pg-boss (job queue, backed by the same Postgres) ──► worker container
                                                                          └─► python3 solver/solve_roster.py
                                                                              (subprocess, JSON over stdin/stdout)
```

- **SPA → nginx → api replicas → Postgres.** `docker-compose.yml` publishes *only* nginx's
  port 80; every other service (`postgres`, `api`, `worker`) is reachable exclusively over the
  compose project's internal Docker network. `infra/nginx.conf` proxies `/api` (including
  `/api/schedule`) to an `upstream api { least_conn; server api:3000; }` block — because a scaled compose service
  (`docker compose up --scale api=2`) registers multiple A records under one DNS name, nginx
  resolves all of them at startup and load-balances across whichever replicas are healthy, with
  no shared in-process state required on the api side (every replica is stateless — all state
  lives in Postgres).
- **Background jobs run in a separate `worker` container**, not inside the request/response
  cycle: `POST /api/rosters/generate` and the CSV-import endpoints enqueue a pg-boss job and
  return `202 { jobId }` immediately; the client polls `GET /api/jobs/:id` for progress. This
  keeps roster generation (which can take up to the solver's 30-second budget) and CSV
  processing off of user-facing request threads, and lets `api` stay horizontally scalable
  independent of job throughput.
- **The scheduling engine itself is a separate Python process**, not reimplemented in
  TypeScript: `apps/api/src/engine/runSolver.ts` spawns `solver/solve_roster.py` as a
  subprocess (`spawn(pythonExecutable, [scriptPath])`), sending the month's problem (staffing
  requirements, active workers, per-worker date→shift availability, contract hour bounds) as
  JSON over stdin and reading the assignment solution back over stdout. OR-Tools' CP-SAT solver
  is genuinely the right tool for a constraint-satisfaction/optimization problem like this —
  reimplementing a SAT solver in TypeScript would be both slower and far more error-prone than
  wrapping the purpose-built library. The `worker` image is the only one that bundles a Python
  venv with OR-Tools installed; `api` never spawns the solver directly (only the background job
  handler does).

### Why this shape

- **SOLID layering, thin routes → services → pure engine.** Express routes
  (`apps/api/src/routes/*.ts`) do request parsing/status codes only; business logic lives in
  `services/*.ts`; the scheduling/validation core (`engine/validator.ts`,
  `solver/solve_roster.py`) is pure and framework-free (an ESLint rule enforces that
  `src/engine/**` never imports `express`, `@prisma/client`, or `pg-boss`), so the hard/soft
  rostering rules can be unit-tested in isolation and reasoned about without any HTTP or DB
  context.
- **Scalability via stateless api replicas behind nginx.** Because every `api` instance is
  stateless (no in-memory sessions, no sticky state), `--scale api=N` is a drop-in horizontal
  scale-out with zero code changes — nginx's `least_conn` upstream picks up new replicas
  automatically via Docker DNS.
- **One-shot `migrate` service.** Both `api` and `worker` declare
  `depends_on: migrate: condition: service_completed_successfully`, so `prisma migrate deploy`
  always runs exactly once against a fresh database before anything else starts — no manual
  migration step, no race between replicas trying to migrate concurrently.
- **Shared package boundary.** `packages/shared` is the single source of truth for domain types,
  Zod validation schemas (e.g. Israeli-ID checksum, shift-subset canonicalization, month/date
  bounds), and constants (`ROLES`, `SHIFT_TYPES`, `SHIFT_HOURS`) — both `apps/api` (server-side
  validation) and `apps/web` (client-side form validation) import the exact same schemas, so
  validation logic can never drift between client and server.

See `docs/design/rostering-system-design.html` for the full architecture write-up (sequence
diagrams, the CP-SAT model definition, and the original design rationale).

## Database schema

Postgres via Prisma (`apps/api/prisma/schema.prisma`). Core entities:

| Entity | Purpose |
| --- | --- |
| `Company` | Employer of record for workers (case-insensitively unique name). |
| `Worker` | A staffable person: national ID, name, role (`GENERAL_GUARD`/`SUPERVISOR`/`SCREENER`), status (`ACTIVE`/`INACTIVE`), employer, and a `shareToken` for the public schedule link. |
| `Contract` | One-to-one with `Worker`: hourly cost and contracted min/max monthly hours. |
| `WorkerAvailability` | One row per `(worker, calendar date)` carrying the subset of `{A,B,C}` shifts that worker can work *that exact date*. Absence of a row means unavailable that date. |
| `StaffingRequirement` | One row per `(role, shift)` — how many workers of that role are required on that daily shift (≤ 9 rows total: 3 roles × 3 shifts). |
| `Roster` | One row per calendar month (`YYYY-MM`, unique), `DRAFT` or `PUBLISHED`. |
| `Shift` | One row per `(roster, date, shiftType)` — a schedulable slot. |
| `ShiftWorker` | Join table: which worker(s) are assigned to which shift, with a snapshot of their role at assignment time. |
| `Alert` | Generated per roster: `UNFILLABLE_SLOT` (a shift/role cell short of its requirement) or `MIN_HOURS_SHORTFALL` (a worker under their contracted minimum), each independently acknowledgeable. |

### Key design choices

- **`Shift`/`ShiftWorker` normalization instead of a flat table.** A flat "one row per
  worker-shift-assignment" table would duplicate `date`/`shiftType` across every worker on a
  busy shift and make "is this slot fully staffed" a `GROUP BY` instead of a direct lookup.
  Splitting into `Shift` (the slot) and `ShiftWorker` (who's in it) makes both the calendar-grid
  read (`@@index([rosterId, date])` on `Shift`) and the solver's coverage-counting cheap, and
  gives a natural place to snapshot `role` at assignment time (so a later role change on the
  `Worker` record doesn't retroactively rewrite already-published rosters' historical role data).
- **Partial index on active workers.** `Worker.status` is indexed because every roster
  generation loads only `ACTIVE` workers as solver input — this is the hottest read path.
- **`WorkerAvailability`'s date-specific redesign (Availability v2).** The original design used
  a weekly pattern (7 weekdays × 3 shifts) stored on `Contract`. That doesn't actually match how
  a real staffing operation enters availability — a worker's availability varies week to week
  (vacation, a specific unavailable Tuesday, etc.), not by a fixed weekly template. It was
  replaced with one row per `(worker, real calendar date)` scoped to the month being rostered,
  entered via a month-scoped CSV or an editable grid UI, with absence of a row meaning
  unavailable — never an implicit "assume available" default. See
  `.notes/availability-v2-date-specific-plan.md` and `docs/design/rostering-system-design.html`
  for the full before/after rationale.
- **`ShiftWorker.workerId → Worker` is `onDelete: Restrict`**, so a worker with roster history
  can never be hard-deleted (only deactivated) — history integrity is enforced at the database
  level, not just in application code. `WorkerAvailability` and `Contract`, by contrast, cascade
  on worker delete: they're worker-owned auxiliary data with no independent historical value.

Full schema: `apps/api/prisma/schema.prisma`. Full entity/relationship write-up with diagrams:
`docs/design/rostering-system-design.html`.

## Setup & run instructions

### Prerequisites

- **Node.js 24** (see `.nvmrc`) and **pnpm** via Corepack (`corepack enable`, then
  `corepack prepare pnpm@11.13.1 --activate` — the exact pinned version is in the root
  `package.json`'s `packageManager` field).
- **Docker** (or OrbStack) with Compose v2, for the one-command path and/or the local dev
  Postgres container.
- **Python 3.11+** with `pip`, only if you intend to run/test `solver/solve_roster.py` directly
  on the host rather than through the containerized `worker` service (see `solver/README.md`;
  `solver/requirements.txt` / `requirements-dev.txt` list the dependencies, principally
  `ortools` and `pytest`).

### One-command path (recommended — no manual DB setup)

```bash
cp .env.example .env   # first time only; placeholder values are fine
docker compose up --build --scale api=2
```

This builds and starts the whole stack — Postgres, a one-shot `migrate` service (runs
`prisma migrate deploy` automatically; `api`/`worker` wait on it before starting, so there is no
manual migration step), two `api` replicas, the `worker` background-job process, and nginx — and
serves the SPA + full API through nginx on **http://localhost**. Add more replicas with a higher
`--scale api=N`; nginx picks them up automatically.

To seed sample data into the running stack (idempotent — safe to re-run):

```bash
docker compose run --rm migrate node_modules/.bin/tsx prisma/seed.ts
```

This creates 3 companies, 12 workers with contracts, the default staffing requirements, and a
month of `WorkerAvailability` rows (for the calendar month after the one you run it in).

Tear down with `docker compose down` (add `-v` only if you also want to drop the Postgres
volume and start from a truly empty database next time).

### Local dev workflow

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d   # dev-only Postgres, bound to 127.0.0.1
cp .env.example .env                             # DATABASE_URL points at that container
pnpm --filter @rostering/api db:migrate           # apply migrations
pnpm --filter @rostering/api db:seed              # seed sample data
pnpm dev                                          # turbo: runs every workspace's `dev` script
```

`pnpm dev` runs `apps/api` (via `tsx watch`) and `apps/web` (via `vite`) concurrently; the SPA's
dev server proxies API calls to the local API. `docker-compose.dev.yml` is a *separate* Postgres
container/volume from the one-command production stack above — the two never share data, and
both can run simultaneously without colliding.

`docker-compose.dev.yml` also starts a pgAdmin container for browsing the dev database. Once it's
up, open `http://localhost:5050` (or whatever `PGADMIN_PORT` you set in `.env`) and add a new
server pointing at host `postgres`, port `5432`, using the same `POSTGRES_USER`/`POSTGRES_PASSWORD`
values from `.env`. Log in to pgAdmin itself with `PGADMIN_EMAIL`/`PGADMIN_PASSWORD` from `.env`
(dev-only placeholder credentials — never reuse them in a real/shared environment).

Tests, per workspace (or `pnpm test` from the root to run all of them via Turborepo):

```bash
pnpm --filter @rostering/shared test    # domain schemas/validation (Vitest)
pnpm --filter @rostering/api test       # services/routes/engine, Supertest against a real test DB (Vitest)
pnpm --filter @rostering/web test       # component/page tests (Vitest + Testing Library)
pnpm --filter @rostering/ui test        # component kit tests (Vitest + Testing Library)
cd solver && python3 -m venv .venv && source .venv/bin/activate \
  && pip install -r requirements.txt -r requirements-dev.txt && pytest
```

Other useful root scripts: `pnpm build`, `pnpm lint`, `pnpm typecheck` (all Turborepo-orchestrated
across every workspace).

### Sample data

`samples/workers-sample.csv` (12 workers, matches `apps/api/src/db/seedData.ts`) and
`samples/availability-sample-2026-08.csv` (one month of matching availability) are both
re-importable unmodified via the CSV import endpoints/UI — see [CSV schema](#csv-schema) below.

## CSV schema

Two independent CSV formats, both documented column-by-column in **[`docs/csv-schema.md`](docs/csv-schema.md)**:

- **Worker CSV** (`POST /api/import/workers`, `GET /api/export/workers`) — 8 columns:
  `national_id,name,company_name,role,status,hourly_cost_ils,min_monthly_hours,max_monthly_hours`.
  Upserts by `national_id`; full-sync semantics (any `ACTIVE` worker absent from the file is set
  `INACTIVE` — the file is treated as the authoritative current workforce list, and a worker is
  never hard-deleted by an import).
- **Availability CSV** (`POST /api/import/availability/:month`, `GET /api/export/availability/:month`)
  — month-scoped: `national_id` plus one `dNN` column per real calendar day of that month (28–31
  columns depending on the month). Each cell is empty (unavailable) or a canonical shift-subset
  string (`A`, `B`, `C`, `AB`, `AC`, `BC`, `ABC`). Replaces that worker's whole month of
  availability per import — no cross-worker deactivation sweep (that's worker-CSV-only).

Both formats guard against spreadsheet formula injection on export and are exact round-trip safe
(`export → import` reproduces the original data unmodified) — verified end-to-end in this phase's
smoke test (see below).

## Bonus features

Two bonus features beyond the four core areas (HR management, contract management, CSV
import/export, rostering engine):

### 1. Cost Dashboard

`GET /api/rosters/:month/cost-summary` + `apps/web/src/pages/CostDashboard/` — projected monthly
labor cost for a roster, broken down by total, per company, and per worker (shift count × 8h ×
contracted hourly rate).

**Rationale:** for a 24/7 security-staffing operation, labor is the dominant line-item cost, and
the roster is generated *before* the month happens — the whole point of automated rostering is to
let a planner see the financial consequence of a staffing decision (a headcount bump, a new
contract rate, an availability change) immediately, not discover it after the fact from a payroll
run weeks later. Per-company breakdown matters specifically because workers here are employed by
distinct client-facing companies sharing one roster — a manager needs to know what *this month's*
roster costs *per client contract*, not just in aggregate, to make defensible budget and
staffing-mix decisions before publishing.

### 2. Public read-only worker schedule page

The frontend route `/schedule/:token` (`apps/web/src/pages/PublicSchedule/`) — a print-friendly,
no-login page a worker can bookmark to see their own upcoming published shifts, and nothing else
(never their national ID, hourly rate, or any other worker's assignments) — backed by
`GET /api/schedule/:token` (no authentication, per-worker rotatable share token, rate-limited both
at the app and nginx edge layers; kept under `/api` specifically so it doesn't collide with the
frontend's own identically-shaped route above).

**Rationale:** in a 50–150-person shift-work operation, "what's my schedule this month" is one of
the highest-frequency, lowest-value-to-mediate questions an office can get — without a
self-service option, every one of those questions is a phone call or a printed notice that goes
stale the moment a manual edit happens. A token-scoped public link removes that entire class of
office interruption without requiring worker accounts/logins (a real deployment barrier for a
workforce that may not all have company email addresses), while the token's rotation endpoint
(`POST /api/workers/:id/share-link/rotate`) gives a clean revocation path if a link is ever shared
somewhere it shouldn't be.

## Phase 10 verification

The full golden path (seed → configure staffing requirements → set worker availability via the
bulk availability API → generate a roster → review/acknowledge alerts → a blocked manual edit
[422] and a confirmed manual edit [409→200] → publish → cost dashboard → worker CSV round-trip →
availability CSV round-trip → public schedule page) was smoke-verified end-to-end through
`docker compose up --scale api=2` and nginx on `:80`, using real HTTP calls against the composed
stack. No application bugs were found during this pass.
