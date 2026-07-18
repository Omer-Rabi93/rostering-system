// Load-test: roster-generation / solver concurrency proof.
//
// Two things this script proves against a REAL running dev stack (API + worker + Postgres),
// exercising the actual CP-SAT Python subprocess (`apps/api/src/engine/runSolver.ts`), not a fake
// solve function:
//
//   1. Per-(company, month) singleton: firing two concurrent `POST /api/rosters/generate`
//      requests for the SAME company+month must yield exactly one 202 (real job enqueued) and one
//      409 `{ reason: 'generation-in-progress' }` (pg-boss `singletonKey` collision, see
//      `enqueueRosterGeneration` in `src/jobs/queue.ts`) -- never two 202s, never a raw 500.
//   2. Cross-company concurrency cap: firing N DIFFERENT companies' generate requests concurrently
//      must never run more than `ROSTER_GENERATION_CONCURRENCY` (default 2, see
//      `registerRosterGenerationWorker`) solver subprocesses at once system-wide, even though each
//      company's own `singletonKey` is independent -- proven by sampling `pgboss.job`'s own
//      `state` column directly while the batch is in flight, not just inferred from timing.
//
// Requires a running dev stack -- see `apps/api/loadtest/README.md`. Additionally requires the
// worker process to actually be ABLE to run the real solver: either `SOLVER_PYTHON_PATH` pointed
// at `solver/.venv/bin/python3`, or a plain `python3` on `PATH` with the OR-Tools dependency
// installed -- see `solver/README.md`. Without that, every generate job settles `failed` instead
// of `completed` and this script's assertions correctly flag it as such (not silently skipped).
//
// Run: `pnpm --filter @rostering/api exec tsx loadtest/rosterGenerationLoad.ts`

import {
  checkStackReachable,
  disconnectPrisma,
  fmtMs,
  getPrisma,
  pollGenerationJobUntilSettled,
  postRosterGenerate,
  RUN_SALT,
  section,
  seedSingleWorkerCompanyForRoster,
  sleep,
  type SeededRosterCompany,
} from './shared.js';

const COMPANY_COUNT = Number(process.env.LOADTEST_ROSTER_COMPANY_COUNT ?? 6);
const MONTH = process.env.LOADTEST_ROSTER_MONTH ?? '2027-03';
/** Must match the value the ALREADY-RUNNING worker process was actually started with
 * (`ROSTER_GENERATION_CONCURRENCY`, default 2 -- see `registerRosterGenerationWorker`) -- this
 * script only OBSERVES the worker's behavior, it cannot configure a process it didn't start. */
const EXPECTED_CONCURRENCY = Number(process.env.ROSTER_GENERATION_CONCURRENCY ?? 2);
/** How often to sample `pgboss.job`'s active-row count while a batch is in flight. */
const SAMPLE_INTERVAL_MS = 75;
/** Disjoint from every other script's national-ID prefix range in this repo (3M/4M/5M/5.5M/6M are
 * already taken by crossCompanyNonBlocking/rapidFireReupload/largeFileResponsiveness/spamChurn). */
const PREFIX_BASE = 7_000_000 + RUN_SALT;

