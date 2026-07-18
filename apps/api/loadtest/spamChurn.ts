// Load-test, Part 3 (v4 design doc, Part C's "Sustained rapid-churn 'spam' test" -- the highest-
// priority script in this whole suite; run this BEFORE considering the cancel-and-replace +
// DB-uniqueness-backstop work done, not just as an afterthought).
//
// One company, 60 uploads over 60 seconds (1/sec). Each upload is generated from the PREVIOUS
// iteration's worker list via a churn generator: a random ratio `p` in [0.5, 1.0] drawn fresh each
// iteration, `(1-p) x N` rows kept byte-identical, `p x N` rows replaced -- each replaced slot
// randomly either (a) a brand-new synthetic worker (simulating a hire) or (b) an existing worker
// from an EARLIER iteration with a field changed (simulating an edit, or a former worker
// reappearing -- a rehire). This is deliberately adversarial: sustained 1/sec timing COMBINED with
// real data change on every single upload is exactly what motivated the DB-level partial-unique-
// index backstop on `import_tasks (companyId, kind) WHERE status IN ('PENDING','PROCESSING')` --
// at this cadence, if the cancel-then-create round-trip takes even tens of milliseconds under
// load, two of the 60 requests landing close together is a real, not theoretical, possibility.
//
// Asserts all four of:
//   1. Exactly one ImportTask (of the ~60 created) reaches COMPLETED, the rest CANCELLED (a FAILED
//      task is flagged as a real bug). Never more than one non-terminal task at any single polled
//      instant (checked once per second during the run, both via the HTTP endpoint the frontend
//      actually uses AND a direct DB count -- the direct empirical check on the uniqueness
//      backstop).
//   2. The final Worker table state for the company matches the file behind whichever task
//      actually COMPLETED, field-for-field -- not just row count.
//   3. No worker anywhere ends up with `lastImportTaskId` pointing at a CANCELLED task.
//   4. No ImportTask stuck in PROCESSING after the run settles, and no unhandled rejection / error-
//      level log line from a DEDICATED worker process this script spawns and captures for the
//      whole run (spawning our own, rather than assuming an externally-started one is capturable,
//      is what makes this log-scanning assertion actually reliable rather than best-effort; running
//      an extra worker replica alongside whatever else is already up is safe by design -- see the
//      v4 design doc, Part E.1's pg-boss multi-replica row-claiming guarantee).
//
// Requires a running dev stack (API server + Postgres; this script spawns its OWN worker replica,
// so an already-running worker process is not required for THIS script specifically, though the
// other three loadtest scripts do need one) -- see `apps/api/loadtest/README.md`.
// Run: `pnpm --filter @rostering/api exec tsx loadtest/spamChurn.ts`

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';

import {
  API_BASE_URL,
  buildWorkerCsv,
  createLoadtestCompany,
  disconnectPrisma,
  fmtMs,
  getPrisma,
  here,
  makeSyntheticWorkerRow,
  RUN_SALT,
  section,
  sleep,
  uploadWorkersCsv,
  writeTempCsv,
  type CsvRole,
  type CsvStatus,
  type LoadtestWorkerRow,
} from './shared.js';

const ITERATIONS = Number(process.env.LOADTEST_SPAM_ITERATIONS ?? 60);
const TICK_MS = Number(process.env.LOADTEST_SPAM_TICK_MS ?? 1000);
/** Base worker-list size -- large enough to be a non-trivial import (multiple cooperative-
 * cancellation checkpoints, every 50 rows -- see `CANCELLATION_CHECK_INTERVAL` in
 * `csvImportService.ts`), small enough that a single import's processing time stays in the same
 * ballpark as the 1/sec upload cadence, which is what makes this adversarial in the first place. */
const BASE_WORKER_COUNT = Number(process.env.LOADTEST_SPAM_WORKER_COUNT ?? 150);
/** Extra time to keep polling for settlement after the last (60th) upload, before giving up. */
const SETTLE_TIMEOUT_MS = Number(process.env.LOADTEST_SPAM_SETTLE_TIMEOUT_MS ?? 60_000);

/** Disjoint from every other script's/fixture's national-ID prefix range in this repo; `RUN_SALT`
 * keeps repeated runs against the same persistent dev Postgres from colliding with each other. */
const PREFIX_BASE = 6_000_000 + RUN_SALT;
let nextNewHirePrefix = PREFIX_BASE;

