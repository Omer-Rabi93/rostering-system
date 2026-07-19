import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setupEnv.ts'],
    // Integration test suites share one real, dockerized Postgres database (see
    // `tests/helpers/testDb.ts`) and each resets/truncates it in `beforeEach`. Running test FILES
    // in parallel (Vitest's default) would let two suites truncate/seed the same tables
    // concurrently and produce flaky cross-suite failures, so file execution is forced serial.
    // Tests *within* one file still run in the declared order (Vitest default for a single file).
    fileParallelism: false,
  },
});
