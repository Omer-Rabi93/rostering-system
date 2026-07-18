import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import {
  BadRequestError,
  ConflictError,
  ConflictWarningError,
  NotFoundError,
  PublishConflictError,
  UnprocessableError,
} from '../errors.js';
import { logServerError } from '../logger.js';

interface BodyParserError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

function isBodyTooLargeError(err: unknown): err is BodyParserError {
  return (
    err instanceof Error &&
    'type' in err &&
    (err as BodyParserError).type === 'entity.too.large'
  );
}

/**
 * The single place that maps every error the app can throw to the design doc's envelope
 * convention. Must be mounted LAST (after every route). Never forwards Prisma internals, a stack
 * trace, query text, or schema detail to the client — those are logged server-side only via
 * `logServerError`, which redacts national IDs.
 */
// Express identifies error middleware by arity (4 params) — `_next` must stay declared even
// though it is never called.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      errors: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  if (err instanceof BadRequestError) {
    res.status(400).json({ errors: err.fieldErrors });
    return;
  }

  if (err instanceof NotFoundError) {
    res.status(404).json({ message: err.message });
    return;
  }

  if (err instanceof ConflictWarningError) {
    res.status(409).json({ warnings: err.warnings, confirmRequired: true });
    return;
  }

  if (err instanceof PublishConflictError) {
    res.status(409).json({ unacknowledgedAlertIds: err.unacknowledgedAlertIds });
    return;
  }

  if (err instanceof ConflictError) {
    res.status(409).json({ message: err.message, ...(err.reason ? { reason: err.reason } : {}) });
    return;
  }

  if (err instanceof UnprocessableError) {
    res.status(422).json({ violations: err.violations });
    return;
  }

  if (isBodyTooLargeError(err)) {
    res.status(413).json({ message: 'Request body too large' });
    return;
  }

  // Unexpected error (including raw Prisma errors): never leak internals to the client. Full
  // detail is logged server-side only, national IDs redacted.
  logServerError(`${req.method} ${req.path}`, err);
  res.status(500).json({ message: 'Internal server error' });
}
