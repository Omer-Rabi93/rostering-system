# Rostering System — Implementation Plan

## Overview

Build the full Rostering System from the approved PRD (`docs/prd/rostering-system-brief.md`) and technical design (`docs/design/rostering-system-design.html`): a planner-facing web platform for a 24/7 single-site security operation that manages workers/contracts and auto-generates monthly rosters via a Google OR-Tools CP-SAT solver.

**Strategy:** backend-first with strict TDD (red → green → refactor), UI design produced in parallel via `/create-design`, then frontend implementation against the finished API, finishing with Playwright E2E and full dockerization.

## Requirements

- React + TypeScript SPA (Vite), Node.js + TypeScript backend (Express), Node **24 LTS** pinned via `.nvmrc` / `engines`.
- SOLID throughout: thin routes → services → pure `engine/` module (imports nothing from Express/Prisma/pg-boss); dependency injection for services so units are testable in isolation.
- Monorepo: **pnpm workspaces + Turborepo** — `apps/api`, `apps/web`, `packages/shared` (Zod schemas + inferred types + constants, consumed by both api and web), `packages/ui` (reusable presentational React components), `solver/` (Python, not a workspace), `infra/` (nginx, Dockerfiles).
- State management: **Redux Toolkit + RTK Query** — RTK Query owns all server state (code-split API slices, tag-based cache invalidation, polling for job status); plain RTK slices for client-only UI state (roster editor selection, alert-acknowledgment checklist, dialogs).
- Testing: TDD with **Vitest** (unit), **Supertest + Testcontainers-style Postgres** (integration), **Playwright** (E2E). Tests are written before implementation in every backend phase.
- Docker: multi-stage Dockerfiles; `docker-compose.yml` runs **nginx → N stateless API replicas** (`--scale api=2`, `least_conn`), a separate **worker** container (pg-boss + Python OR-Tools), and **postgres** with a volume. nginx also serves the built React app and proxies `/api`.
- Database: PostgreSQL (hard constraint) with the exact Prisma schema from the design doc (Company, Worker, Contract, StaffingRequirement, Roster, Shift, ShiftWorker junction, Alert; native enums, FK indexes, partial index on active workers, cascade/restrict rules).
- Scheduling engine: Python CP-SAT sidecar (`solver/solve_roster.py`), JSON in → JSON out, deterministic (fixed seed, 1 search worker, 30 s limit); TypeScript `RosterValidator` gates every manual edit (hard rules → 422, soft rules → 409 + `?confirm=true`).
- CSV import/export: 29-column documented schema, per-row upsert by national ID, re-importable export, sample file with ≥10 workers. Import is a **full workforce sync**: existing workers whose national ID is absent from the file are set Inactive (never deleted; contract + shift history kept); workers whose row is present but fails validation are NOT deactivated.

---

## Execution Strategy

> Phases 1–6 (backend, TDD) run sequentially. **Phase D (UI design) runs in parallel with Phases 2–6.** Phases 7–9 (frontend) start once the API contract is stable and the UI design is approved. Phase 10 (Docker) can start any time after Phase 6. Phase 11 is E2E.

### Phase 1: Monorepo Foundation
**Agent:** `ts-boilerplate`

**Tasks:**
- [ ] Initialize pnpm workspace + Turborepo: root `package.json` (engines: node >=24), `pnpm-workspace.yaml` (`apps/*`, `packages/*`), `turbo.json` with `build`/`test`/`lint`/`typecheck` pipelines, `.nvmrc` (24), `.gitignore`, root `tsconfig.base.json` (strict: true, all strict flags).
- [ ] Scaffold `packages/shared`: tsup build, Vitest configured, exports barrel — will hold Zod schemas, inferred types, constants (`SHIFT_TYPES`, `ROLES`, `SHIFT_HOURS = 8`).
- [ ] Scaffold `packages/ui`: React + TS library build, Vitest + Testing Library configured, empty component barrel.
- [ ] Scaffold `apps/api`: Express + TS, `src/app.ts` (app assembly, no listen) / `src/index.ts` (HTTP entrypoint) / `src/worker.ts` (pg-boss entrypoint) split per design; Vitest + Supertest configured; ESLint + Prettier shared config at root (root `.eslintrc` extends a type-checked TS ruleset enabling `no-explicit-any`, `no-non-null-assertion`, and `consistent-type-imports` across every workspace, including `apps/web`).
- [ ] Scaffold `apps/web`: Vite + React + TS, Redux Toolkit store skeleton with typed hooks (`useAppDispatch`/`useAppSelector`), RTK Query `baseApi` (fetchBaseQuery to `/api`), path alias to `packages/shared` and `packages/ui`.
- [ ] Add `solver/` directory: `requirements.txt` pinning `ortools`, empty `solve_roster.py` stub, `solver/README.md` on venv setup.
- [ ] Verify: `pnpm turbo run build lint typecheck test` passes across all workspaces (empty test suites OK).

