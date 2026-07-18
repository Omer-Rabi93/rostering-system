import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';
import { buildTestApp } from '../helpers/testApp.js';

describe('GET /api/import-tasks/active', () => {
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

  it('returns 200 with null when no task is in flight for that company+kind', async () => {
    const company = await prisma.company.create({ data: { name: 'No Task Co' } });

    const response = await request(app)
      .get('/api/import-tasks/active')
      .query({ companyId: company.id, kind: 'WORKER_SYNC' });

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it('returns the non-terminal task for that company+kind when one exists', async () => {
    const company = await prisma.company.create({ data: { name: 'Active Task Co' } });
    const task = await prisma.importTask.create({
      data: { companyId: company.id, kind: 'WORKER_SYNC', status: 'PROCESSING' },
    });

    const response = await request(app)
      .get('/api/import-tasks/active')
      .query({ companyId: company.id, kind: 'WORKER_SYNC' });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(task.id);
    expect(response.body.status).toBe('PROCESSING');
  });

  it('does not return a terminal (COMPLETED/CANCELLED/FAILED) task', async () => {
    const company = await prisma.company.create({ data: { name: 'Terminal Task Co' } });
    await prisma.importTask.create({
      data: { companyId: company.id, kind: 'WORKER_SYNC', status: 'COMPLETED', finishedAt: new Date() },
    });

    const response = await request(app)
      .get('/api/import-tasks/active')
      .query({ companyId: company.id, kind: 'WORKER_SYNC' });

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it('scopes strictly by kind -- an in-flight AVAILABILITY_SYNC task is not returned for a WORKER_SYNC query', async () => {
    const company = await prisma.company.create({ data: { name: 'Kind Scoped Co' } });
    await prisma.importTask.create({
      data: { companyId: company.id, kind: 'AVAILABILITY_SYNC', status: 'PENDING', month: '2027-05' },
    });

    const response = await request(app)
      .get('/api/import-tasks/active')
      .query({ companyId: company.id, kind: 'WORKER_SYNC' });

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it('scopes strictly by companyId -- another company\'s in-flight task is never returned', async () => {
    const companyA = await prisma.company.create({ data: { name: 'Scope Co A' } });
    const companyB = await prisma.company.create({ data: { name: 'Scope Co B' } });
    await prisma.importTask.create({
      data: { companyId: companyB.id, kind: 'WORKER_SYNC', status: 'PENDING' },
    });

    const response = await request(app)
      .get('/api/import-tasks/active')
      .query({ companyId: companyA.id, kind: 'WORKER_SYNC' });

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it('returns 400 for a missing or invalid companyId/kind', async () => {
    const missingCompanyId = await request(app).get('/api/import-tasks/active').query({ kind: 'WORKER_SYNC' });
    expect(missingCompanyId.status).toBe(400);

    const badKind = await request(app).get('/api/import-tasks/active').query({ companyId: 1, kind: 'NOT_A_KIND' });
    expect(badKind.status).toBe(400);
  });
});
