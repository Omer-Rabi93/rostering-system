// pg-boss wiring, shared by the API (which only ever *sends* jobs) and `worker.ts` (which
// consumes them). Owns the `pgboss` schema (migrated automatically on `boss.start()`) -- see the
// design doc's "pg-boss specifics" section.
//
// Note on `teamSize`: the design doc's snippet (`boss.work(queue, { teamSize: 1 }, handler)`) is
// written against an older pg-boss major. pg-boss 12 replaced `teamSize` with per-`work()`
// `localConcurrency`.
//
// v4/Part G: both queues use `singletonKey` + `stately` policy for per-company (or
// per-company+month) partitioning: `roster-generation` on `"<companyId>:<month>"`,
// `workforce-import` on `"<companyId>:WORKFORCE_SYNC"`. This key is REQUIRED on a `stately`
// queue, not optional -- see `enqueueWorkforceImport`'s doc comment for why dropping it doesn't
// disable the uniqueness constraint, it collapses every job on the queue onto one shared implicit
// key, making the whole queue globally single-flight instead of per-company (confirmed directly, by
// trying exactly that and finding it broke cross-company independence). `workforce-import` used to
// be two separate queues (`csv-import`/`availability-import`, one per CSV pipeline) before the two
// pipelines merged into one combined upload (Part G) -- there is no remaining axis to split the
// queue on once the job data and per-row cost are unified.
//
// `workforce-import` ALSO has a DB-level `import_tasks` partial unique index
// (`import_tasks_company_kind_active_key`) enforcing the same "at most one non-terminal task per
// company+kind" invariant, one layer up, in `WorkforceImportService`'s own `beginImportTask` ->
// `cancelAndCreateTask` sequence. These are two INDEPENDENTLY-raced resources (the `import_tasks`
// row and the pg-boss job row), not one primary and one redundant backstop -- there is a real
// window, between "we created a fresh PENDING task" and "we actually called
// `enqueueWorkforceImport`", during which a different concurrent request can complete its own full
// cancel-and-replace sequence and win the pg-boss slot first. The fix (found via the v4 load-test
// suite's rapid-fire-reupload script) is for the route-level caller to retry the WHOLE
// `beginImportTask` -> `enqueueWorkforceImport` sequence as one unit on EITHER a DB-level P2002 OR a
// pg-boss-level `null` return, not to treat them as two independent retry loops -- see
// `WorkforceImportService.beginImportTask`'s doc comment for the full sequence.
//
// `localConcurrency` on both queues is env-configurable rather than hardcoded to `1` -- see
// each `register*Worker` function below for why the right number differs sharply between the
// I/O-bound CSV queue and the CPU-bound roster-generation queue (design doc Part E.3).

import { PgBoss } from 'pg-boss';
import type { Job } from 'pg-boss';