---

### Phase D (parallel with Phases 2–6): UI Design
**Agent:** `general-purpose` (or run interactively via `/create-design`)

**Tasks:**
- [ ] Produce UI design ("Claude design") for the 6 screens: Workers list + worker/contract form, Companies, Staffing Requirements settings, Roster calendar grid (month view, 3 shift rows/day, drag/click editing, alert checklist side panel), Cost Dashboard (roster total, per-company, per-worker), public Worker Schedule page (print stylesheet).
- [ ] Design system tokens: colors (incl. shift A/B/C accents, alert severity), spacing, typography; component inventory mapping every screen to reusable `packages/ui` components (Table, FormField, Modal/ConfirmDialog, CalendarGrid, Badge, Toast, EmptyState, Spinner/JobProgress).
- [ ] Save design artifacts under `docs/design/ui/` and get user approval before Phase 8 starts.

---

### Phase 2: Shared Domain Package (TDD)
**Agent:** `ts-test-writer` (tests first), then `general-purpose` (implementation)

**Tasks:**
- [ ] Write failing unit tests for Israeli ID checksum (`isValidIsraeliId`): valid IDs, invalid checksum, short IDs zero-padded, non-digits, length > 9.
- [ ] Implement `packages/shared/src/validation/israeliId.ts` per the design's algorithm (alternating 1/2 weights, digit-sum reduction, mod 10).
- [ ] Write failing tests, then implement, Zod schemas in `packages/shared/src/schemas/`: `workerSchema` (nationalId with checksum refine, name ≤120, role enum, status enum, companyId), `contractSchema` (hourlyCostIls ≥ 0 decimal, 0 ≤ min ≤ max monthly hours, 7×3 boolean availability matrix shape), `companySchema`, `staffingRequirementSchema` (role×shift, requiredCount ≥ 0, no duplicate cells), `monthSchema` (`YYYY-MM`), job/alert/roster DTO schemas, API error envelope types (400/409/422 shapes from the design). All request-body schemas use `.strict()` (unknown keys rejected) and every free-text string field has an explicit max length, so Zod is the enforced validation boundary for anything crossing HTTP, CSV, or solver I/O.
- [ ] Export inferred TS types + constants; verify both `apps/api` and `apps/web` can import them.

---

### Phase 3: Database Layer
**Agent:** `general-purpose`

**Tasks:**
- [ ] Write `apps/api/prisma/schema.prisma` exactly per the design: enums (Role, ShiftType, WorkerStatus, RosterStatus, AlertType); Company, Worker (unique nationalId char(9), shareToken uuid — must be UUID v4 from a CSPRNG (`crypto.randomUUID()` / Prisma `uuid(4)`), never sequential or derived from worker data, so tokens are non-enumerable; companyId FK Restrict), Contract (unique workerId, JsonB availability), StaffingRequirement (@@unique role+shift), Roster (unique month char(7)), Shift (@@unique rosterId+date+shiftType, Cascade), ShiftWorker (composite PK shiftId+workerId, role snapshot, worker Restrict), Alert (JsonB detail, Cascade); all FK indexes from the design.
- [ ] Add raw-SQL migration steps: `CREATE UNIQUE INDEX ON companies (lower(name))` and partial index `ON workers (id) WHERE status = 'ACTIVE'`.
- [ ] Create `docker-compose.dev.yml` with just Postgres for local dev/test (port bound to `127.0.0.1` only); document `DATABASE_URL` in `.env.example` with placeholder values only — real credentials live in an untracked `.env` (gitignored), never in any committed file.
- [ ] Seed script: 3 companies, ≥10 workers with contracts (matching the sample CSV), default staffing requirements (one row per role × shift).
- [ ] Integration-test harness: per-test-suite Postgres schema/db reset helper used by all later phases.

---

### Phase 4: Scheduling Engine + Validator (TDD — the core)
**Agent:** `ts-test-writer` (tests first), then `general-purpose` (implementation)

