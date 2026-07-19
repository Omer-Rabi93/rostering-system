import { companyIdFormFieldSchema, companyIdQuerySchema } from './companyIdSchema.js';
import { Router } from 'express';
import { monthSchema } from '@rostering/shared';
import type { PgBoss } from 'pg-boss';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { isUniqueConstraintViolation } from '../db/prismaErrors.js';
import { BadRequestError, ConflictError } from '../errors.js';
import { WorkforceExportService } from '../services/workforceExportService.js';
import { WorkforceImportService } from '../services/workforceImportService.js';
import { WorkforceCsvHeaderError, WorkforceCsvRowShapeError, parseWorkforceCsv } from '../csv/index.js';
import { enqueueWorkforceImport } from '../jobs/queue.js';
import { handleSingleCsvFileUpload } from './csvUpload.js';

/**
 * Raised for the 1,000-10,000-worker-per-company scale target: 10,000 sat EXACTLY at this
 * system's own stated worker-count ceiling, leaving zero headroom for a company genuinely at that
 * limit (any row miscount/off-by-one, or a company that grows to precisely 10,000 workers, would
 * hit this wall with no slack). 15,000 gives 50% headroom above the stated ceiling. See
 * `routes/csvUpload.ts`'s `MAX_CSV_FILE_SIZE_BYTES` for the corresponding worst-case-byte-size
 * math at this row count.
 */
export const MAX_WORKFORCE_CSV_ROWS = 15_000;

/** Bounded retry count for the route-level cancel-and-replace sequence below. See the doc comment
 * on the `POST /import/workforce/:month` handler for why a single attempt isn't enough under
 * genuine concurrent load, and why the retry must cover BOTH `beginImportTask` and
 * `enqueueWorkforceImport` together, not either one independently. */
const MAX_ENQUEUE_ATTEMPTS = 5;

/**
 * The combined workforce CSV is scoped to one company at upload time (the app's "active
 * company"), same as the pre-merge worker-CSV convention. Travels as a multipart form field
 * alongside `file` (multer parses non-file fields into `req.body`).
 */

/** Thin HTTP layer for `/api/import/workforce/:month` and `/api/export/workforce/:month`.
 * Supersedes `importExport.ts` (worker-only) and `availability.ts`'s CSV-import/export routes
 * (availability-only) -- see the Part G design doc. `availability.ts` keeps only the manual/grid
 * `GET`/`PUT /api/availability/:month` JSON routes, untouched by this merge. */
export function createWorkforceRouter(prisma: PrismaClient, boss: PgBoss): Router {
  const router = Router();
  const exportService = new WorkforceExportService(prisma);
  const importService = new WorkforceImportService(prisma, boss);

  router.post(
    '/import/workforce/:month',
    handleSingleCsvFileUpload,
    asyncHandler(async (req, res) => {
      const month = monthSchema.parse(req.params.month);
      const { companyId } = companyIdFormFieldSchema.parse(req.body);

      if (!req.file) {
        throw new BadRequestError([{ path: 'file', message: 'A CSV file is required (multipart field "file")' }]);
      }

      const csvText = req.file.buffer.toString('utf8');

      // Full parse with exact-header validation for THIS month, BEFORE anything is enqueued -- a
      // wrong-month day-count header (or any other framing problem) is rejected here as a clean
      // 400, never silently accepted into the job queue.
      let rowCount: number;
      try {
        rowCount = parseWorkforceCsv(csvText, month).length;
      } catch (err) {
        if (err instanceof WorkforceCsvHeaderError || err instanceof WorkforceCsvRowShapeError) {
          throw new BadRequestError([{ path: 'file', message: err.message }]);
        }
        throw err;
      }
      if (rowCount > MAX_WORKFORCE_CSV_ROWS) {
        throw new BadRequestError([
          {
            path: 'file',
            message: `CSV file has ${rowCount} data rows, exceeding the ${MAX_WORKFORCE_CSV_ROWS}-row limit`,
          },
        ]);
      }

      // v4 cancel-and-replace (Part A): cancel any existing non-terminal WORKFORCE_SYNC task+job
      // for this company and create a fresh PENDING task, THEN enqueue the real pg-boss job under
      // that task. `beginImportTask` (a DB-level `import_tasks` row) and `enqueueWorkforceImport`
      // (a pg-boss job row, singletonKey-guarded) are two INDEPENDENTLY-raced resources, not one
      // primary and one redundant backstop -- there is a real window, between "we created a fresh
      // PENDING task" and "we actually called enqueueWorkforceImport", during which a different
      // concurrent request for this same company can complete its OWN full cancel-and-replace
      // sequence and win the pg-boss slot first. A single attempt at this sequence is provably not
      // enough under genuine concurrent load (found via the v4 load-test suite's rapid-fire-
      // reupload script: multiple requests could each "win" the DB-level race yet still collide at
      // the pg-boss level) -- so retry the WHOLE sequence, as one unit, up to
      // `MAX_ENQUEUE_ATTEMPTS` times. `beginImportTask` itself has its own bounded internal P2002
      // retry (`WorkforceImportService.cancelAndCreateTask`), but under a genuine burst that inner
      // retry CAN also be exhausted and throw -- this loop must catch that (not just a `null`
      // return from `enqueueWorkforceImport`) and retry the whole sequence again, or a burst wide
      // enough to exhaust the inner retry crashes the request instead of cleanly converging.
      let jobId: string | null = null;
      let task: Awaited<ReturnType<typeof importService.beginImportTask>> | undefined;
      for (let attempt = 0; attempt < MAX_ENQUEUE_ATTEMPTS; attempt++) {
        try {
          task = await importService.beginImportTask(companyId, month, rowCount);
        } catch (err) {
          if (isUniqueConstraintViolation(err)) continue;
          throw err;
        }
        jobId = await enqueueWorkforceImport(boss, companyId, csvText, month);
        if (jobId) break;
        await importService.failImportTask(task.id);
        task = undefined;
      }
      if (!jobId || !task) {
        throw new ConflictError(`A workforce-CSV import for company ${companyId} is already in flight`);
      }
      await importService.attachImportJob(task.id, jobId);

      res.status(202).json({ jobId });
    }),
  );

  router.get(
    '/export/workforce/:month',
    asyncHandler(async (req, res) => {
      const month = monthSchema.parse(req.params.month);
      const { companyId } = companyIdQuerySchema.parse(req.query);
      const csv = await exportService.exportCsv(month, companyId);
      res
        .status(200)
        .set('Content-Type', 'text/csv; charset=utf-8')
        .set('X-Content-Type-Options', 'nosniff')
        .set('Content-Disposition', `attachment; filename="workforce-${month}-export.csv"`)
        .send(csv);
    }),
  );

  return router;
}
