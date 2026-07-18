// pg-boss `roster-generation` job handler -- a thin wrapper around `RosterGenerationService`, the
// pg-boss-free business logic (`tests/services/rosterGenerationService.test.ts` covers it
// directly, including the idempotent-retry proof). Registered by `worker.ts` via
// `registerRosterGenerationWorker`.

import type { RosterGenerationResult } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import { RosterGenerationService } from '../services/rosterGenerationService.js';
import type { RosterGenerationJobData } from './queue.js';

export function createRosterGenerationHandler(
  prisma: PrismaClient,
): (data: RosterGenerationJobData) => Promise<RosterGenerationResult> {
  const service = new RosterGenerationService(prisma);
  // `data.force` was only ever a route-layer gating signal (whether to allow reopening an
  // already-published month) -- by the time the job runs that decision has already been made, so
  // the handler unconditionally regenerates the requested month's draft.
  return (data) => service.generate(data.month);
}
