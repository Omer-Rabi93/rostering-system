// pg-boss `csv-import` job handler -- a thin wrapper around `CsvImportService`, the pg-boss-free
// business logic (`tests/services/csvImportService.test.ts` covers it directly). Registered by
// `worker.ts` via `registerCsvImportWorker`.

import type { ImportResult } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import { CsvImportService } from '../services/csvImportService.js';
import type { CsvImportJobData } from './queue.js';

export function createCsvImportHandler(
  prisma: PrismaClient,
): (data: CsvImportJobData) => Promise<ImportResult> {
  const service = new CsvImportService(prisma);
  return (data) => service.importCsv(data.csv);
}
