import express, { Router } from 'express';
import { monthAvailabilitySchema, monthSchema } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { companyIdQuerySchema } from './companyIdSchema.js';
import { AvailabilityService } from '../services/availabilityService.js';

/**
 * v4: the bulk `PUT` gains a required `companyId` -- see the v4 design doc, Part A's "Same-company
 * nationalId matching, cross-company conflict as an error" section. `PUT`'s own JSON body is
 * already fully occupied by the `MonthAvailability` payload itself (a date-keyed record,
 * `monthAvailabilitySchema`), so `companyId` travels as a query param here -- the same convention
 * every company-scoped route shares (`routes/companyIdSchema.ts`).
 */

/**
 * Body-size decision (Availability v2 plan; raised for the 1,000-10,000-worker-per-company scale
 * target): the app-wide `express.json({ limit: '100kb' })` in `app.ts` is too small for a dense
 * month's `PUT` payload (~1 KB/worker x 31 dates breaks the default cap around 95-100
 * fully-available workers -- this app's ORIGINAL 50-150-worker stated org size). This router is
 * mounted in `app.ts` BEFORE the app-wide json() call, and this PUT route applies its OWN, wider
 * json() middleware first -- so this is the only body parser that ever touches this one route.
 * Every other `/api` route is untouched: a request that does not match one of this router's routes
 * falls through unchanged to the app-wide 100kb parser mounted after this router.
 *
 * Sized against a REAL measurement, not a round-number guess: `{[workerId]: {[date]:
 * ShiftSubset]}}` (this route's exact wire shape, `monthAvailabilitySchema`) serialized for the
 * absolute worst case -- 10,000 workers x 31 dates (this system's stated ceiling x the longest
 * possible calendar month) x a full 3-element `["A","B","C"]` shift-subset array in every entry
 * (the largest a single entry can be) -- measures to ~8.07 MB (`JSON.stringify` output, no
 * whitespace). 12 MB gives ~49% headroom above that measured worst case, covering request-encoding
 * variance (larger workerId key strings past 10,000, client-side JSON formatting differences)
 * without leaving the cap so generous it stops being a meaningful DoS bound. Must stay `<=`
 * `infra/nginx.conf`'s `client_max_body_size`, or nginx rejects a large-but-legal request before it
 * ever reaches this limit.
 */
const AVAILABILITY_JSON_BODY_LIMIT = '12mb';

/** Thin HTTP layer for the manual/grid availability path only: `GET`/`PUT /api/availability/:month`
 * (bulk JSON, `AvailabilityGrid.tsx`'s data source). The month-scoped availability CSV
 * import/export that used to live here merged into the combined workforce-CSV pipeline
 * (`routes/workforce.ts`) -- see the Part G design doc. This grid path is deliberately untouched by
 * that merge. */
export function createAvailabilityRouter(prisma: PrismaClient): Router {
  const router = Router();
  const availabilityService = new AvailabilityService(prisma);

  router.get(
    '/availability/:month',
    asyncHandler(async (req, res) => {
      const month = monthSchema.parse(req.params.month);
      const { companyId } = companyIdQuerySchema.parse(req.query);
      const availability = await availabilityService.getMonth(month, companyId);
      res.status(200).json(availability);
    }),
  );

  router.put(
    '/availability/:month',
    express.json({ limit: AVAILABILITY_JSON_BODY_LIMIT }),
    asyncHandler(async (req, res) => {
      const month = monthSchema.parse(req.params.month);
      const { companyId } = companyIdQuerySchema.parse(req.query);
      const payload = monthAvailabilitySchema(month).parse(req.body);
      await availabilityService.replaceMonth(month, payload, companyId);
      res.status(200).json({ month });
    }),
  );

  return router;
}
