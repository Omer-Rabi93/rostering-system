import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  badRequestErrorSchema,
  conflictMessageErrorSchema,
  conflictWarningErrorSchema,
  notFoundErrorSchema,
  publishConflictErrorSchema,
  unprocessableErrorSchema,
} from '@rostering/shared';

import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from './helpers/testDb.js';
import { buildTestApp } from './helpers/testApp.js';

/**
 * Confirms every documented error envelope actually round-trips through the SAME Zod schemas
 * `packages/shared` exports for clients to validate against — not just an eyeballed shape match.
 */
describe('error envelopes conform to @rostering/shared schemas', () => {
  const prisma = getTestPrismaClient();
  const app = buildTestApp();

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  it('400 (Zod validation) matches badRequestErrorSchema', async () => {
    const response = await request(app).post('/api/companies').send({ name: '' });
    expect(response.status).toBe(400);
    expect(() => badRequestErrorSchema.parse(response.body)).not.toThrow();
  });

  it('404 matches notFoundErrorSchema', async () => {
    const response = await request(app).get('/api/workers/999999');
    expect(response.status).toBe(404);
    expect(() => notFoundErrorSchema.parse(response.body)).not.toThrow();
  });

  it('409 duplicate-name matches conflictMessageErrorSchema', async () => {
    await request(app).post('/api/companies').send({ name: 'Alpha Ltd.' });
    const response = await request(app).post('/api/companies').send({ name: 'Alpha Ltd.' });
    expect(response.status).toBe(409);
    expect(() => conflictMessageErrorSchema.parse(response.body)).not.toThrow();
  });

  it('409 soft-warning matches conflictWarningErrorSchema', async () => {
    const company = await prisma.company.create({ data: { name: 'Alpha Ltd.' } });
    const worker = await prisma.worker.create({
      data: { nationalId: '000000018', name: 'Test Worker', role: 'GENERAL_GUARD', companyId: company.id },
    });
    await prisma.contract.create({
      data: {
        workerId: worker.id,
        hourlyCostIls: 40,
        minMonthlyHours: 0,
        maxMonthlyHours: 0,
      },
    });
    // Availability v2: the add below must clear the HARD `withinAvailability` rule so the only
    // violation raised is the SOFT `exceedsMaxMonthlyHours` one this test is actually about.
    await prisma.workerAvailability.create({
      data: { workerId: worker.id, date: new Date('2026-08-01T00:00:00.000Z'), shifts: 'ABC' },
    });
    const roster = await prisma.roster.create({ data: { month: '2026-08' } });
    const shift = await prisma.shift.create({
      data: { rosterId: roster.id, date: new Date('2026-08-01T00:00:00.000Z'), shiftType: 'A' },
    });

    const response = await request(app).post(`/api/shifts/${shift.id}/workers`).send({ workerId: worker.id });

    expect(response.status).toBe(409);
    expect(() => conflictWarningErrorSchema.parse(response.body)).not.toThrow();
  });

  it('422 matches unprocessableErrorSchema', async () => {
    const company = await prisma.company.create({ data: { name: 'Alpha Ltd.' } });
    const worker = await prisma.worker.create({
      data: {
        nationalId: '000000018',
        name: 'Test Worker',
        role: 'GENERAL_GUARD',
        status: 'INACTIVE',
        companyId: company.id,
      },
    });
    await prisma.contract.create({
      data: {
        workerId: worker.id,
        hourlyCostIls: 40,
        minMonthlyHours: 0,
        maxMonthlyHours: 200,
      },
    });
    const roster = await prisma.roster.create({ data: { month: '2026-08' } });
    const shift = await prisma.shift.create({
      data: { rosterId: roster.id, date: new Date('2026-08-01T00:00:00.000Z'), shiftType: 'A' },
    });

    const response = await request(app).post(`/api/shifts/${shift.id}/workers`).send({ workerId: worker.id });

    expect(response.status).toBe(422);
    expect(() => unprocessableErrorSchema.parse(response.body)).not.toThrow();
  });

  it('409 publish-gate matches publishConflictErrorSchema', async () => {
    const roster = await prisma.roster.create({ data: { month: '2026-08' } });
    await prisma.alert.create({
      data: { rosterId: roster.id, type: 'MIN_HOURS_SHORTFALL', detail: { workerId: 1, deficitHours: 10 } },
    });

    const response = await request(app).post(`/api/rosters/${roster.id}/publish`);

    expect(response.status).toBe(409);
    expect(() => publishConflictErrorSchema.parse(response.body)).not.toThrow();
  });
});