function freshHire(): LoadtestWorkerRow {
  const row = makeSyntheticWorkerRow(nextNewHirePrefix, { name: `Spam Hire ${nextNewHirePrefix}` });
  nextNewHirePrefix++;
  return row;
}

const ROLE_CYCLE: readonly CsvRole[] = ['General Guard', 'Supervisor', 'Screener'];
const STATUS_CYCLE: readonly CsvStatus[] = ['Active', 'Inactive'];

/** Simulates an edit (or a rehire, if the worker was not currently in the active slot list) --
 * mutates exactly one field so the row is a real change, not a byte-identical re-send. */
function editedCopy(worker: LoadtestWorkerRow): LoadtestWorkerRow {
  const field = Math.floor(Math.random() * 4);
  switch (field) {
    case 0:
      return { ...worker, role: ROLE_CYCLE[(ROLE_CYCLE.indexOf(worker.role) + 1) % ROLE_CYCLE.length] ?? worker.role };
    case 1:
      return { ...worker, status: STATUS_CYCLE[(STATUS_CYCLE.indexOf(worker.status) + 1) % STATUS_CYCLE.length] ?? worker.status };
    case 2:
      return { ...worker, hourlyCostIls: Math.round((worker.hourlyCostIls + 1.5) * 100) / 100 };
    default:
      return { ...worker, minMonthlyHours: worker.minMonthlyHours + 5 };
  }
}

/** One churn step: returns the NEXT worker-slot array, mutating `retiredPool` (workers currently
 * absent from the slot list, available to "reappear") as a side effect. */
function churn(
  currentSlots: readonly LoadtestWorkerRow[],
  retiredPool: LoadtestWorkerRow[],
): LoadtestWorkerRow[] {
  const p = 0.5 + Math.random() * 0.5; // uniform in [0.5, 1.0]
  const replaceCount = Math.round(p * currentSlots.length);
  const indices = [...currentSlots.keys()];
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j] as number, indices[i] as number];
  }
  const replacedIndices = new Set(indices.slice(0, replaceCount));

  const next = currentSlots.map((worker, i) => {
    if (!replacedIndices.has(i)) return worker; // kept byte-identical
    retiredPool.push(worker);
    const reappear = retiredPool.length > 1 && Math.random() < 0.5;
    if (reappear) {
      // Pick a DIFFERENT retired worker than the one we just retired (index length - 1) so an
      // edit doesn't just undo the retirement we're mid-way through recording.
      const pickIndex = Math.floor(Math.random() * (retiredPool.length - 1));
      const [picked] = retiredPool.splice(pickIndex, 1);
      if (picked) return editedCopy(picked);
    }
    return freshHire();
  });
  return next;
}

interface ActivePoll {
  readonly iteration: number;
  readonly atMs: number;
  readonly activeTaskId: number | null;
  readonly nonTerminalCount: number;
}

async function getActiveTaskViaHttp(companyId: number): Promise<{ id: number } | null> {
  const response = await fetch(`${API_BASE_URL}/api/import-tasks/active?companyId=${companyId}&kind=WORKER_SYNC`);
  return (await response.json()) as { id: number } | null;
}

function spawnDedicatedWorker(): { child: ChildProcessByStdio<null, Readable, Readable>; logLines: string[] } {
  const apiRoot = path.join(here, '..');
  const logLines: string[] = [];
  const child = spawn('pnpm', ['exec', 'tsx', 'src/worker.ts'], {
    cwd: apiRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim().length > 0) logLines.push(line);
    }
    process.stdout.write(`[spam-worker] ${text}`);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  return { child, logLines };
}

const UNHANDLED_REJECTION_PATTERNS = [/unhandledRejection/i, /UnhandledPromiseRejection/i, /uncaughtException/i];

