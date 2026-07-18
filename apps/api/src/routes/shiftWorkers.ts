import { Router } from 'express';
import { z } from 'zod';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ShiftWorkerService } from '../services/shiftWorkerService.js';
import { parseIdParam } from './params.js';

const addWorkerBodySchema = z.object({ workerId: z.number().int().positive() }).strict();
const moveWorkerBodySchema = z.object({ targetShiftId: z.number().int().positive() }).strict();

function isConfirmed(req: { query: unknown }): boolean {
  const query = req.query as Record<string, unknown>;
  return query.confirm === 'true';
}

/** Thin HTTP layer for `/api/shifts/:shiftId/workers` manual-edit endpoints. */
export function createShiftWorkersRouter(prisma: PrismaClient): Router {
  const router = Router();
  const shiftWorkerService = new ShiftWorkerService(prisma);

  router.post(
    '/:shiftId/workers',
    asyncHandler(async (req, res) => {
      const shiftId = parseIdParam(req.params.shiftId, 'Shift');
      const { workerId } = addWorkerBodySchema.parse(req.body);
      const result = await shiftWorkerService.addWorker(shiftId, workerId, isConfirmed(req));
      res.status(201).json(result);
    }),
  );

  router.post(
    '/:shiftId/workers/:workerId/move',
    asyncHandler(async (req, res) => {
      const shiftId = parseIdParam(req.params.shiftId, 'Shift');
      const workerId = parseIdParam(req.params.workerId, 'Worker');
      const { targetShiftId } = moveWorkerBodySchema.parse(req.body);
      const result = await shiftWorkerService.moveWorker(shiftId, workerId, targetShiftId, isConfirmed(req));
      res.status(200).json(result);
    }),
  );

  router.delete(
    '/:shiftId/workers/:workerId',
    asyncHandler(async (req, res) => {
      const shiftId = parseIdParam(req.params.shiftId, 'Shift');
      const workerId = parseIdParam(req.params.workerId, 'Worker');
      await shiftWorkerService.removeWorker(shiftId, workerId, isConfirmed(req));
      res.status(204).send();
    }),
  );

  return router;
}
