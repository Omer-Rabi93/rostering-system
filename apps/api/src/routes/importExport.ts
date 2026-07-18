import { Router } from 'express';
import type { PgBoss } from 'pg-boss';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { BadRequestError } from '../errors.js';
import { CsvExportService } from '../services/csvExportService.js';
import { CsvHeaderError, CsvRowShapeError, parseWorkersCsv } from '../csv/index.js';
import { enqueueCsvImport } from '../jobs/queue.js';
import { handleSingleCsvFileUpload } from './csvUpload.js';

const MAX_ROWS = 10_000;

/** Thin HTTP layer for `/api/import/workers` and `/api/export/workers`. */
export function createImportExportRouter(prisma: PrismaClient, boss: PgBoss): Router {
  const router = Router();
  const exportService = new CsvExportService(prisma);

  router.post(
    '/import/workers',
    handleSingleCsvFileUpload,
    asyncHandler(async (req, res) => {
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

      const jobId = await enqueueCsvImport(boss, csvText);
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
