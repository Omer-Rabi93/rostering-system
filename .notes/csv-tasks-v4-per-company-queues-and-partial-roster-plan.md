# v4 — Per-Company CSV Import Queues/Tasks + Partial Roster Regeneration — Design & Plan

## Overview

Three related but separable pieces of work:

**Part A** (points 1–7, 9, plus the availability-CSV follow-up): today, a worker-CSV upload is
**not** scoped to one company — `company_name` is a per-row CSV column, resolved/created
independently for each row (`csvImportService.ts:69`), and the post-import "deactivation sweep"
(any `ACTIVE` worker whose `nationalId` isn't in the uploaded file gets set `INACTIVE`) runs
**globally across the whole `Worker` table, not scoped by company** (`csvImportService.ts:133-142`).
This is a real bug in the current system, not just a missing feature: uploading Company A's worker
roster today silently deactivates every `ACTIVE` worker at every *other* company not mentioned in
that file. The **availability CSV has the same underlying gap**: `AvailabilityService`'s row-
matching (`availabilityService.ts:222`) and the bulk `PUT /api/availability/:month` full-replace
(`availabilityService.ts:100-153`) never reference `companyId` at all — a national-ID collision or
a bulk-replace payload could touch a worker at any company. Part A redesigns both CSV imports to be
company-scoped end to end.

**Part B** (point 8): partial/range-scoped roster regeneration. This is a materially larger,
higher-risk change (it touches the CP-SAT solver model itself). **Recommend shipping it as a
separate follow-up effort after Part A lands.** (Unchanged from the previous draft of this doc —
see that section below.)

**Part C** (this round's addition): testing infrastructure — load tests proving companies don't
block each other under concurrency, and a reusable set of invalid-CSV-row fixtures.

**Part D** (this round's addition): local dev tooling — pgAdmin in `docker-compose.dev.yml`.

**Part E** (this round's addition): scaling the pg-boss worker process to multiple replicas —
turns out to need close to zero code change, given how the design in Part A is shaped; the design
choice in Part A is deliberately steered to make this true (see Part E).

---

## Part A: Per-Company Import Queues, Tasks, and Import-Presence Tracking

### Key design decisions

- **A CSV upload becomes scoped to the currently active company** (the same "active company"
  concept `ActiveCompanyGate` already established app-wide) — not resolved per-row. The
  `company_name` CSV column is **removed** from the worker CSV (8 columns → 7: `national_id, name,
  role, status, hourly_cost_ils, min_monthly_hours, max_monthly_hours`). This is what makes
  "different queue per company" and "task id per company" well-defined in the first place — there's
  no such thing as "the queue for this CSV" if a single file can span companies. The availability
  CSV already has no company column (`csv/availability.ts:36-38`); it just gains a required
  `companyId` on its route/job instead.

- **Queue-partitioning mechanism — recommended: `singletonKey` on the existing shared queues, not
  literal per-company physical pg-boss queues.** Two options were weighed:

  | | `singletonKey: companyId` on one shared queue | dynamic `csv-import:${companyId}` physical queue per company |
  |---|---|---|
  | Precedent in this codebase | **Yes** — `roster-generation` already does exactly this (`singletonKey: \`${companyId}:${month}\``, `stately` policy, `queue.ts:105-121`), proven in production | None |
  | `worker.ts` startup change needed | None — queue names stay fixed/static, exactly like today | A registration loop over every `Company` row, plus an in-process "already registered" guard to avoid double-subscribing (calling `boss.work()` twice on the same queue double-processes every job) |
  | New-company handling | Automatic — no registration step needed when a company is created | Needs a hook wherever companies are created (or lazy-register-on-first-use) so a brand-new company's queue gets subscribed without a restart |
  | Worker-replica scaling (Part E) | Trivial — replicas subscribe to the same static queue names, pg-boss's own row-claiming already makes this safe | Also safe, but every replica must run the same dynamic per-company registration loop at startup |
  | Literal match to "different queue per company" | Logical partitioning (one physical queue, N independent singleton slots) | Literal (N physical named queues) |

  **Recommendation: `singletonKey`.** It gives every functional property that was actually asked
  for — one company's slow import never blocks another's, cancel-and-replace works per company,
  scaling the worker process needs no new code — while reusing a pattern this codebase has already
  proven correct, and avoiding a whole class of "did every replica register" bugs. Raise
  `localConcurrency` on the `csv-import` and `availability-import` queues from `1` to something like
  `8–16` (today it's `1`, meaning literally one import in the whole system at a time regardless of
  company — that's the actual root cause of "company B has to wait for company A" today) so
  multiple *different* companies' singleton slots can run genuinely concurrently; `singletonKey`
  still guarantees at most one in-flight job per company per queue. If the literal "N physical
  queues" interpretation matters for some reason not captured above (e.g. wanting to size worker
  capacity per company independently at the infra level), the dynamic-registration alternative is
  fully specified in the table and can be swapped in — flag it if so, since it changes `worker.ts`
  and needs the double-registration guard called out above.

- **New `ImportTask` entity** (generalized to cover both worker and availability CSV, since the
  lifecycle — pending/processing/completed/failed/cancelled, cancel-and-replace, one-in-flight-per-
  company — is identical between them; only the per-row processing differs):
  ```prisma
  enum ImportTaskKind {
    WORKER_SYNC
    AVAILABILITY_SYNC
  }

  enum ImportTaskStatus {
    PENDING
    PROCESSING
    COMPLETED
    FAILED
    CANCELLED
  }

  model ImportTask {
    id             Int               @id @default(autoincrement())
    companyId      Int
    company        Company           @relation(fields: [companyId], references: [id], onDelete: Restrict)
    kind           ImportTaskKind
    status         ImportTaskStatus  @default(PENDING)
    pgBossJobId    String?           // cross-reference for boss.cancel()
    month          String?           @db.Char(7) // set for AVAILABILITY_SYNC only
    totalRows      Int?
    processedRows  Int?
    insertedCount  Int?
    updatedCount   Int?
    failedCount    Int?
    errors         Json?
    createdAt      DateTime          @default(now())
    startedAt      DateTime?
    finishedAt     DateTime?
    workers        Worker[]          // reverse of Worker.lastImportTaskId (WORKER_SYNC only)

    @@index([companyId, kind, status])
    @@index([companyId, kind, finishedAt])   // "latest COMPLETED task for company X + kind" lookup
    @@map("import_tasks")
  }
  ```
  (Named `ImportTask`, not `CsvImportTask`, in this revision — the previous draft's name doesn't
  fit once availability import shares the same table.)

- **New `Worker.lastImportTaskId Int?`** (nullable FK, `onDelete: SetNull`) — **only meaningful for
  `WORKER_SYNC` tasks.** Stamped onto a worker's row every time a worker-CSV row matches/creates/
  updates them inside a task that eventually reaches `COMPLETED`. A worker created/edited manually
  through the UI (never touched by any worker-CSV import) keeps `lastImportTaskId: null` forever.
  No backfill migration needed — existing workers naturally get `null`, which is exactly the
  "manually managed, always eligible" state.

- **Availability sync does NOT need this eligibility-gate mechanism.** Confirmed from the current
  code: a worker absent from an availability CSV is already correctly "simply untouched, no
  deactivation-style sweep" (`availabilityService.ts:189-195`), and "absence of a `WorkerAvailability`
  row IS the unavailable state" is already the explicit, correct semantics
  (`csv/availability.ts:143`). There's no analogous bug to fix there — availability only needs the
  company-scoping + queue/task-tracking/cancel-and-replace treatment for consistency, observability,
  and to stop one company's availability import from blocking another's.

- **Deactivation sweep is removed entirely** (worker CSV only) — replaced by the presence-tracking
  mechanism below. A worker absent from a new worker-CSV **stays `ACTIVE`** (point 5's explicit ask)
  but becomes ineligible for roster generation because their `lastImportTaskId` no longer matches
  the company's latest completed `WORKER_SYNC` task.

- **Roster-generation eligibility rule** (`RosterGenerationService.generate()`'s worker query):
  ```
  latestTask = ImportTask.findFirst({ where: { companyId, kind: 'WORKER_SYNC', status: 'COMPLETED' }, orderBy: { finishedAt: 'desc' } })

  eligible workers = Worker.findMany({
    where: {
      companyId,
      status: 'ACTIVE',
      OR: [
        { lastImportTaskId: null },                                   // never touched by CSV — always eligible
        { lastImportTaskId: latestTask?.id ?? -1 },                   // touched by the CURRENT sync
      ],
    },
  })
  ```
  The `lastImportTaskId: null` branch is deliberate: a company that manages workers entirely by
  hand must still be able to generate a roster. Only workers that HAVE been placed under CSV-sync
  management are held to "must match the latest completed sync." If the intent is instead that CSV
  sync should be strictly authoritative the moment it's ever used — flag it; it's a one-line rule
  change but changes real behavior.

- **Cancel-and-replace (point 3), per company AND per kind** (a worker-CSV upload for Company A
  cancels only Company A's in-flight `WORKER_SYNC` task, never touches an in-flight
  `AVAILABILITY_SYNC` task for the same company, and vice versa). When a new upload arrives for a
  company+kind while a `PENDING`/`PROCESSING` task already exists for that company+kind:
  1. Mark the old task `CANCELLED` (persisted immediately, before touching pg-boss).
  2. Call `boss.cancel(queueName, oldTask.pgBossJobId)` — reliably stops a job that hasn't started
     yet, but **cannot forcibly interrupt Node.js code already executing inside a running handler**.
  3. **Cooperative cancellation inside the row-processing loop is therefore required, not
     optional**: periodically (e.g. every 50 rows) the handler re-reads its own `ImportTask.status`;
     if no longer `PROCESSING`, it stops and returns without marking itself `COMPLETED`. This needs
     a dedicated concurrency test: start a slow/large import, cancel mid-flight, assert it stops and
     never reaches `COMPLETED`, and assert the replacement task completes normally.
  4. Only after 1–2 does the new task get created and enqueued (with the shared queue's
     `singletonKey` = `${companyId}:${kind}` now free again).
  - **This sequence alone is not sufficient under truly concurrent uploads for the same
    company+kind** — two requests arriving close enough together (well within reach of a client
    that uploads once a second, if the cancel-then-create round-trip itself takes even tens of
    milliseconds under load) can both read "existing task is non-terminal," both cancel it, and
    both create their own new `PENDING` task, momentarily violating "at most one non-terminal task
    per company+kind." The app-level sequence needs a **DB-level backstop**, not just careful
    ordering: a partial unique index, `CREATE UNIQUE INDEX ON import_tasks (companyId, kind) WHERE
    status IN ('PENDING', 'PROCESSING')`. The route/service catches the resulting unique-constraint
    violation on step 4's insert and retries the cancel-then-create sequence once (the just-lost
    race means there IS now a non-terminal task to cancel, from the request that won) rather than
    surfacing a 500. This is exactly the kind of gap a steady, faster-than-processing-time upload
    stream (see the spam/churn test in Part C) is likely to actually trigger, not just a
    theoretical concern — call it out explicitly as required, not optional hardening.

- **Same-company nationalId matching, cross-company conflict as an error** (both CSV kinds).
  Worker matching stays by `nationalId` (kept **globally unique** — a real person's ID doesn't
  change if they change employers). Since a worker-CSV row's company is now fixed (the upload's
  active company), a row whose `national_id` already exists under a **different** company is a
  per-row validation error, not a silent company reassignment. Same fix applies to availability CSV
  rows and to the bulk `PUT /api/availability/:month` payload (`replaceMonth`,
  `availabilityService.ts:100-153`) — that endpoint has no `companyId` today at all and can
  currently full-replace any worker's month regardless of company; it needs a required `companyId`
  and must reject (per-entry error, not a silent no-op or cross-company write) any payload entry
  for a worker outside that company.

- **Route/frontend changes**: `POST /import/workers` and `POST /import/availability/:month` both
  gain a required `companyId` (multipart form field, alongside `file` — multer already parses
  non-file fields into `req.body`). `PUT /api/availability/:month` gains a required `companyId`
  query/body param. All three need `useActiveCompanyId()` threaded into the corresponding frontend
  call — see **Frontend** below.

- **Point 9 ("route each employee to the right queue")** is satisfied by construction once upload
  is company-scoped: a file can no longer mix companies, so every row in one upload belongs to the
  one task/queue-slot the whole file was submitted under. True per-row fan-out (each employee as an
  independent sub-job, processed with real parallelism) was considered and **not recommended** —
  it would require aggregating N sub-job results back into one task's status/counts and cancelling N
  sub-jobs instead of one; the current `MAX_ROWS = 10,000` cap and existing sequential-with-
  continue-on-error model don't obviously need that complexity yet.

- **Point 6/7 status: already implemented and confirmed; the one real gap (CSV uploads not
  carrying `companyId` at all — worker CSV, availability CSV, AND the bulk availability PUT) is
  exactly what Part A closes.**

### Frontend

- **`apps/web/src/pages/Workers/CsvPanel.tsx`**: add `const companyId = useActiveCompanyId();`,
  include it in the upload `FormData` (`apps/web/src/api/csv.api.ts`'s `importWorkersCsv` mutation
  signature changes from `File` to `{ file: File; companyId: number }`).
- **`apps/web/src/pages/Roster/AvailabilityCsvPanel.tsx`**: same treatment —
  `useActiveCompanyId()`, `importAvailabilityCsv({ month, companyId, file })`
  (`apps/web/src/api/availability.api.ts`'s mutation signature gains `companyId`).
- **The month-scoped availability grid's bulk save** (wherever it calls `PUT
  /api/availability/:month` — check `apps/web/src/api/availability.api.ts`'s other mutations) needs
  the same `companyId` addition.
- **New small endpoint + pre-upload confirm UX**: `GET /api/import-tasks/active?companyId=&kind=`
  returns the current non-terminal task for that company+kind, if any (`null` otherwise). Both CSV
  panels call this right before opening the file picker / on file selection, and if a task is
  in-flight, show a confirm dialog (reuse the existing `ConfirmDialog` component already used
  elsewhere, e.g. `AvailabilityCsvPanel`'s existing upload-confirm gate) — *"An import is still
  processing for this company. Uploading now will cancel it and start over. Continue?"* — before
  actually submitting. This avoids a same-tab or another-tab/another-user's in-flight import being
  silently killed with no warning; the backend still enforces cancel-and-replace unconditionally as
  the correctness guarantee (this is a UX nicety layered on top, not a substitute for it — a race
  between the confirm-check and the actual upload is possible and fine, since the backend's cancel-
  and-replace logic is what's actually correct regardless of whether the dialog was shown).
- **Optional polish, not required**: `GET /api/jobs/:id`'s `toPollState` currently folds pg-boss's
  `cancelled` into the generic `failed` bucket (`jobs.ts:13-17`) — distinguishing "cancelled because
  a newer upload superseded it" from "genuinely failed" in the `JobProgress` UI would read better,
  but isn't required for correctness.

### Requirements

- Prisma: `ImportTaskKind`/`ImportTaskStatus` enums, `ImportTask` model, `Worker.lastImportTaskId`
  (nullable FK, `onDelete: SetNull`); migration (additive only, no data backfill needed).
- `apps/api/src/csv/columns.ts`: drop `company_name` from the worker CSV (8→7 columns); update
  `parse.ts`/`serialize.ts` tests, `docs/csv-schema.md`, `samples/workers-sample.csv`,
  `apps/api/scripts/generateSampleCsv.ts`.
- `apps/api/src/jobs/queue.ts`: raise `localConcurrency` on `csv-import`/`availability-import`;
  `enqueueCsvImport`/`enqueueAvailabilityImport` take `companyId` and pass
  `singletonKey: \`${companyId}:${kind}\``. No change to queue *names* under the recommended design
  (no `worker.ts` startup-loop change needed).
- `apps/api/src/services/csvImportService.ts` + `apps/api/src/services/availabilityService.ts`:
  `ImportTask` create/cancel/complete lifecycle (shared helper, since it's identical logic for both
  kinds); remove the worker-CSV global deactivation sweep; stamp `lastImportTaskId` per
  successfully-processed worker-CSV row; cross-company nationalId conflict becomes a per-row error
  in both; cooperative cancellation check in both row loops; `replaceMonth` gains required
  `companyId` + per-entry cross-company rejection.
- `apps/api/src/services/rosterGenerationService.ts`: eligibility query change (latest-completed-
  task-or-never-synced rule above).
- `apps/api/src/routes/importExport.ts`, `apps/api/src/routes/availability.ts`: `companyId` required
  on the three routes named above; new `GET /api/import-tasks/active` route.
- Frontend changes per the **Frontend** section above.
- Tests: company-scoped upload doesn't touch other companies' workers/availability (regression test
  for the current bug, both CSV kinds); cancel-and-replace mid-flight (concurrency test, both
  kinds); eligibility rule for both branches (never-synced manual worker included; stale-synced
  worker excluded but still `ACTIVE`); cross-company nationalId conflict reported as a row error in
  both CSV paths and in `replaceMonth`.

### Execution Strategy (Part A)

**Phase A1 — Schema + queue plumbing (TDD)**
`ImportTask`/`Worker.lastImportTaskId` migration. `queue.ts` `singletonKey`/`localConcurrency`
changes. No behavior change to either import service yet — just the infrastructure to track a task
row and partition the existing shared queues per company.

**Phase A2 — CSV schema + company-scoped routes**
Drop `company_name` (7-column worker CSV), update every parse/serialize/sample/docs artifact.
`POST /import/workers`, `POST /import/availability/:month`, `PUT /api/availability/:month` all
require `companyId`; frontend threads it through (Frontend section above).

**Phase A3 — Task lifecycle + eligibility (TDD — core semantics change)**
Both services: task create/cancel/complete, remove the worker-CSV deactivation sweep, stamp
`lastImportTaskId`, cross-company conflict handling (all three write paths), cooperative
cancellation. Cancel-and-replace concurrency tests (both kinds). `rosterGenerationService.ts`
eligibility query change + its own tests.

**Phase A4 — New endpoint + confirm UX**
`GET /api/import-tasks/active`; both CSV panels' pre-upload check + `ConfirmDialog`.

**Phase A5 — Verification**
`pnpm typecheck`/`lint`/`test`. Manual smoke: upload for Company A while Company B's own upload
(either kind) is mid-flight — confirm both complete independently. Upload twice quickly for the
same company — confirm the first is cancelled, the second completes, no worker ends up with
`lastImportTaskId` pointing at a cancelled task.

---

## Part B: Partial / Range-Scoped Roster Regeneration (point 8) — recommend as a separate follow-up

*(Unchanged from the previous draft — included here for completeness.)*

### Why this is architecturally bigger than it sounds

Persistence today is a full destroy-and-rebuild: `persistDraft` deletes **every** `Shift` (and
cascades every `ShiftWorker`) for the roster, then recreates every day × every shift type from
scratch (`rosterGenerationService.ts:129-200`). Narrowing that to "only touch days in a range" is
the easy 20%. The hard 80% is the **solver**: CP-SAT constraints like max-2-shifts-per-day, min/max
monthly hours, and fairness are computed **across the whole month** — if the solver is only given
the in-range days' requirements, it has no way to know a worker already has, say, 190 of their 200
max monthly hours booked from *fixed, out-of-range* days, and could over-assign them. Correctness
requires the solver to see the **entire month's context** but only actually *decide* (create
`BoolVar` decision variables for) the in-range days — everything else must enter the model as a
fixed constant that still counts toward hour/fairness/cap accounting.

### Design sketch

- `SolverProblem` (`engine/problem.ts`) gains `fixedAssignments: {workerId, date, shiftType}[]` —
  existing (out-of-range) assignments read from the DB before solving. These contribute to every
  constraint that sums over "a worker's assignments this month" but are NOT decision variables —
  only in-range date×shift×role combos get real `BoolVar`s.
- `solve_roster.py` needs its hour/cap/fairness accumulation logic updated to fold in
  `fixedAssignments` as constants. Needs the same rigor the availability-v2 work applied to solver
  changes (byte-identical determinism re-proven, full existing pytest suite re-run, new tests for
  "does a partial solve respect a fixed-context worker's near-maxed monthly hours").
- `RosterGenerationService.generate(companyId, month, range?)` — `range` optional and additive;
  omitted = today's full-month behavior, unchanged. `persistDraft` becomes range-aware.
- `POST /api/rosters/generate` gains optional `startDate`/`endDate` fields.
- UI: a date-range picker next to "Generate roster" (or a per-day "regenerate this day" affordance).

### Recommendation

Ship Part A first, on its own. Part B deserves its own dedicated plan/worktree/review cycle.

---

## Part C: Testing Infrastructure — Load Tests + Invalid-Data Fixtures

### Current state

No load/perf testing tool or precedent exists anywhere in the repo (`autocannon`/`k6`/`loadtest`/
`benchmark` all grep to zero hits). No shared CSV fixtures directory exists either — every test
builds its CSV strings inline, per test file (e.g. `availabilityService.test.ts:171,201-203,213-
215,226-230`), which is a fine convention for single-test-scoped data but doesn't serve a case where
the SAME invalid-row scenarios need reuse across unit tests, load tests, and manual QA.

### Design

- **Invalid-data fixtures** — new `apps/api/tests/fixtures/csv/` directory (a deliberate, scoped
  exception to the "build CSV inline" convention, justified because these are reused across three
  contexts, not scoped to one test file): one small file per scenario, covering both CSV kinds —
  bad national-ID checksum, unknown `role`/`status` enum value, negative/non-numeric hours, wrong
  column count, duplicate `national_id` within one file, a `national_id` that belongs to a
  *different* company (the cross-company-conflict case Part A introduces), malformed `dNN` shift-
  subset cell, wrong month header for the availability CSV, empty file, header-only file, and a
  file at/over `MAX_ROWS`/`MAX_AVAILABILITY_CSV_ROWS`. Each fixture is a plain `.csv` file plus a
  co-located `.expected.json` describing what error(s) that scenario should produce, so both a unit
  test and a load-test script can assert against the same expectation without duplicating it.
- **Load tests** — add `autocannon` (Node-native, npm, fits the existing TS/Node stack without
  introducing a new language/runtime the way `k6` would) as a devDependency, under a new
  `apps/api/loadtest/` directory, driven against the dev-server stack (same one `e2e/` already
  spins up via `globalSetup.ts` — reuse it rather than inventing a second environment). Three
  scripts:
  1. **Cross-company non-blocking proof**: N companies' CSVs uploaded concurrently (mix of valid and
     the invalid fixtures above), assert wall-clock time scales with the slowest single import, not
     the sum of all of them — the direct load-level proof that "different queue per company" (point
     1) actually holds.
  2. **Rapid-fire re-upload stress**: the same company uploaded K times in quick succession, assert
     only the last ever reaches `COMPLETED` and the worker table ends up matching exactly the last
     file — a throughput-level companion to Phase A3's precise Vitest concurrency test (the Vitest
     test proves correctness under one controlled race; this proves it holds up under real,
     uncontrolled timing).
  3. **Large-file responsiveness**: a near-`MAX_ROWS` file, assert cooperative cancellation
     (mid-import, from a second superseding upload) still responds within a bounded number of rows,
     not "after the whole file finishes."
  A raw HTTP load tool can't precisely control race timing, so these are throughput/non-blocking
  proofs, not a substitute for the Phase A3 Vitest-level correctness tests — both are needed, for
  different reasons.

### Scale-tier benchmarks: 100 / 1,000 / 10,000 workers, CSV import + full-month generation, staged timing report

A fourth, distinct load-test concern from the three above: not "do companies block each other," but
"how does *one* company's pipeline behave as its own worker count grows," with a breakdown precise
enough to say which stage — upload, queue wait, row processing, DB fetch, solve, persist — is
actually where the time goes at each size. 10,000 is not an arbitrary top tier: it's exactly
`MAX_ROWS`, the enforced CSV row cap, so that tier is specifically "does the system behave correctly
and reasonably fast at its own documented limit," not just a round number.

- **Synthetic worker generation at scale** — reuse/extend the checksum-valid synthetic-national-ID
  generator already proven in `e2e/support/dbAdminServer.ts`'s `bulkCreateWorkers` (built for a
  different purpose — probing the availability-PUT payload-size limit — but the exact right tool
  here too) to produce valid 7-column worker-CSV files (post-Part-A schema) at each tier, rather
  than hand-authoring huge fixtures.
- **"Inject the amount of people per shift" — scaling `StaffingRequirement` with worker count.**
  Without this, a 10,000-worker CSV import would still be a meaningful test, but the *roster-
  generation* half wouldn't be: today's seeded default (`GENERAL_GUARD: 3, SUPERVISOR: 1, SCREENER:
  2` per shift, from `dbAdminServer.ts`'s `resetRequirementsToDefault`) would make the CP-SAT
  problem trivially small regardless of how many workers exist, since almost the entire workforce
  would sit unused/ineligible every day. The benchmark script takes a configurable **utilization
  ratio** (default suggestion: ~40%) and sets `requiredCount` per `(role, shift)` proportionally to
  that role's share of the imported workforce, capped so it never exceeds the actual number of
  workers in that role (an unsatisfiable requirement just generates alerts, it doesn't stress the
  solver's real assignment search — the point is to make the *solve* itself hard, not to manufacture
  shortage alerts). Keep this ratio a script parameter, not a hardcoded constant — the "right"
  utilization to benchmark against is a judgment call worth being able to sweep.
- **Where the fine-grained stage timing comes from — a benchmark script that drives the real
  service methods directly, not new production instrumentation.** Adding permanent timing
  instrumentation/schema fields to `CsvImportService`/`RosterGenerationService` just to serve a
  benchmarking report isn't worth the permanent surface area. Instead, `apps/api/loadtest/
  scaleTiers.ts` calls `CsvImportService.importCsv(...)` and `RosterGenerationService.generate(...)`
  **in-process** against a real (disposable) Postgres — the same pattern this repo's own Vitest
  tests already use to call these services directly — and wraps each constituent `await` with
  `performance.now()` timestamps *from the outside*, since the script itself is the caller of each
  internal step:
  - CSV import stages: `upload+validate` (the route's synchronous pre-check, if driving through
    HTTP for this part) → `row-processing` (the bulk of the work; also report rows/sec throughput,
    not just total time) → `task total`.
  - Roster-generation stages: `data-fetch` (the `worker.findMany`/`staffingRequirement.findMany`/
    availability query `Promise.all` in `generate()`) → `problem-build` (`buildProblem` — pure,
    in-memory, should be near-instant even at 10,000 workers; if it's not, that's itself a finding)
    → `solve` (the `runSolver` call — almost certainly the dominant cost at the top tier, and the
    one to watch against the solver's own internal ~30s cap: **does a 10,000-worker problem even
    solve within the existing timeout, or does this benchmark surface a genuine solver-scaling
    question that Part B's partial-regeneration work — or a longer/tiered timeout — would need to
    address?** That's a real, open question this benchmark is partly designed to answer, not
    assumed either way here) → `persist` (`persistDraft`'s transaction) → `total`.
  - This driving-the-service-layer-directly approach deliberately does **not** go through the real
    HTTP+pg-boss path for the stage breakdown — that's what the three `autocannon` scripts above are
    for (queueing/concurrency behavior). The two are complementary: this script answers "where does
    the time go inside one run," the `autocannon` scripts answer "do concurrent runs interfere with
    each other."
- **Report** — the script emits a table (console + a saved markdown/JSON artifact under
  `apps/api/loadtest/results/`, not committed) of tier × workload → duration (ms), plus
  throughput (rows/sec for import, workers/sec-equivalent for generation) and a pass/fail column
  against the solver's internal timeout specifically for the 10,000-worker tier.

### Sustained rapid-churn "spam" test — 1 upload/second for 60 seconds, 50–100% data churn per upload

A fourth, deliberately adversarial scenario, distinct from the "rapid-fire re-upload" scenario
above (which just re-sends the *same* file quickly): for one company, upload a **new, meaningfully
different** worker CSV once per second for 60 seconds straight (60 uploads total), where each
upload differs from the immediately-preceding one by a randomized **50–100% churn ratio** — not
just faster-than-processing timing, but sustained timing *combined with* real data change on every
single upload. This is the single most valuable test in Part C for surfacing subtle races, because
it stresses the cancel-and-replace machinery far harder and longer than a one-shot "cancel it once
cleanly" test ever would — **it's exactly what motivated the DB-level uniqueness backstop added to
Part A above**, not a hypothetical: at 1 upload/second, if the cancel-then-create round-trip takes
even tens of milliseconds under load, two of the 60 requests landing close together is a real,
not theoretical, possibility.

- **Churn generator**: given the previous iteration's worker list (starting from a base set, e.g.
  the 1,000-worker tier from the scale benchmark above) and a churn ratio `p` drawn uniformly from
  `[0.5, 1.0]` fresh each iteration, produce the next file by keeping `(1-p) × N` rows byte-identical
  and replacing the remaining `p × N` rows — each replaced slot is randomly either (a) a brand-new
  synthetic worker (new checksum-valid `national_id`, simulating a hire) or (b) an existing worker
  from an even earlier iteration with one or more fields changed (role/status/hours, simulating an
  edit — or a former worker reappearing, simulating a rehire). Total row count stays roughly
  constant across iterations for this test (an optional variant could also drift total size ±X%, but
  isn't necessary to find the races this test is aimed at).
- **What it asserts** (a spam test without assertions is just noise, not a test):
  1. Poll `ImportTask` for that company+`WORKER_SYNC` until it settles: expect **exactly one**
     `COMPLETED` task among the ~60 created, the rest `CANCELLED` (a few `FAILED` would also be a
     real bug worth surfacing, not expected). **Never** more than one non-terminal task existing at
     any single polled instant — the direct empirical check on the DB-constraint backstop above.
  2. The final `Worker` table state for that company matches the file behind whichever task actually
     reached `COMPLETED` exactly — every field, not just row count — and every worker present in
     that file has `lastImportTaskId` pointing at it.
  3. **No worker anywhere ends up with `lastImportTaskId` pointing at a `CANCELLED` task** — the
     precise, adversarial-timing proof of the eligibility rule's core invariant (Phase A3's Vitest
     test proves this under one controlled cancellation; this proves it holds under sustained,
     uncontrolled real timing).
  4. No unhandled promise rejections / unexpected error-level log lines in the worker process for
     the whole 60-second run, and no `ImportTask` stuck permanently in `PROCESSING` after the run
     settles (the TOCTOU signature: a cancellation and a completion racing on the same task, one
     writer's update silently clobbering the other's without either erroring).
- This test is worth running **before** Phase A3 is considered done, not just as a Part C
  afterthought — it's the highest-signal way to find out whether the cooperative-cancellation
  check (re-reading `ImportTask.status` mid-loop) and the completion write race cleanly, since the
  Vitest-level single-cancellation test in Phase A3 can prove the happy path works but can't easily
  reproduce this specific back-to-back timing without something like this generator.

### Execution Strategy (Part C)

Fits naturally as an extra phase after Part A lands (the fixtures reference `ImportTask`/
cross-company-conflict behavior that doesn't exist until Phase A3 is done): add fixtures + unit
tests using them, then the **spam/churn test first** (it's the highest-signal check on Phase A3's
cancel-and-replace + DB-uniqueness-backstop correctness — run it before considering Phase A3 done,
per the note above, not after everything else), then the three `autocannon` scripts against a
running dev stack, then the scale-tier benchmark script (100 → 1,000 → 10,000, run in that order so
a regression/blowup at a smaller tier is caught before burning time on the largest one) — all
documented in a short `apps/api/loadtest/README.md` (how to run each, what "pass" looks like, and
for the scale-tier script, how to read the stage-by-stage report).

---

## Part D: Local Dev Tooling — pgAdmin

Add to `docker-compose.dev.yml` **only** (never the production `docker-compose.yml` — pgAdmin is a
dev convenience, not something to ship), matching this file's existing conventions (`${VAR:-default}`
env fallbacks from the gitignored root `.env`, loopback-only port binding, named volume,
`restart: unless-stopped`):

```yaml
  pgadmin:
    image: dpage/pgadmin4:latest
    restart: unless-stopped
    environment:
      PGADMIN_DEFAULT_EMAIL: ${PGADMIN_EMAIL:-dev@localhost}
      PGADMIN_DEFAULT_PASSWORD: ${PGADMIN_PASSWORD:-dev}
      PGADMIN_CONFIG_SERVER_MODE: "False"
    ports:
      - "127.0.0.1:${PGADMIN_PORT:-5050}:80"
    volumes:
      - rostering-dev-pgadmin-data:/var/lib/pgadmin
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  rostering-dev-pgadmin-data:
```

`PGADMIN_CONFIG_SERVER_MODE: "False"` skips pgAdmin's normal login-gate-behind-a-real-account setup
(desktop-mode, auto-logged-in) — appropriate for a loopback-only local dev container, not something
to carry into any shared/hosted environment. Add `PGADMIN_EMAIL`/`PGADMIN_PASSWORD`/`PGADMIN_PORT`
to `.env.example` with a comment that these are dev-only placeholder credentials. No code change
needed elsewhere; README gets a short "open http://localhost:5050, add a server pointing at
`postgres:5432` using the same `POSTGRES_USER`/`POSTGRES_PASSWORD` from `.env`" note.

---

## Part E: Scaling — Worker Replicas, Connection Budget, and CPU-Bound vs. I/O-Bound Concurrency

### E.1 — `docker compose up --scale worker=N` already works today, and stays safe under Part A

Checked `docker-compose.yml`'s `worker` service directly: no `container_name`, no host port
binding — nothing prevents scaling it, the exact same mechanism already documented for `api`
(`docker-compose.yml:20`, `:80-82`). The single-flight-per-company guarantee (cancel-and-replace)
is enforced **at enqueue time** (Phase A3's cancel-then-enqueue sequencing + `singletonKey`), not
by `localConcurrency` — `localConcurrency` only bounds how many *different* job rows one process
pulls concurrently, it says nothing about how many processes may be subscribed. Since the app logic
never lets two non-terminal tasks exist for the same company+kind at once, there's only ever at
most one claimable job row per company+kind regardless of replica count, and pg-boss's row-claiming
is already safe for multiple concurrent subscribers to one queue (this is exactly how
`roster-generation` already works safely today). Because the recommended Part A design keeps queue
*names* static, `worker.ts` needs **no startup-loop change** — every replica registers the same
three static handlers it already does today (`worker.ts:37-39`).

That said, replica count is not a free dial — two real, quantifiable constraints show up before
"add more workers" stops helping, covered below.

### E.2 — The actual ceiling: Postgres connection budget (two pools per process, not one)

Checked the exact connection setup: `createPrismaClient` (`db/client.ts:21-29`) wraps
`@prisma/adapter-pg`'s `PrismaPg` with only `{ connectionString }` — no explicit pool size, so it
inherits `pg`'s own default pool cap (`max: 10`). Separately, `createBoss` (`queue.ts:45-47`) is
`new PgBoss(connectionString)` — **also** no explicit pool size, and pg-boss maintains its **own**
independent connection pool under the hood, on top of (not shared with) Prisma's. So **every
process that both serves the app and touches the job queue holds two separate ~10-connection
pools**, not one. A `worker` process does both (Prisma for row reads/writes, boss for job
claiming), so each worker replica alone can hold up to ~20 connections; each `api` replica holds
Prisma's pool plus its own boss instance for *sending* jobs (`enqueueCsvImport` etc.), so likely a
similar shape — exact number depends on `app.ts`'s own boss setup, worth confirming precisely at
implementation time rather than assumed here.

Default Postgres `max_connections` is 100, and that ceiling is shared with the e2e test harness,
`prisma migrate`, pgAdmin (Part D), and any developer's own `psql` session — realistically you want
to stay well under it, not right up against it. Rough math at defaults: `(api_replicas +
worker_replicas) × ~20 ≤ ~100` → **comfortably scaling past ~4–5 total replicas requires action**,
not just `--scale N`. Two levers, cheapest first:

1. **Explicitly cap both pools per instance** — `PrismaPg` accepts `pg.PoolConfig` (verify the
   exact shape against the installed `@prisma/adapter-pg` version at implementation time), so
   `new PrismaPg({ connectionString, max: 5 })`; pg-boss's constructor accepts a config object with
   its own `max` (`new PgBoss({ connectionString, max: 5 })`). Make both env-configurable
   (`DB_POOL_SIZE_PRISMA`, `DB_POOL_SIZE_BOSS`, or similar) rather than hardcoded, so the deployment
   can tune them without a code change as replica count changes. This buys headroom cheaply but
   caps *per-replica* throughput too — a smaller pool means more waiting for a free connection
   under heavy concurrent load on that one replica.
2. **PgBouncer in front of Postgres (transaction-pooling mode)** — the standard answer once replica
   count needs to grow past what lever 1 comfortably supports: app-side pool counts stop mapping
   1:1 to real Postgres backend connections, since PgBouncer multiplexes many app-side connections
   onto a smaller, fixed set of real ones. This is real new infrastructure (another `docker-compose`
   service, a connection-string change for every consumer), not a config tweak — worth it once
   you're actually pushing replica counts up, premature before that.

**Recommendation:** do lever 1 as part of Part A/E's implementation (cheap, no new infra, and
forces the exact pool numbers to be a conscious, documented choice instead of an accidental
default); treat PgBouncer as a follow-up, gated on actually needing more replicas than lever 1
comfortably supports (see the monitoring checklist below for how you'd know).

### E.3 — `localConcurrency` must be tuned differently for CPU-bound vs. I/O-bound queues

All three queues currently use the same hardcoded `localConcurrency: 1` (`worker.ts`'s comment:
"matching the design doc's `teamSize: 1` intent") — including `roster-generation`, which is a
**separate, pre-existing scaling bottleneck from anything CSV-related**: today, only one roster
regeneration runs at a time *system-wide*, across every company, since `singletonKey` only
deduplicates the *same* `(companyId, month)`, not cross-company concurrency. Company A regenerating
a large roster (up to the solver's ~30s cap) currently blocks Company B's regeneration request the
entire time, even though they're unrelated. This should be fixed alongside the CSV-queue
concurrency work in Phase A1, and needs different reasoning than the CSV queues:

- **`csv-import`/`availability-import` are I/O-bound** (mostly waiting on per-row DB transactions,
  `csvImportService.ts:66-123`) — raising `localConcurrency` well above 1 (the "8–16" figure from
  Part A) is safe and directly helps, *as long as it doesn't outrun the process's own connection
  pool from E.2* — if `localConcurrency` exceeds the Prisma pool size, extra concurrent jobs just
  queue up waiting for a free connection anyway, so these two numbers should be tuned together, not
  independently (e.g. don't set `localConcurrency: 16` against a `max: 5` Prisma pool and expect
  16-way real concurrency).
- **`roster-generation` is CPU-bound, and deliberately single-threaded per solve.** `runSolver.ts`
  spawns one Python `solve_roster.py` process per job (`runSolver.ts:53`) — confirmed no existing
  concurrency cap beyond the queue's own `localConcurrency`. The solver's own determinism guarantee
  (seed 42, referenced in the availability-v2 plan) is achieved by constraining CP-SAT to effectively
  single-threaded search *within one solve* — meaning a single solve does **not** get faster by
  throwing more cores at it, but *multiple concurrent solves* (different companies) each only need
  one core, so overall throughput scales with **available CPU cores**, not with an arbitrary queue
  number. `localConcurrency` for `roster-generation` should be set to (available CPU cores per
  worker replica, minus headroom for Node/Prisma/pg-boss's own overhead) — e.g. 2–4 on a typical
  small container, not the same "raise it a lot" advice that applies to the I/O-bound queues.
  Setting it higher than actual cores doesn't add real throughput, just makes every concurrent solve
  slower via OS scheduling contention (still logically single-threaded and still deterministic per
  solve, just slower wall-clock) — worth a load test (Part C) specifically proving this shape (solve
  latency vs. concurrent-company count, at a few different `localConcurrency` settings) rather than
  guessing a number.

### E.4 — When (if ever) to revisit physical per-company queues

Part A recommended `singletonKey` over literal per-company pg-boss queues, partly for operational
simplicity. Now that scaling is the explicit question, the trade-off is worth quantifying more
precisely rather than just asserted:

- **`singletonKey`'s degradation mode**: all companies share one `localConcurrency` budget per
  queue per replica. If the number of companies with a *concurrently active* import/generation
  request exceeds `localConcurrency × worker_replica_count`, the excess simply FIFO-waits inside
  that shared queue — even though each individual company's work is small and unrelated to the
  others ahead of it. This is a real cost at high concurrent-company counts, but note polling
  overhead stays flat: pg-boss polls a fixed 3 queue names regardless of how many companies exist.
- **Physical per-company queues' benefit**: no shared budget — every company gets independent
  concurrency, bounded only by total worker fleet capacity, with pg-boss distributing fairly. **But**
  this comes with its own, different cost that wasn't fully priced in the original comparison: pg-
  boss polls each subscribed queue on its own interval, so N physical queues means N× the polling
  query load against Postgres (a separate cost from the connection-count discussion above — this is
  about *query volume*, not connection count), and the dynamic-registration machinery from Part A's
  comparison table still applies.
- **Recommendation stands: start with `singletonKey`.** Revisit physical per-company queues only
  with actual evidence of the shared-budget degradation happening — see the monitoring checklist
  below for the specific signal to watch. Don't pre-optimize for a company count this system isn't
  actually serving yet.

### E.5 — What to actually implement, and what to monitor before scaling further

**Implement now (folds into Phase A1/A5, not a separate phase):**
- Env-configurable pool sizes for both Prisma and pg-boss (E.2, lever 1).
- Fix `roster-generation`'s `localConcurrency` from `1` to an env-configurable, CPU-informed value
  (E.3) — this is a real bug-fix-shaped improvement independent of the CSV work, worth doing even
  if Part A's CSV pieces were deferred.
- Document `docker compose up --scale worker=N` (and its prod-equivalent deployment mechanism, if
  different) in the README/deploy notes, next to the existing `--scale api=N` documentation.

**Monitor before adding more replicas or infrastructure (no new tooling required — these are
queryable directly from pg-boss's own tables / Postgres):**
- **Job age at claim time** (`createdOn` → `startedOn` gap in pg-boss's job table) trending up for
  `csv-import`/`availability-import` → the I/O-bound queues are saturated; raise `localConcurrency`
  first (if connection budget allows, per E.2) before adding replicas.
- **`roster-generation` solve wall-clock time** trending up under concurrent load (Part C's load
  test should measure this directly) → you've exceeded available CPU cores' worth of concurrent
  solves; add worker replicas or CPU, don't just raise `localConcurrency` past core count.
- **Postgres active connection count** approaching `max_connections` → time for PgBouncer (E.2,
  lever 2), before it becomes an outage instead of a planned change.
- **Companies actually queueing behind each other on the same shared `singletonKey` budget**
  (visible as multiple companies' jobs sitting `created`, not yet `active`, at the same time) → the
  specific, concrete signal that would justify revisiting E.4's physical-per-company-queue
  alternative — otherwise, don't.
