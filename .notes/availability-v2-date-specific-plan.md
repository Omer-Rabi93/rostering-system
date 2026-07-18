# Availability v2 — Date-Specific Worker Availability — Implementation Plan

## Overview

Replace the contract-level weekly availability pattern (7 weekdays × 3 shifts boolean matrix) with **date-specific availability**: per worker, per calendar date, a subset of shifts {A, B, C} the worker can work that exact date. This corrects a requirements mismatch against the source assignment doc (`~/Downloads/Developer HS.docx`, §2.2) as interpreted with the user (2026-07-17): availability should be entered per real calendar date of the month being rostered, e.g. `2026-08-03 → "A"` (morning only), `2026-08-04 → "ABC"` (all shifts), no entry → unavailable that date.

**Key semantics (user-confirmed):**
- `Contract` keeps only `hourlyCostIls`, `minMonthlyHours`, `maxMonthlyHours`. The `availability` JSON field is **removed** (full replacement — no weekly-default fallback).
- New entity `WorkerAvailability`: one row per `(workerId, date)` with `shifts` = non-empty subset of {A,B,C}. **Absence of a row = unavailable that date.** An empty subset is never stored — deleting the row is the "unavailable" representation.
- Availability is entered per target month **before** generation, via a month-scoped CSV import/export and/or an editable grid UI. A worker with no rows in a month is simply never schedulable that month (surfaces as unfillable-slot alerts if that causes shortage — not an error).
- Manual roster edits validate against the exact date's availability row.

## Requirements

