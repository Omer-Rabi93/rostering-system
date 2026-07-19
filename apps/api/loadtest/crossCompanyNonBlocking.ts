// Load-test 1/3 (v4 design doc, Part C): cross-company non-blocking proof.
//
// Seeds N companies, fires one concurrent `POST /import/workforce/:month` upload per company (a mix of
// valid files and a couple of the invalid-but-well-framed fixtures from
// `tests/fixtures/csv/` -- rows that fail per-row validation but still parse fine, so they still
// get a fast 202 and an async COMPLETED-with-failures task, exactly like a real "someone uploaded
// a slightly bad file" case), then polls every company's `ImportTask` to settlement and asserts
// the overall wall-clock is close to the SLOWEST single company's own processing time, not the sum
// of all N -- the direct load-level proof that per-company `singletonKey` partitioning (point 1 of
// the v4 design doc) actually holds, not just that it type-checks.
//
// Requires a running dev stack: `docker compose -f docker-compose.dev.yml up -d`, `pnpm --filter
// @rostering/api dev`, and `pnpm --filter @rostering/api exec tsx src/worker.ts` (or your own
// equivalent) -- see `apps/api/loadtest/README.md`.
//
// Run: `pnpm --filter @rostering/api exec tsx loadtest/crossCompanyNonBlocking.ts`

import {
  buildWorkforceCsv,
  checkStackReachable,
  createLoadtestCompany,
  disconnectPrisma,
  fmtMs,
  FIXTURES_DIR,
  getPrisma,
  makeSyntheticWorkerRows,
  pollAllUntilSettled,
  RUN_SALT,
  section,
  uploadWorkforceCsv,
  writeTempCsv,
} from './shared.js';

/** Matches the fixture files' own baked-in month (see `tests/fixtures/csv/*.expected.json`'s
 * `"month": "2027-02"`) -- the two fixture-driven companies below need the request's `:month` to
 * match the fixture CSV's own header shape exactly. */
const MONTH = '2027-02';
const COMPANY_COUNT = Number(process.env.LOADTEST_COMPANY_COUNT ?? 10);
/** Rows per valid company file -- large enough that processing takes a real, measurable amount of
 * wall-clock time (each row is its own DB transaction), not so large the whole script takes
 * minutes. */
const ROWS_PER_COMPANY = Number(process.env.LOADTEST_ROWS_PER_COMPANY ?? 300);
/** Disjoint from every other script's/fixture's national-ID prefix range in this repo; `RUN_SALT`
 * keeps repeated runs against the same persistent dev Postgres from colliding with each other. */
const PREFIX_BASE = 3_000_000 + RUN_SALT;
/** How much slower than the single slowest company's own processing time the OVERALL wall-clock
 * is allowed to be before we call this a blocking regression. A generous multiplier (not 1.0x) --
 * real scheduling/DB-contention jitter across N genuinely concurrent transactions is expected;
 * what must NOT happen is overall time tracking the SUM of all N companies' processing times. */
const ALLOWED_SLOWDOWN_FACTOR = 3;

