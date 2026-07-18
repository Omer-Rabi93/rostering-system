// pg-boss wiring, shared by the API (which only ever *sends* jobs) and `worker.ts` (which
// consumes them). Owns the `pgboss` schema (migrated automatically on `boss.start()`) -- see the
// design doc's "pg-boss specifics" section.
//
// Note on `teamSize`: the design doc's snippet (`boss.work(queue, { teamSize: 1 }, handler)`) is
// written against an older pg-boss major. pg-boss 12 replaced `teamSize` with per-`work()`
// `localConcurrency`.
//
// v4: per-company partitioning uses `singletonKey` on these same shared/static queues (recommended
// over literal per-company physical queues -- see the v4 design doc, Part A's "Queue-partitioning
// mechanism" comparison table), the same pattern `roster-generation` already proved
// (`singletonKey: "<companyId>:<month>"`, `stately` policy). `csv-import`/`availability-import` now
// use `singletonKey: "<companyId>:<kind>"` (kind = 'WORKER_SYNC' | 'AVAILABILITY_SYNC', matching
// `ImportTaskKind`) and the `stately` policy too, so at most one queued/active job per company+kind
// can exist -- the queue-level half of cancel-and-replace (the DB-level backstop lives in the
// `import_tasks` partial unique index). `localConcurrency` on all three queues is now
// env-configurable rather than hardcoded to `1` -- see each `register*Worker` function below for
// why the right number differs sharply between the I/O-bound CSV queues and the CPU-bound
// roster-generation queue (design doc Part E.3).

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
  readonly companyId: number;
}

export interface AvailabilityImportJobData {
  readonly csv: string;
  readonly month: string;
  readonly companyId: number;
}

export interface RosterGenerationJobData {
  readonly companyId: number;
  readonly month: string;
  readonly force?: boolean;
}

/**
 * `DB_POOL_SIZE_BOSS` caps pg-boss's own internal connection pool, kept separate from (and on top
 * of) Prisma's own pool (`db/client.ts`'s `DB_POOL_SIZE_PRISMA`) -- every process that both serves
 * the app and touches the job queue holds two independent pools, not one. Explicitly bounding both
 * is cheap headroom against the shared Postgres connection budget once multiple replicas run -- see
 * the v4 design doc, Part E.2.
 */
export function createBoss(connectionString: string): PgBoss {
  return new PgBoss({ connectionString, max: Number(process.env.DB_POOL_SIZE_BOSS ?? 10) });
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

// `stately` is the pg-boss v12 queue policy whose DB-level uniqueness constraint blocks a second
// job sharing a `singletonKey` while an existing one is in ANY non-terminal state (`created` OR
// `active`) -- exactly "at most one queued/active job per key" from the design doc. (pg-boss's
// plain `standard` policy, and the design doc's own original snippet, predate this per-policy
// split and would only dedupe within one of those two states, not both.) All three queues use it:
// `roster-generation` keys on `<companyId>:<month>`, `csv-import`/`availability-import` key on
// `<companyId>:<kind>` -- see the v4 design doc, Part A's "Queue-partitioning mechanism".

/** Idempotent: safe to call on every process start (API and worker both call it independently). */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUES.CSV_IMPORT, { retryLimit: RETRY_LIMIT, policy: 'stately' });
  await boss.createQueue(QUEUES.AVAILABILITY_IMPORT, { retryLimit: RETRY_LIMIT, policy: 'stately' });
  await boss.createQueue(QUEUES.ROSTER_GENERATION, { retryLimit: RETRY_LIMIT, policy: 'stately' });
}

/**
 * `singletonKey = "<companyId>:WORKER_SYNC"` -> pg-boss allows at most ONE queued/active
 * worker-CSV-import job per company (matching `ImportTaskKind.WORKER_SYNC`) -- a different
 * company's own worker-CSV import is an unrelated job, not a collision. Mirrors
 * `enqueueRosterGeneration`'s exact pattern, including returning `null` on a singletonKey
 * collision rather than throwing: a later phase's cancel-and-replace flow (mark the existing
 * non-terminal `ImportTask` `CANCELLED`, `boss.cancel()` its pg-boss job, only then enqueue the
 * replacement) is expected to always free the slot before calling this again, so a collision here
 * signals a genuine race the caller must detect and retry, exactly like `enqueueRosterGeneration`'s
 * 409 handling -- see the v4 design doc, Part A's "Cancel-and-replace" section.
 */
export async function enqueueCsvImport(boss: PgBoss, companyId: number, csv: string): Promise<string | null> {
  await ensureBossStarted(boss);
  return boss.send(QUEUES.CSV_IMPORT, { csv, companyId } satisfies CsvImportJobData, {
    singletonKey: `${companyId}:WORKER_SYNC`,
  });
}

/**
 * `singletonKey = "<companyId>:AVAILABILITY_SYNC"` -> same partitioning (and same `null`-on-
 * collision contract) as `enqueueCsvImport`, for the availability-CSV kind (matching
 * `ImportTaskKind.AVAILABILITY_SYNC`).
 */
