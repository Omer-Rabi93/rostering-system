// One-off script (not part of the build) that renders the Phase 3 seed fixture
// (`src/db/seedData.ts`) through the real CSV module, so `samples/workers-sample.csv` is
// guaranteed to be structurally correct and re-importable. Run with:
//   npx tsx scripts/generateSampleCsv.ts > ../../samples/workers-sample.csv
import { SEED_WORKERS } from '../src/db/seedData.js';
import { serializeWorkersCsv, type CsvWorkerRecord } from '../src/csv/index.js';

const records: CsvWorkerRecord[] = SEED_WORKERS.map((w) => ({
  nationalId: w.nationalId,
  name: w.name,
  role: w.role,
  status: w.status,
  hourlyCostIls: w.hourlyCostIls,
  minMonthlyHours: w.minMonthlyHours,
  maxMonthlyHours: w.maxMonthlyHours,
}));

process.stdout.write(serializeWorkersCsv(records));
