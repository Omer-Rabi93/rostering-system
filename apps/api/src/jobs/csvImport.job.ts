// pg-boss `csv-import` job handler -- a thin wrapper around `CsvImportService`, the pg-boss-free
// business logic (`tests/services/csvImportService.test.ts` covers it directly). Registered by
// `worker.ts` via `registerCsvImportWorker`.
//
// v4: `CsvImportService` now needs `boss` (cancel-and-replace's `boss.cancel()` step) and this
// run's own pg-boss job id (to adopt the specific `ImportTask` row the route's `beginImportTask`
// created for this exact upload, via `pgBossJobId` -- see `services/csvImportService.ts`'s doc
// comment) -- `registerCsvImportWorker` (`jobs/queue.ts`) passes the job id through as this
// handler's second argument for exactly that reason.

import type { ImportResult } from '@rostering/shared';
import type { PgBoss } from 'pg-boss';

import type { PrismaClient } from '../db/client.js';
import { CsvImportService } from '../services/csvImportService.js';
import type { CsvImportJobData } from './queue.js';

export function createCsvImportHandler(
  prisma: PrismaClient,
  boss: PgBoss,
): (data: CsvImportJobData, jobId: string) => Promise<ImportResult> {
  const service = new CsvImportService(prisma, boss);
  return (data, jobId) => service.importCsv(data.csv, data.companyId, jobId);
}
