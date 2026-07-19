import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidIsraeliId } from '@rostering/shared';

import { dayColumns } from '../../src/csv/availability.js';
import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';
import { buildTestApp } from '../helpers/testApp.js';

function validNationalId(prefix: number): string {
  const base = String(prefix).padStart(8, '0');
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${base}${checkDigit}`;
    if (isValidIsraeliId(candidate)) return candidate;
  }
  throw new Error('no valid check digit found');
}

const FEB_2027 = '2027-02'; // 28 days

describe('/api/availability/:month (bulk JSON, manual/grid path)', () => {
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

  async function makeWorker(prefix: number, companyId?: number) {
    const cid = companyId ?? (await prisma.company.create({ data: { name: `Company ${prefix}` } })).id;
    return prisma.worker.create({
      data: {
        nationalId: validNationalId(prefix),
        name: `Worker ${prefix}`,
        role: 'GENERAL_GUARD',
        status: 'ACTIVE',
        companyId: cid,
      },
    });
  }

  describe('GET /api/availability/:month', () => {
    it('rejects a malformed month with 400 before any query runs', async () => {
      const company = await prisma.company.create({ data: { name: 'Malformed Month Co' } });
      const response = await request(app).get('/api/availability/not-a-month').query({ companyId: company.id });
      expect(response.status).toBe(400);
    });

    it('rejects (400) a request with no companyId query param', async () => {
      const response = await request(app).get(`/api/availability/${FEB_2027}`);
      expect(response.status).toBe(400);
    });

    it('returns grouped availability for the month, scoped to the given company', async () => {
      const company = await prisma.company.create({ data: { name: 'Get Month Co' } });
      const worker = await makeWorker(701, company.id);
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2027-02-05T00:00:00.000Z'), excludedShifts: 'AB' },
      });

      const response = await request(app)
        .get(`/api/availability/${FEB_2027}`)
        .query({ companyId: company.id });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ [String(worker.id)]: { '2027-02-05': ['A', 'B'] } });
    });

    it('never returns another company\'s workers\' rows (v4 company scoping)', async () => {
      const companyA = await prisma.company.create({ data: { name: 'Cross GET Co A' } });
      const companyB = await prisma.company.create({ data: { name: 'Cross GET Co B' } });
      const workerA = await makeWorker(722, companyA.id);
      const workerB = await makeWorker(723, companyB.id);
      await prisma.workerAvailability.create({
        data: { workerId: workerA.id, date: new Date('2027-02-05T00:00:00.000Z'), excludedShifts: 'A' },
      });
      await prisma.workerAvailability.create({
        data: { workerId: workerB.id, date: new Date('2027-02-06T00:00:00.000Z'), excludedShifts: 'B' },
      });

      const responseA = await request(app)
        .get(`/api/availability/${FEB_2027}`)
        .query({ companyId: companyA.id });
      expect(responseA.status).toBe(200);
      expect(responseA.body).toEqual({ [String(workerA.id)]: { '2027-02-05': ['A'] } });
      expect(responseA.body).not.toHaveProperty(String(workerB.id));

      const responseB = await request(app)
        .get(`/api/availability/${FEB_2027}`)
        .query({ companyId: companyB.id });
      expect(responseB.status).toBe(200);
      expect(responseB.body).toEqual({ [String(workerB.id)]: { '2027-02-06': ['B'] } });
      expect(responseB.body).not.toHaveProperty(String(workerA.id));
    });
  });

  describe('PUT /api/availability/:month', () => {
    it('rejects a malformed month with 400', async () => {
      const company = await prisma.company.create({ data: { name: 'Month Co' } });
      const response = await request(app)
        .put('/api/availability/2027-13')
        .query({ companyId: company.id })
        .send({});
      expect(response.status).toBe(400);
    });

    it('rejects (400) a request with no companyId query param', async () => {
      const worker = await makeWorker(720);
      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .send({ [String(worker.id)]: { '2027-02-01': ['A'] } });
      expect(response.status).toBe(400);
    });

    it('full-replaces the month and returns 200', async () => {
      const company = await prisma.company.create({ data: { name: 'Full Replace Co' } });
      const worker = await makeWorker(702, company.id);
      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .query({ companyId: company.id })
        .send({ [String(worker.id)]: { '2027-02-01': ['A'] } });

      expect(response.status).toBe(200);
      const rows = await prisma.workerAvailability.findMany({ where: { workerId: worker.id } });
      expect(rows).toHaveLength(1);
    });

    it('rejects (400) a date outside the target month', async () => {
      const company = await prisma.company.create({ data: { name: 'Date Co' } });
      const worker = await makeWorker(703, company.id);
      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .query({ companyId: company.id })
        .send({ [String(worker.id)]: { '2027-03-01': ['A'] } });
      expect(response.status).toBe(400);
    });

    it('rejects (400) an illegal shift subset (duplicate letter)', async () => {
      const company = await prisma.company.create({ data: { name: 'Shift Co' } });
      const worker = await makeWorker(704, company.id);
      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .query({ companyId: company.id })
        .send({ [String(worker.id)]: { '2027-02-01': ['A', 'A'] } });
      expect(response.status).toBe(400);
    });

    it('rejects (400) an unknown workerId key, not a masked 500', async () => {
      const company = await prisma.company.create({ data: { name: 'Unknown Worker Co' } });
      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .query({ companyId: company.id })
        .send({ '999999': { '2027-02-01': ['A'] } });
      expect(response.status).toBe(400);
    });

    it('rejects (400) a non-numeric workerId key via the shared schema', async () => {
      const company = await prisma.company.create({ data: { name: 'Non Numeric Co' } });
      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .query({ companyId: company.id })
        .send({ 'not-a-worker-id': { '2027-02-01': ['A'] } });
      expect(response.status).toBe(400);
    });

    it('rejects (400) a workerId that belongs to a DIFFERENT company than the query companyId, without touching it', async () => {
      const companyA = await prisma.company.create({ data: { name: 'Cross PUT Co A' } });
      const companyB = await prisma.company.create({ data: { name: 'Cross PUT Co B' } });
      const workerB = await makeWorker(721, companyB.id);
      await prisma.workerAvailability.create({
        data: { workerId: workerB.id, date: new Date('2027-02-10T00:00:00.000Z'), excludedShifts: 'ABC' },
      });

      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .query({ companyId: companyA.id })
        .send({ [String(workerB.id)]: { '2027-02-01': ['A'] } });

      expect(response.status).toBe(400);
      const rows = await prisma.workerAvailability.findMany({ where: { workerId: workerB.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.excludedShifts).toBe('ABC'); // untouched
    });

    it('accepts a dense, legal payload whose JSON body exceeds the app-wide 100kb limit (route-scoped 12mb)', async () => {
      const company = await prisma.company.create({ data: { name: 'Big Co' } });
      const workers = [];
      for (let i = 0; i < 170; i++) {
        workers.push(await makeWorker(800 + i, company.id));
      }

      const payload: Record<string, Record<string, string[]>> = {};
      for (const worker of workers) {
        const byDate: Record<string, string[]> = {};
        for (const date of dayColumns(FEB_2027).map((_c, i) => `2027-02-${String(i + 1).padStart(2, '0')}`)) {
          byDate[date] = ['A', 'B', 'C'];
        }
        payload[String(worker.id)] = byDate;
      }

      const bodySize = Buffer.byteLength(JSON.stringify(payload));
      expect(bodySize).toBeGreaterThan(100 * 1024); // proves this test actually exercises the >100kb case

      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .query({ companyId: company.id })
        .send(payload);
      expect(response.status).toBe(200);

      const [firstWorker] = workers;
      if (!firstWorker) throw new Error('expected at least one seeded worker');
      const rows = await prisma.workerAvailability.findMany({ where: { workerId: firstWorker.id } });
      expect(rows).toHaveLength(28);
    }, 30_000);
  });

  describe('body-size limit is unchanged for every other route (spot check)', () => {
    it('POST /api/workers still 413s on an oversized body under the global 100kb cap', async () => {
      const company = await prisma.company.create({ data: { name: 'Alpha Security Ltd.' } });
      const response = await request(app)
        .post('/api/workers')
        .send({
          nationalId: validNationalId(709),
          name: 'a'.repeat(200 * 1024), // well over 100kb on its own
          role: 'GENERAL_GUARD',
          status: 'ACTIVE',
          companyId: company.id,
        });
      expect(response.status).toBe(413);
    });
  });
});
