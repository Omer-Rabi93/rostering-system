import express, { Router } from 'express';
import type { PgBoss } from 'pg-boss';
import { monthAvailabilitySchema, monthSchema } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { BadRequestError } from '../errors.js';
import { AvailabilityService } from '../services/availabilityService.js';
import { AvailabilityCsvHeaderError, AvailabilityCsvRowShapeError, parseAvailabilityCsv } from '../csv/index.js';
import { enqueueAvailabilityImport } from '../jobs/queue.js';
import { handleSingleCsvFileUpload } from './csvUpload.js';

/** One row = one worker; bounds the `availability-import` job at <= this x the month's day count
 * upserts, mirroring `routes/importExport.ts`'s own `MAX_ROWS` for the worker CSV. */
const MAX_AVAILABILITY_CSV_ROWS = 10_000;

/**
 * Body-size decision (Availability v2 plan): the app-wide `express.json({ limit: '100kb' })` in
 * `app.ts` is too small for a dense month's `PUT` payload (~1 KB/worker x 31 dates breaks the
 * default cap around 95-100 fully-available workers -- inside this app's own 50-150-worker
 * stated org size). This router is mounted in `app.ts` BEFORE the app-wide json() call, and this
 * PUT route applies its OWN, wider json() middleware first -- so this is the only body parser
 * that ever touches this one route. Every other `/api` route is untouched: a request that does
 * not match one of this router's routes falls through unchanged to the app-wide 100kb parser
 * mounted after this router.
 */
const AVAILABILITY_JSON_BODY_LIMIT = '2mb';

/** Thin HTTP layer for `/api/availability/:month` (bulk JSON) and the month-scoped availability
 * CSV import/export (`/api/import/availability/:month`, `/api/export/availability/:month`). */
export function createAvailabilityRouter(prisma: PrismaClient, boss: PgBoss): Router {
  const router = Router();
  const availabilityService = new AvailabilityService(prisma);

  router.get(
    '/availability/:month',
    asyncHandler(async (req, res) => {
      const month = monthSchema.parse(req.params.month);
      const availability = await availabilityService.getMonth(month);
      res.status(200).json(availability);
    }),
  );

  router.put(
    '/availability/:month',
    express.json({ limit: AVAILABILITY_JSON_BODY_LIMIT }),
    asyncHandler(async (req, res) => {
      const month = monthSchema.parse(req.params.month);
      const payload = monthAvailabilitySchema(month).parse(req.body);
      await availabilityService.replaceMonth(month, payload);
      res.status(200).json({ month });
    }),
  );

  router.get(
    '/export/availability/:month',
    asyncHandler(async (req, res) => {
      const month = monthSchema.parse(req.params.month);
      const csv = await availabilityService.exportCsv(month);
      res
        .status(200)
        .set('Content-Type', 'text/csv; charset=utf-8')
        .set('X-Content-Type-Options', 'nosniff')
        .set('Content-Disposition', `attachment; filename="availability-${month}-export.csv"`)
        .send(csv);
    }),
  );

  router.post(
    '/import/availability/:month',
    handleSingleCsvFileUpload,
    asyncHandler(async (req, res) => {
      const month = monthSchema.parse(req.params.month);
      if (!req.file) {
        throw new BadRequestError([{ path: 'file', message: 'A CSV file is required (multipart field "file")' }]);
      }

      const csvText = req.file.buffer.toString('utf8');

      // Full parse with exact-header validation for THIS month, BEFORE anything is enqueued --
      // mirrors `parseWorkersCsv`'s position in the worker-import pipeline (`routes/importExport.ts`).
      // A wrong-month day-count header (or any other framing problem) is rejected here as a clean
      // 400, never silently accepted into the job queue.
      let rowCount: number;
      try {
        rowCount = parseAvailabilityCsv(csvText, month).length;
      } catch (err) {
        if (err instanceof AvailabilityCsvHeaderError || err instanceof AvailabilityCsvRowShapeError) {
          throw new BadRequestError([{ path: 'file', message: err.message }]);
        }
        throw err;
      }
      if (rowCount > MAX_AVAILABILITY_CSV_ROWS) {
        throw new BadRequestError([
          {
            path: 'file',
            message: `CSV file has ${rowCount} data rows, exceeding the ${MAX_AVAILABILITY_CSV_ROWS}-row limit`,
          },
        ]);
      }

      const jobId = await enqueueAvailabilityImport(boss, csvText, month);
      res.status(202).json({ jobId });
    }),
  );

  return router;
}