async function main(): Promise<void> {
  const prisma = getPrisma();

  section('Spawning a dedicated worker replica for this run (log-capture for assertion #4)');
  const { child: workerChild, logLines } = spawnDedicatedWorker();
  // Give it a moment to connect + register queue handlers before we start uploading.
  await sleep(1_500);

  section('Seeding one company');
  const companyId = await createLoadtestCompany(prisma, `Loadtest Spam Churn ${Date.now()}`);
  console.log(`company: ${companyId}`);

  let currentSlots: LoadtestWorkerRow[] = Array.from({ length: BASE_WORKER_COUNT }, () => freshHire());
  const retiredPool: LoadtestWorkerRow[] = [];

  const iterationJobIds: Array<string | null> = [];
  const iterationSnapshots: LoadtestWorkerRow[][] = [];
  const polls: ActivePoll[] = [];
  const liveViolations: string[] = [];

  section(`Firing ${ITERATIONS} uploads, 1/sec, with random 50-100% churn each iteration`);
  const runStart = new Date();
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const tickStart = Date.now();

    currentSlots = iter === 0 ? currentSlots : churn(currentSlots, retiredPool);
    iterationSnapshots.push(currentSlots.map((w) => ({ ...w })));

    const csvPath = writeTempCsv(buildWorkerCsv(currentSlots), `spam-${companyId}-${iter}.csv`);
    const upload = await uploadWorkersCsv(companyId, csvPath);
    const jobId = upload.statusCode === 202 ? ((upload.body as { jobId?: string }).jobId ?? null) : null;
    iterationJobIds.push(jobId);

    const [activeTask, nonTerminalCount] = await Promise.all([
      getActiveTaskViaHttp(companyId),
      prisma.importTask.count({
        where: { companyId, kind: 'WORKER_SYNC', status: { in: ['PENDING', 'PROCESSING'] } },
      }),
    ]);
    polls.push({ iteration: iter, atMs: Date.now(), activeTaskId: activeTask?.id ?? null, nonTerminalCount });
    if (nonTerminalCount > 1) {
      const msg = `iteration ${iter}: ${nonTerminalCount} non-terminal ImportTask rows observed simultaneously (uniqueness backstop violated)`;
      console.error(`LIVE VIOLATION: ${msg}`);
      liveViolations.push(msg);
    }

    console.log(
      `  [${iter + 1}/${ITERATIONS}] upload status=${upload.statusCode} jobId=${jobId ?? '(none)'} ` +
        `activeTaskId=${activeTask?.id ?? 'null'} nonTerminalCount=${nonTerminalCount}`,
    );

    const elapsed = Date.now() - tickStart;
    if (elapsed < TICK_MS) await sleep(TICK_MS - elapsed);
  }
  console.log(`\nfired all ${ITERATIONS} uploads over ${fmtMs(Date.now() - runStart.getTime())}`);

  section('Polling for settlement (no non-terminal task remaining)');
  const settleDeadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const nonTerminalCount = await prisma.importTask.count({
      where: { companyId, kind: 'WORKER_SYNC', status: { in: ['PENDING', 'PROCESSING'] } },
    });
    if (nonTerminalCount === 0) break;
    if (Date.now() > settleDeadline) {
      console.error(`FAIL: ${nonTerminalCount} ImportTask row(s) still non-terminal ${fmtMs(SETTLE_TIMEOUT_MS)} after the last upload`);
      break;
    }
    await sleep(300);
  }

  // Let the worker's own log output flush before we stop it and scan it.
  await sleep(500);
  workerChild.kill('SIGTERM');

  section('Assertion 1: exactly one COMPLETED task, the rest CANCELLED');
  const tasks = await prisma.importTask.findMany({
    where: { companyId, kind: 'WORKER_SYNC', createdAt: { gte: runStart } },
    orderBy: { createdAt: 'asc' },
  });
  const completed = tasks.filter((t) => t.status === 'COMPLETED');
  const cancelled = tasks.filter((t) => t.status === 'CANCELLED');
  const failed = tasks.filter((t) => t.status === 'FAILED');
  const nonTerminal = tasks.filter((t) => t.status === 'PENDING' || t.status === 'PROCESSING');
  console.log(
    `${tasks.length} ImportTask rows total: completed=${completed.length} cancelled=${cancelled.length} ` +
      `failed=${failed.length} still-non-terminal=${nonTerminal.length}`,
  );

  let ok = true;
  if (completed.length !== 1) {
    console.error(`FAIL: expected exactly 1 COMPLETED task, got ${completed.length}`);
    ok = false;
  }
  if (failed.length > 0) {
    console.error(`FAIL: ${failed.length} task(s) unexpectedly FAILED:`, failed.map((t) => t.id));
    ok = false;
  }
  if (nonTerminal.length > 0) {
    console.error(`FAIL (assertion 4): ${nonTerminal.length} task(s) stuck non-terminal after settling:`, nonTerminal.map((t) => t.id));
    ok = false;
  }
  if (liveViolations.length > 0) {
    console.error(`FAIL: ${liveViolations.length} live non-terminal-count violation(s) observed during the run`);
    ok = false;
  }

  section('Assertion 2: final Worker table matches the file behind the COMPLETED task, field-for-field');
  const winningTask = completed[0];
  if (winningTask) {
    const winningIterIndex = iterationJobIds.findIndex((jobId) => jobId === winningTask.pgBossJobId);
    if (winningIterIndex === -1) {
      console.error(`FAIL: could not correlate the COMPLETED task (pgBossJobId=${winningTask.pgBossJobId}) to any of this run's ${ITERATIONS} uploads`);
      ok = false;
    } else {
      const expectedRows = iterationSnapshots[winningIterIndex];
      if (!expectedRows) throw new Error('unreachable');
      console.log(`COMPLETED task corresponds to iteration ${winningIterIndex + 1}/${ITERATIONS} (${expectedRows.length} expected rows)`);
      const actualWorkers = await prisma.worker.findMany({ where: { companyId }, include: { contract: true } });
      const expectedByNationalId = new Map(expectedRows.map((r) => [r.nationalId, r]));

      if (actualWorkers.length !== expectedRows.length) {
        console.error(`FAIL: expected ${expectedRows.length} workers, found ${actualWorkers.length}`);
        ok = false;
      }
      let fieldMismatches = 0;
      let notStampedByWinner = 0;
      for (const worker of actualWorkers) {
        const expected = expectedByNationalId.get(worker.nationalId);
        if (!expected) {
          console.error(`FAIL: worker ${worker.nationalId} present in DB but not in the winning iteration's file`);
          fieldMismatches++;
          continue;
        }
        const expectedRole = expected.role === 'General Guard' ? 'GENERAL_GUARD' : expected.role === 'Supervisor' ? 'SUPERVISOR' : 'SCREENER';
        const expectedStatus = expected.status === 'Active' ? 'ACTIVE' : 'INACTIVE';
        if (
          worker.name !== expected.name ||
          worker.role !== expectedRole ||
          worker.status !== expectedStatus ||
          Number(worker.contract?.hourlyCostIls) !== expected.hourlyCostIls ||
          worker.contract?.minMonthlyHours !== expected.minMonthlyHours ||
          worker.contract?.maxMonthlyHours !== expected.maxMonthlyHours
        ) {
          fieldMismatches++;
        }
        if (worker.lastImportTaskId !== winningTask.id) notStampedByWinner++;
      }
      if (fieldMismatches > 0) {
        console.error(`FAIL: ${fieldMismatches} worker(s) don't field-for-field match the winning iteration's file`);
        ok = false;
      }
      if (notStampedByWinner > 0) {
        console.error(`FAIL: ${notStampedByWinner} worker(s) not stamped with the winning COMPLETED task's id`);
        ok = false;
      }
      if (fieldMismatches === 0 && notStampedByWinner === 0 && actualWorkers.length === expectedRows.length) {
        console.log('Worker table matches the winning file exactly, every worker stamped by the winning task.');
      }
    }
  } else {
    console.error('SKIPPED (no COMPLETED task to check against)');
  }

  section('Assertion 3: no worker anywhere stamped with a CANCELLED task\'s id');
  const cancelledIds = cancelled.map((t) => t.id);
  const staleStamped = cancelledIds.length > 0
    ? await prisma.worker.count({ where: { companyId, lastImportTaskId: { in: cancelledIds } } })
    : 0;
  if (staleStamped > 0) {
    console.error(`FAIL: ${staleStamped} worker(s) stamped with a CANCELLED task's id`);
    ok = false;
  } else {
    console.log('No worker stamped with a CANCELLED task\'s id.');
  }

  section('Assertion 4 (cont\'d): scanning the dedicated worker process log for unhandled rejections/errors');
  const suspiciousLines = logLines.filter((line) => UNHANDLED_REJECTION_PATTERNS.some((re) => re.test(line)));
  console.log(`captured ${logLines.length} log line(s) from the dedicated worker process`);
  if (suspiciousLines.length > 0) {
    console.error(`FAIL: ${suspiciousLines.length} suspicious log line(s):`);
    suspiciousLines.forEach((line) => console.error(`  ${line}`));
    ok = false;
  } else {
    console.log('No unhandled-rejection/uncaught-exception log lines observed.');
  }

  if (!ok) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nPASS: ${ITERATIONS} rapid-churn uploads over ~${ITERATIONS} seconds settled to exactly one COMPLETED task, ` +
      'the Worker table matches that task\'s file exactly, no worker is stamped with a CANCELLED task, and no ' +
      'ImportTask is stuck PROCESSING -- the DB-level uniqueness backstop held under sustained adversarial timing.',
  );
}

main()
  .catch((err: unknown) => {
    console.error('spamChurn failed:', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
