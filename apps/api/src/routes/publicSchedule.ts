import { Router } from 'express';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { PublicScheduleService } from '../services/publicScheduleService.js';
import { parseStringParam } from './params.js';

/** `GET /api/schedule/:token?month=YYYY-MM` — public, unauthenticated, rate-limited at the app
 * level. Mounted under `/api` (see `app.ts`) so it no longer shares a literal path with the SPA's
 * own `/schedule/:token` client-side route (React Router) — that collision meant nginx's
 * top-level document navigation for a worker's bookmarked link was indistinguishable from this
 * route's own data fetch and always won, returning raw JSON instead of the SPA shell. */
export function createPublicScheduleRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = new PublicScheduleService(prisma);

  router.get(
    '/:token',
    asyncHandler(async (req, res) => {
      const token = parseStringParam(req.params.token, 'Schedule');
      const monthRaw = req.query.month;
      const month = typeof monthRaw === 'string' ? monthRaw : undefined;
      const schedule = await service.getSchedule(token, month);
      res.status(200).json(schedule);
    }),
  );

  return router;
}
