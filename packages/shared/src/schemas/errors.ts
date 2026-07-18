import { z } from 'zod';

/** 400 — Zod request-validation failure. */
export const badRequestErrorSchema = z
  .object({
    errors: z.array(
      z
        .object({
          path: z.string().max(500),
          message: z.string().max(500),
        })
        .strict(),
    ),
  })
  .strict();

/** 404 — unknown resource. */
export const notFoundErrorSchema = z
  .object({
    message: z.string().max(500),
  })
  .strict();

/** 422 — RosterValidator hard-rule violation; never persisted, no override. */
export const unprocessableErrorSchema = z
  .object({
    violations: z.array(
      z
        .object({
          code: z.string().max(120),
          detail: z.unknown(),
        })
        .strict(),
    ),
  })
  .strict();

/** 409 — RosterValidator soft-rule warning; retry with ?confirm=true. */
export const conflictWarningErrorSchema = z
  .object({
    warnings: z.array(
      z
        .object({
          code: z.string().max(120),
          detail: z.unknown(),
        })
        .strict(),
    ),
    confirmRequired: z.literal(true),
  })
  .strict();

/** 409 — plain state conflict (e.g. duplicate name, delete with dependents). `reason` is an
 * optional machine-readable discriminant, currently only populated by `POST /rosters/generate`
 * so the client can tell "already published" apart from "generation already in flight" without
 * parsing `message` text — every other `ConflictError` site omits it and keeps the bare
 * `{ message }` shape. */
export const conflictMessageErrorSchema = z
  .object({
    message: z.string().max(500),
    reason: z.enum(['already-published', 'generation-in-progress']).optional(),
  })
  .strict();

/** 409 — publish blocked by unacknowledged alerts. */
export const publishConflictErrorSchema = z
  .object({
    unacknowledgedAlertIds: z.array(z.number().int()),
  })
  .strict();

export type BadRequestError = z.infer<typeof badRequestErrorSchema>;
export type NotFoundError = z.infer<typeof notFoundErrorSchema>;
export type UnprocessableError = z.infer<typeof unprocessableErrorSchema>;
export type ConflictWarningError = z.infer<typeof conflictWarningErrorSchema>;
export type ConflictMessageError = z.infer<typeof conflictMessageErrorSchema>;
export type PublishConflictError = z.infer<typeof publishConflictErrorSchema>;
