# Worker CSV Schema

`POST /api/import/workers` and `GET /api/export/workers` speak the same 8-column CSV format, so an
exported file is always re-importable unmodified. Implemented in `apps/api/src/csv/`.

Availability v2: worker availability is **not** part of this CSV at all. It is date-specific — one
`WorkerAvailability` row per `(worker, calendar date)` — entered/exported via a separate
month-scoped CSV (`POST /api/import/availability/:month`, `GET /api/export/availability/:month`;
see [Availability CSV Schema](#availability-csv-schema) below). This worker CSV previously carried
10 `avail_*` day/shift columns (18 total); Phase V4 of the Availability v2 migration removed them
entirely.

## Header (exact order and names)

```
national_id,name,company_name,role,status,hourly_cost_ils,min_monthly_hours,max_monthly_hours
```

Import rejects a file whose header row does not match this exactly (same 8 columns, same order,
same names) and rejects any data row with more or fewer fields than the header.

## Columns

| Column | Type / allowed values | Notes |
| --- | --- | --- |
| `national_id` | 9 digits, checksum-valid (Israeli ID) | The upsert match key. |
| `name` | non-empty string, ≤ 120 chars | |
| `company_name` | non-empty string, ≤ 120 chars | Resolved to an existing company case-insensitively, or a new company is created. Export always writes the company's current name. |
| `role` | `General Guard` \| `Supervisor` \| `Screener` | Display strings; map to the internal `GENERAL_GUARD`/`SUPERVISOR`/`SCREENER` enum. |
| `status` | `Active` \| `Inactive` | Display strings; map to `ACTIVE`/`INACTIVE`. |
| `hourly_cost_ils` | decimal ≥ 0, dot separator (e.g. `62.50`) | |
| `min_monthly_hours`, `max_monthly_hours` | integers, `0 ≤ min ≤ max` | |

## Full-sync semantics

Each row is validated in full (Zod schema + Israeli-ID checksum) and processed in its own
transaction, so one bad row rolls back only itself and the batch continues to the next row.
`company_name` is resolved to an existing company (case-insensitively) or a new one is created;
then, if `national_id` matches an existing worker, that worker and their contract are updated —
otherwise both are created.

**After every row has been processed**, a sync sweep sets every existing `ACTIVE` worker whose
`national_id` does not appear anywhere in the file to `INACTIVE`. The CSV is treated as the
authoritative current workforce list. Deactivation is a status update only — it never deletes a
worker, and their contract, share-link token, and shift history are all kept untouched. A worker
whose row **is present but failed validation** is **not** deactivated (their `national_id` cell
still shields them from the sweep even though the rest of that row was rejected).

## Formula-injection guard

Any cell whose value starts with `=`, `+`, `-`, `@`, a tab, or a carriage return is prefixed with a
single `'` on export (the standard spreadsheet "force text" convention), which neutralizes it as a
formula in Excel/Sheets/LibreOffice. Import strips that guard prefix back off, so the round-trip
property (`export -> import` reproduces the original worker+contract record) holds even for a name
like `=SUM(A1)`.

## Import result

```ts
type ImportResult = {
  totalRows: number;
  inserted: number;
  updated: number;
  failed: number;
  deactivated: number; // sync sweep: workers absent from the file
  deactivatedWorkers: Array<{ workerId: number; nationalId: string; name: string }>;
  errors: Array<{ row: number; nationalId?: string; field?: string; message: string }>; // row is 1-based
};
```

## Sample file

See [`samples/workers-sample.csv`](../samples/workers-sample.csv) — 12 workers matching the
structure of `apps/api/src/db/seedData.ts`, safe to re-import unmodified.

---

# Availability CSV Schema

`POST /api/import/availability/:month` and `GET /api/export/availability/:month` speak a
month-scoped CSV format (Availability v2): `national_id` plus one column per calendar date of the
target month (`d01` … `d28`/`d29`/`d30`/`d31`, count depends on the month). Implemented in
`apps/api/src/csv/availability.ts`.

## Header (exact order and names, computed per month)

```
national_id,d01,d02,...,dNN
```

`NN` runs from `01` to the target month's real day count (28, 29, 30, or 31 — leap Februaries
included). Import rejects a file whose header does not exactly match the `:month` path
parameter's day count and column order — importing, say, a 31-day month's export into a 30-day
target month is rejected with a 400 before anything is enqueued.

## Cell values

Each `dNN` cell is either:

- **empty** — the worker has no `WorkerAvailability` entry for that date (unavailable that date), or
- a **canonical shift-subset string**: one or more of the letters `A`, `B`, `C` (shift order
  00:00–08:00 / 08:00–16:00 / 16:00–24:00), always in `A` < `B` < `C` order with no duplicates —
  `A`, `B`, `C`, `AB`, `AC`, `BC`, `ABC`. Any other value (unknown letter, duplicate letter,
  out-of-order letters, e.g. `AD` or `AA` or `BA`) is rejected for that row.

## Import semantics

Each **row** (one worker) is validated and applied in its own transaction: an unknown
`national_id` or any illegal cell fails that row as a whole (reported with its 1-based row number
and, for a cell error, the offending `dNN` column) without aborting the rest of the batch. A row
that applies cleanly **replaces** that worker's `WorkerAvailability` rows for every date in the
target month with exactly what the file's row specifies (an empty cell deletes/omits that date's
row).

**There is no full-sync deactivation sweep here** — that is worker-CSV-only semantics. A worker
whose `national_id` does not appear anywhere in the file simply keeps whatever `WorkerAvailability`
rows they already have; no worker is ever deactivated by an availability import.

## Formula-injection guard

Every cell (`national_id` and every `dNN` cell alike) is guarded/unguarded through the exact same
mechanism as the worker CSV — see above. This is applied uniformly regardless of a column's
expected shape, as defense in depth.

## Import result

```ts
type AvailabilityImportResult = {
  totalRows: number;
  applied: number; // rows successfully replaced
  failed: number;
  errors: Array<{ row: number; nationalId?: string; field?: string; message: string }>; // row is 1-based
};
```

## Body/row limits

Import is capped at `MAX_ROWS = 10_000` rows (one row = one worker) before the file is even
enqueued, mirroring the worker CSV's own cap. The bulk JSON endpoints (`GET`/`PUT
/api/availability/:month`) additionally cap the total number of `(workerId, date)` entries at
`MAX_AVAILABILITY_ENTRIES = 20,000` and use a route-scoped 2 MB JSON body limit (see the
Availability v2 plan's body-size note) instead of the app-wide 100 KB default.
