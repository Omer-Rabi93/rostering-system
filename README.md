# Rostering System

A workforce rostering system for a 24/7 security-staffing operation: each company manages its own
workers and contracts, and a constraint-solver engine auto-generates a monthly shift schedule (three
daily shifts: A 00:00–08:00, B 08:00–16:00, C 16:00–00:00) respecting worker availability, role
requirements, and contracted hour limits. Includes manual roster editing, CSV import/export, a cost
dashboard, and a public read-only schedule link for workers (no worker accounts needed).

**Architecture** (pnpm + Turborepo monorepo): `apps/api` (Express + TypeScript REST API — also the
only process that *sends* background jobs), `apps/web` (Vite + React SPA), `packages/shared` (Zod
schemas/types) and `packages/ui` (component kit), consumed by both apps as compiled `dist`;
`solver/` (Python, CP-SAT via OR-Tools, invoked as a subprocess per roster-generation job, not a
pnpm workspace member); a separate **worker** process (`apps/api/src/worker.ts`) that consumes two
`pg-boss` (Postgres-backed) job queues — CSV import and roster generation — so a slow generation
job never blocks the HTTP API; `infra/` (Dockerfiles, nginx config).

For the full technical design (architecture, data model, complete API reference, background-job
internals, deployment/scaling) see
**[`docs/design/rostering-system-design.html`](docs/design/rostering-system-design.html)** — though
per `CLAUDE.md`, that doc lags the shipped code in places (e.g. it still describes two separate CSV
pipelines; they've since merged into the one combined upload described below). This README covers:
what the product is, how to run it (including with multiple workers), where to reach the frontend,
where to upload a CSV and its exact format, current limitations, and what's deliberately out of
scope.

## How to run it

**Prerequisites:** Docker (or OrbStack) with Compose v2. Node.js 24 + pnpm only needed for local
(non-Docker) development.

**One command, no manual setup:**

```bash
cp .env.example .env
docker compose up --build --scale api=2
```

Serves the whole app (SPA + API) at **http://localhost** (see [Entering the frontend](#entering-the-frontend)
below). Seed sample data (idempotent):

```bash
docker compose run --rm migrate node_modules/.bin/tsx prisma/seed.ts
```

Tear down with `docker compose down` (add `-v` to also drop the database).

### Running with multiple workers

There are two independent knobs for concurrency — scale whichever axis your bottleneck is on:

1. **Multiple `worker` container replicas** (multiple OS processes, for horizontal/multi-core
   scaling). The `worker` service has no published port and no host-side state, so it scales the
   same way `api` does:

   ```bash
   docker compose up --build --scale api=2 --scale worker=3
   ```

   All replicas poll the same `pg-boss` queues in Postgres; job dispatch is arbitrated at the
   database level (`stately`-policy singleton keys per company/`company:month`), so replicas never
   double-process the same job.

2. **In-process job concurrency**, via env vars read by `apps/api/src/jobs/queue.ts` (set them in
   `.env`, or as `environment:` overrides on the `worker` service in `docker-compose.yml`):
   - `WORKFORCE_IMPORT_CONCURRENCY` (default `8`) — CSV import is I/O-bound (waiting on per-row DB
     transactions), so raising this is cheap; keep it roughly aligned with `DB_POOL_SIZE_PRISMA`
     (default `10`) or the extra concurrency just queues on a free DB connection instead of helping.
   - `ROSTER_GENERATION_CONCURRENCY` (default `2`) — roster generation is CPU-bound and each solve
     is deliberately single-threaded (CP-SAT determinism requires it), so more concurrency here
     doesn't speed up one solve — it lets more *different* companies solve at once. Size this to
     (available CPU cores per worker replica, minus headroom for Node/Prisma), not arbitrarily high.
   - `DB_POOL_SIZE_BOSS` (default `10`) — caps pg-boss's own Postgres connection pool, separate from
     Prisma's.

