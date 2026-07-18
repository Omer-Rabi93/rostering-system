import { Router } from 'express';
import type { PgBoss } from 'pg-boss';

import { asyncHandler } from '../middleware/asyncHandler.js';
import { NotFoundError } from '../errors.js';
import { ensureBossStarted, QUEUES } from '../jobs/queue.js';
import { parseStringParam } from './params.js';

/** pg-boss's own state machine has more values (`retry`, `cancelled`) than the design doc's
 * simplified 4-state polling shape (`created`|`active`|`completed`|`failed`) -- collapse them:
 * a job still being retried reads as still "active" to a polling client, and a cancelled job
 * reads as "failed" (a client polling to a terminal state has no separate UI for "cancelled"). */
function toPollState(state: string): 'created' | 'active' | 'completed' | 'failed' {
  if (state === 'retry') return 'active';
  if (state === 'cancelled') return 'failed';
  return state as 'created' | 'active' | 'completed' | 'failed';
}

/** Thin HTTP layer for `GET /api/jobs/:id`. pg-boss 12 requires the queue name to look up a job
 * (each queue owns its own partition of the job table) and job ids are unique across queues, so
 * this tries each of the app's two known queues in turn. */
export function createJobsRouter(boss: PgBoss): Router {
  const router = Router();

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseStringParam(req.params.id, 'Job');
      await ensureBossStarted(boss);

      for (const name of Object.values(QUEUES)) {
        const [job] = await boss.findJobs(name, { id });
        if (job) {
          res.status(200).json({
            id: job.id,
            name,
            state: toPollState(job.state),
            createdAt: job.createdOn.toISOString(),
            completedAt: job.completedOn ? job.completedOn.toISOString() : null,
            result: job.state === 'completed' || job.state === 'failed' ? (job.output ?? null) : null,
          });
          return;
        }
      }

      throw new NotFoundError(`Job ${id} not found`);
    }),
  );

  return router;
}
