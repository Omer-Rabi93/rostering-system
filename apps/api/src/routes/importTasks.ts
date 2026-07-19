import { Router } from 'express';
import { z } from 'zod';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

/**
 * v4: small, generically-shaped endpoint (kept as an enum rather than a bare literal, so the
 * query shape stays forward-compatible if a second `ImportTaskKind` is ever reintroduced -- see
 * the v4 design doc, Part A's "New `ImportTask` entity") backing the frontend's pre-upload confirm
 * UX: the combined workforce-CSV panel calls this right before opening the file picker, and if a
 * task is already in-flight for that company, show a confirm dialog before actually submitting --
 * the backend's cancel-and-replace logic is still the real correctness guarantee regardless of
 * whether the dialog was shown (this is a UX nicety, not a substitute for it).
 */
const activeTaskQuerySchema = z.object({
  companyId: z.coerce.number().int().positive(),
  kind: z.enum(['WORKFORCE_SYNC']),
});

/** Thin HTTP layer for `/api/import-tasks`. */
export function createImportTasksRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    '/active',
    asyncHandler(async (req, res) => {
      const { companyId, kind } = activeTaskQuerySchema.parse(req.query);

      const task = await prisma.importTask.findFirst({
        where: { companyId, kind, status: { in: ['PENDING', 'PROCESSING'] } },
        orderBy: { createdAt: 'desc' },
      });

      // 200 either way -- "no task in flight" is a normal, expected response shape, not a 404.
      res.status(200).json(task);
    }),
  );

  return router;
}