**Tasks:**
- [ ] Write failing unit tests for `RosterValidator` (`apps/api/src/engine/validator.ts`) covering every rule: HARD — maxTwoShiftsPerDay (3rd shift same calendar date rejected), withinAvailability, roleMatchesSlot, workerIsActive, noDuplicateSlot; SOFT — exceedsMaxMonthlyHours on add/move, belowMinMonthlyHours on remove/move-away; verdict shape `{ok:true,warnings[]} | {ok:false,violations[]}`. Engine module imports nothing from Express/Prisma/pg-boss (pure functions over plain data — enforce with an ESLint no-restricted-imports rule).
- [ ] Implement `RosterValidator` to green.
- [ ] Write failing tests, then implement, `engine/problem.ts`: builds solver problem JSON (month days, active workers + contracts, staffing requirements) and parses solution JSON (assignments + alerts) with Zod validation of solver output.
- [ ] Implement `solver/solve_roster.py` per the design's CP-SAT model: bool vars only where availability allows; hard constraints (role coverage with shortfall slack, ≤2 shifts/day, 8·Σx ≤ max hours); soft slacks (coverage shortfall → unfillable_slot, min-hours deficit → min_hours_shortfall); lexicographic objective 10000·coverage + 100·deficit + 1·(load_max − load_min); seed 42, 1 search worker, 30 s limit.
- [ ] Python solver tests (pytest): tiny fixture months asserting determinism (same input → same output), the 2-shifts/day cap, coverage shortfall alerts when workforce is insufficient, min-hours shortfall detection, fairness (even spread on a symmetric fixture).
- [ ] Node↔Python contract test: spawn `python3 solver/solve_roster.py` from a Vitest integration test with a real problem JSON; the spawn contract is `child_process.spawn` with a fixed argv array and `shell: false` — problem data goes exclusively over stdin as JSON, never into argv, env, or a shell string (no user-derived value ever reaches the command line); assert the parsed solution round-trips through `engine/problem.ts` and that solver stdout failing Zod validation is rejected (never persisted).

---

### Phase 5: Services + REST API (TDD)
**Agent:** `ts-test-writer` (tests first), then `general-purpose` (implementation)

**Tasks:**
- [ ] Write failing Supertest integration tests, then implement, companies CRUD (`/api/companies`): 409 duplicate name case-insensitive, 409 delete-with-workers, 404s.
- [ ] Write failing tests, then implement, workers CRUD (`/api/workers` + `/:id/contract` upsert + query filters status/role/companyId/q): 400 bad checksum / unknown companyId / min>max / bad matrix, 409 duplicate nationalId, 409 delete-with-shift-history → deactivate instead, contract PUT upsert semantics.
- [ ] Write failing tests, then implement, staffing requirements GET/PUT full-matrix replace: 400 duplicate cell / negative count.
- [ ] Write failing tests, then implement, roster read + manual-edit endpoints wired through `RosterValidator`: `GET /api/rosters/:month` (roster + shifts + workers + alerts), `POST /api/shifts/:shiftId/workers` (422 hard / 409 soft without `?confirm=true` / 201 + recomputed alerts), move (one transaction), delete (409 below-min without confirm), `POST /api/rosters/:id/alerts/:alertId/ack`, `POST /api/rosters/:id/publish` (409 with `unacknowledgedAlertIds` until every alert acked; republish of regenerated month re-runs the gate). Confirm flow is stateless; server re-validates hard rules regardless of the flag.
- [ ] Write failing tests, then implement, cost summary `GET /api/rosters/:month/cost-summary`: totals computed at read time as count × 8 × rate, grouped per worker and per company.
- [ ] Write failing tests, then implement, public schedule `GET /schedule/:token?month=` — published rosters only, 404 indistinguishable for unknown token; response payload contains only that one worker's display name and their own published shifts (never nationalId, hourly rate, contract data, or any other worker's assignments); per-IP rate limiting on this route (e.g. `express-rate-limit`, low ceiling) since it is unauthenticated; `GET /api/workers/:id/share-link` + rotate — rotation issues a fresh `crypto.randomUUID()` and the old token 404s immediately.
- [ ] Error-handling middleware matching the design's envelope convention (400 Zod / 404 / 409 warnings+confirmRequired / 422 violations); unexpected errors (including raw Prisma errors) are never surfaced to clients — map to a generic 500 envelope with no stack trace, query text, or schema detail, logging the full error server-side only; structured logs must never contain worker national IDs (mask to last-4 where an identifier is needed); JSON body-size limit on `express.json()` (e.g. 100 kb). SOLID pass: routes stay thin (parse → service → respond), services receive Prisma client via constructor injection.

---

### Phase 6: CSV + Background Jobs (TDD)
**Agent:** `ts-test-writer` (tests first), then `general-purpose` (implementation)

