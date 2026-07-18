// pg-boss wiring, shared by the API (which only ever *sends* jobs) and `worker.ts` (which
// consumes them). Owns the `pgboss` schema (migrated automatically on `boss.start()`) -- see the
// design doc's "pg-boss specifics" section.
//
// Note on `teamSize`: the design doc's snippet (`boss.work(queue, { teamSize: 1 }, handler)`) is
// written against an older pg-boss major. pg-boss 12 replaced `teamSize` with per-`work()`
// `localConcurrency`; `registerCsvImportWorker`/`registerRosterGenerationWorker` below pass
// `localConcurrency: 1` to preserve the same "at most one job processed at a time per queue"
// intent.

import { PgBoss } from 'pg-boss';
import type { Job } from 'pg-boss';

export const QUEUES = {
  CSV_IMPORT: 'csv-import',
  ROSTER_GENERATION: 'roster-generation',
  AVAILABILITY_IMPORT: 'availability-import',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Both job handlers are idempotent (import upserts by national_id; generation deletes-and-
 * rewrites the month's draft in one transaction) -- see the design doc's decision box -- so both
 * queues use the same retry policy. */
const RETRY_LIMIT = 2;

/** 06:00 on the 25th of every month -> auto-generate NEXT month's draft. Cron never publishes. */
export const NEXT_MONTH_CRON_SCHEDULE = '0 6 25 * *';

export interface CsvImportJobData {
  readonly csv: string;
}

export interface AvailabilityImportJobData {
  readonly csv: string;
  readonly month: string;
}

export interface RosterGenerationJobData {
  readonly companyId: number;
  readonly month: string;
  readonly force?: boolean;
}

export function createBoss(connectionString: string): PgBoss {
  return new PgBoss(connectionString);
}

/** Memoized per-instance lazy start: the HTTP layer (which only ever sends jobs, never
 * `worker.ts`'s long-running `boss.start()` + `work()` process) calls this before its first
 * `send`/read so a `PgBoss` instance can be constructed synchronously (e.g. in `app.ts`) without
 * every caller separately awaiting `start()` + `ensureQueues()`. Idempotent: a second call while
 * (or after) the first is in flight reuses the same promise/result. */
const startPromises = new WeakMap<PgBoss, Promise<void>>();

export function ensureBossStarted(boss: PgBoss): Promise<void> {
  let promise = startPromises.get(boss);
  if (!promise) {
    promise = (async () => {
      await boss.start();
      await ensureQueues(boss);
    })();
    startPromises.set(boss, promise);
  }
  return promise;
}

/** Idempotent: safe to call on every process start (API and worker both call it independently). */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUES.CSV_IMPORT, { retryLimit: RETRY_LIMIT });
  await boss.createQueue(QUEUES.AVAILABILITY_IMPORT, { retryLimit: RETRY_LIMIT });
  // `stately` is the pg-boss v12 queue policy whose DB-level uniqueness constraint blocks a
  // second job sharing a `singletonKey` while an existing one is in ANY non-terminal state
  // (`created` OR `active`) -- exactly "at most one queued/active generation job per month" from
  // the design doc. (pg-boss's plain `standard` policy, and the design doc's own snippet, predate
  // this per-policy split and would only dedupe within one of those two states, not both.)
  await boss.createQueue(QUEUES.ROSTER_GENERATION, { retryLimit: RETRY_LIMIT, policy: 'stately' });
}

export async function enqueueCsvImport(boss: PgBoss, csv: string): Promise<string> {
  await ensureBossStarted(boss);
  const jobId = await boss.send(QUEUES.CSV_IMPORT, { csv } satisfies CsvImportJobData);
  if (!jobId) {
    throw new Error('Failed to enqueue csv-import job');
  }
  return jobId;
}

export async function enqueueAvailabilityImport(boss: PgBoss, csv: string, month: string): Promise<string> {
  await ensureBossStarted(boss);
  const jobId = await boss.send(QUEUES.AVAILABILITY_IMPORT, { csv, month } satisfies AvailabilityImportJobData);
  if (!jobId) {
    throw new Error('Failed to enqueue availability-import job');
  }
  return jobId;
}

/**
 * `singletonKey = "<companyId>:<month>"` -> pg-boss allows at most ONE queued/active generation
 * job per (company, month) pair -- two different companies generating the same calendar month
 * concurrently are unrelated jobs, not a collision. Returns `null` on collision (a second
 * concurrent request for the same company+month), which the HTTP layer
 * (`POST /api/rosters/generate`) translates into a 409.
 */
export async function enqueueRosterGeneration(
  boss: PgBoss,
  companyId: number,
  month: string,
  // `| undefined` (rather than merely optional) so callers can pass through an already-optional
  // `force?: boolean` field (e.g. straight from a parsed Zod body) without first stripping an
  // explicit `undefined` -- `exactOptionalPropertyTypes` would otherwise reject that at the call
  // site even though "explicitly undefined" and "omitted" mean the same thing here.
  options: { readonly force?: boolean | undefined } = {},
): Promise<string | null> {
  await ensureBossStarted(boss);
  // `exactOptionalPropertyTypes` forbids assigning `force: undefined` explicitly -- the optional
  // key must be omitted entirely rather than present-with-undefined.
  const data: RosterGenerationJobData =
    options.force === undefined ? { companyId, month } : { companyId, month, force: options.force };
  return boss.send(QUEUES.ROSTER_GENERATION, data, { singletonKey: `${companyId}:${month}` });
}

export async function scheduleNextMonthGeneration(boss: PgBoss): Promise<void> {
  await boss.schedule(QUEUES.ROSTER_GENERATION, NEXT_MONTH_CRON_SCHEDULE, { month: 'next' });
}

export async function registerCsvImportWorker(
  boss: PgBoss,
  handler: (data: CsvImportJobData) => Promise<object>,
): Promise<void> {
  await boss.work(QUEUES.CSV_IMPORT, { localConcurrency: 1 }, async (jobs: Job<CsvImportJobData>[]) => {
    const [job] = jobs;
    if (!job) throw new Error('pg-boss invoked the work handler with an empty job batch');
    return handler(job.data);
  });
}

export async function registerAvailabilityImportWorker(
  boss: PgBoss,
  handler: (data: AvailabilityImportJobData) => Promise<object>,
): Promise<void> {
  await boss.work(
    QUEUES.AVAILABILITY_IMPORT,
    { localConcurrency: 1 },
    async (jobs: Job<AvailabilityImportJobData>[]) => {
      const [job] = jobs;
      if (!job) throw new Error('pg-boss invoked the work handler with an empty job batch');
      return handler(job.data);
    },
  );
}

export async function registerRosterGenerationWorker(
  boss: PgBoss,
  handler: (data: RosterGenerationJobData) => Promise<object>,
): Promise<void> {
  await boss.work(
    QUEUES.ROSTER_GENERATION,
    { localConcurrency: 1 },
    async (jobs: Job<RosterGenerationJobData>[]) => {
      const [job] = jobs;
      if (!job) throw new Error('pg-boss invoked the work handler with an empty job batch');
      return handler(job.data);
    },
  );
}