export async function enqueueAvailabilityImport(
  boss: PgBoss,
  companyId: number,
  csv: string,
  month: string,
): Promise<string | null> {
  await ensureBossStarted(boss);
  return boss.send(QUEUES.AVAILABILITY_IMPORT, { csv, month, companyId } satisfies AvailabilityImportJobData, {
    singletonKey: `${companyId}:AVAILABILITY_SYNC`,
  });
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

/**
 * Thin wrapper around `boss.cancel()` -- reliably stops a job that hasn't started yet, but cannot
 * forcibly interrupt Node.js code already executing inside a running handler (cooperative
 * cancellation inside the row-processing loop, re-reading the job's own `ImportTask.status`, is
 * what handles the already-running case; that's a later phase's concern in the service layer).
 * This is just the primitive: the actual cancel-and-replace orchestration (mark the `ImportTask`
 * `CANCELLED` first, then call this, then enqueue the replacement) lives in a later wave's service
 * code. See the v4 design doc, Part A's "Cancel-and-replace" section.
 */
export async function cancelJob(boss: PgBoss, queueName: QueueName, jobId: string): Promise<void> {
  await ensureBossStarted(boss);
  await boss.cancel(queueName, jobId);
}

/**
 * `csv-import` is I/O-bound (mostly waiting on per-row DB transactions), so raising
 * `localConcurrency` well above `1` is safe and directly helps multiple *different* companies'
 * singleton slots run genuinely concurrently -- `singletonKey` still guarantees at most one
 * in-flight job per company. Default `8` is deliberately sized to not wildly outrun
 * `DB_POOL_SIZE_PRISMA`'s default (`10`): raising this past the Prisma pool size just means the
 * extra concurrent jobs queue up waiting for a free connection instead of gaining real
 * concurrency, so tune the two together, not independently -- see the v4 design doc, Part E.3.
 *
 * The handler also receives this run's own pg-boss job id (`job.id`) as a second argument --
 * mirrors `registerAvailabilityImportWorker`'s identical reasoning: v4's `CsvImportService.importCsv`
 * uses it to adopt the specific `ImportTask` row the route's `beginImportTask` created for this
 * exact upload (matched via `ImportTask.pgBossJobId`), rather than guessing which non-terminal
 * task "belongs" to this run -- see `jobs/csvImport.job.ts`'s doc comment.
 */
export async function registerCsvImportWorker(
  boss: PgBoss,
  handler: (data: CsvImportJobData, jobId: string) => Promise<object>,
): Promise<void> {
  const localConcurrency = Number(process.env.CSV_IMPORT_CONCURRENCY ?? 8);
  await boss.work(QUEUES.CSV_IMPORT, { localConcurrency }, async (jobs: Job<CsvImportJobData>[]) => {
    const [job] = jobs;
    if (!job) throw new Error('pg-boss invoked the work handler with an empty job batch');
    return handler(job.data, job.id);
  });
}

/**
 * I/O-bound, same reasoning as `registerCsvImportWorker` above. The handler also receives this
 * run's own pg-boss job id (`job.id`, pg-boss 12's own job identifier) as a second argument -- v4's
 * `AvailabilityService.importCsv` uses it to adopt the specific `ImportTask` row the route's
 * `beginImportTask` created for this exact upload (matched via `ImportTask.pgBossJobId`), rather
 * than guessing which non-terminal task "belongs" to this run -- see
 * `jobs/availabilityImport.job.ts`'s doc comment.
 */
export async function registerAvailabilityImportWorker(
  boss: PgBoss,
  handler: (data: AvailabilityImportJobData, jobId: string) => Promise<object>,
): Promise<void> {
  const localConcurrency = Number(process.env.AVAILABILITY_IMPORT_CONCURRENCY ?? 8);
  await boss.work(
    QUEUES.AVAILABILITY_IMPORT,
    { localConcurrency },
    async (jobs: Job<AvailabilityImportJobData>[]) => {
      const [job] = jobs;
      if (!job) throw new Error('pg-boss invoked the work handler with an empty job batch');
      return handler(job.data, job.id);
    },
  );
}

/**
 * `roster-generation` is CPU-bound, and deliberately single-threaded per solve: `runSolver.ts`
 * spawns one Python `solve_roster.py` process per job, and the solver's determinism guarantee
 * (fixed seed) is achieved by constraining CP-SAT to effectively single-threaded search *within
 * one solve* -- a single solve does NOT get faster by throwing more cores at it. Multiple
 * *concurrent* solves (different companies) each only need one core, so overall throughput scales
 * with available CPU cores, not with an arbitrary queue number the way the I/O-bound CSV queues
 * do. `localConcurrency` here should therefore track (available CPU cores per worker replica,
 * minus headroom for Node/Prisma/pg-boss's own overhead), not be raised arbitrarily -- setting it
 * higher than actual cores doesn't add real throughput, it just makes every concurrent solve
 * slower via OS scheduling contention (still deterministic per solve, just slower wall-clock).
 * Default `2` is a modest, small-container-sized value; deployments with more cores available
 * should raise `ROSTER_GENERATION_CONCURRENCY` accordingly. Previously hardcoded to `1`, which
 * meant only ONE company's roster generation could run at a time system-wide even though
 * `singletonKey` already scopes duplicate-prevention to `<companyId>:<month>` -- see the v4 design
 * doc, Part E.3, for the full reasoning (including why this is a real, pre-existing bug fix, not
 * new scope).
 */
export async function registerRosterGenerationWorker(
  boss: PgBoss,
  handler: (data: RosterGenerationJobData) => Promise<object>,
): Promise<void> {
  const localConcurrency = Number(process.env.ROSTER_GENERATION_CONCURRENCY ?? 2);
  await boss.work(
    QUEUES.ROSTER_GENERATION,
    { localConcurrency },
    async (jobs: Job<RosterGenerationJobData>[]) => {
      const [job] = jobs;
      if (!job) throw new Error('pg-boss invoked the work handler with an empty job batch');
      return handler(job.data);
    },
  );
}