**Tasks:**
- [ ] Write failing unit tests, then implement, the shared CSV module (`apps/api/src/csv/`): 29-column schema (national_id … avail_sat_c), parse + serialize, availability flatten/unflatten, round-trip property (export → import unchanged). Serialization guards against CSV formula injection: any cell starting with `=`, `+`, `-`, `@`, tab, or CR is prefixed with `'` on export, and parse strips that guard prefix so the round-trip property still holds; parsing uses a real CSV library (no hand-rolled splitting), validates the header row exactly against the 29 documented columns, and rejects rows with extra/missing fields.
- [ ] Write failing integration tests, then implement, the CSV import job: per-row validation (bad row reported with row number/field/message, batch continues), company resolve-or-create by case-insensitive name, upsert by national_id, one transaction per row; after all rows, run the **sync sweep** — set every existing worker whose national_id appears nowhere in the file to INACTIVE (status update only, nothing deleted). Tests must cover: absent worker deactivated; worker with a present-but-invalid row NOT deactivated; already-inactive absent worker unchanged (idempotent re-run); `ImportResult` persisted as job result with `deactivated: number` and `deactivatedWorkers: [{workerId, nationalId, name}]` alongside the per-row error report.
- [ ] Write failing tests, then implement, `POST /api/import/workers` (multipart via multer memory storage limited to a single file with an explicit size cap — e.g. 2 MB — plus MIME/extension check for CSV, strict header validation, and a max-row cap — e.g. 10,000 — before enqueueing; 400 non-CSV/missing headers/size limit/too many rows → 202 {jobId}) and `GET /api/export/workers` (text/csv with `X-Content-Type-Options: nosniff` and an attachment `Content-Disposition`, re-importable, formula-injection-safe via the shared CSV module).
- [ ] pg-boss wiring (`jobs/queue.ts`, `worker.ts`): queues `csv-import` + `roster-generation` (teamSize 1, retryLimit 2), singletonKey = month for generation (second request → 409), cron `0 6 25 * *` generating next month's draft (never publishes).
- [ ] Write failing tests, then implement, roster-generation job end-to-end: build problem → spawn solver (`spawn('python3', [scriptPath])` with `shell: false`, problem JSON on stdin only — no user data in argv/env — plus a Node-side kill timeout slightly above the solver's 30 s limit, and solver output Zod-validated before any persistence) → persist draft (delete-and-rewrite month's shifts + shift_workers + alerts in ONE transaction, idempotent on retry) → job result `{rosterId, alertCount}`; `POST /api/rosters/generate` (202 {jobId}, 409 in-flight or published-without-force, `force:true` reopens published month as draft).
- [ ] `GET /api/jobs/:id` polling endpoint reading pgboss.job (state, result, timestamps).
- [ ] Commit `docs/csv-schema.md` + `samples/workers-sample.csv` (≥10 workers, matches seed).

---

### Phase 7: Dockerization
**Agent:** `general-purpose`

