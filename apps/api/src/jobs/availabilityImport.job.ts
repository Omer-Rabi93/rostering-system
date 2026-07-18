// pg-boss `availability-import` job handler -- a thin wrapper around `AvailabilityService`'s CSV
// import logic (pg-boss-free business logic, directly testable). Registered by `worker.ts` via
// `registerAvailabilityImportWorker`. Never logs the raw CSV text or job data -- if this handler
// throws, pg-boss records the thrown error's message as the job's failure output; the message
// itself must never embed the CSV body (it doesn't -- `AvailabilityService.importCsv` only ever
// throws framing errors describing header/shape, not row content).

import type { AvailabilityImportResult } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import { AvailabilityService } from '../services/availabilityService.js';
import type { AvailabilityImportJobData } from './queue.js';

export function createAvailabilityImportHandler(
  prisma: PrismaClient,
): (data: AvailabilityImportJobData) => Promise<AvailabilityImportResult> {
  const service = new AvailabilityService(prisma);
  return (data) => service.importCsv(data.csv, data.month);
}
