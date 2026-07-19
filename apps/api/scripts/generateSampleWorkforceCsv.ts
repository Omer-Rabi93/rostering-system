// One-off script (not part of the build) that renders the Phase 3 seed fixture
// (`src/db/seedData.ts`) -- worker identity/contract fields AND its Availability v3 rows
// (`buildSeedAvailabilityRows`, the exact same source `prisma/seed.ts` used to populate the live
// dev database) -- through the real combined workforce CSV module, so
// `samples/workforce-sample-<month>.csv` is guaranteed structurally correct and re-importable.
// Supersedes `generateSampleCsv.ts` (worker-only) and `generateSampleAvailabilityCsv.ts`
// (availability-only) -- see the Part G design doc. Run with:
//   npx tsx scripts/generateSampleWorkforceCsv.ts > ../../samples/workforce-sample-<month>.csv
import type { ShiftType } from '@rostering/shared';
import { SEED_WORKERS, buildSeedAvailabilityRows, nextCalendarMonth } from '../src/db/seedData.js';
import { serializeWorkforceCsv, type WorkforceCsvExportRow } from '../src/csv/workforce.js';

const month = nextCalendarMonth();

const records: WorkforceCsvExportRow[] = SEED_WORKERS.map((w) => ({
  record: {
    nationalId: w.nationalId,
    name: w.name,
    role: w.role,
    status: w.status,
    hourlyCostIls: w.hourlyCostIls,
    minMonthlyHours: w.minMonthlyHours,
    maxMonthlyHours: w.maxMonthlyHours,
  },
  // `buildSeedAvailabilityRows` returns the canonical EXCLUDED shift-subset as a joined string
  // (e.g. "C"); split it back into the `ShiftType[]` the CSV serializer's entry shape expects --
  // the CSV cell's letters ARE the excluded shifts directly (Availability v3: no inversion at this
  // boundary). Already in canonical `A`<`B`<`C` order with no duplicates by construction
  // (`excludedShiftSubsetForFixture`), so this is a plain split, not a re-validation.
  entries: buildSeedAvailabilityRows(w, month).map((row) => ({
    date: row.date,
    shifts: row.excludedShifts.split('') as ShiftType[],
  })),
}));

process.stderr.write(`Generating combined workforce sample CSV for month ${month}\n`);
process.stdout.write(serializeWorkforceCsv(records, month));
