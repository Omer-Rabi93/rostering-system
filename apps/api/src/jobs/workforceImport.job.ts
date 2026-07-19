// pg-boss `workforce-import` job handler -- a thin wrapper around `WorkforceImportService`, the
// pg-boss-free business logic (`tests/services/workforceImportService.test.ts` covers it
// directly). Registered by `worker.ts` via `registerWorkforceImportWorker`. Supersedes
// `csvImport.job.ts`/`availabilityImport.job.ts` (Part G merge).
//
// `WorkforceImportService` needs `boss` (cancel-and-replace's `boss.cancel()` step) and this run's
// own pg-boss job id (to adopt the specific `ImportTask` row the route's `beginImportTask` created
// for this exact upload, via `pgBossJobId` -- see `services/workforceImportService.ts`'s doc
// comment) -- `registerWorkforceImportWorker` (`jobs/queue.ts`) passes the job id through as this
// handler's second argument for exactly that reason.

import type { ImportResult } from '@rostering/shared';
import type { PgBoss } from 'pg-boss';

import type { PrismaClient } from '../db/client.js';
import { WorkforceImportService } from '../services/workforceImportService.js';
import type { WorkforceImportJobData } from './queue.js';

export function createWorkforceImportHandler(
  prisma: PrismaClient,
  boss: PgBoss,
): (data: WorkforceImportJobData, jobId: string) => Promise<ImportResult> {
  const service = new WorkforceImportService(prisma, boss);
  return (data, jobId) => service.importCsv(data.csv, data.month, data.companyId, jobId);
}