async function main(): Promise<void> {
  await checkStackReachable();
  const prisma = getPrisma();

  section('Singleton proof: seeding one company');
  const singleton = await seedSingleWorkerCompanyForRoster(
    prisma,
    `Loadtest Roster Singleton ${Date.now()}`,
    PREFIX_BASE,
    MONTH,
  );
  console.log(`company: ${singleton.companyId}`);

  section(`Firing 2 concurrent generate requests for company ${singleton.companyId}, month ${MONTH}`);
  const [respA, respB] = await Promise.all([
    postRosterGenerate(singleton.companyId, MONTH),
    postRosterGenerate(singleton.companyId, MONTH),
  ]);
  console.log('response A:', respA.statusCode, respA.body);
  console.log('response B:', respB.statusCode, respB.body);

  const accepted = [respA, respB].filter((r) => r.statusCode === 202);
  const conflicted = [respA, respB].filter((r) => r.statusCode === 409 && r.body.reason === 'generation-in-progress');
  if (accepted.length !== 1 || conflicted.length !== 1) {
    console.error(
      'FAIL: expected exactly one 202 and one 409 (reason: generation-in-progress) for two concurrent ' +
        'generate requests on the SAME company+month -- got',
      { respA, respB },
    );
    process.exitCode = 1;
    return;
  }
  const winningJobId = accepted[0]?.body.jobId;
  if (!winningJobId) {
    console.error('FAIL: the accepted (202) response had no jobId', accepted[0]);
    process.exitCode = 1;
    return;
  }
  const singletonResult = await pollGenerationJobUntilSettled(winningJobId);
  if (singletonResult.state !== 'completed') {
    console.error('FAIL: the singleton-winning generation job did not complete:', singletonResult);
    process.exitCode = 1;
    return;
  }
  console.log(
    `singleton-winning job completed: rosterId=${singletonResult.result?.rosterId}, ` +
      `alertCount=${singletonResult.result?.alertCount}`,
  );

  section(`Seeding ${COMPANY_COUNT} companies for the cross-company concurrency-cap proof`);
  const companies: SeededRosterCompany[] = [];
  for (let i = 0; i < COMPANY_COUNT; i++) {
    const seeded = await seedSingleWorkerCompanyForRoster(
      prisma,
      `Loadtest Roster Concurrency ${Date.now()}-${i}`,
      PREFIX_BASE + (i + 1) * 100,
      MONTH,
    );
    companies.push(seeded);
  }
  console.log(`companies: ${companies.map((c) => c.companyId).join(', ')}`);

  section(`Firing ${COMPANY_COUNT} concurrent generate requests (one per company, same month ${MONTH})`);
  let sampling = true;
  let maxObservedActive = 0;
  const samplerPromise = (async () => {
    while (sampling) {
      const rows = await prisma.$queryRaw<Array<{ cnt: number }>>`
        SELECT count(*)::int AS cnt FROM pgboss.job WHERE name = 'roster-generation' AND state = 'active'
      `;
      const cnt = rows[0]?.cnt ?? 0;
      if (cnt > maxObservedActive) maxObservedActive = cnt;
      await sleep(SAMPLE_INTERVAL_MS);
    }
  })();

  const fireStart = Date.now();
  const responses = await Promise.all(companies.map((c) => postRosterGenerate(c.companyId, MONTH)));
  const rejected = responses.filter((r) => r.statusCode !== 202);
  if (rejected.length > 0) {
    sampling = false;
    await samplerPromise;
    console.error('FAIL: some cross-company generate requests were not accepted (202):', rejected);
    process.exitCode = 1;
    return;
  }

  const settleResults = await Promise.all(
    responses.map(async (r, i) => ({
      companyId: companies[i]?.companyId,
      result: await pollGenerationJobUntilSettled(r.body.jobId as string),
    })),
  );
  sampling = false;
  await samplerPromise;
  const totalWallClockMs = Date.now() - fireStart;

  section('Results');
  for (const { companyId, result } of settleResults) {
    console.log(`  company ${companyId}: ${result.state}, rosterId=${result.result?.rosterId}, alertCount=${result.result?.alertCount}`);
  }
  console.log(`\ntotal wall-clock: ${fmtMs(totalWallClockMs)}`);
  console.log(`max observed concurrently-active roster-generation jobs: ${maxObservedActive} (expected cap: ${EXPECTED_CONCURRENCY})`);
  if (maxObservedActive === 0) {
    console.warn(
      '\nWARN: the sampler never observed more than 0 concurrently-active roster-generation jobs at any ' +
        `polled instant -- these trivial single-worker solves settled faster than the ${SAMPLE_INTERVAL_MS}ms ` +
        'sampling interval, so this run gives no POSITIVE evidence the concurrency cap is enforced (it also ' +
        'found no violation, which is not the same claim). Re-run with a larger LOADTEST_ROSTER_COMPANY_COUNT ' +
        'for a stronger signal.',
    );
  }

  const failed = settleResults.filter((r) => r.result.state !== 'completed');
  if (failed.length > 0) {
    console.error('FAIL: some roster-generation jobs did not complete:', failed);
    process.exitCode = 1;
    return;
  }
  if (maxObservedActive > EXPECTED_CONCURRENCY) {
    console.error(
      `FAIL: observed ${maxObservedActive} concurrently-active roster-generation jobs, exceeding the ` +
        `configured cap of ${EXPECTED_CONCURRENCY} (ROSTER_GENERATION_CONCURRENCY) -- the CPU-bound solver ` +
        `queue's localConcurrency guard is not holding.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nPASS: same-company+month duplicate requests resolve to exactly one winner (409 generation-in-progress ` +
      `for the loser), and ${COMPANY_COUNT} different companies' concurrent solves never exceeded the ` +
      `configured ${EXPECTED_CONCURRENCY}-job concurrency cap.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error('rosterGenerationLoad failed:', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
