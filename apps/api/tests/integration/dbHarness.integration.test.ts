import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { seedDatabase } from '../../src/db/seed.js';
import { buildSeedAvailabilityRows, nextCalendarMonth, SEED_WORKERS } from '../../src/db/seedData.js';
import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';

/**
 * Proves the reusable integration-test DB harness (`tests/helpers/testDb.ts`)
 * actually works against a real, dockerized Postgres (docker-compose.dev.yml)
 * — not mocked. Later phases (5, 6) import `getTestPrismaClient`/
 * `resetDatabase` the same way this suite does to get a clean database before
 * each integration test suite runs.
 *
 * Requires DATABASE_URL to be set (see tests/setupEnv.ts, which loads it from
 * the repo-root .env) and Postgres to be reachable, migrated, at that URL.
 */
describe.skipIf(!process.env.DATABASE_URL)('integration-test DB harness', () => {
  const prisma = getTestPrismaClient();

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  it('starts every reset with an empty database', async () => {
    await expect(prisma.company.count()).resolves.toBe(0);
    await expect(prisma.worker.count()).resolves.toBe(0);
    await expect(prisma.contract.count()).resolves.toBe(0);
    await expect(prisma.workerAvailability.count()).resolves.toBe(0);
    await expect(prisma.staffingRequirement.count()).resolves.toBe(0);
    await expect(prisma.roster.count()).resolves.toBe(0);
    await expect(prisma.shift.count()).resolves.toBe(0);
    await expect(prisma.shiftWorker.count()).resolves.toBe(0);
    await expect(prisma.alert.count()).resolves.toBe(0);
  });

  it('seeds the expected row counts, then resets back to empty', async () => {
    const result = await seedDatabase(prisma);

    // The exact `WorkerAvailability` row count (Availability v2) depends on which month is "next
    // calendar month" when the test runs (28-31 dates x 12 fixture workers, minus the
    // weekdays-only fixtures' weekend gaps) -- derive the expectation from the same fixture/helper
    // the seed itself uses rather than hardcoding a number that would drift across months.
    const expectedMonth = nextCalendarMonth();
    const expectedAvailabilityRows = SEED_WORKERS.reduce(
      (sum, w) => sum + buildSeedAvailabilityRows(w, expectedMonth).length,
      0,
    );

    expect(result).toEqual({
      companies: 3,
      workers: 12,
      contracts: 12,
      staffingRequirements: 9,
      availabilityRows: expectedAvailabilityRows,
      availabilityMonth: expectedMonth,
    });

    await expect(prisma.company.count()).resolves.toBe(3);
    await expect(prisma.worker.count()).resolves.toBe(12);
    await expect(prisma.contract.count()).resolves.toBe(12);
    await expect(prisma.workerAvailability.count()).resolves.toBe(expectedAvailabilityRows);
    await expect(prisma.staffingRequirement.count()).resolves.toBe(9);

    await resetDatabase(prisma);

    await expect(prisma.company.count()).resolves.toBe(0);
    await expect(prisma.worker.count()).resolves.toBe(0);
    await expect(prisma.contract.count()).resolves.toBe(0);
    await expect(prisma.workerAvailability.count()).resolves.toBe(0);
    await expect(prisma.staffingRequirement.count()).resolves.toBe(0);
  });

  it('enforces case-insensitive company-name uniqueness (raw-SQL index)', async () => {
    await prisma.company.create({ data: { name: 'Case Test Ltd.' } });

    await expect(prisma.company.create({ data: { name: 'case test ltd.' } })).rejects.toThrow();
  });

  it('restarts identity sequences on reset (fresh IDs start at 1 again)', async () => {
    const first = await prisma.company.create({ data: { name: 'Sequence Test A' } });
    expect(first.id).toBeGreaterThan(0);

    await resetDatabase(prisma);

    const second = await prisma.company.create({ data: { name: 'Sequence Test B' } });
    expect(second.id).toBe(1);
  });
});
