// Shared multer configuration for the combined workforce-CSV multipart-upload route
// (`/api/import/workforce/:month`) -- extracted from the two now-merged pre-Part-G routes so any
// future CSV upload route reuses the exact same size cap, file-count cap, MIME/extension
// `fileFilter`, and `MulterError` -> 400-envelope translation rather than a hand-maintained config
// that can drift (a security-review finding from the Availability v2 plan: import-protection
// parity across CSV import routes).

import multer, { MulterError } from 'multer';
import type { NextFunction, Request, Response } from 'express';

import { BadRequestError } from '../errors.js';

/**
 * Sized against a REAL measurement (raised for the 1,000-10,000-worker-per-company scale target;
 * the original 2 MB was already within ~3% of a real 10,000-row worst case, leaving almost no
 * headroom at this system's own stated ceiling): the combined workforce CSV
 * (`csv/workforce.ts#workforceCsvHeader` -- the 7 `CSV_COLUMNS` worker fields + up to 31 `dNN`
 * day-columns for the target month) serialized for `MAX_WORKFORCE_CSV_ROWS` rows (see
 * `routes/workforce.ts`), each row using realistically-long field values (a long name, every `dNN`
 * cell filled with a full `"ABC"` exclusion) measures to ~2.9 MB. 8 MB gives ~2.75x headroom above
 * that measured worst case. Must stay `<=` `infra/nginx.conf`'s `client_max_body_size`.
 */
export const MAX_CSV_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB

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
