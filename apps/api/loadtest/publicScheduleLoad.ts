// Load-test: public schedule endpoint (`GET /api/schedule/:token`) burst + rate-limit proof.
//
// This is the one production-facing endpoint with no auth wall (see `app.ts`'s comment on why
// it's mounted under `/api/schedule`, not bare `/schedule`) -- its only protection is a per-IP
// rate limiter (`publicScheduleLimiter`: 30 requests/minute, `standardHeaders: true`). This script
// fires ONE real concurrent burst mixing valid and invalid tokens and asserts three things at
// once, against a REAL running dev stack (not mocked):
//
//   1. Content correctness under concurrency: every response for the VALID token is either 200
//      (with the correct `{name, month, shifts}` shape) or 429 -- NEVER 404 or 500. Every response
//      for a bogus token is either 404 (generic `{message: "Not found"}`, see
//      `publicScheduleService.ts`'s `NOT_FOUND_MESSAGE`) or 429 -- NEVER 200 or 500.
//   2. The rate limiter actually engages under a burst above its 30/min cap: at least one 429
//      response, each carrying a `RateLimit-*` header (draft-7 `standardHeaders`).
//   3. The limiter counts EVERY request through the middleware regardless of route outcome (valid
//      or bogus token) -- so the total non-429 response count across the whole burst is capped at
//      the configured limit, not just the 200s.
//
// Setup generates a real roster via the same `POST /api/rosters/generate` + poll flow as
// `rosterGenerationLoad.ts` (this endpoint has nothing to read otherwise), so this script has the
// same solver-availability requirement -- see that script's header comment.
//
// Requires a running dev stack -- see `apps/api/loadtest/README.md`.
// Run: `pnpm --filter @rostering/api exec tsx loadtest/publicScheduleLoad.ts`

import {
  API_BASE_URL,
  checkStackReachable,
  disconnectPrisma,
  getPrisma,
  pollGenerationJobUntilSettled,
  postRosterGenerate,
  RUN_SALT,
  section,
  seedSingleWorkerCompanyForRoster,
} from './shared.js';

const MONTH = process.env.LOADTEST_SCHEDULE_MONTH ?? '2027-04';
/** Deliberately above the limiter's 30/min cap (`app.ts`'s `publicScheduleLimiter`) so the burst
 * is guaranteed to trip it, while still keeping the run short. */
const BURST_COUNT = Number(process.env.LOADTEST_SCHEDULE_BURST_COUNT ?? 45);
/** Every 4th request in the burst uses a bogus token instead of the real one -- interleaved, not
 * grouped, so the limiter's per-request counting can't be confused with request ORDER. */
const BOGUS_EVERY_NTH = 4;
const RATE_LIMIT = 30;
/** Disjoint from every other script's national-ID prefix range in this repo (3M/4M/5M/5.5M/6M/7M
 * are already taken -- see the other loadtest scripts' own `PREFIX_BASE` comments). */
const PREFIX_BASE = 8_000_000 + RUN_SALT;

interface ScheduleResponse {
  readonly statusCode: number;
  readonly body: { name?: string; month?: string; shifts?: unknown[]; message?: string };
  readonly rateLimitHeaderPresent: boolean;
}

async function getSchedule(token: string, month: string): Promise<ScheduleResponse> {
  const response = await fetch(`${API_BASE_URL}/api/schedule/${token}?month=${month}`);
  // A 429 body comes from `express-rate-limit`'s own default handler, not this app's JSON error
  // envelope (`errorHandler.ts`) -- it's plain text ("Too many requests, please try again
  // later."), so `response.json()` would throw on it. Every other status this route can return
  // (200, 404) IS this app's own JSON envelope.
  const rawText = await response.text();
  let body: ScheduleResponse['body'];
  try {
    body = JSON.parse(rawText) as ScheduleResponse['body'];
  } catch {
    body = { message: rawText };
  }
  const rateLimitHeaderPresent = [...response.headers.keys()].some(
    (h) => h.toLowerCase().startsWith('ratelimit') || h.toLowerCase() === 'retry-after',
  );
  return { statusCode: response.status, body, rateLimitHeaderPresent };
}

