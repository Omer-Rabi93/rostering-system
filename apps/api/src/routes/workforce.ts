import { companyIdFormFieldSchema, companyIdQuerySchema } from './companyIdSchema.js';
import { Router } from 'express';
import { monthSchema } from '@rostering/shared';
import type { PgBoss } from 'pg-boss';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { BadRequestError, ConflictError } from '../errors.js';
import { WorkforceExportService } from '../services/workforceExportService.js';
import { WorkforceImportService } from '../services/workforceImportService.js';
import { WorkforceCsvHeaderError, WorkforceCsvRowShapeError, parseWorkforceCsv } from '../csv/index.js';
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
      // that task -- see `WorkforceImportService.beginAndEnqueueImport`'s doc comment for why this
      // whole sequence runs under one per-company Postgres advisory lock rather than as separate,
      // independently-retried steps.
      const claimed = await importService.beginAndEnqueueImport(companyId, month, rowCount, csvText);
      if (!claimed) {
        throw new ConflictError(`A workforce-CSV import for company ${companyId} is already in flight`);
      }

      res.status(202).json({ jobId: claimed.jobId });
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