- `RosterValidator.withinAvailability` checks the availability row for the edit's exact date (day-set × shift-set logic and any weekday reasoning is gone).
- CP-SAT solver receives per-worker **date→shifts** availability in the problem JSON; decision variables are only created where the date's subset allows the shift. Determinism guarantees unchanged (seed 42, 1 worker, 30s).
- Worker CSV (full workforce sync) drops all 21 `avail_*` columns: **29 → 8 columns** (`national_id`, `name`, `company_name`, `role`, `status`, `hourly_cost_ils`, `min_monthly_hours`, `max_monthly_hours`). Still re-importable, still formula-injection-guarded, still full-sync-deactivation semantics.
- New **month-scoped availability CSV**: `national_id` + one column per calendar date of the target month (`d01`…`d28/29/30/31`, count varies by month), cell values = ordered subsets like `ABC`, `A`, `BC`, or empty (= unavailable). Export for month M is re-importable unmodified. Import validates: known national IDs, legal shift-letter subsets, exact header match for that month's day count. Per-row errors reported without aborting the batch (same convention as worker CSV).
- Prisma: new `WorkerAvailability` model — `workerId` FK (Cascade on worker delete is wrong — worker delete is already Restrict'd/deactivate-flow; use Cascade only if consistent with existing rules, else Restrict + status semantics), `date` (`@db.Date`), `shifts` string or bool triple; `@@unique([workerId, date])`; index on `(date)` for month-window queries.
- API: bulk get/replace availability for a month (`GET/PUT /api/availability/:month`), month-scoped CSV import (async job, same pg-boss pattern) + sync export endpoint.
- Frontend: availability grid (workers × dates of target month, cell = shift-subset editor) reachable from the Roster page for the month being planned; worker form's 7×3 `AvailabilityMatrix` component removed.
- All existing invariants preserved: strict Zod at every boundary, no PII in logs, engine purity (no Express/Prisma imports), tag-precise RTK Query invalidation, a11y on the new grid (roving tabindex like `CalendarGrid`).

---

## Execution Strategy

> Phases V1→V4 are backend, sequential, strict TDD. Phase V5 is frontend. Phase V6 is a validation review. Phase V7 updates docs/samples and re-verifies the Docker stack. E2E scenario amendments fold into the existing Phase 11 backlog.

### Phase V1: Shared Schemas (TDD)
**Agent:** `general-purpose`

**Tasks:**
- [ ] Write failing tests, then implement, in `packages/shared`: `shiftSubsetSchema` (non-empty ordered subset of `SHIFT_TYPES`, canonical form `A<B<C`, rejects duplicates/unknown letters), `availabilityEntrySchema` (`{date: YYYY-MM-DD, shifts}` with date inside a given month), `monthAvailabilitySchema` (array for one worker or map keyed by nationalId/workerId — match what the API bulk endpoint needs), all `.strict()`.
  - If `monthAvailabilitySchema`'s inferred type (or any downstream DTO built from it) models a per-date cell as an optional field (e.g. `shifts?: ShiftType[]`), `exactOptionalPropertyTypes` (on repo-wide in `tsconfig.base.json`) means `{ shifts: undefined }` is a type error where the field is simply absent — every builder for a sparse date-keyed payload (row has no entry for a given date) must omit the key via conditional spread (`...(shifts.length ? { shifts } : {})`), not assign `undefined`.
- [ ] Update `contractSchema`: remove `availability`; update inferred types/exports; fix every in-repo consumer that compiles against it (api services, csv module, web form types will break — leave `apps/web` breakage for Phase V5 but keep `packages/shared` + `apps/api` green).
  - Two `apps/web` consumers read `contract.availability` directly and are not yet listed under "Files to Modify": `apps/web/src/pages/Roster/eligibility.ts` (`getIneligibilityReason` indexes `contract.availability[weekday]?.[shiftIndex]`) and its caller `apps/web/src/pages/Roster/SlotEditDialog.tsx` (passes `worker.contract` straight into it) — both drive the manual-edit worker-picker's "ineligible" hint and must be rewired in Phase V5 to the date-specific availability source instead of deleted silently by the type break.

### Phase V2: Database Layer
**Agent:** `general-purpose`

**Tasks:**
- [ ] Prisma migration: add `WorkerAvailability` (`@@unique([workerId, date])`, FK to Worker consistent with existing delete rules, `date @db.Date`, index for month-range queries); drop nothing from `Contract` (its `availability` Json column: remove field from schema + a migration to drop the column — history is not needed per user's full-replacement decision).
- [ ] Update `seedData.ts`/`seed.ts`: seed availability rows for the **next calendar month** for the 12 fixture workers, preserving each fixture's old intent (e.g. ex-"no nights" worker gets `AB` on every seeded date; ex-"weekdays only" gets rows only on Mon–Fri dates).
- [ ] Update the test-DB harness only if table discovery needs it (it truncates dynamically — likely zero change; verify).

### Phase V3: Engine + Solver (TDD — core semantics change)
**Agent:** `general-purpose`

**Tasks:**
- [ ] `engine/types.ts`: replace `AvailabilityMatrix` with `AvailabilityByDate` (readonly map `date → readonly ShiftType[]`). `validator.ts` `withinAvailability`: allowed iff the edit's date has an entry containing the slot's shift. Tests: date present + shift in subset → ok; date present + shift not in subset → violation; date absent → violation; other rules untouched (re-run whole suite).
  - If `AvailabilityByDate` is a `ReadonlyMap`, `.get(date)` is already `T | undefined` regardless of `noUncheckedIndexedAccess`, so that part is safe by construction — but if the problem-JSON wire shape instead uses a plain `Record<string, readonly ShiftType[]>` (needed for JSON serialization to the Python solver, see `engine/problem.ts` below), `obj[date]` is `readonly ShiftType[] | undefined` under `noUncheckedIndexedAccess`; `withinAvailability` must treat a missing key as the real "date absent → violation" case via an explicit check, not a non-null assertion (`!`).
- [ ] `engine/problem.ts`: `buildProblem` takes availability rows (fetched by the service layer for the month window) and emits per-worker `{date: [shifts]}` in the problem JSON; parser side unchanged. Update problem tests.
  - Build the per-worker date map internally as a `Map`/nested `Map` (avoids repeated `noUncheckedIndexedAccess` undefined-checks in the assembly logic) and only convert to the plain JSON-serializable object at the final wire-shape boundary, rather than indexing a plain object throughout.
- [ ] `solver/solve_roster.py`: availability check becomes `shift in availability.get(worker, {}).get(date, [])`; variable creation pruned accordingly. Update all pytest fixtures to date-keyed availability; re-run determinism/cap/shortfall/fairness suites; re-prove byte-identical two-run determinism.
- [ ] Node↔Python contract test: update fixture problem JSON to the new wire shape; re-run.

### Phase V4: Services + API + CSV + Jobs (TDD)
**Agent:** `general-purpose`

**Tasks:**
- [ ] `GET /api/availability/:month` — all availability rows in the month window, grouped per worker (planner grid data source). `PUT /api/availability/:month` — full-replace for the month in one transaction (delete month window + insert payload), 400 on out-of-month dates/bad subsets/unknown workerIds. Supertest TDD against live Postgres.
  - The grouped-per-worker response is exactly the sparse-optional-field case from Phase V1's `monthAvailabilitySchema` note: a worker with no row for a given date must omit that date's key from the response object (not `date: undefined`) to satisfy `exactOptionalPropertyTypes` on the DTO type; same discipline applies to the request-side parser building the delete/insert transaction from the PUT body.
  - Validate the `:month` path param with the shared `monthSchema` (exactly as `routes/rosters.ts` does) before any month-window arithmetic or Prisma query — `parseStringParam` alone accepts any string, and a malformed month must never reach date computation or a query. Applies to both GET and PUT (and to the CSV import/export routes below).
  - Body-size decision (explicit now, not discovered in production): the app-wide `express.json({ limit: '100kb' })` in `app.ts` is too small for this one route. A dense month payload runs ~1 KB per worker (31 dates × `"YYYY-MM-DD":["A","B","C"],` ≈ 33 B each), so the default cap breaks at roughly 95–100 fully-available workers — inside this plan's own stated 50–150-worker org size — and the 500-worker × 31-date worst case is ~0.5 MB. Mount a route-scoped `express.json({ limit: '2mb' })` on the availability router only (the global 100kb stays for every other route); an oversized body already maps to the clean 413 envelope via `errorHandler`'s `entity.too.large` branch, and nginx's `client_max_body_size 3m` (`infra/nginx.conf`) already clears 2 MB — no nginx change needed. Add a supertest for a >100kb-but-legal payload succeeding.
  - DoS bounds beyond bytes: after Zod parse (`.strict()` schemas from V1, so unknown keys are rejected), 400 if the total `(workerId, date)` entry count exceeds a named constant (e.g. `MAX_AVAILABILITY_ENTRIES = 20_000` — analogous to `MAX_ROWS` in `routes/importExport.ts`, comfortably above the 500×31 = 15,500 worst case) before opening the transaction. If any part of the payload shape is array-based, explicitly 400 duplicate `(workerId, date)` pairs rather than letting the `@@unique([workerId, date])` constraint abort the transaction as a masked 500; a date-keyed object shape sidesteps duplicates by construction.
  - Mount the router under `/api` in `app.ts` (`app.use('/api/availability', ...)`) — never at root — so nginx's `location /api` proxying and its `always`-applied security headers cover it, and the only non-`/api` route in the app remains the rate-limited `/schedule`.
- [ ] Worker CSV module: remove the 21 `avail_*` columns (29→8), update parse/serialize/round-trip/guard tests, `docs/csv-schema.md`, and regenerate `samples/workers-sample.csv` via the existing script. Import job: contract upsert no longer writes availability; sweep semantics unchanged.
- [ ] New month-scoped availability CSV: `apps/api/src/csv/availability.ts` (headers computed from the month's day count; values validated as shift subsets; formula guard kept), `GET /api/export/availability/:month` (sync, attachment headers, nosniff), `POST /api/import/availability/:month` (multipart caps + strict header check for that month → 202 job via pg-boss `availability-import` queue, per-row error report, absent workers in file = simply no change to their rows — **no deactivation sweep here**, that's worker-CSV-only semantics).
  - Import-protection parity checklist — each item stated explicitly here because none is inherited automatically: the same multer config as `routes/importExport.ts` — `multer.memoryStorage()` (no disk spool), `limits: { fileSize: 2 * 1024 * 1024, files: 1 }`, and the same `fileFilter` (`.csv` extension AND the `CSV_MIME_TYPES` allowlist) — plus the same `handleSingleFileUpload` MulterError→400-envelope translation. Extract those pieces from `importExport.ts` into a shared helper and reuse them (don't copy-paste two configs that can drift).
  - BEFORE enqueue, in the route handler (mirroring `parseWorkersCsv`'s position in the worker-import pipeline): full parse with exact-header validation for that `:month` (`national_id` + that month's complete `dNN` set — count and order exact → 400 via the `CsvHeaderError`-style path), then the `MAX_ROWS = 10_000` row-count check (one row = one worker here, so 10k bounds the job at ≤ 10k × 31 upserts). Only already-header-validated, row-capped CSV text ever reaches pg-boss.
  - Formula-injection guard, made precise: export every cell through the same `serializeCsv`/`guardCell` path the worker CSV uses (`csv/serialize.ts` applies `guardCell` to every cell) and `unguardCell` each cell on parse before validation. Post-validation no cell here can start with a trigger character (`national_id` is digit-only, `dNN` values are canonical `A`<`B`<`C` subsets, empty stays empty) — so the guard is defense-in-depth invariance of the shared serializer, not the primary control — but do NOT special-case the `dNN` columns out of the guard on the theory that they're constrained; keep it uniform and include a guarded-cell case in the month round-trip test.
  - PII/logging: the `availabilityImport` job handler and service must never log raw CSV text or a full national ID — any server-side logging goes through `logger.ts` (`logServerError`/`redactNationalIds`, last-4 masking). The per-row error report returned in the job *result* may carry `nationalId` (consistent with the worker import's `ImportRowError` shape — that is a planner-facing API response, not a log line).
  - Both endpoints mount under `/api` (reuse the `app.use('/api', ...)` mount style of `createImportExportRouter` — no new nginx location or exposure outside `location /api`), and both validate `:month` with `monthSchema` before computing that month's header set.
- [ ] Roster generation: `rosterGenerationService` fetches the month's availability rows to build the problem; a month with zero availability rows generates an all-alerts empty roster (test explicitly). Update every existing api test fixture that used contract availability.

### Phase V5: Frontend
**Agent:** `general-purpose`

**Tasks:**
- [ ] Remove `AvailabilityMatrix` from `WorkerFormModal` (contract form keeps rate/min/max only); delete the component and its tests; update worker-form tests.
  - Also rewire `apps/web/src/pages/Roster/eligibility.ts` (`getIneligibilityReason`) and `apps/web/src/pages/Roster/SlotEditDialog.tsx` off the removed `contract.availability[weekday][shiftIndex]` lookup onto the new date-specific source (the same `getMonthAvailability` cache entry the grid reads — see below), keyed by the edit's exact `date` rather than weekday; add both files to "Files to Modify" and update `eligibility.test.ts` for date-keyed fixtures. This is a real compile break today (Phase V1 removes the field), not just an optional cleanup.
- [ ] `availability.api.ts` (RTK Query): `getMonthAvailability` (provides `Availability` tag by month), `replaceMonthAvailability` (invalidates `Availability` + nothing else), export/import endpoints wired to the job-polling pattern (`availability-import` completion invalidates `Availability`). Add the new tag type to `baseApi`.
  - Scope both the `providesTags`/`invalidatesTags` entries per month (`{ type: 'Availability', id: month }`), mirroring `rosterTag(month)`/`costSummaryTag(month)` in `rosters.api.ts` — not a flat `Availability` tag — so replacing one month's availability doesn't refetch cached grids for other months.
  - Verified against the two existing CostSummary-staleness precedents (`rosters.api.ts`'s `addShiftWorker`/`moveShiftWorker`/`removeShiftWorker` co-invalidating `[rosterTag, costSummaryTag]`, and `workers.api.ts`'s `upsertWorkerContract` invalidating the whole `CostSummary` tag on a rate change) before asserting "invalidates `Availability` + nothing else": availability alone doesn't change any already-computed roster/cost, only a *future regeneration* does, and `jobs.api.ts`'s `roster-generation` completion handler already invalidates `['Roster', 'CostSummary']` — so `replaceMonthAvailability` correctly must NOT also invalidate `Roster`/`CostSummary` itself (V6 should treat this as a checked conclusion, not an open question).
- [ ] Availability grid UI on the Roster page (pre-generation section or tab): rows = workers, columns = dates of the selected month, cell = compact A/B/C toggle set; roving-tabindex keyboard nav consistent with `CalendarGrid`'s pattern; bulk actions kept minimal (set-all-for-worker). Save = single month-replace PUT. CSV import/export buttons beside it (confirm dialog for import states replace-month semantics).
  - Component structure: do **not** reuse `packages/ui`'s `CalendarGrid` as-is — its shape is fixed at 3 shift *rows* × N day columns, `getSlot(date, shift)` returns multi-worker chip content, and `onSlotActivate` opens an external modal (`SlotEditDialog`); this grid's rows are *workers* (arbitrary count, not fixed at 3) × N day columns, and each cell must be inline-editable (an A/B/C toggle), not "click opens a modal". Keep it a new component (`AvailabilityGrid.tsx`, page-local like `AvailabilityMatrix.tsx` was for Workers), but extract `CalendarGrid.tsx`'s roving-tabindex keyboard math (`neighborFor`/`cellKey`/the focus-ref map, `CalendarGrid.tsx` lines ~40-134) into a shared, exported utility/hook in `packages/ui` (e.g. `useRovingTabindex`) so both grids share one tested implementation instead of a ~90-line copy-paste fork. Add `packages/ui/src/CalendarGrid/CalendarGrid.tsx` (refactor) and the new shared util/hook (+ tests) to "Files to Create"/"Files to Modify" — currently that list has no `packages/ui` entry at all despite this requirement.
  - a11y concreteness: "roving tabindex like `CalendarGrid`" doesn't by itself resolve what Enter/Space does on a focused cell here, because `CalendarGrid`'s cells aren't themselves inline-editable (activation opens a dialog). Nesting 3 independently-focusable checkboxes per cell would 3x the tab-stop count and break the one-tab-stop-per-cell roving model. Specify: the cell itself is the roving tab stop (`role="gridcell"`, `tabIndex={0|-1}`, `aria-label` summarizing worker/date/current subset, mirroring `buildAriaLabel`'s pattern), arrow keys/Home/End move between cells exactly as in `CalendarGrid`, and the A/B/C sub-toggles are reached via a secondary in-cell key (e.g. pressing `A`/`B`/`C` while the cell is focused toggles that letter) rather than as separate tab stops.
  - Scale/perf: unlike `CalendarGrid`'s fixed 3 rows, worker count is unbounded — a 50-150 active-worker org × 31 dates is 1,500-4,650 focusable `<td>`s in one table. Either state this is accepted for expected org sizes, or add a worker filter (active-only / by company, reusing `workers.api.ts`'s existing filters) before this ships; also note the grid needs sticky/scrollable behavior on **both** axes (worker-name column *and* date-header row), whereas `CalendarGrid`'s `.calendar-scroll` only handles the day-column axis.
  - Data: reuse `apps/web/src/lib/calendar.ts`'s `buildMonthDays(month)` for the date columns (already produces the 28-31-entry `{date,label,dayOfWeek,isWeekend}` list `CalendarGrid` itself is built from) instead of reimplementing month-day generation.
  - TS strictness: the per-(worker,date) lookup structure hits `noUncheckedIndexedAccess` the same way `CalendarGrid.tsx`'s own `handleKeyDown` already guards against (`const nextDay = days[next.col]; if (!nextDay...) return;`) — a `Record`/nested-object lookup like `lookup[workerId]?.[date]` is `ShiftType[] | undefined`, and `undefined` is the real "unavailable" state here (per the plan's "absence of a row = unavailable" semantics), not a value to coalesce away with `!` or a default `[]` fabricated before it reaches the cell renderer.
- [ ] Testing Library coverage: grid renders month correctly (28/29/30/31 days), cell edit → PUT payload correct, empty-cell = no row sent, import 400 surfaced (do not repeat the CsvPanel swallow bug), keyboard nav on the grid.
  - Add: a worker with zero rows in the month renders every cell as unavailable (not a crash) — the `noUncheckedIndexedAccess`-driven undefined path from the note above; and a test that the shared roving-tabindex util is exercised (not re-implemented) by both `CalendarGrid` and `AvailabilityGrid`, if V6 flags a fork.

### Phase V6: Validation Review
**Agent:** `ts-reviewer`

**Tasks:**
- [ ] Review V1–V5 against the same criteria as Phases 8/9 validation: state management, packages/ui reuse, error-handling completeness for every new endpoint's codes, grid a11y, no `dangerouslySetInnerHTML`, RTK tag precision (does roster generation completion need to invalidate `Availability`? — no; does availability replace need to invalidate `Roster`/`CostSummary`? — no, per the V5 note grounding this in `jobs.api.ts`'s `roster-generation` handler already owning that invalidation — confirm it's still true, don't just re-assert it), plus: no stale references to the old matrix anywhere (`grep AvailabilityMatrix`, `avail_sun_a`).
  - Also grep for `contract.availability` (should be zero hits outside `git log`/migration files — catches `eligibility.ts`/`SlotEditDialog.tsx` if V5 missed the rewire).
  - Confirm `Availability`'s `providesTags`/`invalidatesTags` are month-scoped (`{type:'Availability', id: month}`), not a flat tag — an unscoped tag would over-invalidate every cached month's grid on any single month's save.
  - Confirm the roving-tabindex keyboard logic is shared between `CalendarGrid` and `AvailabilityGrid` (one implementation in `packages/ui`), not forked/copy-pasted.
  - Grep the new date-keyed lookup/map code (engine, API DTO builders, `AvailabilityGrid`) for non-null assertions (`!`) papering over `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` — these are exactly the spots a fast implementation is likely to reach for `!` instead of the explicit undefined-is-unavailable handling the plan calls for.
  - Security regression checks: (a) `services/publicScheduleService.ts` is untouched by v2 — its DTO still exposes only `name`/`month`/own `shifts` and never availability rows or `nationalId` (grep the public-schedule path for `availability`; v2 must not widen that surface); (b) every new route is mounted under `/api` in `app.ts` — nothing new at root besides the pre-existing rate-limited `/schedule`; (c) the availability import route's multer limits/`fileFilter`/row-cap are the shared helpers from `importExport.ts`, not a diverged copy; (d) no new `console.*` call (api services, jobs) logs an unredacted national ID or raw CSV/JSON body — everything server-logged goes through `logger.ts`'s redaction; (e) the route-scoped `express.json` 2mb limit is on the availability router only, with the global 100kb cap unchanged for all other routes.