async function main(): Promise<void> {
  await checkStackReachable();
  const prisma = getPrisma();

  section(`Seeding ${COMPANY_COUNT} companies`);
  const companyIds: number[] = [];
  for (let i = 0; i < COMPANY_COUNT; i++) {
    const id = await createLoadtestCompany(prisma, `Loadtest Cross-Company ${Date.now()}-${i}`);
    companyIds.push(id);
  }
  console.log(`companies: ${companyIds.join(', ')}`);

  section('Building per-company CSV files');
  const csvPaths = new Map<number, string>();
  companyIds.forEach((companyId, i) => {
    // The first two companies get a well-FRAMED but per-row-INVALID fixture (still returns a fast
    // 202 -- row validation happens inside the async job, not the route) -- the "mix of valid and
    // invalid fixtures" the design doc calls for.
    if (i === 0) {
      csvPaths.set(companyId, `${FIXTURES_DIR}/bad-checksum.csv`);
    } else if (i === 1) {
      csvPaths.set(companyId, `${FIXTURES_DIR}/unknown-role.csv`);
    } else {
      const rows = makeSyntheticWorkerRows(ROWS_PER_COMPANY, PREFIX_BASE + i * 10_000);
      const path = writeTempCsv(buildWorkforceCsv(rows, MONTH), `cross-company-${companyId}.csv`);
      csvPaths.set(companyId, path);
    }
  });

  section(`Firing ${COMPANY_COUNT} concurrent uploads`);
  const fireStart = Date.now();
  const uploads = await Promise.all(
    companyIds.map(async (companyId) => {
      const csvPath = csvPaths.get(companyId);
      if (!csvPath) throw new Error(`no csv path for company ${companyId}`);
      const result = await uploadWorkforceCsv(companyId, MONTH, csvPath);
      return { companyId, ...result };
    }),
  );
  const fireElapsedMs = Date.now() - fireStart;
  console.log(`all ${COMPANY_COUNT} uploads ack'd (202) in ${fmtMs(fireElapsedMs)} wall-clock`);

  const rejected = uploads.filter((u) => u.statusCode !== 202);
  if (rejected.length > 0) {
    console.error('FAIL: some uploads were not accepted (202):', rejected);
    process.exitCode = 1;
    return;
  }

  section('Polling every company\'s ImportTask to settlement');
  const settleStart = Date.now();
  const settled = await pollAllUntilSettled(prisma, companyIds, 'WORKFORCE_SYNC', { timeoutMs: 120_000 });
  const overallWallClockMs = Date.now() - settleStart;

  const durations: Array<{ companyId: number; durationMs: number; status: string }> = [];
  for (const [companyId, task] of settled) {
    const startedAt = task.startedAt ?? task.createdAt;
    const finishedAt = task.finishedAt ?? new Date();
    durations.push({ companyId, durationMs: finishedAt.getTime() - startedAt.getTime(), status: task.status });
  }
  durations.sort((a, b) => b.durationMs - a.durationMs);

  section('Results');
  for (const d of durations) {
    console.log(`  company ${d.companyId}: ${d.status}, own processing time ${fmtMs(d.durationMs)}`);
  }
  const maxSingleMs = durations[0]?.durationMs ?? 0;
  const sumMs = durations.reduce((acc, d) => acc + d.durationMs, 0);
  console.log(`\noverall wall-clock (fire -> last settle): ${fmtMs(fireElapsedMs + overallWallClockMs)}`);
  console.log(`slowest single company's own processing time: ${fmtMs(maxSingleMs)}`);
  console.log(`sum of all ${COMPANY_COUNT} companies' processing times (what SERIAL processing would cost): ${fmtMs(sumMs)}`);

  const failedTasks = [...settled.entries()].filter(([, t]) => t.status === 'FAILED');
  if (failedTasks.length > 0) {
    console.error('FAIL: unexpected FAILED task(s):', failedTasks);
    process.exitCode = 1;
    return;
  }

  const totalWallClockMs = fireElapsedMs + overallWallClockMs;
  const budgetMs = Math.max(maxSingleMs * ALLOWED_SLOWDOWN_FACTOR, 2_000);
  if (totalWallClockMs > budgetMs) {
    console.error(
      `FAIL: overall wall-clock (${fmtMs(totalWallClockMs)}) exceeded ${ALLOWED_SLOWDOWN_FACTOR}x the slowest ` +
        `single company's own processing time (budget ${fmtMs(budgetMs)}) -- companies appear to be blocking ` +
        `each other, contrary to the per-company singletonKey design.`,
    );
    process.exitCode = 1;
    return;
  }
  if (totalWallClockMs > sumMs * 0.9 && COMPANY_COUNT > 2) {
    console.error(
      `FAIL: overall wall-clock (${fmtMs(totalWallClockMs)}) tracks the SUM of all companies' processing ` +
        `times (${fmtMs(sumMs)}) -- looks like serial (blocking) processing, not concurrent.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nPASS: ${COMPANY_COUNT} companies' worker-CSV imports completed concurrently -- overall wall-clock tracks ` +
      `the slowest single import, not the sum of all ${COMPANY_COUNT}.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error('crossCompanyNonBlocking failed:', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
