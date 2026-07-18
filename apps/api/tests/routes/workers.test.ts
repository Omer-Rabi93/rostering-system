import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidIsraeliId } from '@rostering/shared';

import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';
import { buildTestApp } from '../helpers/testApp.js';

/** Deterministically derives a checksum-valid 9-digit Israeli ID for test fixtures. */
function validNationalId(prefix: number): string {
  const base = String(prefix).padStart(8, '0');
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${base}${checkDigit}`;
    if (isValidIsraeliId(candidate)) return candidate;
  }
  throw new Error('no valid check digit found');
}

const ID_A = validNationalId(101);
const ID_B = validNationalId(102);
const ID_C = validNationalId(103);

describe('/api/workers', () => {
  const prisma = getTestPrismaClient();
  const app = buildTestApp();

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  async function makeCompany(name = 'Alpha Security Ltd.') {
    return prisma.company.create({ data: { name } });
  }

  describe('POST /api/workers', () => {
    it('creates a worker', async () => {
      const company = await makeCompany();

      const response = await request(app).post('/api/workers').send({
        nationalId: ID_A,
        name: 'Noa Levi',
        role: 'GENERAL_GUARD',
        status: 'ACTIVE',
        companyId: company.id,
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        nationalId: ID_A,
        name: 'Noa Levi',
        role: 'GENERAL_GUARD',
        status: 'ACTIVE',
        companyId: company.id,
      });
      expect(response.body.id).toEqual(expect.any(Number));
    });

    it('returns 400 for a bad Israeli ID checksum', async () => {
      const company = await makeCompany();

      const response = await request(app).post('/api/workers').send({
        nationalId: '123456789',
        name: 'Bad Checksum',
        role: 'GENERAL_GUARD',
        status: 'ACTIVE',
        companyId: company.id,
      });

      expect(response.status).toBe(400);
      expect(response.body.errors).toBeInstanceOf(Array);
    });

    it('returns 400 for an unknown companyId', async () => {
      const response = await request(app).post('/api/workers').send({
        nationalId: ID_A,
        name: 'Noa Levi',
        role: 'GENERAL_GUARD',
        status: 'ACTIVE',
        companyId: 999999,
      });

      expect(response.status).toBe(400);
      expect(response.body.errors).toBeInstanceOf(Array);
    });

    it('returns 409 for a duplicate nationalId', async () => {
      const company = await makeCompany();
      await request(app).post('/api/workers').send({
        nationalId: ID_A,
        name: 'Noa Levi',
        role: 'GENERAL_GUARD',
        status: 'ACTIVE',
        companyId: company.id,
      });

      const response = await request(app).post('/api/workers').send({
        nationalId: ID_A,
        name: 'Someone Else',
        role: 'SUPERVISOR',
        status: 'ACTIVE',
        companyId: company.id,
      });

      expect(response.status).toBe(409);
    });

    it('rejects unknown fields (.strict())', async () => {
      const company = await makeCompany();
      const response = await request(app)
        .post('/api/workers')
        .send({
          nationalId: ID_A,
          name: 'Noa Levi',
          role: 'GENERAL_GUARD',
          status: 'ACTIVE',
          companyId: company.id,
          extra: 'nope',
        });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/workers/:id', () => {
    it('returns the worker with a null contract when none exists', async () => {
      const company = await makeCompany();
      const worker = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Noa Levi', role: 'GENERAL_GUARD', companyId: company.id },
      });

      const response = await request(app).get(`/api/workers/${worker.id}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: worker.id, name: 'Noa Levi' });
      expect(response.body.contract).toBeNull();
    });

    it('returns 404 for an unknown worker id', async () => {
      const response = await request(app).get('/api/workers/999999');
      expect(response.status).toBe(404);
    });
  });

  describe('PUT /api/workers/:id', () => {
    it('updates a worker', async () => {
      const company = await makeCompany();
      const worker = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Noa Levi', role: 'GENERAL_GUARD', companyId: company.id },
      });

      const response = await request(app).put(`/api/workers/${worker.id}`).send({
        nationalId: ID_A,
        name: 'Noa Levi-Cohen',
        role: 'SUPERVISOR',
        status: 'ACTIVE',
        companyId: company.id,
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ name: 'Noa Levi-Cohen', role: 'SUPERVISOR' });
    });

    it('returns 404 for an unknown worker id', async () => {
      const company = await makeCompany();
      const response = await request(app).put('/api/workers/999999').send({
        nationalId: ID_A,
        name: 'Noa Levi',
        role: 'GENERAL_GUARD',
        status: 'ACTIVE',
        companyId: company.id,
      });
      expect(response.status).toBe(404);
    });

    it('returns 409 when updating to a nationalId already used by another worker', async () => {
      const company = await makeCompany();
      await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Worker A', role: 'GENERAL_GUARD', companyId: company.id },
      });
      const workerB = await prisma.worker.create({
        data: { nationalId: ID_B, name: 'Worker B', role: 'GENERAL_GUARD', companyId: company.id },
      });

      const response = await request(app).put(`/api/workers/${workerB.id}`).send({
        nationalId: ID_A,
        name: 'Worker B',
        role: 'GENERAL_GUARD',
        status: 'ACTIVE',
        companyId: company.id,
      });

      expect(response.status).toBe(409);
    });
  });

  describe('DELETE /api/workers/:id', () => {
    it('deletes a worker with no shift history', async () => {
      const company = await makeCompany();
      const worker = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Noa Levi', role: 'GENERAL_GUARD', companyId: company.id },
      });

      const response = await request(app).delete(`/api/workers/${worker.id}`);

      expect(response.status).toBe(204);
      await expect(prisma.worker.count()).resolves.toBe(0);
    });

    it('returns 404 for an unknown worker id', async () => {
      const response = await request(app).delete('/api/workers/999999');
      expect(response.status).toBe(404);
    });

    it('returns 409 and does not delete a worker with shift history', async () => {
      const company = await makeCompany();
      const worker = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Noa Levi', role: 'GENERAL_GUARD', companyId: company.id },
      });
      const roster = await prisma.roster.create({ data: { companyId: company.id, month: '2026-08' } });
      const shift = await prisma.shift.create({
        data: { rosterId: roster.id, date: new Date('2026-08-01T00:00:00.000Z'), shiftType: 'A' },
      });
      await prisma.shiftWorker.create({
        data: { shiftId: shift.id, workerId: worker.id, role: 'GENERAL_GUARD' },
      });

      const response = await request(app).delete(`/api/workers/${worker.id}`);

      expect(response.status).toBe(409);
      await expect(prisma.worker.count()).resolves.toBe(1);
    });
  });

  describe('GET /api/workers (filters)', () => {
    it('filters by status, role, companyId, and free-text q, combined', async () => {
      const alpha = await makeCompany('Alpha Security Ltd.');
      const beta = await makeCompany('Beta Guarding Co.');

      await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Noa Levi', role: 'GENERAL_GUARD', status: 'ACTIVE', companyId: alpha.id },
      });
      await prisma.worker.create({
        data: { nationalId: ID_B, name: 'Avi Cohen', role: 'SUPERVISOR', status: 'ACTIVE', companyId: alpha.id },
      });
      await prisma.worker.create({
        data: { nationalId: ID_C, name: 'Dana Mizrahi', role: 'GENERAL_GUARD', status: 'INACTIVE', companyId: beta.id },
      });

      const all = await request(app).get('/api/workers');
      expect(all.body).toHaveLength(3);

      const byStatus = await request(app).get('/api/workers?status=ACTIVE');
      expect(byStatus.body).toHaveLength(2);

      const byRole = await request(app).get('/api/workers?role=SUPERVISOR');
      expect(byRole.body).toHaveLength(1);
      expect(byRole.body[0].name).toBe('Avi Cohen');

      const byCompany = await request(app).get(`/api/workers?companyId=${beta.id}`);
      expect(byCompany.body).toHaveLength(1);
      expect(byCompany.body[0].name).toBe('Dana Mizrahi');

      const byQ = await request(app).get('/api/workers?q=levi');
      expect(byQ.body).toHaveLength(1);
      expect(byQ.body[0].name).toBe('Noa Levi');

      const combined = await request(app).get(`/api/workers?status=ACTIVE&role=GENERAL_GUARD&companyId=${alpha.id}`);
      expect(combined.body).toHaveLength(1);
      expect(combined.body[0].name).toBe('Noa Levi');
    });
  });

  describe('/api/workers/:id/contract', () => {
    it('returns 404 reading a contract for an unknown worker', async () => {
      const response = await request(app).get('/api/workers/999999/contract');
      expect(response.status).toBe(404);
    });

    it('returns 404 reading a contract that does not exist yet', async () => {
      const company = await makeCompany();
      const worker = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Noa Levi', role: 'GENERAL_GUARD', companyId: company.id },
      });

      const response = await request(app).get(`/api/workers/${worker.id}/contract`);
      expect(response.status).toBe(404);
    });

    // Availability v2: `Contract` (and the `PUT /api/workers/:id/contract` body it validates
    // against) carries only rate/min/max hours -- `availableDays`/`availableShifts` were removed
    // from `contractSchema` entirely, not reshaped, so there is no "malformed availableDays/
    // availableShifts shape" case left to test here; date-specific availability moves to its own
    // `WorkerAvailability` table/endpoint (Phase V4), covered by that endpoint's own test suite.

    it('creates a contract when none exists (upsert)', async () => {
      const company = await makeCompany();
      const worker = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Noa Levi', role: 'GENERAL_GUARD', companyId: company.id },
      });

      const response = await request(app).put(`/api/workers/${worker.id}/contract`).send({
        hourlyCostIls: 45,
        minMonthlyHours: 120,
        maxMonthlyHours: 200,
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ hourlyCostIls: 45, minMonthlyHours: 120, maxMonthlyHours: 200 });

      const getResponse = await request(app).get(`/api/workers/${worker.id}/contract`);
      expect(getResponse.status).toBe(200);
      expect(getResponse.body).toMatchObject({ hourlyCostIls: 45 });
    });

    it('replaces an existing contract (upsert)', async () => {
      const company = await makeCompany();
      const worker = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Noa Levi', role: 'GENERAL_GUARD', companyId: company.id },
      });
      await request(app).put(`/api/workers/${worker.id}/contract`).send({
        hourlyCostIls: 45,
        minMonthlyHours: 120,
        maxMonthlyHours: 200,
      });

      const response = await request(app).put(`/api/workers/${worker.id}/contract`).send({
        hourlyCostIls: 50,
        minMonthlyHours: 100,
        maxMonthlyHours: 180,
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ hourlyCostIls: 50, minMonthlyHours: 100, maxMonthlyHours: 180 });
      await expect(prisma.contract.count()).resolves.toBe(1);
    });

    it('returns 400 when minMonthlyHours > maxMonthlyHours', async () => {
      const company = await makeCompany();
      const worker = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Noa Levi', role: 'GENERAL_GUARD', companyId: company.id },
      });

      const response = await request(app).put(`/api/workers/${worker.id}/contract`).send({
        hourlyCostIls: 45,
        minMonthlyHours: 200,
        maxMonthlyHours: 100,
      });

      expect(response.status).toBe(400);
    });

    it('returns 404 upserting a contract for an unknown worker', async () => {
      const response = await request(app).put('/api/workers/999999/contract').send({
        hourlyCostIls: 45,
        minMonthlyHours: 100,
        maxMonthlyHours: 200,
      });
      expect(response.status).toBe(404);
    });
  });
});
