import express, { Router } from 'express';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { monthAvailabilitySchema, monthSchema } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { isUniqueConstraintViolation } from '../db/prismaErrors.js';
import { BadRequestError, ConflictError } from '../errors.js';
import { AvailabilityService } from '../services/availabilityService.js';
import { AvailabilityCsvHeaderError, AvailabilityCsvRowShapeError, parseAvailabilityCsv } from '../csv/index.js';
import { enqueueAvailabilityImport } from '../jobs/queue.js';
import { handleSingleCsvFileUpload } from './csvUpload.js';

/**
 * v4: both the bulk `PUT` and the CSV import gain a required `companyId` -- see the v4 design
 * doc, Part A's "Same-company nationalId matching, cross-company conflict as an error" section.
 * `PUT`'s own JSON body is already fully occupied by the `MonthAvailability` payload itself (a
 * date-keyed record, `monthAvailabilitySchema`), so `companyId` travels as a query param there --
 * the same convention `routes/rosters.ts`'s `companyIdQuerySchema` already uses for its own
 * company-scoped `GET` routes. The CSV import route's `companyId` travels as a multipart form
 * field alongside `file` (multer parses non-file fields into `req.body`), per the design doc's
 * "Route/frontend changes" section.
 */
const companyIdQuerySchema = z.object({ companyId: z.coerce.number().int().positive() });
const companyIdFormFieldSchema = z.object({ companyId: z.coerce.number().int().positive() });

/** One row = one worker; bounds the `availability-import` job at <= this x the month's day count
 * upserts, mirroring `routes/importExport.ts`'s own `MAX_ROWS` for the worker CSV. */
const MAX_AVAILABILITY_CSV_ROWS = 10_000;

/** Bounded retry count for the route-level cancel-and-replace sequence below. See the doc comment
 * on the `POST /import/availability/:month` handler for why a single attempt isn't enough under
 * genuine concurrent load, and why the retry must cover BOTH `beginImportTask` and
 * `enqueueAvailabilityImport` together, not either one independently. Matches
 * `routes/importExport.ts`'s identical constant/reasoning. */
const MAX_ENQUEUE_ATTEMPTS = 5;

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
  const availabilityService = new AvailabilityService(prisma, boss);

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
      const { companyId } = companyIdFormFieldSchema.parse(req.body);
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

      // v4 cancel-and-replace: create (or replace) this company's `AVAILABILITY_SYNC` `ImportTask`,
      // THEN send the job. `beginImportTask` (a DB-level `import_tasks` row) and
      // `enqueueAvailabilityImport` (a pg-boss job row, singletonKey-guarded) are two
      // INDEPENDENTLY-raced resources, not one primary and one redundant backstop -- there is a real
      // window, between "we created a fresh PENDING task" and "we actually called
      // enqueueAvailabilityImport", during which a different concurrent request for this same
      // company can complete its OWN full cancel-and-replace sequence and win the pg-boss slot
      // first. A single attempt at this sequence is provably not enough under genuine concurrent
      // load (found via the v4 load-test suite's rapid-fire-reupload script, same root cause as
      // `routes/importExport.ts`'s identical fix) -- so retry the WHOLE sequence, as one unit, up to
      // `MAX_ENQUEUE_ATTEMPTS` times. `beginImportTask` itself has its own bounded internal P2002
      // retry (`AvailabilityService.cancelAndCreateTask`), but under a genuine burst that inner
      // retry CAN also be exhausted and throw -- this loop must catch that (not just a `null` return
      // from `enqueueAvailabilityImport`) and retry the whole sequence again, or a burst wide enough
      // to exhaust the inner retry crashes the request instead of cleanly converging (confirmed as a
      // real reproduced 500, not a hypothetical). `enqueueAvailabilityImport`'s positional argument
      // order is `(boss, companyId, csv, month)` -- verified directly against `jobs/queue.ts`, not
      // assumed.
      let jobId: string | null = null;
      let task: Awaited<ReturnType<typeof availabilityService.beginImportTask>> | undefined;
      for (let attempt = 0; attempt < MAX_ENQUEUE_ATTEMPTS; attempt++) {
        try {
          task = await availabilityService.beginImportTask(companyId, month, rowCount);
        } catch (err) {
          if (isUniqueConstraintViolation(err)) continue;
          throw err;
        }
        jobId = await enqueueAvailabilityImport(boss, companyId, csvText, month);
        if (jobId) break;
        await availabilityService.failImportTask(task.id);
        task = undefined;
      }
      if (!jobId || !task) {
        throw new ConflictError(`An availability-import job for company ${companyId} is already in flight`);
      }
      await availabilityService.attachImportJob(task.id, jobId);

      res.status(202).json({ jobId });
    }),
  );

  return router;
}
