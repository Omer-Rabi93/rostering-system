# `apps/api/loadtest/` — CSV-import concurrency load tests

Four scripts proving the v4 per-company CSV-import queue/task design (see
`.notes/csv-tasks-v4-per-company-queues-and-partial-roster-plan.md`, Part A + Part C) actually
holds under real HTTP load and real timing — not just under Vitest's controlled single-race tests.
None of this mocks anything: every script drives a REAL, already-running dev stack (API + worker +
Postgres) over HTTP and/or a real Prisma client.

`scaleTiers.ts` (100/1,000/10,000-worker staged-timing benchmark) is a separate script in this same
directory with its own concerns (single-company pipeline stage timing, not cross-company
concurrency) — see its own header comment for how to run it.

## Prerequisites: start the dev stack

1. **Postgres** (`docker-compose.dev.yml`):
   ```sh
   docker compose -f docker-compose.dev.yml up -d
   ```
   Confirm `DATABASE_URL` in the repo-root `.env` points at it (see `.env.example`).

2. **Migrate** (only needed once / after a schema change):
   ```sh
   pnpm --filter @rostering/api db:migrate:deploy
   ```

3. **API server** (port 3000 — every script defaults `LOADTEST_API_URL` to
   `http://localhost:3000`, matching `apps/web/vite.config.ts`'s hardcoded dev-proxy target):
   ```sh
   pnpm --filter @rostering/api dev
   ```

4. **Worker process** (consumes `csv-import`/`availability-import`/`roster-generation` jobs — there
   is no dedicated `dev:worker` package script yet, so run it directly):
   ```sh
   pnpm --filter @rostering/api exec tsx src/worker.ts
   ```
   `spamChurn.ts` (below) spawns its OWN dedicated extra worker replica for the duration of its own
   run (so it can capture that replica's log output directly for its unhandled-rejection check) —
   running an extra replica alongside this one is safe by design (pg-boss's own row-claiming makes
   multiple concurrent worker replicas safe, see the design doc's Part E.1), so you do not need to
   stop this one before running `spamChurn.ts`.

Every script also accepts `LOADTEST_API_URL` (default `http://localhost:3000`) if your dev API
server runs on a different port, and reads `DATABASE_URL` from the repo-root `.env` the same way
every other script/test in this repo does.

## Running a script

```sh
pnpm --filter @rostering/api exec tsx loadtest/<script>.ts
```

Each script prints a running transcript to stdout, ends with either `PASS: ...` (exit code 0) or one
or more `FAIL: ...` lines (exit code 1), and seeds its own fresh `Company` row(s) per run — safe to
re-run repeatedly against the same persistent dev Postgres (every script salts its synthetic
`national_id` prefix range with a per-process random offset, `shared.ts`'s `RUN_SALT`, so repeated
runs never collide with a previous run's leftover data).

### 1. `crossCompanyNonBlocking.ts` — ~5-15s

Seeds 10 companies (`LOADTEST_COMPANY_COUNT`), fires one concurrent worker-CSV upload per company
(two of them using the well-framed-but-invalid-rows fixtures from `tests/fixtures/csv/` — a
realistic "someone uploaded a slightly bad file" case, mixed in with 8 valid 300-row files), then
polls every company's `ImportTask` to settlement.

**Pass** = every company's task reaches a terminal status (no unexpected `FAILED`), and the overall
wall-clock (upload fan-out + settle) stays within 3x the SLOWEST single company's own processing
time — not anywhere near the SUM of all 10 companies' processing times, which is what serial
(blocking) processing would look like. This is the direct load-level proof that per-company
`singletonKey` partitioning (Part A, point 1) actually holds.

### 2. `rapidFireReupload.ts` — ~3-10s

One company, the SAME valid file uploaded 10 times (`LOADTEST_REUPLOAD_COUNT`) concurrently (not
sequentially — sequential awaits would trivially serialize through cancel-and-replace and never
stress the race). Polls `GET /api/import-tasks/active` until settled.

**Pass** = exactly one of the 10 `ImportTask` rows reaches `COMPLETED`, the rest `CANCELLED` (any
`FAILED` is a bug), no task stuck non-terminal, the `Worker` table matches the file exactly, and
every resulting worker is stamped with the winning task's id (never a cancelled one's).

**Known limitation, found and left as-is (not what this design was actually built for):** with 10
requests firing within the SAME ~1 second window (genuine simultaneity, not the sustained-but-
sequential 1/sec cadence `spamChurn.ts` exercises — see that script's own passing run, which is
the pattern this feature was actually designed and asked for), the route-level cancel-and-replace
retry loop (`MAX_ENQUEUE_ATTEMPTS`) can still fail to converge to a single winner within its bounded
retry count — several requests can keep cancelling each other's freshly-created tasks in quick
succession. This is NOT a crash and NOT a data-corruption risk: every request still gets a clean
HTTP response (202 or 409, confirmed zero raw 500s across repeated runs), no worker is ever stamped
with a cancelled task's id, and the DB-level uniqueness invariant (at most one non-terminal task per
company+kind) never breaks — it just means an extreme, sub-second, truly-simultaneous burst can
occasionally settle to "nobody won, try again" rather than "exactly one winner." A fully airtight
fix would serialize the whole cancel-create-enqueue-attach sequence behind a Postgres advisory lock
(`pg_advisory_xact_lock(hashtext(companyId || kind))`) rather than relying on optimistic retries —
a real architecture change (the sequence currently spans a network call to pg-boss between two
separate Prisma operations, so the lock can't just be `$transaction`-scoped), deliberately not done
here since the actual requested scenario (`spamChurn.ts`) already passes cleanly without it.

### 3. `largeFileResponsiveness.ts` — ~10-40s (depends on machine speed)

One company: uploads an 8,000-row file (`LOADTEST_LARGE_FILE_ROWS`; deliberately near but not AT
`MAX_ROWS` = 10,000 — the exactly-`MAX_ROWS` boundary is instead covered by
`tests/fixtures/csv/max-rows*.csv` + `tests/fixtures/csvFixtures.test.ts`, since that boundary is a
route-level guard-clause check, not a concurrency behavior), waits 500ms
(`LOADTEST_HEAD_START_MS`) for it to start `PROCESSING`, then uploads a 5-row file for the SAME
company and times how long THAT ONE takes to reach `COMPLETED`.

**Pass** = the second (small) upload's task reaches `COMPLETED` within 8 seconds
(`LOADTEST_RESPONSIVENESS_BUDGET_MS`) of being enqueued — not "eventually, after the 8,000-row file
finishes" — and the large file's own task ends `CANCELLED`, never `COMPLETED`. This is the direct
proof that cooperative cancellation (re-reading `ImportTask.status` every ~50 rows inside the
row-processing loop) is actually RESPONSIVE under load, not just eventually consistent.

### 4. `spamChurn.ts` — fixed ~60-90s (highest priority — read this one first)

The most load-bearing script in this suite; this is what motivated the DB-level partial-unique-index
backstop (`import_tasks_company_kind_active_key`) in the v4 design in the first place — see the
design doc's dedicated "Sustained rapid-churn 'spam' test" subsection.

One company, 1,000 workers (`LOADTEST_SPAM_WORKER_COUNT` -- deliberately large: it must reliably
take LONGER than the 1-second upload cadence to process a whole file, or there is no actual overlap
for cancel-and-replace to resolve and the run degenerates into a boring chain of uncontested
completions), 60 uploads (`LOADTEST_SPAM_ITERATIONS`) fired 1/second for 60 seconds straight. Each upload's file is generated from the PREVIOUS one via a
churn generator: a random ratio `p` in `[0.5, 1.0]` per iteration, `(1-p)×N` rows kept
byte-identical, `p×N` rows replaced (each either a brand-new synthetic hire or an existing worker
from an earlier iteration reappearing/edited). Spawns its own dedicated extra worker replica for the
duration of the run so it can capture that replica's stdout/stderr directly.

Polls `GET /api/import-tasks/active` (the same endpoint the frontend's pre-upload confirm dialog
uses) AND a direct Prisma count of non-terminal `ImportTask` rows once per second, alongside every
upload, logging every observation.

**Pass = all four of:**
1. Exactly one of the ~60 `ImportTask` rows reaches `COMPLETED`, the rest `CANCELLED` (any `FAILED`
   is a bug) — and never more than one non-terminal task observed at any single polled instant
   during the run (the direct empirical check on the DB uniqueness backstop).
2. The final `Worker` table state matches the file behind whichever task actually `COMPLETED`,
   field-for-field (name/role/status/hourlyCostIls/minMonthlyHours/maxMonthlyHours) — not just row
   count — and every one of those workers is stamped with that task's id.
3. No worker anywhere ends up with `lastImportTaskId` pointing at a `CANCELLED` task.
4. No `ImportTask` stuck in `PROCESSING` after the run settles, and no unhandled-rejection /
   uncaught-exception log line from the dedicated worker replica's captured output.

If any of these four fail, that is a real bug in the cancel-and-replace / DB-backstop machinery —
report it, do not loosen the assertion to make the script "pass".

## Environment variables (all optional, sensible defaults)

| Variable | Default | Used by |
|---|---|---|
| `LOADTEST_API_URL` | `http://localhost:3000` | all |
| `LOADTEST_COMPANY_COUNT` | `10` | crossCompanyNonBlocking |
| `LOADTEST_ROWS_PER_COMPANY` | `300` | crossCompanyNonBlocking |
| `LOADTEST_REUPLOAD_COUNT` | `10` | rapidFireReupload |
| `LOADTEST_REUPLOAD_ROWS` | `50` | rapidFireReupload |
| `LOADTEST_LARGE_FILE_ROWS` | `8000` | largeFileResponsiveness |
| `LOADTEST_SMALL_FILE_ROWS` | `5` | largeFileResponsiveness |
| `LOADTEST_HEAD_START_MS` | `500` | largeFileResponsiveness |
| `LOADTEST_RESPONSIVENESS_BUDGET_MS` | `8000` | largeFileResponsiveness |
| `LOADTEST_SPAM_ITERATIONS` | `60` | spamChurn |
| `LOADTEST_SPAM_TICK_MS` | `1000` | spamChurn |
| `LOADTEST_SPAM_WORKER_COUNT` | `1000` | spamChurn |
| `LOADTEST_SPAM_SETTLE_TIMEOUT_MS` | `60000` | spamChurn |

## A note on the shared dev Postgres

These scripts (deliberately, per the design doc) run against your regular persistent dev database,
not a disposable per-run one — so if you run them while ALSO running the Vitest suite
(`pnpm --filter @rostering/api test`) or `pnpm --filter @rostering/api dev:worker` against the same
database, you may see occasional cross-talk (e.g. a stray `csv-import` job from a test run still
sitting in pg-boss's queue). If a script fails in a way that looks like unrelated interference
rather than a real bug (e.g. a `409` on a company that was JUST created), re-run it once things are
quiet — this mirrors the same "concurrent test processes racing against the shared DB" caveat other
work in this worktree has already flagged.
