# Availability v3 — Exclusion Semantics + Combined Workforce CSV — Design & Plan

## Overview

Two changes, requested together, both touching the availability subsystem built in "Availability
v2" (`docs/csv-schema.md`, `packages/shared/src/schemas/availability.ts`):

**Part F — Invert availability semantics.** Today: a `WorkerAvailability` row lists the shifts a
worker CAN work that date; absence of a row = unavailable. New: a row lists the shifts a worker
CANNOT work that date (excluded); absence of a row = available for everything. Confirmed with the
user: empty CSV cell → available A/B/C; a cell listing letters → NOT available for those, available
for the rest; a cell listing all three (`ABC`) → unavailable all day (the new way to express what
row-absence used to mean).

**Part G — Combine the worker CSV and the availability CSV into one upload.** Today: two separate
files, two separate upload endpoints (`POST /import/workers`, `POST /import/availability/:month`),
two separate `ImportTaskKind`s (`WORKER_SYNC`, `AVAILABILITY_SYNC`) with independent cancel-and-
replace domains — all just built and merged (v4). New: one file, one endpoint, one task kind,
carrying worker fields (`national_id,name,role,status,hourly_cost_ils,min_monthly_hours,
max_monthly_hours`) AND that month's `dNN` availability columns together.

**Confirmed via research, not assumed: no production data exists anywhere in this repo's history**
(single from-scratch dev migration history, no deployment/ops docs, no evidence of a real dataset).
So Part F needs **no data-preserving migration** — existing dev/seed rows can simply be
re-authored to express the same real-world intent under the new meaning, not inverted-in-place.

---

## Part F: Exclusion Semantics

### Key design decision: where the inversion lives — store EXCLUDED shifts, invert only where "available shifts" is actually needed

Two ways to implement "empty = available for everything, letters = excluded" were considered:

