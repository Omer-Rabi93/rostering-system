// Load-test 3/3 (v4 design doc, Part C): large-file responsiveness.
//
// One company: start uploading a near-`MAX_ROWS` file, then -- shortly after, while it is very
// likely still `PROCESSING` -- fire a second, small, valid upload for the SAME company. Asserts
// the SECOND upload's task reaches COMPLETED within a bounded time (not "after the whole large
// file finishes") -- the direct proof that cooperative cancellation (re-reading `ImportTask`
// status every ~50 rows inside the row loop, see `csvImportService.ts`) is actually RESPONSIVE
// under load, not just eventually-consistent. Also asserts the large file's own task ends up
// CANCELLED, never COMPLETED, since it was genuinely superseded mid-flight.
//
// Requires a running dev stack -- see `apps/api/loadtest/README.md`.
// Run: `pnpm --filter @rostering/api exec tsx loadtest/largeFileResponsiveness.ts`

import {
  buildWorkerCsv,
  checkStackReachable,
  createLoadtestCompany,
  disconnectPrisma,
  fmtMs,
  getPrisma,
  makeSyntheticWorkerRows,
  pollTaskUntilSettled,
  RUN_SALT,
  section,
  sleep,
  uploadWorkersCsv,
  writeTempCsv,
} from './shared.js';

/** MAX_ROWS (routes/importExport.ts) is 10,000 -- "near" it, not AT it, so there is real per-row
 * processing time left for the second upload to interrupt mid-flight (an exactly-MAX_ROWS run is
 * covered by the `tests/fixtures/csv/max-rows*.csv` fixtures + `csvFixtures.test.ts` instead).
 * Large enough that, even at a fast few-ms-per-row rate, processing takes tens of seconds -- long
 * enough to reliably still be PROCESSING when the second upload lands. */
const LARGE_FILE_ROWS = Number(process.env.LOADTEST_LARGE_FILE_ROWS ?? 8000);
const SMALL_FILE_ROWS = Number(process.env.LOADTEST_SMALL_FILE_ROWS ?? 5);
/** How long to wait after the large file's upload is ack'd before firing the small one -- long
 * enough that the worker process has definitely picked the job up and started the row loop, short
 * enough to stay comfortably inside "still PROCESSING" for an 8000-row file. */
const HEAD_START_MS = Number(process.env.LOADTEST_HEAD_START_MS ?? 500);
/** The bound the whole test is about: the SECOND (small) upload's own task must reach COMPLETED
 * within this many ms of being enqueued -- proving responsiveness, not eventual completion after
 * the large file's own (much longer) run finishes. */
const RESPONSIVENESS_BUDGET_MS = Number(process.env.LOADTEST_RESPONSIVENESS_BUDGET_MS ?? 8_000);

/** Disjoint from every other script's/fixture's national-ID prefix range in this repo; `RUN_SALT`
 * keeps repeated runs against the same persistent dev Postgres from colliding with each other. */
const LARGE_PREFIX_BASE = 5_000_000 + RUN_SALT;
const SMALL_PREFIX_BASE = 5_500_000 + RUN_SALT;