### Phase V7: Docs, Samples, Docker re-verify
**Agent:** `general-purpose`

**Tasks:**
- [ ] Update `docs/design/rostering-system-design.html` availability sections (schema row, engine pseudocode, CSV spec, validator rule list) to v2 — record it as a design revision, per the plan's "Files to Modify" rule.
- [ ] Add `samples/availability-sample-<month>.csv` matching the seeded month.
- [ ] Re-run the Phase 7 golden path in Docker (`compose up --scale api=2` → seed → import availability CSV → generate → verify) to prove v2 end-to-end in the composed stack.
  - Include two limit probes in the composed-stack run: a dense-month `PUT /api/availability/:month` with a body >100 KB (proves the route-scoped 2mb JSON limit actually took effect through nginx — under the app-wide 100kb cap this request would 413), and one oversized (>2 MB) availability CSV upload expecting the clean 400/413 envelope (multer `fileSize` cap and nginx `client_max_body_size 3m` interplay).
- [ ] Amend `.notes/rostering-system-implementation-plan.md` Phase 11 scenarios: replace form-matrix availability tests with grid-based ones (set a worker to `A`-only on specific dates → solver respects it; manual add on an unavailable date → 422; availability CSV round-trip; grid keyboard nav). The precise amendment (all edits are to the Phase 11 backlog in place — no new phase, no new section):
  - **Setup task amendment** (Phase 11's "Playwright setup" bullet, ~line 178): the per-test DB reset fixture must now also reset and seed `WorkerAvailability` rows — under v2, any generation-dependent scenario run against a month with zero availability rows produces an all-alerts empty roster, which would silently break every pre-v2 scenario that assumes assignments exist. Add a fixture helper that seeds "fully available" rows (`ABC` on every date of the target month) for named workers, so existing scenarios keep their original intent with one setup line. Cross-browser convention is **unchanged**: every rewritten and new scenario below runs via the existing chromium + firefox + webkit project matrix — coverage comes from the project matrix, not per-test duplication, and no new projects or browser-specific skips are introduced.
  - **Scenarios to REWRITE (7 existing bullets; none is deleted outright — the only removed content is the worker-form availability step and the 29-column CSV assumption):**
    - "worker CRUD happy path — create worker with contract, edit availability, deactivate" (~line 179): drop "edit availability" — the worker form no longer contains the 7×3 matrix (`AvailabilityMatrix` is deleted in V5). Becomes: create worker with contract (rate/min/max only) → deactivate → absent from generation. Availability editing is covered by the new grid scenarios below, not by this one.
    - "roster generation flow — … deterministic re-generation" (~line 186): keep, with the explicit new precondition that availability rows are seeded for the month before Generate. **Determinism-sensitive scenarios remain valid and required under the new model — say so in the amended text:** date-specific availability rows are plain deterministic solver inputs (per-worker `date → shifts` in the problem JSON; seed 42, 1 search worker, 30 s unchanged), so "generate twice with identical availability rows → identical roster" is still asserted exactly as before.
    - "empty-workforce generation" (~line 189): keep as-is (cause: all workers deactivated), but note it is now distinct from the new all-workers-zero-availability scenario below — two different causes, same required outcome (terminal job, all-alerts empty roster, grid renders).
    - "manual edit eligibility hints" (~line 195): redefine "unavailable for the slot" — a worker is greyed out iff the edit's **exact date** has no availability row for them OR the row's subset excludes the slot's shift (all weekday-matrix reasoning is gone); the hint source is the same month-availability data the grid reads (`getMonthAvailability`), and force-attempting such an add is still 422-blocked with the violation shown.
    - "CSV — import sample file, per-row error report, export re-imports unmodified" (~line 197): worker CSV is now the **8-column** schema — the 29-column round-trip assertion is deleted and replaced by an 8-column round-trip (no `avail_*` columns anywhere in header or report). The availability CSV round-trip is a **separate new scenario** below, not folded into this one.
    - "CSV full-sync deactivation" (~line 198): semantics unchanged, file shape now 8-column; add the explicit contrast that the availability-CSV import performs **no** deactivation sweep (asserted in the new availability-CSV error scenario below — full-sync is worker-CSV-only).
    - "Accessibility pass (axe)" (~line 207): add the availability grid to the audited Roster surfaces — "Roster (availability grid + calendar grid + open edit dialog + open confirm dialog + alert checklist)" — zero serious/critical violations, same bar as every other page.
    - Also update the final checkpoint row ("all ~29 Playwright E2E scenarios", ~line 254) to the new total (~39: 29 existing + 10 added).
  - **Scenarios to ADD (10 new bullets, same "Test: …" format, inserted into the Phase 11 list):**
    - Test: availability grid happy path — open the availability grid for the target month, set worker W to `A`-only on three specific dates and clear all of W's other cells, save (a single month-replace PUT), reload → grid state persists; generate → W is assigned only to shift A and only on those dates, and never appears on a date with no entry.
    - Test: availability grid month boundaries — the grid renders exactly 28 (non-leap February), 29 (2028-02), 30, and 31 date columns for the respective months with no spill-over from adjacent months; the availability CSV export for each of those months has `national_id` + exactly that many `dNN` columns, and each export re-imports unmodified.
    - Test: zero-availability worker — a worker with no rows in the month renders as an all-unavailable grid row (no crash), is never assigned by generation, and is greyed out as unavailable for every slot in the manual-edit dialog.
    - Test: all-workers-zero-availability month — with active workers but zero availability rows for the month, generation completes to a terminal state, every required slot raises an unfillable-slot alert, and the empty calendar grid renders without errors (mirror of empty-workforce, with availability as the cause).
    - Test: availability CSV round-trip — export month M → import the file unmodified → import report shows zero errors and the grid is unchanged; include a guarded-cell (formula-prefix) case surviving the round trip.
    - Test: availability CSV per-row errors — a file containing one illegal shift-letter cell (e.g. `AD`), one duplicate-letter cell (`AA`), and one row with an unknown `national_id`: import completes, each bad row is listed with its row number in the per-row error report, valid rows are applied, the batch is not aborted, and no worker is deactivated by this import.
    - Test: availability CSV wrong month shape — importing a 31-day month's export into a 30-day target month (header day-count mismatch) is rejected with a 400 that is surfaced in the import panel UI (regression guard: the error must not be swallowed — same bug class as the CsvPanel swallow fix).
    - Test: availability payload limits — a dense, legal month save whose PUT body exceeds 100 KB (≥ ~100 fully-available workers, seeded via API fixture) succeeds through nginx, proving the route-scoped 2 mb JSON limit took effect; an oversized (> 2 MB) availability CSV upload is rejected with the clean 400/413 error envelope surfaced in the UI and no partial import.
    - Test: manual edit vs date-specific availability — in a generated roster, adding a worker to a slot on a date where they have no availability row → 422 blocked with the violation shown; a date with a row whose subset excludes the slot's shift (row `A`, add to shift C) → 422; a date with the shift in the subset → the add succeeds.
    - Test: keyboard-only availability grid — Tab enters the grid at exactly one roving tab stop; arrow keys/Home/End move focus between cells (one tab stop per cell — the A/B/C sub-toggles are not separate tab stops, per the V5 spec); pressing `A`/`B`/`C` on a focused cell toggles that letter and the cell's `aria-label` updates to the new worker/date/subset; the change is saved entirely by keyboard, without a single mouse interaction.

---

## Files to Create

```
apps/api/src/csv/availability.ts (+ tests)
apps/api/src/services/availabilityService.ts (+ tests)
apps/api/src/routes/availability.ts (+ tests)
apps/api/src/jobs/availabilityImport.job.ts (+ tests)
apps/api/prisma/migrations/<ts>_availability_v2/migration.sql
apps/web/src/api/availability.api.ts (+ tests)
apps/web/src/pages/Roster/AvailabilityGrid.tsx (+ tests)
packages/ui/src/CalendarGrid/rovingTabindex.ts (+ tests) — shared roving-tabindex hook/util extracted from CalendarGrid, reused by AvailabilityGrid
samples/availability-sample-<month>.csv
```

## Files to Modify

- `packages/shared/src/schemas/contract.ts`, new `availability.ts` schema file, barrel
- `apps/api/src/engine/{types,validator,problem}.ts` + tests
- `solver/solve_roster.py` + all solver tests
- `apps/api/src/csv/{columns,record,parse,serialize}.ts` + tests, `docs/csv-schema.md`, `samples/workers-sample.csv`
- `apps/api/src/db/{seedData,seed}.ts`, `apps/api/prisma/schema.prisma`
- `apps/api/src/services/{csvImportService,csvExportService,rosterGenerationService,shiftWorkerService}.ts` + tests
- `apps/web/src/pages/Workers/{WorkerFormModal.tsx,AvailabilityMatrix.tsx(delete)}`
- `apps/web/src/pages/Roster/{eligibility.ts,SlotEditDialog.tsx}` + `eligibility.test.ts` — off `contract.availability`, onto date-specific availability
- `apps/web/src/api/baseApi.ts` (new tag), `apps/web/src/pages/Roster/RosterPage.tsx`
- `packages/ui/src/CalendarGrid/CalendarGrid.tsx` + tests — refactor to consume the shared roving-tabindex util instead of its private `neighborFor`/focus-map logic
- `docs/design/rostering-system-design.html`, `.notes/rostering-system-implementation-plan.md` (Phase 11 scenario amendments)

---

## Checkpoints

| Checkpoint | Verification |
|------------|--------------|
| After V1–V2 | shared + api build/typecheck green (web expectedly red); migration applies; seed produces availability rows |
| After V3 | validator suite green with date semantics; solver pytest green; determinism re-proven byte-identical; contract test green |
| After V4 | full api suite green against live Postgres; worker CSV 8-col round-trip; availability CSV month round-trip; zero-availability month generates all-alerts roster |
| After V5–V6 | full repo `turbo build lint typecheck test` green; review findings fixed |
| Final (V7) | Docker golden path with availability CSV import passes; design doc + plan updated |