1. **Keep the DB meaning as "included shifts" (today's meaning), invert only at the CSV/UI
   boundary.** Rejected: it has no way to represent "fully unavailable" without either storing an
   empty string (violating the schema's existing, deliberate invariant — `schema.prisma:146-148`,
   "an empty subset is never stored, the row is deleted instead") or resurrecting row-absence to
   mean unavailable again (which is exactly the meaning being inverted — self-contradictory).
2. **Change the DB meaning to "excluded shifts."** No representability gap: "fully unavailable" is
   a normal, non-empty row (`excludedShifts = "ABC"`); "fully available" is row-absence, matching
   the CSV's own empty-cell convention exactly. **This is the recommended design.**

Concretely:
- `WorkerAvailability.shifts` — recommend renaming to `excludedShifts` (a no-cost rename given no
  production data; leaving it named `shifts` while its meaning inverts is a standing footgun for
  future readers). Same type/column (`VarChar(3)`), same non-empty-or-absent invariant, just
  opposite meaning.
- **CSV parsing/serialization (`csv/availability.ts`) barely changes** — the cell's letters ARE the
  stored value directly now (no inversion math at this boundary at all): empty cell → no row (was
  already the mechanical behavior, only the English meaning of "no row" changes); non-empty cell →
  validated subset, stored as-is as `excludedShifts`. `parseShiftSubsetCell`/`shiftsToCell`/
  `serializeAvailabilityCsv`/`toAvailabilityEntries` need doc-comment updates, not logic changes.
- **The actual excluded→available inversion happens at exactly TWO other points**, both currently
  reading `WorkerAvailability` rows to answer "is this worker available for shift S on date D":
  1. Wherever `RosterGenerationService`/whatever calls `buildProblem` fetches availability rows and
     builds the `EngineAvailabilityRow[]` array — compute
     `includedShifts = ALL_SHIFTS.filter(s => !row.excludedShifts.includes(s))` per row (only for
     rows that exist — a date with no row still contributes no entry, unchanged mechanically) and
     pass THAT as `EngineAvailabilityRow.shifts`. `buildProblem` itself, `EngineAvailabilityRow`'s
     type, and its "no rows for this worker → `{}`" behavior all stay **completely unchanged** —
     they still mean "included/available shifts," computed one layer up.
  2. Wherever `RosterValidator`'s `ctx.worker.availability` Map gets built for manual-edit
     validation (same fetch pattern, different call site — identify the exact function during
     implementation, likely in `rosterService.ts`/`shiftWorkerService.ts`) — same per-row inversion.
  3. **`solve_roster.py`'s per-missing-date default flips**: `shifts_for_date =
     availability.get(date, [])` → `availability.get(date, ALL_SHIFT_TYPES)` (or the actual
     constant name) — a single-line change. Everything else in the solver (variable creation,
     constraints, determinism, the whole CP-SAT model) is untouched — it already only ever reasoned
     about "available shifts per date," which is exactly what it keeps receiving; only what a
     *missing* date now defaults to changes.
  4. **`validator.ts`'s `withinAvailability`** flips its own missing-date default the same way:
     `available = shiftsForDate === undefined ? true : shiftsForDate.includes(target.shiftType)`
     (today: `shiftsForDate !== undefined && shiftsForDate.includes(...)`, i.e. missing = false).
  - Recommend a single shared helper (`packages/shared` or an api-side util both call sites import)
    for the excluded→included computation, rather than duplicating the `ALL_SHIFTS.filter(...)`
    line in two services.
- **Net effect: the solver's wire contract, its Python-side model-building logic, and
  `buildProblem`'s own type/logic are almost entirely untouched** — the two riskiest, hardest-to-
  verify, determinism-sensitive components each get exactly one default-flip, not a rewrite. That
  containment is deliberate — it's what makes this a same-day change instead of a solver rewrite.

### Open decision: does the Availability Grid UI show/toggle EXCLUDED or AVAILABLE letters?

Two options, genuinely a UX call, not inferable from what was asked (which described the CSV/data
semantics, not the grid's interaction paradigm):

- **A — Grid matches CSV/DB 1:1 (toggle = "mark yourself excluded from this shift").** Zero
  inversion needed anywhere in the fetch/save path for the grid (`getMonth`, `replaceMonth`,
  `AvailabilityDraft`'s shape are all unchanged mechanically) — only the on-page help text and
  possibly the bold/dimmed visual polarity need updating. **Recommended** — keeps CSV and grid
  conceptually identical (what you'd type in a cell is exactly what toggling represents), and is
  the smallest, lowest-risk change to the UI layer.
- **B — Grid shows/toggles AVAILABLE letters (the human-intuitive "click what you CAN work"),
  opposite of what's stored/CSV.** Requires inversion at `getMonth`'s response mapping (for
  display) and `draftToPayload`'s write mapping (for save) — two more places needing the exact same
  `ALL_SHIFTS.filter(...)` logic, and a CSV export/grid mismatch (a cell showing "A" in an exported
  file would show as "B,C toggled on" in the grid) that could confuse a planner who uses both.

**Flag if B is actually wanted** — proceeding with A unless told otherwise, since it's simpler and
keeps the two UIs (CSV, grid) speaking the same language.

### Requirements

- `apps/api/prisma/schema.prisma`: rename `WorkerAvailability.shifts` → `excludedShifts` (comment
  updated to state the new meaning explicitly), migration (rename-only, no backfill given no
  production data — confirm dev/seed data can just be dropped/reseeded rather than migrated in
  place, matching this repo's existing "dev database, not production" posture elsewhere).
- `apps/api/src/csv/availability.ts`: doc-comment updates throughout (mechanical logic unchanged
  per above); update `docs/csv-schema.md`'s availability-CSV section.
- The two inversion points (buildProblem's feed, validator's feed) + the shared helper.
- `solve_roster.py`: one-line default flip + doc-comment update; **re-run and re-verify the full
  existing pytest suite**, especially `test_determinism.py` (byte-identical two-run guarantee must
  still hold) and `test_coverage_shortfall.py`/`test_min_hours_shortfall.py` (their fixtures encode
  specific availability patterns that need re-deriving under the new meaning — see below).
- `validator.ts`: one-line default flip; re-run `validator.test.ts` (18 existing tests) plus new
  tests for the flipped default.
- `apps/web/src/pages/Roster/AvailabilityGrid.tsx` + `availabilityDraft.ts`: help-text update
  ("A blank cell means available for all shifts; toggle a letter to mark yourself unavailable for
  that shift"), and Option A/B above.
- **Fixture re-derivation** (confirmed necessary by the research, not optional): `db/seedData.ts`'s
  `NO_NIGHT_SHIFT`/`WEEKDAYS`-pattern workers (5 of 12 seed workers encode real intent via the old
  meaning — e.g. "Avi Cohen can't work nights" is currently `shifts: "AB"` i.e. included-A,B; under
  the new meaning, preserving that SAME real-world intent requires storing `excludedShifts: "C"`
  instead) — re-derive each one to preserve intent, don't just leave the same letters in place.
  Same for `generateSampleAvailabilityCsv.ts`'s downstream sample file and
  `e2e/tests/roster-manual-edit.spec.ts`'s fixture references (e.g. the "no-night" comment at line
  213, `setAvailabilityCell` calls in `dbAdminServer.ts`).
- Full solver pytest + `runSolver.contract.test.ts` + `problem.test.ts` + `validator.test.ts` +
  `availabilityService.test.ts` + `AvailabilityGrid.test.tsx` + `availabilityDraft.test.ts` all need
  updating to the new meaning, not just left passing by accident.

---

## Part G: Combined Workforce CSV

### Key design decisions

- **New combined header**: `national_id,name,role,status,hourly_cost_ils,min_monthly_hours,
  max_monthly_hours,d01,d02,...,d<N>` — worker fields (fixed 7) + that month's day columns (variable
  count, exactly matching today's availability CSV's own month-dependent header sizing).
- **One route, month required**: replaces both `POST /import/workers` and
  `POST /import/availability/:month` with one endpoint carrying `:month` (e.g.
  `POST /import/workforce/:month` — name TBD, avoid overloading the existing `/import/workers`
  path since its shape changes) + `companyId` (multipart field, as today).
- **One `ImportTaskKind`.** `AVAILABILITY_SYNC` becomes unused as an upload-triggered kind once the
  standalone availability CSV route is removed (see the open decision below) — either repurpose
  `WORKER_SYNC` to mean "the combined sync" or introduce a new kind name; either is a small,
  mechanical rename. `Worker.lastImportTaskId`/the roster-eligibility query (Part A's v4 work) keeps
  working unchanged in spirit — it just now tracks "latest completed combined sync" instead of
  "latest completed worker-only sync."
- **Per-row processing**: one transaction now does BOTH what `csvImportService.importRow` does
  (upsert worker+contract) AND what `availabilityService.applyRow` does (replace that worker's
  month window) — a genuine merge of two existing per-row functions into one, not two calls kept
  side by side (keeping them side-by-side per row would double the per-row transaction count and
  reintroduce the two-cancellation-domain complexity this change is meant to remove).
- **The manual/grid editing path (`PUT /api/availability/:month`, `AvailabilityGrid.tsx`) is
  UNCHANGED** — this only merges the two CSV *upload* paths, not the separate fine-grained manual-
  edit mechanism, which has no reason to be affected.

### Open decision: does the standalone availability-only CSV upload disappear entirely, or stay as a supplementary option?

Full replacement (assumed by the design above) means a company that just wants to refresh next
month's availability without re-submitting every worker's full field set must now re-submit the
whole combined file every time — a real workflow regression for that specific case, not just an
implementation detail. Two ways to handle it if that matters:
- **Ship full replacement now, revisit later if the workflow gap is actually felt** — simplest,
  matches "needs to be combined" as stated. **Recommended default**, since it's what was asked for
  and the gap is speculative until it's an actual complaint.
- **Keep the standalone availability-only route alongside the new combined one** — more total
  surface (two upload paths again, just one of them now also-does-worker-fields), defeats some of
  the simplification purpose, but preserves the partial-update workflow.

**Flag if the partial-update workflow actually matters** — proceeding with full replacement
otherwise.

### Requirements

- `apps/api/src/csv/columns.ts`/`availability.ts`: merge into one combined-CSV parser/serializer
  (header = worker columns + month's day columns; row shape carries both worker fields and a
  per-date shift-cell map).
- `apps/api/src/services/csvImportService.ts` + `availabilityService.ts`: merge into one service
  (or one new service composing both), one combined `importRow` doing upsert-worker-then-replace-
  availability-window per row, one `ImportTask` lifecycle (cancel-and-replace, cooperative
  cancellation, the P2002/pg-boss unified retry loop from the v4 concurrency fixes — reuse that
  exact pattern, don't re-derive it).
- `apps/api/src/routes/importExport.ts` + `availability.ts`: replace the two POST routes with one.
- `apps/api/src/jobs/queue.ts`: collapse `csv-import`/`availability-import` into one queue (or keep
  two if there's a reason to, e.g. different `localConcurrency` tuning needs — worth a quick check
  during implementation whether the combined job's per-row cost changes the I/O-bound concurrency
  math from Part E).
- Frontend: `CsvPanel.tsx`/`AvailabilityCsvPanel.tsx` merge into one upload panel/flow; drop the
  now-redundant second confirm-dialog wiring (one `ImportTaskKind` to check against
  `GET /api/import-tasks/active`, not two).
- `docs/csv-schema.md`, `samples/`: one combined sample file replacing the two separate ones (this
  is the literal thing originally asked about — resolved as a consequence of this change, not a
  separate task).
- Every test file touching either of the two old pipelines needs updating to the combined shape —
  this is the largest mechanical footprint of Part G, comparable in size to Part A's own original
  test-update footprint.

---

## Execution Strategy

Recommend doing Part F (semantics) fully first, verified in isolation (solver determinism re-proven,
validator/buildProblem correctness re-proven), THEN Part G (combining the CSV pipelines) on top of
the already-correct new semantics — combining two pipelines that are simultaneously changing their
underlying meaning is a harder thing to verify in one pass than doing them sequentially, even though
they were requested together. Same worktree-per-task, parallel-subagent pattern as v4, once you
confirm the two open decisions above (grid display polarity, standalone-availability-upload fate).
