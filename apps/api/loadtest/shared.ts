// Shared helpers for every script in `apps/api/loadtest/` (except `scaleTiers.ts`, which is owned
// separately -- see that file's own header). Everything here talks to a REAL, already-running dev
// stack (API server + worker process + Postgres) over HTTP/Prisma -- nothing in this directory
// mocks the pipeline. See `apps/api/loadtest/README.md` for how to start that stack.
//
// v4 design doc, Part C: "Load tests -- add `autocannon` (Node-native, npm, fits the existing
// TS/Node stack) ... driven against the dev-server stack". `autocannon`'s `form` option (backed by
// the `form-data` package) only accepts `{ type: 'file', path }` for file fields -- not an in-
// memory Buffer -- so every CSV upload in this directory is written to a temp file first
// (`writeTempCsv`) and referenced by path.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import autocannon from 'autocannon';
import { config } from 'dotenv';

import { createPrismaClient, type PrismaClient } from '../src/db/client.js';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(here, '..', 'tests', 'fixtures', 'csv');

// Loads DATABASE_URL (and friends) from the repo-root `.env` -- these scripts are run directly via
// `tsx` (not through Vitest's own `tests/setupEnv.ts`), and `dotenv/config`'s default auto-load
// resolves relative to `process.cwd()`, which is `apps/api` when run via `pnpm --filter
// @rostering/api exec tsx loadtest/<script>.ts`, not the repo root. Mirrors `tests/setupEnv.ts`'s
// identical explicit-path convention. Never overwrites a variable already set in `process.env`.
config({ path: path.resolve(here, '../../../.env') });

/**
 * These scripts run against a persistent, shared dev Postgres across repeated local invocations
 * (not a fresh disposable DB per run, unlike the Vitest suites' `resetDatabase`) -- and
 * `nationalId` is GLOBALLY unique (`Worker.nationalId @unique`), not scoped to a run. A
 * per-process random salt keeps every run's synthetic national-ID prefix ranges disjoint from
 * whatever a PREVIOUS run of the same script may have left behind, rather than colliding on a
 * fixed literal prefix and manufacturing spurious cross-company-conflict errors on the second run.
 * Mirrors `tests/routes/importExport.test.ts`'s identical `RUN_SALT` convention.
 */
export const RUN_SALT = Math.floor(Math.random() * 9_000) * 1000;

/** Base URL of the running `apps/api` dev server (`pnpm --filter @rostering/api dev`, port 3000
 * by default -- see `apps/web/vite.config.ts`'s hardcoded dev-proxy target, which the e2e suite's
 * own comment already documents as the fixed port every dev tool in this repo assumes). */
export const API_BASE_URL = process.env.LOADTEST_API_URL ?? 'http://localhost:3000';

let sharedPrisma: PrismaClient | undefined;
/** One shared `PrismaClient` per script process -- these scripts construct their own client
 * directly (per the v4 design doc's "a benchmark script that drives the real service methods /
 * queries the DB directly" guidance), independent of the running API/worker processes' own
 * clients. */
