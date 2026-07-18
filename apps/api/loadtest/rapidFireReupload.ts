// Load-test 2/3 (v4 design doc, Part C): rapid-fire re-upload stress.
//
// One company, the SAME valid worker-CSV file uploaded K times as close together as the script
// can fire them (concurrently, not sequentially -- sequential awaits would trivially serialize
// through cancel-and-replace and never actually stress the race). Polls `GET
// /api/import-tasks/active` until settled, then asserts only ONE of the K tasks ever reaches
// COMPLETED (the rest CANCELLED) and the `Worker` table ends up matching the file exactly -- a
// throughput-level companion to Phase A3's precise Vitest concurrency test (that test proves
// correctness under one controlled race; this proves it holds under real, uncontrolled timing).
//
// Requires a running dev stack -- see `apps/api/loadtest/README.md`.
// Run: `pnpm --filter @rostering/api exec tsx loadtest/rapidFireReupload.ts`

import {
  API_BASE_URL,
  buildWorkerCsv,
  checkStackReachable,
  createLoadtestCompany,
  disconnectPrisma,
  fmtMs,
  getPrisma,
  makeSyntheticWorkerRows,
  RUN_SALT,
  sleep,
  uploadWorkersCsv,
  writeTempCsv,
  section,
  type LoadtestWorkerRow,
} from './shared.js';

const REUPLOAD_COUNT = Number(process.env.LOADTEST_REUPLOAD_COUNT ?? 10);
const ROWS_PER_FILE = Number(process.env.LOADTEST_REUPLOAD_ROWS ?? 50);
/** Disjoint from every other script's/fixture's national-ID prefix range in this repo; `RUN_SALT`
 * keeps repeated runs against the same persistent dev Postgres from colliding with each other. */
const PREFIX_BASE = 4_000_000 + RUN_SALT;

async function pollActiveTaskUntilNull(companyId: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${API_BASE_URL}/api/import-tasks/active?companyId=${companyId}&kind=WORKER_SYNC`);
    const body = await response.json();
    if (body === null) return;
    if (Date.now() > deadline) {
      throw new Error(`GET /api/import-tasks/active for company ${companyId} never settled within ${timeoutMs}ms`);
    }
    await sleep(150);
  }
}

async function main(): Promise<void> {
  await checkStackReachable();
  const prisma = getPrisma();

  section('Seeding one company');
  const companyId = await createLoadtestCompany(prisma, `Loadtest Rapid Reupload ${Date.now()}`);
  console.log(`company: ${companyId}`);

  const rows: LoadtestWorkerRow[] = makeSyntheticWorkerRows(ROWS_PER_FILE, PREFIX_BASE);
  const csvPath = writeTempCsv(buildWorkerCsv(rows), `rapid-fire-${companyId}.csv`);

  section(`Firing ${REUPLOAD_COUNT} concurrent re-uploads of the SAME file`);
  const runStart = new Date();
  const fireStart = Date.now();
  const uploads = await Promise.all(
    Array.from({ length: REUPLOAD_COUNT }, () => uploadWorkersCsv(companyId, csvPath)),
  );
  console.log(`fired ${REUPLOAD_COUNT} uploads in ${fmtMs(Date.now() - fireStart)}`);

  const accepted = uploads.filter((u) => u.statusCode === 202);
  const conflicted = uploads.filter((u) => u.statusCode === 409);
  const other = uploads.filter((u) => u.statusCode !== 202 && u.statusCode !== 409);
  console.log(`  202 accepted: ${accepted.length}, 409 conflict (genuine singleton-slot race): ${conflicted.length}, other: ${other.length}`);
  if (other.length > 0) {
    console.error('FAIL: unexpected response status codes:', other);
    process.exitCode = 1;
    return;
  }

  section('Polling /api/import-tasks/active until settled');
  await pollActiveTaskUntilNull(companyId);

  const tasks = await prisma.importTask.findMany({
    where: { companyId, kind: 'WORKER_SYNC', createdAt: { gte: runStart } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\n${tasks.length} ImportTask row(s) created by this run:`);
  for (const t of tasks) {
    console.log(`  id=${t.id} status=${t.status} pgBossJobId=${t.pgBossJobId}`);
  }

  const completed = tasks.filter((t) => t.status === 'COMPLETED');
  const cancelled = tasks.filter((t) => t.status === 'CANCELLED');
  const failed = tasks.filter((t) => t.status === 'FAILED');
  const stillNonTerminal = tasks.filter((t) => t.status === 'PENDING' || t.status === 'PROCESSING');

  let ok = true;
  if (completed.length !== 1) {
    console.error(`FAIL: expected exactly 1 COMPLETED task, got ${completed.length}`);
    ok = false;
  }
  if (stillNonTerminal.length > 0) {
    console.error(`FAIL: ${stillNonTerminal.length} task(s) stuck non-terminal after settling:`, stillNonTerminal);
    ok = false;
  }
  if (failed.length > 0) {
    console.error(`FAIL: ${failed.length} task(s) unexpectedly FAILED (should be COMPLETED or CANCELLED only):`, failed);
    ok = false;
  }
  console.log(`\ncompleted=${completed.length} cancelled=${cancelled.length} failed=${failed.length}`);

  section('Verifying final Worker table matches the uploaded file exactly');
  const finalWorkers = await prisma.worker.findMany({
    where: { companyId },
    include: { contract: true },
    orderBy: { nationalId: 'asc' },
  });
  const expectedByNationalId = new Map(rows.map((r) => [r.nationalId, r]));
  if (finalWorkers.length !== rows.length) {
    console.error(`FAIL: expected ${rows.length} workers, found ${finalWorkers.length}`);
    ok = false;
  }
  for (const worker of finalWorkers) {
    const expected = expectedByNationalId.get(worker.nationalId);
    if (!expected) {
      console.error(`FAIL: unexpected worker nationalId ${worker.nationalId} not in the uploaded file`);
      ok = false;
      continue;
    }
    const expectedRole = expected.role === 'General Guard' ? 'GENERAL_GUARD' : expected.role === 'Supervisor' ? 'SUPERVISOR' : 'SCREENER';
    if (worker.role !== expectedRole || worker.name !== expected.name) {
      console.error(`FAIL: worker ${worker.nationalId} field mismatch (name=${worker.name}, role=${worker.role})`);
      ok = false;
    }
  }

  if (completed.length === 1) {
    const winningTask = completed[0];
    if (!winningTask) throw new Error('unreachable');
    const staleStamped = await prisma.worker.count({
      where: { companyId, lastImportTaskId: { in: cancelled.map((t) => t.id) } },
    });
    if (staleStamped > 0) {
      console.error(`FAIL: ${staleStamped} worker(s) stamped with a CANCELLED task's id`);
      ok = false;
    }
    const wrongStamped = await prisma.worker.count({
      where: { companyId, NOT: { lastImportTaskId: winningTask.id } },
    });
    if (wrongStamped > 0) {
      console.error(`FAIL: ${wrongStamped} worker(s) NOT stamped with the winning COMPLETED task's id`);
      ok = false;
    }
  }

  if (!ok) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nPASS: of ${REUPLOAD_COUNT} rapid-fire re-uploads, exactly 1 task reached COMPLETED, the rest CANCELLED, ` +
      `and the Worker table matches the file exactly with every worker stamped by the winning task.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error('rapidFireReupload failed:', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
