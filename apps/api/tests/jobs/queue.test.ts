import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';

import {
  createBoss,
  ensureQueues,
  enqueueAvailabilityImport,
  enqueueCsvImport,
  enqueueRosterGeneration,
  NEXT_MONTH_CRON_SCHEDULE,
  QUEUES,
  scheduleNextMonthGeneration,
} from '../../src/jobs/queue.js';

describe('jobs/queue.ts (pg-boss wiring)', () => {
  let boss: PgBoss;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set for the queue test suite');
    boss = createBoss(databaseUrl);
    await boss.start();
    await ensureQueues(boss);
    // This suite runs against a persistent, shared dev Postgres (not reset between runs like the
    // Prisma-backed `public` schema is) -- purge any queued jobs left over from a previous run so
    // the singletonKey-collision assertions below are never polluted by a stale "created" job
    // that never got consumed (no worker is running during this test).
    await boss.deleteQueuedJobs(QUEUES.ROSTER_GENERATION);
    await boss.deleteQueuedJobs(QUEUES.CSV_IMPORT);
    await boss.deleteQueuedJobs(QUEUES.AVAILABILITY_IMPORT);
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
  });

  it('creates all three application queues with retryLimit 2 (idempotently)', async () => {
    // ensureQueues already ran once in beforeAll; calling it again must not throw.
    await expect(ensureQueues(boss)).resolves.toBeUndefined();

    const csvQueue = await boss.getQueue(QUEUES.CSV_IMPORT);
    const rosterQueue = await boss.getQueue(QUEUES.ROSTER_GENERATION);
    const availabilityQueue = await boss.getQueue(QUEUES.AVAILABILITY_IMPORT);
    expect(csvQueue?.retryLimit).toBe(2);
    expect(rosterQueue?.retryLimit).toBe(2);
    expect(availabilityQueue?.retryLimit).toBe(2);
  });

  it('enqueueCsvImport returns a job id', async () => {
    const jobId = await enqueueCsvImport(boss, 'national_id,name\n');
    expect(typeof jobId).toBe('string');
  });

  it('enqueueAvailabilityImport returns a job id', async () => {
    const jobId = await enqueueAvailabilityImport(boss, 'national_id,d01\n', '2027-05');
    expect(typeof jobId).toBe('string');
  });

  it('enqueueRosterGeneration returns null when a job for the same month is already in flight (singletonKey collision)', async () => {
    const month = '2027-03'; // scoped to this test only, to avoid colliding with other tests' months
    const firstJobId = await enqueueRosterGeneration(boss, month);
    expect(typeof firstJobId).toBe('string');

    const secondJobId = await enqueueRosterGeneration(boss, month);
    expect(secondJobId).toBeNull();
  });

  it('enqueueRosterGeneration allows a fresh job once the month differs', async () => {
    const jobId = await enqueueRosterGeneration(boss, '2027-04');
    expect(typeof jobId).toBe('string');
  });

  it('registers the next-month cron schedule with the documented cron string', async () => {
    await scheduleNextMonthGeneration(boss);

    const schedules = await boss.getSchedules();
    const rosterSchedule = schedules.find((s) => s.name === QUEUES.ROSTER_GENERATION);
    expect(rosterSchedule).toBeDefined();
    expect(rosterSchedule?.cron).toBe(NEXT_MONTH_CRON_SCHEDULE);
    expect(NEXT_MONTH_CRON_SCHEDULE).toBe('0 6 25 * *');
  });
});