async function main(): Promise<void> {
  await checkStackReachable();
  const prisma = getPrisma();

  section('Seeding one company + worker and generating + publishing a real roster');
  const seeded = await seedSingleWorkerCompanyForRoster(
    prisma,
    `Loadtest Public Schedule ${Date.now()}`,
    PREFIX_BASE,
    MONTH,
  );
  console.log(`company: ${seeded.companyId}, worker: ${seeded.workerId}, shareToken: ${seeded.shareToken}`);

  const generateResp = await postRosterGenerate(seeded.companyId, MONTH);
  if (generateResp.statusCode !== 202 || !generateResp.body.jobId) {
    console.error('FAIL: setup roster-generate request was not accepted (202):', generateResp);
    process.exitCode = 1;
    return;
  }
  const generationResult = await pollGenerationJobUntilSettled(generateResp.body.jobId);
  if (generationResult.state !== 'completed' || generationResult.result?.rosterId === undefined) {
    console.error('FAIL: setup roster-generation job did not complete:', generationResult);
    process.exitCode = 1;
    return;
  }
  if ((generationResult.result.alertCount ?? 0) > 0) {
    console.error(
      `FAIL: setup roster generated with ${generationResult.result.alertCount} unacknowledged alert(s) -- ` +
        'publish would 409 (PublishConflictError); the seed recipe is supposed to be alert-free.',
    );
    process.exitCode = 1;
    return;
  }
  const rosterId = generationResult.result.rosterId;

  const publishResponse = await fetch(`${API_BASE_URL}/api/rosters/${rosterId}/publish`, { method: 'POST' });
  if (publishResponse.status !== 200) {
    console.error(`FAIL: publish returned ${publishResponse.status}:`, await publishResponse.text());
    process.exitCode = 1;
    return;
  }
  console.log(`roster ${rosterId} published`);

  const bogusToken = '00000000-0000-4000-8000-000000000000';
  const expectedDaysInMonth = new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0)).getUTCDate();

  section(`Firing a ${BURST_COUNT}-request concurrent burst (1 in ${BOGUS_EVERY_NTH} using a bogus token)`);
  const plan = Array.from({ length: BURST_COUNT }, (_unused, i) =>
    i % BOGUS_EVERY_NTH === 0 ? 'invalid' : 'valid',
  );
  const results = await Promise.all(
    plan.map((kind) => getSchedule(kind === 'valid' ? seeded.shareToken : bogusToken, MONTH).then((r) => ({ kind, ...r }))),
  );

  const validResults = results.filter((r) => r.kind === 'valid');
  const invalidResults = results.filter((r) => r.kind === 'invalid');
  console.log(
    `valid-token responses: ${validResults.length} (` +
      `${validResults.filter((r) => r.statusCode === 200).length} x 200, ` +
      `${validResults.filter((r) => r.statusCode === 429).length} x 429, ` +
      `${validResults.filter((r) => ![200, 429].includes(r.statusCode)).length} x other)`,
  );
  console.log(
    `invalid-token responses: ${invalidResults.length} (` +
      `${invalidResults.filter((r) => r.statusCode === 404).length} x 404, ` +
      `${invalidResults.filter((r) => r.statusCode === 429).length} x 429, ` +
      `${invalidResults.filter((r) => ![404, 429].includes(r.statusCode)).length} x other)`,
  );

  const badValid = validResults.filter((r) => r.statusCode !== 200 && r.statusCode !== 429);
  if (badValid.length > 0) {
    console.error('FAIL: valid-token requests returned a status other than 200/429:', badValid);
    process.exitCode = 1;
    return;
  }
  const badInvalid = invalidResults.filter((r) => r.statusCode !== 404 && r.statusCode !== 429);
  if (badInvalid.length > 0) {
    console.error('FAIL: invalid-token requests returned a status other than 404/429:', badInvalid);
    process.exitCode = 1;
    return;
  }

  const malformed200s = validResults.filter(
    (r) =>
      r.statusCode === 200 &&
      (r.body.name !== seeded.workerName || r.body.month !== MONTH || !Array.isArray(r.body.shifts) || r.body.shifts.length !== expectedDaysInMonth),
  );
  if (malformed200s.length > 0) {
    console.error(
      `FAIL: ${malformed200s.length} valid-token 200 response(s) had the wrong shape/content ` +
        `(expected name=${seeded.workerName}, month=${MONTH}, shifts.length=${expectedDaysInMonth}):`,
      malformed200s,
    );
    process.exitCode = 1;
    return;
  }
  const malformed404s = invalidResults.filter((r) => r.statusCode === 404 && r.body.message !== 'Not found');
  if (malformed404s.length > 0) {
    console.error('FAIL: invalid-token 404 response(s) did not use the generic "Not found" message:', malformed404s);
    process.exitCode = 1;
    return;
  }

  const all429s = results.filter((r) => r.statusCode === 429);
  const allNon429s = results.filter((r) => r.statusCode !== 429);
  const missingHeader429s = all429s.filter((r) => !r.rateLimitHeaderPresent);
  if (missingHeader429s.length > 0) {
    console.error(`FAIL: ${missingHeader429s.length} of ${all429s.length} 429 response(s) had no RateLimit-*/Retry-After header`);
    process.exitCode = 1;
    return;
  }
  if (all429s.length === 0) {
    console.error(
      `FAIL: none of the ${BURST_COUNT} requests were rate-limited (429) -- the burst was supposed to exceed ` +
        `the configured ${RATE_LIMIT}/min cap and never tripped the limiter at all.`,
    );
    process.exitCode = 1;
    return;
  }
  if (allNon429s.length > RATE_LIMIT) {
    console.error(
      `FAIL: ${allNon429s.length} requests got through as non-429 (200 or 404), exceeding the configured ` +
        `${RATE_LIMIT}/min cap -- the limiter is not counting every request through the middleware ` +
        'regardless of route outcome.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\n${all429s.length} of ${BURST_COUNT} requests were rate-limited (429), ${allNon429s.length} got through`);
  console.log(
    '\nPASS: valid/invalid tokens resolved correctly under concurrency (200/404, never crossed), the rate ' +
      `limiter engaged (${all429s.length} x 429, each with a RateLimit-*/Retry-After header), and total ` +
      `non-429 responses (${allNon429s.length}) stayed within the configured ${RATE_LIMIT}/min cap.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error('publicScheduleLoad failed:', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
