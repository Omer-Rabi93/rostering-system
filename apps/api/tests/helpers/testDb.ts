import { createPrismaClient, type PrismaClient } from '../../src/db/client.js';

let cachedClient: PrismaClient | undefined;

/**
 * Process-wide singleton `PrismaClient` for integration tests, connected via
 * `DATABASE_URL` (see `tests/setupEnv.ts` for how that gets loaded from the
 * repo-root `.env` during a test run). Reusing one client per test process
 * avoids exhausting Postgres connections across many suites.
 */
export function getTestPrismaClient(): PrismaClient {
  cachedClient ??= createPrismaClient();
  return cachedClient;
}

/**
 * Truncates every application table Prisma migrated into the `public` schema
 * (discovered dynamically, so it stays correct as later phases add nothing
 * new here — Phase 3 already defines the full schema) and restarts identity
 * sequences, leaving the schema/migration history itself intact.
 *
 * This is the reusable per-test-suite reset helper later phases (5, 6) import
 * to get a clean database before each integration test suite runs, e.g.:
 *
 *   const prisma = getTestPrismaClient();
 *   beforeEach(async () => {
 *     await resetDatabase(prisma);
 *   });
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;

  if (tables.length === 0) {
    return;
  }

  const quotedTables = tables.map((table) => `"public"."${table.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quotedTables} RESTART IDENTITY CASCADE;`);
}

/** Closes the shared test client; call once from a global test teardown, not per-suite. */
export async function disconnectTestPrismaClient(): Promise<void> {
  if (cachedClient) {
    await cachedClient.$disconnect();
    cachedClient = undefined;
  }
}
