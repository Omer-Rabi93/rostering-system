// pg-boss `availability-import` job handler -- a thin wrapper around `AvailabilityService`'s CSV
// import logic (pg-boss-free business logic, directly testable). Registered by `worker.ts` via
// `registerAvailabilityImportWorker`. Never logs the raw CSV text or job data -- if this handler
// throws, pg-boss records the thrown error's message as the job's failure output; the message
// itself must never embed the CSV body (it doesn't -- `AvailabilityService.importCsv` only ever
// throws framing errors describing header/shape, not row content).
//
// v4: `AvailabilityService` now needs `boss` (cancel-and-replace's `boss.cancel()` step) and this
// run's own pg-boss job id (to adopt the specific `ImportTask` row the route's `beginImportTask`
// created for this exact upload, via `pgBossJobId` -- see `services/availabilityService.ts`'s doc
// comment) -- `registerAvailabilityImportWorker` (`jobs/queue.ts`) now passes the job id through as
// this handler's second argument for exactly that reason.

import type { AvailabilityImportResult } from '@rostering/shared';
import type { PgBoss } from 'pg-boss';

import type { PrismaClient } from '../db/client.js';
import { AvailabilityService } from '../services/availabilityService.js';
import type { AvailabilityImportJobData } from './queue.js';

export function createAvailabilityImportHandler(
  prisma: PrismaClient,
  boss: PgBoss,
): (data: AvailabilityImportJobData, jobId: string) => Promise<AvailabilityImportResult> {
  const service = new AvailabilityService(prisma, boss);
  return (data, jobId) => service.importCsv(data.csv, data.month, data.companyId, jobId);
}
