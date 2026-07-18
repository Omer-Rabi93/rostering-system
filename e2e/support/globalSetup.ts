// Playwright `globalSetup`: brings up a dedicated, disposable E2E-only Postgres (NEVER the
// developer's own `rostering-system-postgres-1` container from `docker-compose.dev.yml`, and
// never the production-shaped `docker-compose.yml` stack either), applies Prisma migrations to
// it, makes sure `packages/shared`/`packages/ui` are built (the `apps/api`/`apps/web` dev
// processes both resolve those workspace packages via their built `dist/`, per each package's
// `package.json#main`/`#exports`), and starts the pg-boss `worker` process (the one long-running
// process that has no HTTP port of its own, so it can't be expressed as a Playwright `webServer`
// entry — those all require a `port`/`url` to poll for readiness).
//
// Returning a teardown function from `globalSetup` (rather than a separate `globalTeardown`
// module) is Playwright's documented way to keep in-process state — here, the spawned worker
// child process handle — reachable at teardown time.
//
// See `playwright.config.ts` for how `E2E_DATABASE_URL` here matches the `DATABASE_URL` env
// handed to the `webServer` entries for the db-admin server / api / web.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export const E2E_POSTGRES_CONTAINER = 'rostering-e2e-postgres';
export const E2E_POSTGRES_PORT = 5439;
export const E2E_DATABASE_URL = `postgresql://rostering:rostering_e2e_password@localhost:${E2E_POSTGRES_PORT}/rostering_e2e`;
export const SOLVER_PYTHON_PATH = path.join(repoRoot, 'solver/.venv/bin/python3');

function sh(cmd: string, args: string[], opts: Parameters<typeof execFileSync>[2] = {}): string {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).toString();
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function ensurePostgres(): Promise<void> {
  // Fresh container every run: simpler and safer than trying to detect + reuse a stale one left
  // over from a previous interrupted run, and it's disposable (no volume mount) by design.
  try {
    sh('docker', ['rm', '-f', E2E_POSTGRES_CONTAINER]);
  } catch {
    // Container didn't exist — fine.
  }
  sh('docker', [
    'run',
    '-d',
    '--name',
    E2E_POSTGRES_CONTAINER,
    '-e',
    'POSTGRES_USER=rostering',
    '-e',
    'POSTGRES_PASSWORD=rostering_e2e_password',
    '-e',
    'POSTGRES_DB=rostering_e2e',
    '-p',
    `127.0.0.1:${E2E_POSTGRES_PORT}:5432`,
    'postgres:16-alpine',
  ]);

  await waitFor(
    () => {
      try {
        sh('docker', ['exec', E2E_POSTGRES_CONTAINER, 'pg_isready', '-U', 'rostering', '-d', 'rostering_e2e']);
        return true;
      } catch {
        return false;
      }
    },
    30_000,
    'E2E postgres to become ready',
  );

  sh('node_modules/.bin/prisma', ['migrate', 'deploy'], {
    cwd: path.join(repoRoot, 'apps/api'),
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
  });
}

function buildWorkspacePackages(): void {
  sh('pnpm', ['--filter', '@rostering/shared', 'build'], { cwd: repoRoot, env: process.env });
  sh('pnpm', ['--filter', '@rostering/ui', 'build'], { cwd: repoRoot, env: process.env });
}

function spawnWorker(): ChildProcess {
  const child = spawn('node_modules/.bin/tsx', ['src/worker.ts'], {
    cwd: path.join(repoRoot, 'apps/api'),
    env: {
      ...process.env,
      DATABASE_URL: E2E_DATABASE_URL,
      SOLVER_PYTHON_PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[worker] ${chunk.toString()}`));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[worker] ${chunk.toString()}`));
  return child;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await ensurePostgres();
  buildWorkspacePackages();
  const workerProcess = spawnWorker();
  // Give the worker a moment to register its pg-boss handlers before tests start hammering the
  // queue (the api/web webServer entries below still have their own readiness polling on top of
  // this).
  await new Promise((r) => setTimeout(r, 1000));

  return async function globalTeardown() {
    // Wait for the worker process to actually exit before tearing down Postgres underneath it —
    // `worker.ts` has no SIGTERM handler (not required by any Phase 11 scenario), so a `kill()`
    // that returns before the process has finished unwinding its in-flight pg-boss/pg connections
    // races the container removal below: if `docker rm -f` wins, the worker's socket gets an
    // abrupt ECONNRESET while still connected, which (with no listener on that specific error) can
    // crash the process noisily on the way down. That's a test-harness ordering bug here, not an
    // application bug — fixed by simply waiting for exit (with a bounded grace period) before
    // pulling the database out from under it.
    await new Promise<void>((resolve) => {
      if (workerProcess.exitCode !== null || workerProcess.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        workerProcess.kill('SIGKILL');
      }, 5_000);
      workerProcess.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      workerProcess.kill('SIGTERM');
    });

    try {
      sh('docker', ['rm', '-f', E2E_POSTGRES_CONTAINER]);
    } catch {
      // best-effort cleanup
    }
  };
}
