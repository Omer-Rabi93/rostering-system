import { z } from 'zod';

export const JOB_NAMES = ['workforce-import', 'roster-generation'] as const;
export const JOB_STATES = ['created', 'active', 'completed', 'failed'] as const;

/**
 * Result of a `workforce-import` job (the combined worker+availability CSV, Part G). Each row is
 * one worker's full field set upserted AND that same worker's month-of-availability replaced, as
 * one atomic outcome -- `inserted`/`updated` count that row's worker-upsert outcome; a row fails
 * (counted in `failed`) if EITHER half is invalid (a bad worker field or a bad `dNN` cell), never
 * partially applying one half. Supersedes the two prior CSV pipelines' separate result shapes
 * (`csv-import`'s worker-only `ImportResult`, `availability-import`'s availability-only
 * `AvailabilityImportResult`) -- the merge needed no new fields, since this shape already fit "one
 * row = one outcome" once availability became part of that same row. v4: the global "sync sweep"
 * deactivation pass was removed entirely (it was scoped to the whole `Worker` table, not the
 * uploading company -- a real bug; see the v4 design doc, Part A) and replaced by a
 * presence-tracking mechanism (`Worker.lastImportTaskId` + roster-generation eligibility), which
 * has no polled-job-result shape of its own -- so `deactivated`/`deactivatedWorkers` are gone from
 * this schema too.
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
  result: z.union([importResultSchema, rosterGenerationResultSchema, jobErrorResultSchema]).nullable(),
});

export type ImportResult = z.infer<typeof importResultSchema>;
export type RosterGenerationResult = z.infer<typeof rosterGenerationResultSchema>;
export type JobErrorResult = z.infer<typeof jobErrorResultSchema>;
export type Job = z.infer<typeof jobSchema>;
