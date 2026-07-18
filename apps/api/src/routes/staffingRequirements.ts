import { Router } from 'express';
import { staffingRequirementsInputSchema } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { StaffingRequirementService } from '../services/staffingRequirementService.js';

/** Thin HTTP layer for `/api/staffing-requirements`. */
export function createStaffingRequirementsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = new StaffingRequirementService(prisma);

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const rows = await service.list();
      res.status(200).json(rows);
    }),
  );

  router.put(
    '/',
    asyncHandler(async (req, res) => {
      const input = staffingRequirementsInputSchema.parse(req.body);
      const rows = await service.replaceAll(input);
      res.status(200).json(rows);
    }),
  );

  return router;
}
