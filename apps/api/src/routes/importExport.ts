import { Router } from 'express';
import { z } from 'zod';
import type { PgBoss } from 'pg-boss';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { isUniqueConstraintViolation } from '../db/prismaErrors.js';
import { BadRequestError, ConflictError } from '../errors.js';
import { CsvExportService } from '../services/csvExportService.js';
import { CsvImportService } from '../services/csvImportService.js';
import { CsvHeaderError, CsvRowShapeError, parseWorkersCsv } from '../csv/index.js';
import { enqueueCsvImport } from '../jobs/queue.js';
import { handleSingleCsvFileUpload } from './csvUpload.js';

const MAX_ROWS = 10_000;

/** Bounded retry count for the route-level cancel-and-replace sequence below. See the doc comment
 * on the `POST /import/workers` handler for why a single attempt isn't enough under genuine
 * concurrent load, and why the retry must cover BOTH `beginImportTask` and `enqueueCsvImport`
 * together, not either one independently. */
const MAX_ENQUEUE_ATTEMPTS = 5;

/**
 * v4: the worker-CSV upload gains a required `companyId` -- a worker CSV is now scoped to one
 * company at upload time (the app's "active company"), rather than resolving/creating a company
 * per row (see `csv/columns.ts`'s 7-column schema). Travels as a multipart form field alongside
 * `file` (multer parses non-file fields into `req.body`), mirroring `routes/availability.ts`'s
 * identical `companyIdFormFieldSchema` convention for its own CSV import route.
 */
const companyIdFormFieldSchema = z.object({ companyId: z.coerce.number().int().positive() });

/** Thin HTTP layer for `/api/import/workers` and `/api/export/workers`. */
export function createImportExportRouter(prisma: PrismaClient, boss: PgBoss): Router {
  const router = Router();
  const exportService = new CsvExportService(prisma);
  const importService = new CsvImportService(prisma, boss);

  router.post(
    '/import/workers',
    handleSingleCsvFileUpload,
    asyncHandler(async (req, res) => {
      const { companyId } = companyIdFormFieldSchema.parse(req.body);

      if (!req.file) {
        throw new BadRequestError([{ path: 'file', message: 'A CSV file is required (multipart field "file")' }]);
      }

      const csvText = req.file.buffer.toString('utf8');

      let rowCount: number;
      try {
        rowCount = parseWorkersCsv(csvText).length;
      } catch (err) {
        if (err instanceof CsvHeaderError || err instanceof CsvRowShapeError) {
          throw new BadRequestError([{ path: 'file', message: err.message }]);
        }
        throw err;
      }
      if (rowCount > MAX_ROWS) {
        throw new BadRequestError([
          { path: 'file', message: `CSV file has ${rowCount} data rows, exceeding the ${MAX_ROWS}-row limit` },
        ]);
      }

      // v4 cancel-and-replace (Part A): cancel any existing non-terminal WORKER_SYNC task+job for
      // this company and create a fresh PENDING task, THEN enqueue the real pg-boss job under that
      // task. `beginImportTask` (a DB-level `import_tasks` row) and `enqueueCsvImport` (a pg-boss
      // job row, singletonKey-guarded) are two INDEPENDENTLY-raced resources, not one primary and
      // one redundant backstop -- there is a real window, between "we created a fresh PENDING task"
      // and "we actually called enqueueCsvImport", during which a different concurrent request for
      // this same company can complete its OWN full cancel-and-replace sequence and win the pg-boss
      // slot first. A single attempt at this sequence is provably not enough under genuine
      // concurrent load (found via the v4 load-test suite's rapid-fire-reupload script: multiple
      // requests could each "win" the DB-level race yet still collide at the pg-boss level) -- so
      // retry the WHOLE sequence, as one unit, up to `MAX_ENQUEUE_ATTEMPTS` times. `beginImportTask`
      // itself has its own bounded internal P2002 retry (`CsvImportService.cancelAndCreateTask`),
      // but under a genuine burst that inner retry CAN also be exhausted and throw -- this loop
      // must catch that (not just a `null` return from `enqueueCsvImport`) and retry the whole
      // sequence again, or a burst wide enough to exhaust the inner retry crashes the request
      // instead of cleanly converging (confirmed as a real reproduced 500, not a hypothetical).
      let jobId: string | null = null;
      let task: Awaited<ReturnType<typeof importService.beginImportTask>> | undefined;
      for (let attempt = 0; attempt < MAX_ENQUEUE_ATTEMPTS; attempt++) {
        try {
          task = await importService.beginImportTask(companyId);
        } catch (err) {
          if (isUniqueConstraintViolation(err)) continue;
          throw err;
        }
        jobId = await enqueueCsvImport(boss, companyId, csvText);
        if (jobId) break;
        await importService.failImportTask(task.id);
        task = undefined;
      }
      if (!jobId || !task) {
        throw new ConflictError(`A worker-CSV import for company ${companyId} is already in flight`);
      }
      await importService.attachImportJob(task.id, jobId);

      res.status(202).json({ jobId });
    }),
  );

  router.get(
    '/export/workers',
    asyncHandler(async (_req, res) => {
      const csv = await exportService.exportCsv();
      res
        .status(200)
        .set('Content-Type', 'text/csv; charset=utf-8')
        .set('X-Content-Type-Options', 'nosniff')
        .set('Content-Disposition', 'attachment; filename="workers-export.csv"')
        .send(csv);
    }),
  );

  return router;
}
