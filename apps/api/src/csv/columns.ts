// The 7-column worker CSV schema. Both import and export use this exact column list, so an
// exported file is always re-importable unmodified.
//
// Availability v2: worker availability is date-specific (`WorkerAvailability`, one row per
// `(worker, calendar date)`), entered via the separate month-scoped availability CSV
// (`csv/availability.ts`), NOT via this worker-identity/contract CSV. This file previously carried
// 10 `avail_*` day/shift columns (18 total) inherited from the pre-Availability-v2 weekly-pattern
// model; Phase V4 drops them entirely (18 -> 8 columns).
//
// `company_name` was removed in the per-company-import-queues work: a worker-CSV upload is now
// scoped to one company at upload time (the app's "active company"), rather than resolving/creating
// a company per row (8 -> 7 columns).

export const CSV_COLUMNS = [
  'national_id',
  'name',
  'role',
  'status',
  'hourly_cost_ils',
  'min_monthly_hours',
  'max_monthly_hours',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

export type CsvRawRow = Record<CsvColumn, string>;
