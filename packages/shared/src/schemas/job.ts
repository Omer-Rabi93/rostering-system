import { z } from 'zod';

export const JOB_NAMES = ['csv-import', 'roster-generation', 'availability-import'] as const;
export const JOB_STATES = ['created', 'active', 'completed', 'failed'] as const;

/**
 * Result of a `csv-import` job (worker CSV). v4: the global "sync sweep" deactivation pass was
 * removed entirely (it was scoped to the whole `Worker` table, not the uploading company -- a real
 * bug; see the v4 design doc, Part A) and replaced by a presence-tracking mechanism
 * (`Worker.lastImportTaskId` + roster-generation eligibility), which has no polled-job-result
 * shape of its own -- so `deactivated`/`deactivatedWorkers` are gone from this schema too.
 */
export const importResultSchema = z
  .object({
    totalRows: z.number().int().nonnegative(),
    inserted: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errors: z.array(
      z
        .object({
          row: z.number().int().positive(),
          nationalId: z.string().optional(),
          field: z.string().max(120).optional(),
          message: z.string().max(500),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * Result of an `availability-import` job (Availability v2 month-scoped CSV import). Distinct from
 * `importResultSchema`: this import has no full-sync deactivation-sweep semantics (a worker absent
 * from the file simply keeps whatever `WorkerAvailability` rows they already have) -- so there is
 * no `deactivated`/`deactivatedWorkers` field here, only per-row apply/fail counts. `errors` may
 * carry `nationalId` (an API response to the planner, not a server log line -- see `logger.ts`).
 */
export const availabilityImportResultSchema = z
  .object({
    totalRows: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errors: z.array(
      z
        .object({
          row: z.number().int().positive(),
          nationalId: z.string().optional(),
          field: z.string().max(120).optional(),
          message: z.string().max(500),
        })
        .strict(),
    ),
  })
  .strict();

export const rosterGenerationResultSchema = z
  .object({
    rosterId: z.number().int(),
    alertCount: z.number().int().nonnegative(),
  })
  .strict();

export const jobErrorResultSchema = z
  .object({
    error: z.string().max(2000),
  })
  .strict();

export const jobSchema = z.object({
  id: z.string(),
  name: z.enum(JOB_NAMES),
  state: z.enum(JOB_STATES),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  result: z
    .union([
      importResultSchema,
      rosterGenerationResultSchema,
      availabilityImportResultSchema,
      jobErrorResultSchema,
    ])
    .nullable(),
});

export type ImportResult = z.infer<typeof importResultSchema>;
export type RosterGenerationResult = z.infer<typeof rosterGenerationResultSchema>;
export type AvailabilityImportResult = z.infer<typeof availabilityImportResultSchema>;
export type JobErrorResult = z.infer<typeof jobErrorResultSchema>;
export type Job = z.infer<typeof jobSchema>;
