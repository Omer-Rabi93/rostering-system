import { companyIdQuerySchema } from './companyIdSchema.js';
import { Router } from 'express';
import { staffingRequirementsInputSchema } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { StaffingRequirementService } from '../services/staffingRequirementService.js';

/** Thin HTTP layer for `/api/staffing-requirements`. Every route is scoped to one company's own
 * requirements matrix via a required `companyId` query param -- each company has its own
 * independent role x shift matrix, never a shared/global one. */
export function createStaffingRequirementsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = new StaffingRequirementService(prisma);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { companyId } = companyIdQuerySchema.parse(req.query);
      const rows = await service.list(companyId);
      res.status(200).json(rows);
    }),
  );

  router.put(
    '/',
    asyncHandler(async (req, res) => {
      const { companyId } = companyIdQuerySchema.parse(req.query);
      const input = staffingRequirementsInputSchema.parse(req.body);
      const rows = await service.replaceAll(companyId, input);
      res.status(200).json(rows);
    }),
  );

  return router;
}
