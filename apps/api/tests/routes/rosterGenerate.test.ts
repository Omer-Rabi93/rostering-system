import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createBoss, ensureQueues, QUEUES } from '../../src/jobs/queue.js';
import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';
import { buildTestApp } from '../helpers/testApp.js';

// This suite runs against a persistent, shared dev Postgres (not reset between test runs the way
// the Prisma-backed `public` schema is via `resetDatabase`). Purge any `roster-generation`/
// `workforce-import` jobs left queued by a previous run so the singletonKey-collision assertions
// below are never polluted by a stale "created" job that no worker ever consumed.
beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const cleanupBoss = createBoss(databaseUrl);
  await cleanupBoss.start();
  await ensureQueues(cleanupBoss);
  await cleanupBoss.deleteQueuedJobs(QUEUES.ROSTER_GENERATION);
  await cleanupBoss.deleteQueuedJobs(QUEUES.WORKFORCE_IMPORT);
  await cleanupBoss.stop({ graceful: false, close: true });
});

describe('POST /api/rosters/generate', () => {
  const prisma = getTestPrismaClient();
  let app: Express;

  beforeAll(() => {
    app = buildTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  async function makeCompany(name: string) {
    return prisma.company.create({ data: { name } });
  }

  it('enqueues a generation job and returns 202 with a jobId', async () => {
    const company = await makeCompany('Generate Co 1');
    const response = await request(app).post('/api/rosters/generate').send({ companyId: company.id, month: '2028-01' });
    expect(response.status).toBe(202);
    expect(typeof response.body.jobId).toBe('string');
  });

  it('returns 400 for a malformed month', async () => {
    const company = await makeCompany('Generate Co 2');
    const response = await request(app).post('/api/rosters/generate').send({ companyId: company.id, month: 'January 2028' });
    expect(response.status).toBe(400);
  });

  it('returns 400 when companyId is missing', async () => {
    const response = await request(app).post('/api/rosters/generate').send({ month: '2028-01' });
    expect(response.status).toBe(400);
  });

  it('returns 409 when a generation job for the same company+month is already in flight', async () => {
    const company = await makeCompany('Generate Co 3');
    const first = await request(app).post('/api/rosters/generate').send({ companyId: company.id, month: '2028-02' });
    expect(first.status).toBe(202);

    const second = await request(app).post('/api/rosters/generate').send({ companyId: company.id, month: '2028-02' });
    expect(second.status).toBe(409);
    // Structured discriminant so the client can tell this apart from "already published" without
    // parsing the message text.
    expect(second.body.reason).toBe('generation-in-progress');
  });

  it('allows two DIFFERENT companies to enqueue the same month concurrently (no cross-company collision)', async () => {
    const companyA = await makeCompany('Generate Co 4A');
    const companyB = await makeCompany('Generate Co 4B');

    const responseA = await request(app).post('/api/rosters/generate').send({ companyId: companyA.id, month: '2028-07' });
    const responseB = await request(app).post('/api/rosters/generate').send({ companyId: companyB.id, month: '2028-07' });

    expect(responseA.status).toBe(202);
    expect(responseB.status).toBe(202);
    expect(responseA.body.jobId).not.toBe(responseB.body.jobId);
  });

  it('returns 409 for an already-published month without force', async () => {
    const company = await makeCompany('Generate Co 5');
    const roster = await prisma.roster.create({
      data: { companyId: company.id, month: '2028-03', status: 'PUBLISHED', publishedAt: new Date() },
    });
    expect(roster.status).toBe('PUBLISHED');

    const response = await request(app).post('/api/rosters/generate').send({ companyId: company.id, month: '2028-03' });
    expect(response.status).toBe(409);
    expect(response.body.reason).toBe('already-published');
  });

  it('does not treat another company publishing the same month as a collision', async () => {
    const companyA = await makeCompany('Generate Co 6A');
    const companyB = await makeCompany('Generate Co 6B');
    await prisma.roster.create({
      data: { companyId: companyA.id, month: '2028-03', status: 'PUBLISHED', publishedAt: new Date() },
    });

    const response = await request(app).post('/api/rosters/generate').send({ companyId: companyB.id, month: '2028-03' });
    expect(response.status).toBe(202);
  });

  it('allows regenerating an already-published month when force:true is passed', async () => {
    const company = await makeCompany('Generate Co 7');
    await prisma.roster.create({
      data: { companyId: company.id, month: '2028-04', status: 'PUBLISHED', publishedAt: new Date() },
    });

    const response = await request(app)
      .post('/api/rosters/generate')
      .send({ companyId: company.id, month: '2028-04', force: true });
    expect(response.status).toBe(202);
  });
});

describe('GET /api/jobs/:id', () => {
  const prisma = getTestPrismaClient();
  let app: Express;

  beforeAll(() => {
    app = buildTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  it('returns 404 for an unknown job id', async () => {
    const response = await request(app).get('/api/jobs/00000000-0000-0000-0000-000000000000');
    expect(response.status).toBe(404);
  });

  it('returns the job record shape for a freshly-enqueued (not yet processed) job', async () => {
    const company = await prisma.company.create({ data: { name: 'Jobs Co' } });
    const enqueueResponse = await request(app).post('/api/rosters/generate').send({ companyId: company.id, month: '2028-05' });
    const { jobId } = enqueueResponse.body as { jobId: string };

    const response = await request(app).get(`/api/jobs/${jobId}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: jobId, name: 'roster-generation', state: 'created', result: null });
    expect(typeof response.body.createdAt).toBe('string');
    expect(response.body.completedAt).toBeNull();
  });
});