**Local dev (without Docker for the app itself):**

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d      # dev Postgres + pgAdmin only
cp .env.example .env
pnpm --filter @rostering/api db:migrate
pnpm --filter @rostering/api db:seed
pnpm dev                                             # starts the API + web dev servers
pnpm --filter @rostering/api exec tsx src/worker.ts  # separate terminal — see note below
```

> **`pnpm dev` does not start the background worker process.** CSV imports and roster generation
> will accept the request (`202 {jobId}`) but never actually complete unless the worker is also
> running — `pnpm --filter @rostering/api exec tsx src/worker.ts`, in its own terminal. This is the
> single most common "why is nothing happening" gotcha in local dev. The one-command Docker path
> above starts the worker automatically; this manual path does not. In this mode you can run
> several of these commands side by side in separate terminals to get multiple worker processes,
> same as the Docker `--scale worker=N` path above.

## Entering the frontend

- **Docker (production-shaped stack):** **http://localhost** — nginx serves the built SPA and
  proxies `/api/*` to the `api` replicas on the same origin (port 80 is the only port published by
  the whole stack).
- **Local dev (`pnpm dev`):** **http://localhost:5173** — Vite's dev server, which proxies `/api` to
  `http://localhost:3000` (the API's `pnpm --filter @rostering/api dev` process) — see
  `apps/web/vite.config.ts`.

The app gates every screen behind picking/creating a company first (there's no login — see
[Out of scope](#out-of-scope)). The public, worker-facing read-only schedule lives at
`/schedule/:token` (a per-worker, non-guessable share token — no worker account needed).

## Uploading a CSV

One combined upload, scoped to one company and one target month (send `companyId` as a multipart
form field alongside the file — the UI does this automatically for whichever company is currently
active). Returns `202 {jobId}` immediately (processed in the background — poll `GET
/api/jobs/:id` or `GET /api/import-tasks/active?companyId=&kind=WORKFORCE_SYNC`), and uploading
again for the same company while one is still processing cancels the old one and takes over. Full
spec: **[`docs/csv-schema.md`](docs/csv-schema.md)**; a ready-to-use example is at
**[`samples/workforce-sample-2026-08.csv`](samples/workforce-sample-2026-08.csv)**.

### `POST /api/import/workforce/:month` — worker roster + that month's availability, in one file

The matching read side, `GET /api/export/workforce/:month`, emits the exact same shape — an export
is always safely re-importable unmodified. Capped at **15,000 rows** (one row = one worker,
`MAX_WORKFORCE_CSV_ROWS`) per upload, rejected with 400 before it's even enqueued; multipart body
capped at **8 MB** (`MAX_CSV_FILE_SIZE_BYTES`), field name `file`.

**Header** — exact order and names, computed per `:month` (import rejects any other shape: wrong
day count, wrong order/names, or a data row with a different field count than the header):

```
national_id,name,role,status,hourly_cost_ils,min_monthly_hours,max_monthly_hours,d01,d02,...,dNN
000000018,Noa Levi,General Guard,Active,45.00,120,200,C,,AB,...,ABC
```

**The first 7 columns** — one worker's identity + contract:

| Column | Type / allowed values |
| --- | --- |
| `national_id` | 9 digits, checksum-valid (Israeli ID) — the upsert match key |
| `name` | non-empty string, ≤ 120 chars |
| `role` | `General Guard` \| `Supervisor` \| `Screener` |
| `status` | `Active` \| `Inactive` |
| `hourly_cost_ils` | decimal ≥ 0, dot separator, e.g. `62.50` |
| `min_monthly_hours`, `max_monthly_hours` | integers, `0 ≤ min ≤ max` |

**`d01`…`dNN`** — one column per real calendar day of `:month` (28–31 columns, leap Februaries
included). Each cell names the shifts that worker is **excluded from** (cannot work) that date —
not a list of shifts they *can* work:

- **empty** — no exclusions, available for every shift that date.
- an ordered, deduplicated subset of `A`/`B`/`C` — always `A`<`B`<`C` order (`A`, `B`, `C`, `AB`,
  `AC`, `BC`, `ABC`). `d05=AB` excludes the `A`/`B` shifts but the worker is still available for
  `C`; `d06=ABC` is fully unavailable that date. Anything else (`AD`, `AA`, `BA`) rejects that row.

**Row atomicity** — one row is one atomic outcome, validated worker-fields-first then day-cells: a
bad worker field *or* an illegal `dNN` cell fails the **whole row**, including the worker upsert;
neither half ever applies partially. A row matched by `national_id` updates that worker and fully
**replaces** their `:month` availability; an unmatched `national_id` creates both. There is **no
deactivation sweep** — a worker absent from the file keeps their current `status` and existing
availability rows untouched; they just become ineligible for the *next* roster generation until
they reappear in a subsequent completed upload (tracked via `lastImportTaskId`, not a status flip).

Cell values starting with `=`, `+`, `-`, `@`, a tab, or a carriage return get a defensive leading
`'` on export (Excel/Sheets formula-injection guard) and have it stripped back off on import, so the
export→import round trip is exact even for a name like `=SUM(A1)`.

**Response shape** (`GET /api/jobs/:id` once complete):

```ts
type ImportResult = {
  totalRows: number;
  inserted: number; // rows whose worker was newly created
  updated: number; // rows whose worker already existed
  failed: number;
  errors: Array<{ row: number; nationalId?: string; field?: string; message: string }>; // row is 1-based
};
```

> The manual/grid `GET`/`PUT /api/availability/:month` (the planner's calendar editing UI) is a
> **separate**, unrelated JSON API — a full-month date-keyed JSON replace, not CSV. It never goes
> through CSV parsing, row atomicity, or the `ImportTask`/queue machinery above.

## Bonus features

Two features beyond the assignment's required scope, each chosen for direct operational value:

### 1. Public read-only schedule link per worker (`/schedule/:token`)

Every worker has a non-guessable share-token URL that shows their own published schedule — no
worker accounts, no login rollout, works on any phone.

**Rationale:** a roster nobody sees still gets violated. For a 24/7 guard workforce the biggest
distribution problem is getting each worker their up-to-date shifts without standing up an auth
system; this replaces the "screenshot of a spreadsheet in WhatsApp" workflow that causes missed
shifts. The link is read-only, scoped to a single worker, and revocable (rotating the worker's
`shareToken` invalidates old links) — access control without login.

### 2. Cost dashboard

Aggregates a month's roster into projected labor cost — per company, role, and worker — computed
as assignments × 8 h × each worker's contracted `hourly_cost_ils`.

**Rationale:** contracts already carry hourly cost, so every generated roster is also a financial
commitment. The dashboard surfaces that cost *before* the roster is published, letting the planner
see the money impact of a regeneration or a manual edit immediately. Scheduling errors are
ultimately cost errors; this closes that loop for the person the system is built for.

## Limitations

- **Roster generation is exact-only, and scales worse than data management.** The CP-SAT solver
  runs single-threaded per solve (required for deterministic, fixed-seed output) with a banded time
  budget that grows with workforce size — 30s up to 200 workers, up to 20min by 10,000, capped at
  30min beyond that. Above roughly **1,000 workers**, a solve may legitimately return `UNKNOWN`
  (no roster produced) rather than an approximate one — this system fails loudly instead of
  silently degrading optimality. By contrast, CSV import/export, the availability grid, and UI row
  virtualization are all sized for up to **10,000 workers per company**.
- **One CPU core doesn't make a single solve faster.** Concurrent throughput instead comes from
  solving *different* companies' rosters at once (`ROSTER_GENERATION_CONCURRENCY`, see
  [multiple workers](#running-with-multiple-workers) above) — raising a single solve's core count
  isn't possible or useful.
- **No partial/range-scoped roster regeneration.** Generating a roster always rebuilds the entire
  target month from scratch; regenerating just a date range while leaving the rest of the month's
  assignments untouched is deferred (would need the solver to accept out-of-range assignments as
  fixed constants rather than decision variables).

## Out of scope

- **No authentication, anywhere.** No login/session/JWT/API key on any route (except a per-worker
  share-token on the public schedule link, which is access control, not login). Appropriate for a
  trusted, single-operator deployment — not for exposing to the public internet or multiple
  mutually untrusting parties without adding an auth layer first.
- **No role-based permissions or audit trail.** Single planner/HR user model.
- **No CORS configuration** — by design; the deployment serves the SPA and API from one origin via
  nginx, so cross-origin requests are never expected.
- **No WebSockets/push.** Async results are delivered by client polling.
