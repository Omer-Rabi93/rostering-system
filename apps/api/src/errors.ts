// Typed application errors thrown by `src/services/*`. Route handlers never build HTTP responses
// directly for these cases — they let the error propagate (via `asyncHandler`) to
// `src/middleware/errorHandler.ts`, which is the single place that knows the envelope shapes from
// the design doc's REST API reference. Keeping the mapping in one place means services stay
// Express-free (no `res` object, no status codes) — see the SOLID pass in the Phase 5 plan.

export interface FieldError {
  readonly path: string;
  readonly message: string;
}

/**
 * 400 — a request-shape-valid but semantically invalid request (e.g. a `companyId` that does not
 * reference any row), surfaced in the same `{ errors: [{path, message}] }` envelope as a Zod
 * validation failure so the client only has one 400 shape to handle.
 */
export class BadRequestError extends Error {
  readonly fieldErrors: readonly FieldError[];
  constructor(fieldErrors: readonly FieldError[]) {
    super('Bad request');
    this.name = 'BadRequestError';
    this.fieldErrors = fieldErrors;
  }
}

/** 404 — unknown resource. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Machine-readable discriminant for a `ConflictError`, currently only populated by
 * `POST /rosters/generate` (see `routes/rosters.ts`) so the client can distinguish "already
 * published" from "generation job already in flight" without parsing `message` text — kept as a
 * loose `string` here (rather than importing `@rostering/shared`'s enum into every service that
 * throws a plain `ConflictError`) since only the roster-generation route needs it; the shared
 * `conflictMessageErrorSchema` is what actually constrains the value the client ever sees. */
export type ConflictReason = 'already-published' | 'generation-in-progress';

/** 409 — plain state conflict (duplicate name, delete-with-dependents, generation in flight, …).
 * `reason` is optional — most call sites (duplicate company/worker, delete-with-dependents) have
 * no need for a structured discriminant and rely on `message` alone. */
export class ConflictError extends Error {
  readonly reason: ConflictReason | undefined;
  constructor(message: string, reason?: ConflictReason) {
    super(message);
    this.name = 'ConflictError';
    this.reason = reason;
  }
}

export interface RuleDetail {
  readonly code: string;
  readonly detail: unknown;
}

/** 409 — RosterValidator soft-rule warning(s); retry the identical request with `?confirm=true`. */
export class ConflictWarningError extends Error {
  readonly warnings: readonly RuleDetail[];
  constructor(warnings: readonly RuleDetail[]) {
    super('Soft rule warning; resubmit with ?confirm=true to proceed');
    this.name = 'ConflictWarningError';
    this.warnings = warnings;
  }
}

/** 422 — RosterValidator hard-rule violation(s); never persisted, no override via `confirm`. */
export class UnprocessableError extends Error {
  readonly violations: readonly RuleDetail[];
  constructor(violations: readonly RuleDetail[]) {
    super('Hard rule violation');
    this.name = 'UnprocessableError';
    this.violations = violations;
  }
}

/** 409 — publish blocked because one or more alerts are unacknowledged. */
export class PublishConflictError extends Error {
  readonly unacknowledgedAlertIds: readonly number[];
  constructor(unacknowledgedAlertIds: readonly number[]) {
    super('Roster has unacknowledged alerts');
    this.name = 'PublishConflictError';
    this.unacknowledgedAlertIds = unacknowledgedAlertIds;
  }
}
