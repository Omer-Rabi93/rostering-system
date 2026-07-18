import { Router } from 'express';
import { z } from 'zod';
import { monthSchema } from '@rostering/shared';
import type { PgBoss } from 'pg-boss';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ConflictError } from '../errors.js';
import { enqueueRosterGeneration } from '../jobs/queue.js';
import { CostSummaryService } from '../services/costSummaryService.js';
import { RosterService } from '../services/rosterService.js';
import { parseIdParam, parseStringParam } from './params.js';

const generateRosterBodySchema = z
  .object({
    companyId: z.number().int().positive(),
    month: monthSchema,
    force: z.boolean().optional(),
  })
  .strict();

const companyIdQuerySchema = z.object({ companyId: z.coerce.number().int().positive() }).strict();

/** Thin HTTP layer for `/api/rosters`. */
export function createRostersRouter(prisma: PrismaClient, boss: PgBoss): Router {
  const router = Router();
  const rosterService = new RosterService(prisma);
  const costSummaryService = new CostSummaryService(prisma);

  // Mounted before the `/:month` catch-all so the literal path `/generate` is never swallowed by
  // the `:month` param route.
  router.post(
    '/generate',
    asyncHandler(async (req, res) => {
      const { companyId, month, force } = generateRosterBodySchema.parse(req.body);

      const existingRoster = await prisma.roster.findUnique({ where: { companyId_month: { companyId, month } } });
      if (existingRoster?.status === 'PUBLISHED' && !force) {
        throw new ConflictError(
          `Roster for ${month} is already published; pass { "force": true } to regenerate it as a draft`,
          'already-published',
        );
      }

      const jobId = await enqueueRosterGeneration(boss, companyId, month, { force });
      if (!jobId) {
        throw new ConflictError(`A roster-generation job for ${month} is already in flight`, 'generation-in-progress');
      }
      res.status(202).json({ jobId });
    }),
  );

  router.get(
    '/:month',
    asyncHandler(async (req, res) => {
      const month = parseStringParam(req.params.month, 'Roster');
      const { companyId } = companyIdQuerySchema.parse(req.query);
      const roster = await rosterService.getByMonth(companyId, month);
      res.status(200).json(roster);
    }),
  );

  router.get(
    '/:month/cost-summary',
    asyncHandler(async (req, res) => {
      const month = parseStringParam(req.params.month, 'Roster');
      const { companyId } = companyIdQuerySchema.parse(req.query);
      const summary = await costSummaryService.getByMonth(companyId, month);
      res.status(200).json(summary);
    }),
  );

  router.post(
    '/:id/alerts/:alertId/ack',
    asyncHandler(async (req, res) => {
      const rosterId = parseIdParam(req.params.id, 'Roster');
      const alertId = parseIdParam(req.params.alertId, 'Alert');
      const alert = await rosterService.ackAlert(rosterId, alertId);
      res.status(200).json(alert);
    }),
  );

  router.post(
    '/:id/publish',
    asyncHandler(async (req, res) => {
      const rosterId = parseIdParam(req.params.id, 'Roster');
      const result = await rosterService.publish(rosterId);
      res.status(200).json(result);
    }),
  );

  return router;
}