**Tasks:**
- [ ] `infra/api.Dockerfile`: multi-stage (pnpm fetch → build with turbo prune → runtime on `node:24-slim`), non-root user, healthcheck on `/api/health`.
- [ ] `infra/worker.Dockerfile`: same base + Python 3 + `pip install -r solver/requirements.txt` (OR-Tools), runs `worker.js` as a non-root user (same policy as the api image).
- [ ] `infra/web.Dockerfile` (build stage only) + `infra/nginx.conf`: serve built SPA with history fallback, `upstream api { least_conn; }` proxying `/api` and `/schedule`, gzip, sensible proxy timeouts for long polls; security headers on every response (`Content-Security-Policy` — `default-src 'self'; frame-ancestors 'none'; object-src 'none'` since the SPA is fully self-hosted, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`), `client_max_body_size` aligned with the CSV upload cap, and a `limit_req` zone on the unauthenticated `/schedule` location as edge rate limiting.
- [ ] Root `docker-compose.yml`: services nginx (:80), api (scalable, `deploy.replicas`/`--scale api=2`, env-config'd, no listen conflicts — nginx resolves the service DNS), worker, postgres (volume + healthcheck, **no host port mapping** — reachable only on the internal compose network; only nginx :80 is published); all credentials (`POSTGRES_PASSWORD`, `DATABASE_URL`) injected via a gitignored `.env` file referenced by compose — no secret values committed in `docker-compose.yml`; `depends_on` with conditions; prisma migrate deploy run as an entrypoint step or one-shot service.
- [ ] Verify: `docker compose up --scale api=2` → seed → generate a roster → CSV import → all through nginx on :80.

---

### Phase 8: Frontend Foundation — UI Kit + Store
**Agent:** `ts-boilerplate` / `general-purpose`

**Tasks:**
- [ ] Implement `packages/ui` components from the approved Phase D design, each with Vitest + Testing Library tests, building accessibility in from the start rather than deferring it to review: Table (sortable); FormField/Input/Select (label programmatically associated to its control via `htmlFor`/`id`, `aria-invalid` + `aria-describedby` wired to the inline error text); Modal + ConfirmDialog (soft-warning confirm flow; focus trap with initial focus moved into the dialog and returned to the trigger element on close, `Escape` to dismiss, `role="dialog"`/`aria-modal="true"` + `aria-labelledby`); Badge (role/status/shift); Toast (`aria-live="polite"` region so status messages are announced); EmptyState; Spinner + JobProgress (polling display; progress text in a `role="status"`/`aria-live` region); CalendarGrid (month × 3 shift rows, slot cells with assigned-worker chips; slots are keyboard-reachable and operable via a roving `tabindex` — arrow keys move focus between slots, `Enter`/`Space` opens the manual-edit dialog for the focused slot); AlertChecklist (per-alert acknowledge; each checkbox has a programmatically associated label naming the alert).
- [ ] RTK store: `baseApi` with tag types (`Company`,`Worker`,`Roster`,`StaffingRequirement`,`Job`,`CostSummary`); code-split injected endpoints per domain, one file per domain named `<domain>.api.ts`, with every endpoint's request/response typed from the `packages/shared` Zod-inferred types (never a locally re-declared shape or `any`); every query declares `providesTags` for its resource (list + per-item `{type, id}`) and every mutation declares the precise `invalidatesTags` it affects (add/move/remove-shift-worker and alert-ack invalidate `Roster`; CSV-import job completion invalidates `Worker`; requirements save invalidates `StaffingRequirement`) so pages never need a manual refetch or keep a duplicated local cache; error-envelope handling that maps 409 `confirmRequired` responses into the ConfirmDialog flow and 422 into blocking toasts; job-polling endpoint with `pollingInterval: 1500` stopping on terminal state, invalidating the tag the job affects (`Roster` for roster-generation, `Worker` for csv-import) on reaching `completed` so the UI updates without an extra manual fetch.
- [ ] Client-only RTK slices: rosterEditor (selected slot/worker, pending edit), ackChecklist, dialogs — each a `<name>.slice.ts` file exporting typed actions/selectors; these slices hold only ephemeral UI state, never server data, so there is a single source of truth for anything that comes from the API.
- [ ] Routing (React Router): /workers, /companies, /requirements, /roster/:month, /cost/:month, /schedule/:token (public, print stylesheet).

### Phase 8 Validation
**Agent:** `ts-reviewer`

**Tasks:**
- [ ] Validate Phase 8 against frontend standards: component reuse (no page-level duplication of ui-kit concerns), strict typing (no `any`), accessibility (labels, focus trap in modals, keyboard nav in grid), RTK Query cache-invalidation correctness, and XSS safety — no `dangerouslySetInnerHTML` anywhere in `packages/ui` (enforce with the `react/no-danger` ESLint rule); all user/CSV-derived strings (worker names, company names, import error messages) rendered only through React's default JSX escaping.

---

### Phase 9: Frontend Features
**Agent:** `general-purpose`

**Tasks:**
- [ ] Workers page: composed from `packages/ui` primitives (Table, FormField, Modal) rather than re-implementing list/table/form chrome at the page level; list with filters (status/role/company/search), create/edit worker + contract form (availability 7×3 checkbox matrix, live Israeli-ID validation surfaced through FormField's `aria-invalid`/`aria-describedby`, not a bare error `<div>`), deactivate flow on delete-409, share-link copy/rotate.
- [ ] Companies page: CRUD with duplicate-name and delete-with-workers error surfacing.
- [ ] Staffing Requirements page: role × shift headcount matrix editor with full-replace save.
- [ ] Roster page: month picker; Generate button → 202 → JobProgress polling → grid refresh driven by the `Roster` tag invalidation on job completion (not a manual re-fetch); CalendarGrid rendering shifts + assigned workers; manual edit dialog (add/move/remove, reusing the Modal from `packages/ui` and returning focus to the originating grid cell on close) greying out ineligible workers as a hint, wired to the 422-block / 409-confirm API flow; AlertChecklist side panel; Publish button disabled until all alerts acked, showing `unacknowledgedAlertIds` on 409; regenerate-published with `force` confirmation.
- [ ] CSV panel: file upload gated by a ConfirmDialog stating the full-sync rule ("workers not in this file will be set Inactive") → job polling → `ImportResult` report showing the per-row error table AND the list of deactivated workers (name + ID) so the sweep is visible and reversible; export download link.
- [ ] Cost Dashboard: roster total, per-company and per-worker tables from cost-summary endpoint.
- [ ] Public worker schedule page: token URL, month picker over published rosters only, print stylesheet; renders only what the scoped public endpoint returns (worker display name + own shifts — never national ID, rates, or other workers), and the page ships no authenticated API access (no `baseApi` credentials/state reused).

### Phase 9 Validation
**Agent:** `ts-reviewer`

**Tasks:**
- [ ] Validate Phase 9 against frontend standards: state management patterns (server state only in RTK Query, no duplicated caches), component reuse from packages/ui, error handling completeness for every documented error code, a11y on the calendar grid and dialogs, no `dangerouslySetInnerHTML` in any page, and the public schedule page exposing no PII beyond the worker's own published schedule.

---

### Phase 10: Full-stack Integration Verification
**Agent:** `general-purpose`

**Tasks:**
- [ ] Wire `apps/web` build into nginx image; `docker compose up --scale api=2` serves the SPA and the whole API on :80.
- [ ] Smoke-verify the golden path in the composed stack: seed → configure requirements → generate → review alerts → ack → manual edit (one blocked, one confirmed) → publish → cost dashboard → CSV export/import round-trip → public schedule page.
- [ ] Root README: prerequisites (Node 24, pnpm, Docker, Python for local solver dev), dev workflow (`pnpm dev`), test commands per level, compose usage, CSV schema pointer.

---

### Phase 11: E2E Testing (Playwright)
**Agent:** `general-purpose` (Playwright)

**Tasks:**
- [ ] Playwright setup at repo root: webServer against docker-compose (or dev servers + Postgres), per-test DB reset fixture, trace on failure, chromium + firefox + webkit projects — every test suite below runs in all three browser projects (cross-browser coverage comes from the project matrix, not per-test duplication; no browser-specific skips without a documented reason). **Availability v2 amendment:** the per-test DB reset fixture must now also reset and seed `WorkerAvailability` rows — under v2, any generation-dependent scenario run against a month with zero availability rows produces an all-alerts empty roster, which would silently break every scenario below that assumes assignments exist. Add a fixture helper that seeds "fully available" rows (`ABC` on every date of the target month) for named workers, so existing scenarios keep their original intent with one setup line.
- [ ] Test: worker CRUD happy path — create worker with contract (rate/min/max only — the worker form no longer contains the 7×3 `AvailabilityMatrix`, removed in Availability v2), deactivate; inactive worker absent from roster generation. Availability editing is covered by the availability-grid scenarios below, not by this test.
- [ ] Test: companies CRUD happy path — create company, rename it, duplicate name (case-insensitive) rejected with 409 surfaced inline, delete of a company with workers shows 409 error, delete of an empty company succeeds and disappears from the list.
- [ ] Test: worker list filters — status/role/company filters and free-text search each narrow the seeded list correctly and combine (e.g. ACTIVE + Supervisor + company X); clearing filters restores the full list.
- [ ] Test: form validation — invalid Israeli ID checksum rejected inline (via FormField `aria-invalid` error) and by API; min > max hours rejected.
- [ ] Test: duplicate national ID — creating a second worker with an already-registered national ID shows the 409 error inline without losing the form input; importing a CSV row with an existing national ID updates (upserts) that worker instead of creating a duplicate.
- [ ] Test: staffing requirements matrix save and reload — edited headcounts persist across a full page reload.
- [ ] Test: staffing requirements validation — negative headcount rejected inline; save is full-matrix replace (a cell zeroed out stays zero after reload).
- [ ] Test: availability grid happy path — open the availability grid for the target month, set worker W to `A`-only on three specific dates and clear all of W's other cells, save (a single month-replace PUT), reload → grid state persists; generate → W is assigned only to shift A and only on those dates, and never appears on a date with no entry.
- [ ] Test: availability grid month boundaries — the grid renders exactly 28 (non-leap February), 29 (2028-02), 30, and 31 date columns for the respective months with no spill-over from adjacent months; the availability CSV export for each of those months has `national_id` + exactly that many `dNN` columns, and each export re-imports unmodified.
- [ ] Test: roster generation flow — with availability rows seeded for the month (Availability v2 precondition — see the setup-fixture amendment above), generate month, job progress visible, calendar grid populated, deterministic re-generation. Determinism-sensitive scenarios remain valid and required under the new model: date-specific availability rows are plain deterministic solver inputs (per-worker `date → shifts` in the problem JSON; seed 42, 1 search worker, 30s unchanged), so "generate twice with identical availability rows → identical roster" is still asserted exactly as before.
- [ ] Test: month boundaries — generate February of a non-leap year (28 day columns), February of a leap year e.g. 2028-02 (29 columns), and a 31-day month (31 columns); each renders exactly 3 shift rows per day with no spill-over days from adjacent months.
- [ ] Test: concurrent generation attempt — clicking Generate while a generation job for the same month is in flight surfaces the 409 in-flight error, keeps showing the existing job's progress, and creates no duplicate job.
- [ ] Test: empty-workforce generation — with all workers deactivated, generation completes (job reaches terminal state), every required slot raises an unfillable-slot alert, and the empty calendar grid renders without errors. (Cause: all workers deactivated — distinct from the all-workers-zero-availability scenario below, which uses active workers with zero availability rows for the month; both require the same terminal-job / all-alerts-empty-roster outcome.)
- [ ] Test: all-workers-zero-availability month — with active workers but zero availability rows for the month, generation completes to a terminal state, every required slot raises an unfillable-slot alert, and the empty calendar grid renders without errors (mirror of empty-workforce, with availability as the cause).
- [ ] Test: alert gate — unfillable-slot and min-hours alerts listed; publish blocked until every alert acknowledged (409 shows `unacknowledgedAlertIds`); publish succeeds after all are acked.
- [ ] Test: regenerate a published month — Generate on a published month without force is rejected (409 surfaced with explanation); confirming with `force:true` reopens the month as draft, re-raises alerts, and the publish gate must be passed again before republish.
- [ ] Test: manual edit rules — adding a 3rd shift in a day is blocked (422 UI state); an over-max-hours add shows confirm dialog and succeeds only after confirmation.
- [ ] Test: midnight-spanning sequence allowed — assigning the same worker shift C (16:00–00:00) and shift A of the NEXT day is accepted (different calendar days, not a 2-shifts/day violation); adding a 3rd shift on either of those calendar days is still blocked.
- [ ] Test: manual move and remove — moving a worker between two slots completes as one action (worker leaves the source and appears in the target); removing a worker that drops them below contracted min hours shows the 409 confirm dialog and only succeeds after confirmation; a removal with no violation applies immediately.
- [ ] Test: manual edit eligibility hints — in the edit dialog, a worker is greyed out as unavailable for a slot iff the edit's **exact date** has no availability row for them, or the row's shift subset excludes the slot's shift (Availability v2: all weekday-matrix reasoning is gone; the hint source is the same month-availability data the availability grid reads, `getMonthAvailability`); workers of the wrong role or inactive are also greyed out; force-attempting such an add is still 422-blocked with the violation shown.
- [ ] Test: zero-availability worker — a worker with no rows in the month renders as an all-unavailable availability-grid row (no crash), is never assigned by generation, and is greyed out as unavailable for every slot in the manual-edit dialog.
- [ ] Test: manual edit vs date-specific availability — in a generated roster, adding a worker to a slot on a date where they have no availability row → 422 blocked with the violation shown; a date with a row whose subset excludes the slot's shift (row `A`, add to shift C) → 422; a date with the shift in the subset → the add succeeds.
- [ ] Test: worker deactivated after assignment — deactivate a worker who holds shifts in the current draft; regeneration excludes them from the new roster, and manually re-adding the inactive worker to a slot is 422-blocked.
- [ ] Test: CSV — import sample worker file (8-column schema, no `avail_*` columns — Availability v2 removed them), per-row error report shown for a bad row, batch not aborted; export re-imports unmodified (8-column round-trip, no `avail_*` columns anywhere in header or report). The availability CSV round-trip is a separate scenario below, not folded into this one.
- [ ] Test: CSV full-sync deactivation — pre-upload confirm dialog states the sync rule; file shape is now 8-column; importing a file missing an existing worker sets that worker Inactive, lists them in the import report, and excludes them from the next roster generation; a worker whose row is present but invalid stays Active; re-importing the full export restores nothing unexpectedly (deactivated worker can be flipped back to Active in the UI). Contrast: the availability-CSV import (below) performs **no** deactivation sweep — full-sync semantics are worker-CSV-only.
- [ ] Test: availability CSV round-trip — export month M → import the file unmodified → import report shows zero errors and the grid is unchanged; include a guarded-cell (formula-prefix) case surviving the round trip.
- [ ] Test: availability CSV per-row errors — a file containing one illegal shift-letter cell (e.g. `AD`), one duplicate-letter cell (`AA`), and one row with an unknown `national_id`: import completes, each bad row is listed with its row number in the per-row error report, valid rows are applied, the batch is not aborted, and no worker is deactivated by this import.
- [ ] Test: availability CSV wrong month shape — importing a 31-day month's export into a 30-day target month (header day-count mismatch) is rejected with a 400 that is surfaced in the import panel UI (regression guard: the error must not be swallowed — same bug class as the CsvPanel swallow fix).
- [ ] Test: availability payload limits — a dense, legal month save whose PUT body exceeds 100 KB (≥ ~100 fully-available workers, seeded via API fixture) succeeds through nginx, proving the route-scoped 2 mb JSON limit took effect; an oversized (> 2 MB) availability CSV upload is rejected with the clean 400/413 error envelope surfaced in the UI and no partial import.
- [ ] Test: cost dashboard totals match count × 8 × rate for a small fixture.
- [ ] Test: public schedule token page shows published month only (draft months absent from the month picker); unknown token → 404 page; after rotating a share link the old token 404s and the new one works; page content contains no national ID or rate data and no other worker's assignments.
- [ ] Test: public schedule print stylesheet — with `page.emulateMedia({ media: 'print' })` on the schedule page, app chrome/navigation is hidden and the worker's monthly schedule remains fully visible and readable (print CSS applied).
- [ ] Test: API failure surfacing — intercept a mutation (e.g. worker save) to return 500: a generic error toast appears with no stack trace or schema detail, the form input is preserved, and retrying after removing the interception succeeds.
- [ ] Test: job failure state shown — force the roster-generation job into a failed terminal state (e.g. intercept `GET /api/jobs/:id` to return `failed`): JobProgress displays the failure, polling stops, the grid is unchanged, and the Generate button is re-enabled.
- [ ] Test: polling network resilience — abort/fail 1–2 consecutive job-status polling requests mid-generation: polling recovers on subsequent intervals, the terminal state is still detected and the grid refreshes, with no unhandled errors in the browser console.
- [ ] Test: keyboard-only calendar grid — Tab moves focus into the grid, arrow keys move the roving tabindex between slot cells, Enter/Space opens the manual-edit dialog for the focused slot, and closing the dialog returns focus to the originating cell — all without a single mouse interaction.
- [ ] Test: keyboard-only confirm dialog flow — complete a 409 soft-warning confirm (over-max-hours add) entirely by keyboard: initial focus lands inside the dialog, Tab is trapped within it, Escape cancels without applying, and activating Confirm applies the edit and restores focus to the trigger.
- [ ] Test: keyboard-only availability grid — Tab enters the grid at exactly one roving tab stop; arrow keys/Home/End move focus between cells (one tab stop per cell — the A/B/C sub-toggles are not separate tab stops); pressing `A`/`B`/`C` on a focused cell toggles that letter and the cell's `aria-label` updates to the new worker/date/subset; the change is saved entirely by keyboard, without a single mouse interaction.
- [ ] Accessibility pass (axe) with zero serious/critical violations on every page — Workers (list + open worker form), Companies, Staffing Requirements, Roster (availability grid + calendar grid + open edit dialog + open confirm dialog + alert checklist), Cost Dashboard, and the public schedule page.

---

## Files to Create

```
rostering-system/
├── package.json / pnpm-workspace.yaml / turbo.json / .nvmrc / tsconfig.base.json
├── docker-compose.yml / docker-compose.dev.yml
├── playwright.config.ts / e2e/…
├── samples/workers-sample.csv
├── docs/csv-schema.md / docs/design/ui/…
├── infra/{api.Dockerfile, worker.Dockerfile, web.Dockerfile, nginx.conf}
├── solver/{solve_roster.py, requirements.txt, tests/}
├── packages/
│   ├── shared/src/{schemas/, validation/israeliId.ts, constants.ts, types.ts}
│   └── ui/src/{Table, FormField, Modal, ConfirmDialog, Badge, Toast, EmptyState,
│               JobProgress, CalendarGrid, AlertChecklist}/…  (+ .test.tsx each)
└── apps/
    ├── api/{prisma/schema.prisma+migrations, src/{app,index,worker}.ts,
    │        src/routes/…, src/services/…, src/engine/{validator,problem,types}.ts,
    │        src/jobs/{queue,csvImport.job,rosterGeneration.job}.ts,
    │        src/csv/…, tests/…}
    └── web/src/{store/ (root store + client-only `<name>.slice.ts` files), api/ (RTK Query
             endpoints, one `<domain>.api.ts` per domain, typed from packages/shared),
             pages/{Workers,Companies,Requirements,Roster,CostDashboard,PublicSchedule}
             (one PascalCase folder per page, colocated tests), routes.tsx}
```

## Files to Modify

- `.notes/rostering-system-implementation-plan.md` — checked off as phases complete.
- `docs/design/rostering-system-design.html` — only if implementation forces a deviation (record it).

---

## Checkpoints

| Checkpoint | Verification |
|------------|--------------|
| After Phase 1 | `pnpm turbo run build lint typecheck test` green across empty workspaces |
| After Phase 2 | shared schemas imported by api & web; israeliId tests green |
| After Phase 4 | validator unit suite green; solver pytest green; Node↔Python contract test green; determinism proven |
| After Phase 6 | full API integration suite green against real Postgres; CSV round-trip proven; jobs execute via pg-boss |
| After Phase 7 | `docker compose up --scale api=2` serves the golden path through nginx |
| After Phase 9 | web app fully functional against composed backend; both validation reviews clean |
| Final | all ~39 Playwright E2E scenarios (29 original + 10 added by the Availability v2 amendment) green in all 3 browser projects (chromium/firefox/webkit); axe scans report zero serious/critical violations; README dev-onboarding verified |
