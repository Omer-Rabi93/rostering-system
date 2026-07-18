import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async Express handler so a rejected promise reaches `next(err)` (and therefore
 * `errorHandler`) instead of crashing the process / hanging the request. Routes stay thin: parse
 * with a Zod schema, call a service method, respond — this is the only "framework glue" needed to
 * let services throw typed errors (`src/errors.ts`) synchronously from an async function.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
