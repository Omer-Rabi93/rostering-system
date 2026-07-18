import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';

import {
  cancelJob,
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
    const jobId = await enqueueCsvImport(boss, 1, 'national_id,name\n');
    expect(typeof jobId).toBe('string');
  });

  it('enqueueCsvImport returns null when a job for the same company is already in flight (singletonKey collision)', async () => {
    const companyId = 9001; // scoped to this test only, to avoid colliding with other tests' companies
    const firstJobId = await enqueueCsvImport(boss, companyId, 'national_id,name\n');
    expect(typeof firstJobId).toBe('string');

    const secondJobId = await enqueueCsvImport(boss, companyId, 'national_id,name\n');
    expect(secondJobId).toBeNull();
  });

  it('enqueueCsvImport allows two DIFFERENT companies to enqueue concurrently (no cross-company singletonKey collision)', async () => {
    const companyAJobId = await enqueueCsvImport(boss, 9002, 'national_id,name\n');
    const companyBJobId = await enqueueCsvImport(boss, 9003, 'national_id,name\n');
    expect(typeof companyAJobId).toBe('string');
    expect(typeof companyBJobId).toBe('string');
    expect(companyAJobId).not.toBe(companyBJobId);
  });

  it('enqueueAvailabilityImport returns a job id', async () => {
    const jobId = await enqueueAvailabilityImport(boss, 1, 'national_id,d01\n', '2027-05');
    expect(typeof jobId).toBe('string');
  });

  it('enqueueAvailabilityImport returns null when a job for the same company is already in flight (singletonKey collision)', async () => {
    const companyId = 9004; // scoped to this test only
    const firstJobId = await enqueueAvailabilityImport(boss, companyId, 'national_id,d01\n', '2027-05');
    expect(typeof firstJobId).toBe('string');

    const secondJobId = await enqueueAvailabilityImport(boss, companyId, 'national_id,d01\n', '2027-05');
    expect(secondJobId).toBeNull();
  });

  it('enqueueRosterGeneration returns null when a job for the same company+month is already in flight (singletonKey collision)', async () => {
    const month = '2027-03'; // scoped to this test only, to avoid colliding with other tests' months
    const firstJobId = await enqueueRosterGeneration(boss, 1, month);
    expect(typeof firstJobId).toBe('string');

    const secondJobId = await enqueueRosterGeneration(boss, 1, month);
    expect(secondJobId).toBeNull();
  });

  it('enqueueRosterGeneration allows a fresh job once the month differs', async () => {
    const jobId = await enqueueRosterGeneration(boss, 1, '2027-04');
    expect(typeof jobId).toBe('string');
  });

  it('enqueueRosterGeneration allows two DIFFERENT companies to enqueue the same month concurrently (no cross-company singletonKey collision)', async () => {
    const month = '2027-06'; // scoped to this test only
    const companyAJobId = await enqueueRosterGeneration(boss, 101, month);
    const companyBJobId = await enqueueRosterGeneration(boss, 102, month);
    expect(typeof companyAJobId).toBe('string');
    expect(typeof companyBJobId).toBe('string');
    expect(companyAJobId).not.toBe(companyBJobId);
  });

  it('cancelJob cancels a queued (not-yet-started) job, freeing its singletonKey slot', async () => {
    const companyId = 9005; // scoped to this test only
    const firstJobId = await enqueueCsvImport(boss, companyId, 'national_id,name\n');
    expect(typeof firstJobId).toBe('string');
    if (!firstJobId) throw new Error('expected a job id');

    await cancelJob(boss, QUEUES.CSV_IMPORT, firstJobId);

    const job = await boss.getJobById(QUEUES.CSV_IMPORT, firstJobId);
    expect(job?.state).toBe('cancelled');

    // The singletonKey slot is free again now that the prior job reached a terminal state.
    const secondJobId = await enqueueCsvImport(boss, companyId, 'national_id,name\n');
    expect(typeof secondJobId).toBe('string');
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
