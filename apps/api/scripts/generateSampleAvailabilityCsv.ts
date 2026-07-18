// One-off script (not part of the build) that renders the Phase 3 seed fixture's Availability v3
// rows (`src/db/seedData.ts#buildSeedAvailabilityRows`, the exact same source `prisma/seed.ts`
// used to populate the live dev database) through the real availability CSV module, so
// `samples/availability-sample-<month>.csv` is guaranteed structurally correct, re-importable,
// and consistent with whatever `national_id`/date data the seeded database actually has. Mirrors
// `generateSampleCsv.ts`'s pattern for the worker CSV. Run with:
//   npx tsx scripts/generateSampleAvailabilityCsv.ts > ../../samples/availability-sample-<month>.csv
import type { ShiftType } from '@rostering/shared';
import { SEED_WORKERS, buildSeedAvailabilityRows, nextCalendarMonth } from '../src/db/seedData.js';
import { serializeAvailabilityCsv, type AvailabilityCsvExportRow } from '../src/csv/availability.js';

const month = nextCalendarMonth();

const records: AvailabilityCsvExportRow[] = SEED_WORKERS.map((w) => ({
  nationalId: w.nationalId,
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

process.stderr.write(`Generating availability sample CSV for month ${month}\n`);
process.stdout.write(serializeAvailabilityCsv(records, month));