export const QUEUES = {
  WORKFORCE_IMPORT: 'workforce-import',
  ROSTER_GENERATION: 'roster-generation',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Both job handlers are idempotent (import upserts by national_id; generation deletes-and-
 * rewrites the month's draft in one transaction) -- see the design doc's decision box -- so both
 * queues use the same retry policy. */
const RETRY_LIMIT = 2;

/** 06:00 on the 25th of every month -> auto-generate NEXT month's draft. Cron never publishes. */
export const NEXT_MONTH_CRON_SCHEDULE = '0 6 25 * *';

export interface WorkforceImportJobData {
  readonly csv: string;
  readonly companyId: number;
  readonly month: string;
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
// split and would only dedupe within one of those two states, not both.) Both queues use it:
// `roster-generation` keys on `<companyId>:<month>`, `workforce-import` keys on
// `<companyId>:WORKFORCE_SYNC` -- see the v4 design doc, Part A's "Queue-partitioning mechanism".

/**
 * pg-boss's own per-job "still running?" deadline -- independent of, and enforced entirely inside
 * Postgres by, pg-boss's own maintenance job, regardless of what `runSolver.ts`'s Node-side
 * `spawn(..., { timeout })` is set to. Left at pg-boss's built-in default (`expireInSeconds`,
 * 900s/15min -- see `QUEUE_DEFAULTS.expire_seconds` in `pg-boss`'s own `plans.js`) for EVERY queue
 * except `roster-generation` would silently kill a large-company solve at the 15-minute mark even
 * if the solver itself was on track to finish within its own legitimate, banded budget: the
 * largest band (`solve_roster.py#compute_time_budget_seconds`, >10,000 workers) allows CP-SAT up
 * to 1800s (30min) of search time, and `runSolver.ts`'s own Node-side kill timeout adds 5s of
 * headroom on top of that (`engine/timeBudget.ts#computeNodeSolverTimeoutMs`) -- so pg-boss's job
 * expiration must comfortably clear BOTH of those, not just the Node-side one, or pg-boss becomes
 * the thing that turns a would-be-successful largest-tier solve into a false failure instead of
 * the solver or Node ever getting the chance to. 2700s (45min) gives ~15 minutes of margin above
 * the 1805s (30min solver budget + 5s Node headroom) worst case -- comfortable room for Postgres
 * scheduling jitter, `RosterGenerationService`'s own pre-solve data-fetch/problem-build and
 * post-solve persist stages, and pg-boss's own supervise-interval polling granularity, without
 * being so large that a genuinely stuck/crashed job sits `active` for an unreasonable time before
 * pg-boss reclaims it.
 */
const ROSTER_GENERATION_EXPIRE_IN_SECONDS = 45 * 60;

/**
 * Idempotent: safe to call on every process start (API and worker both call it independently).
 * `createQueue` itself is `INSERT ... ON CONFLICT DO NOTHING` under the hood (pg-boss's
 * `create_queue` DB function) -- it silently no-ops on a queue row that already exists, it does
 * NOT reconcile that row's options to whatever was just passed. That matters here specifically:
 * this repo's `roster-generation` queue already exists (with pg-boss's built-in 900s
 * `expireInSeconds` default) in every environment that ran this function before
 * `ROSTER_GENERATION_EXPIRE_IN_SECONDS` was introduced, so `createQueue` alone would leave that
 * stale 900s value in place forever. The follow-up `updateQueue` call is what actually applies the
 * new value to an already-existing queue row (and is itself a no-op-equivalent -- an unconditional
 * `UPDATE ... SET expire_seconds = $value` -- on a queue that doesn't have this problem, e.g. a
 * brand new environment where `createQueue` just set it correctly).
 */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUES.WORKFORCE_IMPORT, { retryLimit: RETRY_LIMIT, policy: 'stately' });
  await boss.createQueue(QUEUES.ROSTER_GENERATION, {
    retryLimit: RETRY_LIMIT,
    policy: 'stately',
    expireInSeconds: ROSTER_GENERATION_EXPIRE_IN_SECONDS,
  });
  await boss.updateQueue(QUEUES.ROSTER_GENERATION, { expireInSeconds: ROSTER_GENERATION_EXPIRE_IN_SECONDS });
}

/**
 * `singletonKey = "<companyId>:WORKFORCE_SYNC"` -> pg-boss allows at most ONE queued/active
 * workforce-CSV-import job per company (matching `ImportTaskKind.WORKFORCE_SYNC`) -- a different
 * company's own workforce-CSV import is an unrelated job, not a collision. Deliberately NOT
 * scoped by month: an upload for a different month still supersedes an in-flight upload for the
 * same company, matching this app's pre-merge behavior for both source pipelines (neither prior
 * service's cancel-and-replace slot was ever month-scoped either). IMPORTANT: this key is
 * REQUIRED, not optional, on a `stately`-policy queue -- `stately`'s uniqueness index is on
 * `(name, state, COALESCE(singleton_key, ''))`, so a job sent with NO key doesn't bypass the
 * uniqueness constraint, it shares the SAME implicit empty-string key with every other keyless job
 * on this queue, which would make the whole queue globally single-flight ACROSS EVERY COMPANY, not
 * per-company. (Confirmed directly: an earlier attempt to drop this key entirely, on the theory
 * that the DB-level `import_tasks` partial unique index alone was sufficient, caused exactly that
 * regression -- different companies' uploads started blocking each other, worse than the bug it was
 * meant to fix. Never remove this without also either dropping the queue's `stately` policy or
 * switching to `standard` and re-adding some other per-company gate.)
 *
 * Returns `null` on a genuine collision (a non-terminal job already holds this company's slot).
 * The caller (`WorkforceImportService`'s route-level cancel-and-replace sequence) MUST treat a
 * `null` return the same way it treats a DB-level `import_tasks` unique-constraint violation -- as
 * a signal to retry the WHOLE `beginImportTask` -> `enqueueWorkforceImport` sequence, not a
 * terminal failure. These are two independently-raced resources (the `import_tasks` DB row and the
 * pg-boss job row) with a real window between "we created a fresh PENDING task" and "we actually
 * sent the job" during which a different concurrent request can win that same window -- see
 * `WorkforceImportService.beginImportTask`'s doc comment for the full sequence and why a single
 * retry layer covering both resources, not two independent ad hoc retries, is what actually closes
 * the race (found and fixed via the v4 load-test suite's rapid-fire-reupload script).
 */
export async function enqueueWorkforceImport(
  boss: PgBoss,
  companyId: number,
  csv: string,
  month: string,
): Promise<string | null> {
  await ensureBossStarted(boss);
  return boss.send(QUEUES.WORKFORCE_IMPORT, { csv, companyId, month } satisfies WorkforceImportJobData, {
    singletonKey: `${companyId}:WORKFORCE_SYNC`,
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
 * `workforce-import` is I/O-bound (mostly waiting on per-row DB transactions), so raising
 * `localConcurrency` well above `1` is safe and directly helps multiple *different* companies'
 * singleton slots run genuinely concurrently -- `singletonKey` still guarantees at most one
 * in-flight job per company. Default `8` is deliberately sized to not wildly outrun
 * `DB_POOL_SIZE_PRISMA`'s default (`10`): raising this past the Prisma pool size just means the
 * extra concurrent jobs queue up waiting for a free connection instead of gaining real
 * concurrency, so tune the two together, not independently -- see the v4 design doc, Part E.3.
 * Per-row cost roughly doubled by the Part G merge (one transaction now does upsert+availability-
 * replace instead of just one half), but it's still dominated by DB round-trips, not CPU, so this
 * default is unchanged -- worth revisiting under real load, no evidence to change now.
 *
 * The handler also receives this run's own pg-boss job id (`job.id`) as a second argument -- v4's
 * `WorkforceImportService.importCsv` uses it to adopt the specific `ImportTask` row the route's
 * `beginImportTask` created for this exact upload (matched via `ImportTask.pgBossJobId`), rather
 * than guessing which non-terminal task "belongs" to this run -- see
 * `jobs/workforceImport.job.ts`'s doc comment.
 */
export async function registerWorkforceImportWorker(
  boss: PgBoss,
  handler: (data: WorkforceImportJobData, jobId: string) => Promise<object>,
): Promise<void> {
  const localConcurrency = Number(process.env.WORKFORCE_IMPORT_CONCURRENCY ?? 8);
  await boss.work(QUEUES.WORKFORCE_IMPORT, { localConcurrency }, async (jobs: Job<WorkforceImportJobData>[]) => {
    const [job] = jobs;
    if (!job) throw new Error('pg-boss invoked the work handler with an empty job batch');
    return handler(job.data, job.id);
  });
}

/**
 * `roster-generation` is CPU-bound, and deliberately single-threaded per solve: `runSolver.ts`
 * spawns one Python `solve_roster.py` process per job, and the solver's determinism guarantee
 * (fixed seed) is achieved by constraining CP-SAT to effectively single-threaded search *within
 * one solve* -- a single solve does NOT get faster by throwing more cores at it. Multiple
 * *concurrent* solves (different companies) each only need one core, so overall throughput scales
 * with available CPU cores, not with an arbitrary queue number the way the I/O-bound CSV queue
 * does. `localConcurrency` here should therefore track (available CPU cores per worker replica,
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
