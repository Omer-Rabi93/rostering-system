import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

import { E2E_DATABASE_URL, SOLVER_PYTHON_PATH } from './e2e/support/globalSetup.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// `apps/web/vite.config.ts` hardcodes its dev-mode `/api` proxy target to `http://localhost:3000`
// (not env-configurable, and out of scope to change for this phase — see the constraint against
// touching `apps/web/src`; the proxy target itself lives in the config file, but leaving it
// untouched keeps this suite's setup from diverging from what `pnpm dev` does normally). This
// suite's dedicated api instance therefore runs on that same port. Nothing else uses :3000 for the
// lifetime of an E2E run (verified: the developer's other services — the dev/prod Postgres
// containers — don't listen on it), and this suite fully owns starting/stopping it per run.
const API_PORT = 3000;
const WEB_PORT = 5183;
const DB_ADMIN_PORT = 4100;

/** Base URL every test's `page.goto('/...')` resolves against. */
export const E2E_BASE_URL = `http://localhost:${WEB_PORT}`;
export const E2E_API_BASE_URL = `http://localhost:${API_PORT}/api`;
export const E2E_DB_ADMIN_URL = `http://localhost:${DB_ADMIN_PORT}`;

/**
 * Playwright E2E setup (Phase 11).
 *
 * **webServer target decision:** dev servers (`apps/api`'s `tsx src/index.ts` + `src/worker.ts`,
 * `apps/web`'s `vite`) against a dedicated, disposable Postgres container (`e2e/support/
 * globalSetup.ts`), NOT the composed `docker-compose.yml` stack. Reasoning:
 *   - The composed stack multi-stage-builds 3 Docker images (api, worker, nginx) on every cold
 *     run and only exposes nginx's :80 with N *stateless* api replicas behind `least_conn` — great
 *     for proving the production topology (already done in Phase 10's golden-path smoke test) but
 *     actively hostile to E2E iteration speed and per-test DB control: there is no single api
 *     replica to point a test-only reset endpoint at, and rebuilding images on every spec change
 *     during authoring would dominate wall-clock time.
 *   - Dev servers talk to Postgres exactly like the composed stack's api/worker containers do
 *     (same Prisma client, same migrations, same pg-boss queue, same Python CP-SAT subprocess) —
 *     nothing here is mocked. The only thing NOT exercised by this suite is nginx's reverse-proxy
 *     layer itself (health-checked replicas, `least_conn`), which is out of scope for E2E
 *     acceptance tests and already covered by Phase 10.
 *   - A dedicated Postgres container on its own port/name (`rostering-e2e-postgres`, :5439) keeps
 *     this suite fully isolated from both `docker-compose.dev.yml`'s `rostering-system-postgres-1`
 *     (developer's own dev DB) and the production-shaped `docker-compose.yml` stack — no shared
 *     state, safe to run alongside either.
 *
 * **DB strategy:** one shared Postgres database for the whole run; `e2e/support/dbAdminServer.ts`
 * (started as a `webServer` entry) exposes reset/reseed/fixture-arrangement endpoints used by the
 * `e2e/support/fixtures.ts` `resetAndSeed` fixture. Because every test shares one database, the
 * suite runs with **`workers: 1`** (fully serial) — the correctness-over-speed tradeoff called out
 * explicitly in the task: giving every worker its own schema/DB would allow parallelism but adds
 * real complexity (per-worker migration + seed + teardown) for a suite whose bottleneck is mostly
 * network/DOM/solver-subprocess latency, not CPU. Cross-browser coverage instead comes from the
 * project matrix below, exactly as the plan specifies ("no per-test duplication").
 */
export default defineConfig({
  testDir: path.join(here, 'e2e/tests'),
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(here, 'e2e/report') }]],
  globalSetup: path.join(here, 'e2e/support/globalSetup.ts'),
  outputDir: path.join(here, 'e2e/test-results'),

  use: {
    baseURL: E2E_BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],

  webServer: [
    {
      // No `tsx` binary is hoisted to the repo-root `node_modules/.bin` (it's `apps/api`'s
      // devDependency, and this workspace doesn't hoist bins across packages) — reused from there
      // explicitly. Node's own module resolution for this script's relative imports into
      // `apps/api/src/**` still walks up from each imported *file's* own path (not this process's
      // cwd), so it finds `apps/api/node_modules` regardless of which `tsx` binary launched it;
      // only the `tsx` executable itself needs an explicit path.
      command: `../apps/api/node_modules/.bin/tsx support/dbAdminServer.ts`,
      cwd: path.join(here, 'e2e'),
      port: DB_ADMIN_PORT,
      reuseExistingServer: false,
      env: { DATABASE_URL: E2E_DATABASE_URL, E2E_DB_ADMIN_PORT: String(DB_ADMIN_PORT) },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    },
    {
      command: `node_modules/.bin/tsx src/index.ts`,
      cwd: path.join(here, 'apps/api'),
      port: API_PORT,
      reuseExistingServer: false,
      env: { DATABASE_URL: E2E_DATABASE_URL, PORT: String(API_PORT), SOLVER_PYTHON_PATH },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    },
    {
      command: `node_modules/.bin/vite --port ${WEB_PORT} --strictPort`,
      cwd: path.join(here, 'apps/web'),
      port: WEB_PORT,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    },
  ],
});
