// Shared multer configuration for every CSV multipart-upload route (`/api/import/workers`,
// `/api/import/availability/:month`) -- extracted so both routers use the exact same size cap,
// file-count cap, MIME/extension `fileFilter`, and `MulterError` -> 400-envelope translation
// rather than two hand-maintained configs that can drift apart (a security-review finding from
// the Availability v2 plan: import-protection parity between the two CSV import routes).

import multer, { MulterError } from 'multer';
import type { NextFunction, Request, Response } from 'express';

import { BadRequestError } from '../errors.js';

export const MAX_CSV_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

const CSV_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel', // some browsers/OSes label CSV this way
  'text/plain', // and this way
]);

function isCsvUpload(originalname: string, mimetype: string): boolean {
  return originalname.toLowerCase().endsWith('.csv') && CSV_MIME_TYPES.has(mimetype);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_FILE_SIZE_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!isCsvUpload(file.originalname, file.mimetype)) {
      callback(new BadRequestError([{ path: 'file', message: 'Uploaded file must be a .csv file' }]));
      return;
    }
    callback(null, true);
  },
});

/** Translates multer's own errors (size cap, unexpected extra file, ...) into the app's 400
 * envelope; any other upload error is passed through to the shared `errorHandler`. Reused by
 * every CSV multipart-upload route so the size cap and MIME/extension check can never drift
 * between them. */
export function handleSingleCsvFileUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      next(new BadRequestError([{ path: 'file', message: err.message }]));
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}
