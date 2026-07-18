import { NotFoundError } from '../errors.js';

/**
 * Parses a route param expected to be a positive integer id. A malformed id (non-numeric) is
 * treated the same as "unknown resource" — 404 — rather than a 400, since the id is part of the
 * URL path, not a validated request body.
 */
/** Normalizes a plain string route param (e.g. `:month`), rejecting the array form Express's
 * types allow for repeated query-like segments but that a single path segment can never produce. */
export function parseStringParam(raw: string | string[] | undefined, resourceName: string): string {
  if (typeof raw !== 'string') {
    throw new NotFoundError(`${resourceName} not found`);
  }
  return raw;
}

export function parseIdParam(raw: string | string[] | undefined, resourceName: string): number {
  if (typeof raw !== 'string') {
    throw new NotFoundError(`${resourceName} not found`);
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new NotFoundError(`${resourceName} ${raw} not found`);
  }
  return id;
}