async function main(): Promise<void> {
  await checkStackReachable();
  const prisma = getPrisma();

  section('Seeding one company');
  const companyId = await createLoadtestCompany(prisma, `Loadtest Large File Responsiveness ${Date.now()}`);
  console.log(`company: ${companyId}`);

  const largeRows = makeSyntheticWorkerRows(LARGE_FILE_ROWS, LARGE_PREFIX_BASE);
  const largeCsvPath = writeTempCsv(buildWorkerCsv(largeRows), `large-${companyId}.csv`);
  const smallRows = makeSyntheticWorkerRows(SMALL_FILE_ROWS, SMALL_PREFIX_BASE);
  const smallCsvPath = writeTempCsv(buildWorkerCsv(smallRows), `small-${companyId}.csv`);

  section(`Uploading the large file (${LARGE_FILE_ROWS} rows)`);
  const largeUpload = await uploadWorkersCsv(companyId, largeCsvPath);
  if (largeUpload.statusCode !== 202) {
    throw new Error(`large-file upload was not accepted: ${largeUpload.statusCode} ${JSON.stringify(largeUpload.body)}`);
  }
  const largeJobId = (largeUpload.body as { jobId?: string }).jobId;
  if (!largeJobId) throw new Error(`large-file upload response had no jobId: ${JSON.stringify(largeUpload.body)}`);
  console.log(`large-file upload accepted, jobId=${largeJobId}`);

  section(`Waiting ${HEAD_START_MS}ms for it to start PROCESSING`);
  await sleep(HEAD_START_MS);
  const largeTask = await prisma.importTask.findFirstOrThrow({
    where: { companyId, kind: 'WORKER_SYNC', pgBossJobId: largeJobId },
  });
  console.log(`large-file task ${largeTask.id} status after head start: ${largeTask.status}`);
  if (largeTask.status !== 'PROCESSING') {
    console.warn(
      `WARNING: large-file task was already "${largeTask.status}" (not PROCESSING) before the second upload -- ` +
        `either it finished unexpectedly fast, or the worker process hasn't picked it up yet. The test can still ` +
        `run, but this weakens the "interrupted mid-flight" proof; consider raising LOADTEST_LARGE_FILE_ROWS or ` +
        `lowering LOADTEST_HEAD_START_MS.`,
    );
  }

  section(`Uploading the small file (${SMALL_FILE_ROWS} rows) for the SAME company`);
  const smallUploadStart = Date.now();
  const smallUpload = await uploadWorkersCsv(companyId, smallCsvPath);
  if (smallUpload.statusCode !== 202) {
    throw new Error(`small-file upload was not accepted: ${smallUpload.statusCode} ${JSON.stringify(smallUpload.body)}`);
  }
  const smallJobId = (smallUpload.body as { jobId?: string }).jobId;
  if (!smallJobId) throw new Error(`small-file upload response had no jobId: ${JSON.stringify(smallUpload.body)}`);
  console.log(`small-file upload accepted, jobId=${smallJobId}`);
  const smallTask = await prisma.importTask.findFirstOrThrow({
    where: { companyId, kind: 'WORKER_SYNC', pgBossJobId: smallJobId },
  });

  section('Waiting for the SECOND (small) upload\'s task to reach COMPLETED');
  const settleStart = Date.now();
  const settledSmallTask = await pollTaskUntilSettled(prisma, smallTask.id, {
    timeoutMs: RESPONSIVENESS_BUDGET_MS + 5_000, // give the poll itself a little slack over the hard budget below
    intervalMs: 100,
  });
  const smallSettleMs = Date.now() - settleStart;
  const smallTotalMs = Date.now() - smallUploadStart;
  console.log(`small-file task settled as ${settledSmallTask.status} in ${fmtMs(smallSettleMs)} (${fmtMs(smallTotalMs)} since its own upload)`);

  section('Verifying the large file\'s task was superseded, not left to finish');
  const settledLargeTask = await prisma.importTask.findUniqueOrThrow({ where: { id: largeTask.id } });
  console.log(`large-file task final status: ${settledLargeTask.status}`);

  let ok = true;
  if (settledSmallTask.status !== 'COMPLETED') {
    console.error(`FAIL: small-file task ended as ${settledSmallTask.status}, expected COMPLETED`);
    ok = false;
  }
  if (smallSettleMs > RESPONSIVENESS_BUDGET_MS) {
    console.error(
      `FAIL: small-file task took ${fmtMs(smallSettleMs)} to settle, exceeding the ${fmtMs(RESPONSIVENESS_BUDGET_MS)} ` +
        `responsiveness budget -- cooperative cancellation does not appear to be interrupting the large file promptly.`,
    );
    ok = false;
  }
  if (settledLargeTask.status !== 'CANCELLED') {
    console.error(`FAIL: large-file task ended as ${settledLargeTask.status}, expected CANCELLED (superseded)`);
    ok = false;
  }
  const staleStamped = await prisma.worker.count({ where: { companyId, lastImportTaskId: largeTask.id } });
  if (staleStamped > 0) {
    console.error(`FAIL: ${staleStamped} worker(s) stamped with the CANCELLED large-file task's id`);
    ok = false;
  }

  if (!ok) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nPASS: the second, small upload completed in ${fmtMs(smallSettleMs)} (budget ${fmtMs(RESPONSIVENESS_BUDGET_MS)}) while ` +
      `the large (${LARGE_FILE_ROWS}-row) upload for the same company was still mid-flight, and the superseded ` +
      `large-file task ended CANCELLED, never COMPLETED.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error('largeFileResponsiveness failed:', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
