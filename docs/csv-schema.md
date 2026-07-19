# Workforce CSV Schema

`POST /api/import/workforce/:month` and `GET /api/export/workforce/:month` speak the same
combined, month-scoped CSV format, so an exported file is always re-importable unmodified.
Implemented in `apps/api/src/csv/` (`columns.ts`/`record.ts`/`workforce.ts` for the worker half,
`availability.ts` for the day-cell primitives).

One row = one worker's full field set (identity + contract) **and** that worker's excluded-shifts
for every calendar day of the target month, both applied as one atomic outcome per row — see
[Row atomicity](#row-atomicity) below. This supersedes two CSVs that used to exist independently (a
worker-only CSV and a separate month-scoped availability-only CSV); they merged into one combined
upload — see the `availability-v3-exclusion-and-combined-csv` design doc, Part G.

The upload is scoped to one company at upload time (the app's "active company"), not resolved
per-row — so the CSV itself carries no company column.

## Header (exact order and names, computed per month)

```
national_id,name,role,status,hourly_cost_ils,min_monthly_hours,max_monthly_hours,d01,d02,...,dNN
```

The first 7 columns are fixed; `d01`…`dNN` runs from `01` to the target month's real day count (28,
29, 30, or 31 — leap Februaries included). Import rejects a file whose header does not exactly
match this shape for the `:month` path parameter (wrong day count, wrong order, wrong names, extra
or missing worker columns) and rejects any data row with more or fewer fields than the header.

## Worker columns

| Column | Type / allowed values | Notes |
| --- | --- | --- |
| `national_id` | 9 digits, checksum-valid (Israeli ID) | The upsert match key. |
| `name` | non-empty string, ≤ 120 chars | |
| `role` | `General Guard` \| `Supervisor` \| `Screener` | Display strings; map to the internal `GENERAL_GUARD`/`SUPERVISOR`/`SCREENER` enum. |
| `status` | `Active` \| `Inactive` | Display strings; map to `ACTIVE`/`INACTIVE`. |
| `hourly_cost_ils` | decimal ≥ 0, dot separator (e.g. `62.50`) | |
| `min_monthly_hours`, `max_monthly_hours` | integers, `0 ≤ min ≤ max` | |

## Day columns (`dNN`) — cell values

Each `dNN` cell names the shifts the worker is **excluded from** (cannot work) on that date — it is
NOT a list of shifts they can work (Availability v3 — exclusion semantics). A `dNN` cell is either:

- **empty** — no exclusions: the worker is available for every shift that date, or
- a **canonical shift-subset string**: one or more of the letters `A`, `B`, `C` (shift order
  00:00–08:00 / 08:00–16:00 / 16:00–24:00), always in `A` < `B` < `C` order with no duplicates —
  `A`, `B`, `C`, `AB`, `AC`, `BC`, `ABC`, naming the excluded shift(s). Any other value (unknown
  letter, duplicate letter, out-of-order letters, e.g. `AD` or `AA` or `BA`) is rejected for that
  row.

For example, `d05 = "AB"` means the worker is excluded from (cannot work) the `A` and `B` shifts on
that date but IS available for the `C` shift; `d06 = "ABC"` means the worker is excluded from all
three shifts, i.e. fully unavailable that date; `d07 = ""` (empty) means no exclusions at all, i.e.
available for `A`, `B`, and `C` that date.

## Row atomicity

Each **row** (one worker) is validated in full — worker fields first, then day cells, matching
column order — and applied in one transaction: a bad worker field (e.g. unknown role) OR any
illegal `dNN` cell fails the **entire row**, including the worker upsert. Neither half is applied
partially: a row with a bad availability cell does not upsert the worker either, and a row with a
bad worker field never touches that worker's availability. This is new relative to the two prior
independent CSVs, where a worker-field error and an availability-cell error were unrelated failures
in unrelated uploads.

A row that validates cleanly:

- upserts the worker + contract by `national_id` (creates both if unknown, updates both if the
  `national_id` already belongs to a worker in this upload's company; a `national_id` that already
  belongs to a **different** company fails the row with a `national_id` field error, never a silent
  reassignment), and
- **replaces** that same worker's `WorkerAvailability` rows for every date in the target month with
  exactly what the row's `dNN` cells specify (an empty cell deletes/omits that date's row).

## Full-sync eligibility (not a deactivation sweep)

There is **no deactivation sweep**: a worker whose `national_id` does not appear anywhere in the
file simply keeps their current `status` and whatever `WorkerAvailability` rows they already have —
nothing is ever deleted or flipped to `Inactive` by an import. Instead, each completed import stamps
`lastImportTaskId` on every worker its rows touched; a company's next roster generation only
considers `ACTIVE` workers who either have never been placed under CSV-sync management
(`lastImportTaskId` is `null` — always eligible) or whose `lastImportTaskId` matches the company's
**most recent COMPLETED** import (a worker dropped from the latest file stays `Active` but becomes
unschedulable until they reappear in a completed sync).

## Formula-injection guard

Any cell (worker column or `dNN` column alike) whose value starts with `=`, `+`, `-`, `@`, a tab, or
a carriage return is prefixed with a single `'` on export (the standard spreadsheet "force text"
convention), which neutralizes it as a formula in Excel/Sheets/LibreOffice. Import strips that guard
prefix back off, so the round-trip property (`export -> import` reproduces the original record)
holds even for a name like `=SUM(A1)`. Applied uniformly regardless of a column's expected shape, as
defense in depth.

## Import result

```ts
type ImportResult = {
  totalRows: number;
  inserted: number; // rows whose worker was newly created
  updated: number; // rows whose worker already existed
  failed: number;
  errors: Array<{ row: number; nationalId?: string; field?: string; message: string }>; // row is 1-based
};
```

## Body/row limits

Import is capped at 10,000 rows (one row = one worker) before the file is even enqueued. The
manual/grid `PUT /api/availability/:month` endpoint (unrelated to this CSV — see below) separately
caps the total number of `(workerId, date)` entries at 20,000 and uses a route-scoped 2 MB JSON body
limit instead of the app-wide 100 KB default.

## The manual/grid availability path is separate

`GET`/`PUT /api/availability/:month` (the planner's month-by-month availability grid,
`AvailabilityGrid.tsx`) is a distinct, unrelated JSON API — full-month replace via a date-keyed JSON
payload, not a CSV upload. It is untouched by anything above: editing the grid never goes through
CSV framing, row atomicity, or the `ImportTask`/queue machinery this document describes.

## Sample file

See [`samples/workforce-sample-2026-08.csv`](../samples/workforce-sample-2026-08.csv) — 12 workers
matching the structure of `apps/api/src/db/seedData.ts`, safe to re-import unmodified. Regenerate
with `npx tsx apps/api/scripts/generateSampleWorkforceCsv.ts > samples/workforce-sample-<month>.csv`.