export function getPrisma(): PrismaClient {
  sharedPrisma ??= createPrismaClient();
  return sharedPrisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (sharedPrisma) {
    await sharedPrisma.$disconnect();
    sharedPrisma = undefined;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------
// Checksum-valid synthetic national IDs -- the same algorithm `e2e/support/dbAdminServer.ts`'s
// `bulkCreateWorkers` and `@rostering/shared`'s `isValidIsraeliId` both implement, reproduced here
// rather than imported so these standalone scripts have no dependency on the workspace package
// resolving under plain `tsx` execution outside a test runner.
// ---------------------------------------------------------------------------------------------

function isValidIsraeliId(raw: string): boolean {
  if (!/^\d{1,9}$/.test(raw)) return false;
  const id = raw.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const digit = Number(id[i]);
    const product = digit * (i % 2 === 0 ? 1 : 2);
    sum += product > 9 ? product - 9 : product;
  }
  return sum % 10 === 0;
}

/** Deterministically derives a checksum-valid 9-digit Israeli national ID from an 8-digit prefix
 * (0-padded). Every script in this directory uses its own disjoint prefix RANGE (documented at
 * each call site) so concurrent/repeated runs against a shared dev Postgres never collide. */
export function deriveValidIsraeliId(prefix: number): string {
  const base = String(prefix).padStart(8, '0');
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${base}${checkDigit}`;
    if (isValidIsraeliId(candidate)) return candidate;
  }
  throw new Error(`no valid check digit found for prefix ${base}`);
}

// ---------------------------------------------------------------------------------------------
// Worker CSV construction (post-v4 7-column schema: national_id,name,role,status,
// hourly_cost_ils,min_monthly_hours,max_monthly_hours -- see src/csv/columns.ts).
// ---------------------------------------------------------------------------------------------

export const WORKER_CSV_HEADER =
  'national_id,name,role,status,hourly_cost_ils,min_monthly_hours,max_monthly_hours';

export type CsvRole = 'General Guard' | 'Supervisor' | 'Screener';
export type CsvStatus = 'Active' | 'Inactive';

export interface LoadtestWorkerRow {
  readonly nationalId: string;
  readonly name: string;
  readonly role: CsvRole;
  readonly status: CsvStatus;
  readonly hourlyCostIls: number;
  readonly minMonthlyHours: number;
  readonly maxMonthlyHours: number;
}

export function workerRowToCsvLine(row: LoadtestWorkerRow): string {
  return [
    row.nationalId,
    row.name,
    row.role,
    row.status,
    row.hourlyCostIls.toFixed(2),
    String(row.minMonthlyHours),
    String(row.maxMonthlyHours),
  ].join(',');
}

export function buildWorkerCsv(rows: readonly LoadtestWorkerRow[]): string {
  return [WORKER_CSV_HEADER, ...rows.map(workerRowToCsvLine)].join('\n') + '\n';
}

/** One synthetic worker for prefix `n` -- checksum-valid nationalId, deterministic-but-varied
 * name/role/hours so imports look like real, non-degenerate data. */
export function makeSyntheticWorkerRow(prefix: number, overrides: Partial<LoadtestWorkerRow> = {}): LoadtestWorkerRow {
  const roles: readonly CsvRole[] = ['General Guard', 'Supervisor', 'Screener'];
  return {
    nationalId: deriveValidIsraeliId(prefix),
    name: `Loadtest Worker ${prefix}`,
    role: roles[prefix % roles.length] ?? 'General Guard',
    status: 'Active',
    hourlyCostIls: 40 + (prefix % 20),
    minMonthlyHours: 100,
    maxMonthlyHours: 180,
    ...overrides,
  };
}

export function makeSyntheticWorkerRows(count: number, startPrefix: number): LoadtestWorkerRow[] {
  return Array.from({ length: count }, (_unused, i) => makeSyntheticWorkerRow(startPrefix + i));
}

// ---------------------------------------------------------------------------------------------
// Temp-file + HTTP upload helpers.
// ---------------------------------------------------------------------------------------------

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'rostering-loadtest-'));

/** Writes `content` to a fresh temp file and returns its path -- `autocannon`'s `form` option
 * (backed by the `form-data` package) only supports `{ type: 'file', path }` for file fields, not
 * an in-memory Buffer, so every upload in this directory goes through a real file on disk. */
export function writeTempCsv(content: string, filename: string): string {
  const filePath = path.join(tmpRoot, filename);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

export interface UploadResult {
  readonly statusCode: number;
  readonly body: unknown;
  readonly elapsedMs: number;
}

/** Fires exactly one `POST /api/import/workers` multipart upload via `autocannon` (one dedicated
 * `connections: 1, amount: 1` run per call -- autocannon's connection model assumes homogeneous
 * requests across connections, so "N distinct concurrent uploads" is built by running N of these
 * one-shot instances in parallel via `Promise.all`, not by giving one instance N differing
 * connections). Returns the parsed JSON response body (e.g. `{ jobId }`) and wall-clock latency. */
export async function uploadWorkersCsv(companyId: number, csvFilePath: string): Promise<UploadResult> {
  const start = Date.now();
  let capturedStatus: number | undefined;
  let capturedBody: string | undefined;

  // `form` is a top-level `autocannon.Options` field (typed `string | object`, since the shape
  // `multipart.js` actually expects -- `{ [field]: { type: 'file'|'text', path?, value? } }` --
  // isn't separately exported from `@types/autocannon`), not a per-`Request` override, so it's set
  // once here rather than inside `requests[0]` (this run only ever sends the one request anyway).
  const form: object = {
    file: { type: 'file', path: csvFilePath },
    companyId: { type: 'text', value: String(companyId) },
  };

  await autocannon({
    url: API_BASE_URL,
    connections: 1,
    amount: 1,
    form,
    requests: [
      {
        method: 'POST',
        path: '/api/import/workers',
        onResponse: (status: number, body: string) => {
          capturedStatus = status;
          capturedBody = body;
        },
      },
    ],
  });

  const elapsedMs = Date.now() - start;
  let parsedBody: unknown = capturedBody;
  try {
    parsedBody = capturedBody ? JSON.parse(capturedBody) : undefined;
  } catch {
    // leave as raw text -- an error envelope should still be valid JSON, but don't crash the
    // loadtest script over a malformed response body; the caller's own assertions will surface it.
  }
  return { statusCode: capturedStatus ?? -1, body: parsedBody, elapsedMs };
}

// ---------------------------------------------------------------------------------------------
// Company seeding (direct Prisma, per the v4 design doc's "seed N companies via direct Prisma
// calls, reusing the seed-helper patterns from src/db/seedData.ts / dbAdminServer.ts").
// ---------------------------------------------------------------------------------------------

export async function createLoadtestCompany(prisma: PrismaClient, name: string): Promise<number> {
  const company = await prisma.company.create({ data: { name } });
  return company.id;
}

// ---------------------------------------------------------------------------------------------
// ImportTask polling.
// ---------------------------------------------------------------------------------------------

export type ImportTaskStatusName = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
const TERMINAL_STATUSES: readonly ImportTaskStatusName[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export interface PolledImportTask {
  readonly id: number;
  readonly companyId: number;
  readonly status: ImportTaskStatusName;
  readonly pgBossJobId: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

/** Polls `ImportTask` (directly via Prisma, not the HTTP endpoint -- the HTTP `GET
 * /api/import-tasks/active` only ever returns the single newest non-terminal task, which is not
 * enough to positively confirm settlement of one SPECIFIC task by id) until the task with `taskId`
 * reaches a terminal status, or `timeoutMs` elapses. */
export async function pollTaskUntilSettled(
  prisma: PrismaClient,
  taskId: number,
  { timeoutMs = 60_000, intervalMs = 200 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<PolledImportTask> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await prisma.importTask.findUniqueOrThrow({ where: { id: taskId } });
    if (TERMINAL_STATUSES.includes(task.status)) {
      return task;
    }
    if (Date.now() > deadline) {
      throw new Error(`ImportTask ${taskId} did not settle within ${timeoutMs}ms (last status: ${task.status})`);
    }
    await sleep(intervalMs);
  }
}

/** Polls until EVERY (companyId, kind) pair's latest task has settled, returning the final row per
 * company (keyed by companyId). Used by the cross-company script, where N companies' tasks need to
 * all be watched concurrently rather than one at a time. */
export async function pollAllUntilSettled(
  prisma: PrismaClient,
  companyIds: readonly number[],
  kind: 'WORKER_SYNC' | 'AVAILABILITY_SYNC',
  { timeoutMs = 120_000, intervalMs = 200 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Map<number, PolledImportTask>> {
  const deadline = Date.now() + timeoutMs;
  const settled = new Map<number, PolledImportTask>();
  const remaining = new Set(companyIds);

  while (remaining.size > 0) {
    for (const companyId of [...remaining]) {
      const task = await prisma.importTask.findFirst({
        where: { companyId, kind },
        orderBy: { createdAt: 'desc' },
      });
      if (task && TERMINAL_STATUSES.includes(task.status)) {
        settled.set(companyId, task);
        remaining.delete(companyId);
      }
    }
    if (remaining.size === 0) break;
    if (Date.now() > deadline) {
      throw new Error(`${remaining.size} of ${companyIds.length} companies' tasks never settled within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
  return settled;
}

export function fmtMs(ms: number): string {
  return `${ms.toFixed(0)}ms`;
}

/** Simple console section header -- every script uses this so the run transcript is easy to read
 * when piped to a log file. */
export function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}
