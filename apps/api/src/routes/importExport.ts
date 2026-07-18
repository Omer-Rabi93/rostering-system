import { Router } from 'express';
import { z } from 'zod';
import type { PgBoss } from 'pg-boss';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { BadRequestError, ConflictError } from '../errors.js';
import { CsvExportService } from '../services/csvExportService.js';
import { CsvImportService } from '../services/csvImportService.js';
import { CsvHeaderError, CsvRowShapeError, parseWorkersCsv } from '../csv/index.js';
import { enqueueCsvImport } from '../jobs/queue.js';
import { handleSingleCsvFileUpload } from './csvUpload.js';

const MAX_ROWS = 10_000;

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
      // this company and create a fresh PENDING task BEFORE enqueueing, so the queue's
      // `singletonKey` slot is free again by the time `enqueueCsvImport` runs below.
      const task = await importService.beginImportTask(companyId);

      const jobId = await enqueueCsvImport(boss, companyId, csvText);
      if (!jobId) {
        // Shouldn't happen -- `beginImportTask` above should have already freed the singletonKey
        // slot -- but handle it defensively rather than leaving an unresolvable PENDING task
        // dangling forever (it would otherwise block every future upload for this company).
        await importService.failImportTask(task.id);
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
