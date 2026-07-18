import { Router } from 'express';
import { z } from 'zod';
import { contractSchema, ROLES, WORKER_STATUSES, workerSchema } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { WorkerService } from '../services/workerService.js';
import { parseIdParam } from './params.js';

const listQuerySchema = z
  .object({
    status: z.enum(WORKER_STATUSES).optional(),
    role: z.enum(ROLES).optional(),
    companyId: z.coerce.number().int().positive().optional(),
    q: z.string().min(1).max(200).optional(),
  })
  .strict();

/** Thin HTTP layer for `/api/workers` (+ nested `/contract`). */
export function createWorkersRouter(prisma: PrismaClient): Router {
  const router = Router();
  const workerService = new WorkerService(prisma);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const filters = listQuerySchema.parse(req.query);
      const workers = await workerService.list(filters);
      res.status(200).json(workers);
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = workerSchema.parse(req.body);
      const worker = await workerService.create(input);
      res.status(201).json(worker);
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseIdParam(req.params.id, 'Worker');
      const worker = await workerService.getById(id);
      res.status(200).json(worker);
    }),
  );

  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseIdParam(req.params.id, 'Worker');
      const input = workerSchema.parse(req.body);
      const worker = await workerService.update(id, input);
      res.status(200).json(worker);
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseIdParam(req.params.id, 'Worker');
      await workerService.remove(id);
      res.status(204).send();
    }),
  );

  router.get(
    '/:id/contract',
    asyncHandler(async (req, res) => {
      const id = parseIdParam(req.params.id, 'Worker');
      const contract = await workerService.getContract(id);
      res.status(200).json(contract);
    }),
  );

  router.put(
    '/:id/contract',
    asyncHandler(async (req, res) => {
      const id = parseIdParam(req.params.id, 'Worker');
      const input = contractSchema.parse(req.body);
      const contract = await workerService.upsertContract(id, input);
      res.status(200).json(contract);
    }),
  );

  router.get(
    '/:id/share-link',
    asyncHandler(async (req, res) => {
      const id = parseIdParam(req.params.id, 'Worker');
      const link = await workerService.getShareLink(id);
      res.status(200).json(link);
    }),
  );

  router.post(
    '/:id/share-link/rotate',
    asyncHandler(async (req, res) => {
      const id = parseIdParam(req.params.id, 'Worker');
      const link = await workerService.rotateShareLink(id);
      res.status(200).json(link);
    }),
  );

  return router;
}
