import request from 'supertest';
import type { Express } from 'express';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidIsraeliId } from '@rostering/shared';

import { availabilityCsvHeader, dayColumns, serializeAvailabilityCsv } from '../../src/csv/availability.js';
import { createAvailabilityImportHandler } from '../../src/jobs/availabilityImport.job.js';
import { createBoss, ensureQueues, registerAvailabilityImportWorker } from '../../src/jobs/queue.js';
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

describe('/api/availability/:month (bulk JSON) and availability CSV import/export', () => {
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
      const response = await request(app).get('/api/availability/not-a-month');
      expect(response.status).toBe(400);
    });

    it('returns grouped availability for the month', async () => {
      const worker = await makeWorker(701);
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2027-02-05T00:00:00.000Z'), shifts: 'AB' },
      });

      const response = await request(app).get(`/api/availability/${FEB_2027}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ [String(worker.id)]: { '2027-02-05': ['A', 'B'] } });
    });
  });

  describe('PUT /api/availability/:month', () => {
    it('rejects a malformed month with 400', async () => {
      const response = await request(app).put('/api/availability/2027-13').send({});
      expect(response.status).toBe(400);
    });

    it('full-replaces the month and returns 200', async () => {
      const worker = await makeWorker(702);
      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .send({ [String(worker.id)]: { '2027-02-01': ['A'] } });

      expect(response.status).toBe(200);
      const rows = await prisma.workerAvailability.findMany({ where: { workerId: worker.id } });
      expect(rows).toHaveLength(1);
    });

    it('rejects (400) a date outside the target month', async () => {
      const worker = await makeWorker(703);
      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .send({ [String(worker.id)]: { '2027-03-01': ['A'] } });
      expect(response.status).toBe(400);
    });

    it('rejects (400) an illegal shift subset (duplicate letter)', async () => {
      const worker = await makeWorker(704);
      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .send({ [String(worker.id)]: { '2027-02-01': ['A', 'A'] } });
      expect(response.status).toBe(400);
    });

    it('rejects (400) an unknown workerId key, not a masked 500', async () => {
      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .send({ '999999': { '2027-02-01': ['A'] } });
      expect(response.status).toBe(400);
    });

    it('rejects (400) a non-numeric workerId key via the shared schema', async () => {
      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .send({ 'not-a-worker-id': { '2027-02-01': ['A'] } });
      expect(response.status).toBe(400);
    });

    it('accepts a dense, legal payload whose JSON body exceeds the app-wide 100kb limit (route-scoped 2mb)', async () => {
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

      const response = await request(app).put(`/api/availability/${FEB_2027}`).send(payload);
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

  describe('GET /api/export/availability/:month', () => {
    it('rejects a malformed month with 400', async () => {
      const response = await request(app).get('/api/export/availability/bad-month');
      expect(response.status).toBe(400);
    });

    it('returns text/csv with the security headers and a re-importable body', async () => {
      const worker = await makeWorker(705);
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2027-02-05T00:00:00.000Z'), shifts: 'ABC' },
      });

      const response = await request(app).get(`/api/export/availability/${FEB_2027}`);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/csv/);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-disposition']).toMatch(/attachment/);
      expect(response.text.split('\n')[0]).toBe(availabilityCsvHeader(FEB_2027).join(','));
      expect(response.text).toContain(worker.nationalId);
    });
  });

  describe('POST /api/import/availability/:month', () => {
    it('accepts a well-formed CSV upload for the exact month shape and returns 202 with a jobId', async () => {
      const worker = await makeWorker(706);
      const csv = serializeAvailabilityCsv(
        [{ nationalId: worker.nationalId, entries: [{ date: '2027-02-01', shifts: ['A'] }] }],
        FEB_2027,
      );

      const response = await request(app)
        .post(`/api/import/availability/${FEB_2027}`)
        .attach('file', Buffer.from(csv), { filename: 'availability.csv', contentType: 'text/csv' });

      expect(response.status).toBe(202);
      expect(typeof response.body.jobId).toBe('string');
    });

    it('rejects a malformed month with 400 before any file handling', async () => {
      const response = await request(app).post('/api/import/availability/not-a-month');
      expect(response.status).toBe(400);
    });

    it('returns 400 when no file is attached', async () => {
      const response = await request(app).post(`/api/import/availability/${FEB_2027}`);
      expect(response.status).toBe(400);
    });

    it('returns 400 for a non-CSV file extension/mimetype', async () => {
      const response = await request(app)
        .post(`/api/import/availability/${FEB_2027}`)
        .attach('file', Buffer.from('not a csv'), { filename: 'availability.txt', contentType: 'text/plain' });
      expect(response.status).toBe(400);
    });

    it('rejects (400, pre-enqueue) a header with the wrong month day-count (31-day export into a 28-day month)', async () => {
      const worker = await makeWorker(707);
      const wrongMonthCsv = serializeAvailabilityCsv(
        [{ nationalId: worker.nationalId, entries: [{ date: '2027-01-01', shifts: ['A'] }] }],
        '2027-01', // 31 days
      );

      const response = await request(app)
        .post(`/api/import/availability/${FEB_2027}`) // target: 28-day month
        .attach('file', Buffer.from(wrongMonthCsv), { filename: 'availability.csv', contentType: 'text/csv' });

      expect(response.status).toBe(400);
    });

    it('returns 400 when the file exceeds the multer size cap', async () => {
      const oversized = Buffer.alloc(3 * 1024 * 1024, 'a');
      const response = await request(app)
        .post(`/api/import/availability/${FEB_2027}`)
        .attach('file', oversized, { filename: 'availability.csv', contentType: 'text/csv' });
      expect(response.status).toBe(400);
    });

    // The rest of the suite (like `tests/routes/importExport.test.ts`) only asserts the 202/jobId
    // HTTP contract -- no pg-boss worker runs during the suite, so a sent job just sits queued.
    // This nested block runs its own dedicated `availability-import` worker (against the same
    // shared Postgres) so the full route -> job -> service pipeline, including per-row error
    // reporting, can be proven end-to-end exactly once.
    describe('end-to-end per-row error reporting (dedicated worker)', () => {
      let workerBoss: PgBoss;

      beforeAll(async () => {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) throw new Error('DATABASE_URL is not set for the availability-import worker test');
        workerBoss = createBoss(databaseUrl);
        await workerBoss.start();
        await ensureQueues(workerBoss);
        await registerAvailabilityImportWorker(workerBoss, createAvailabilityImportHandler(prisma));
      });

      afterAll(async () => {
        await workerBoss.stop({ graceful: false, close: true });
      });

      it('an illegal shift-letter cell and an unknown national_id are both reported without aborting the batch', async () => {
        const good = await makeWorker(710);
        const header = availabilityCsvHeader(FEB_2027).join(',');
        const goodRow = [good.nationalId, 'A', ...Array(27).fill('')].join(',');
        const badRow = [validNationalId(711), 'AD', ...Array(27).fill('')].join(',');
        const unknownRow = [validNationalId(712), '', ...Array(27).fill('')].join(',');
        const csv = `${header}\n${goodRow}\n${badRow}\n${unknownRow}\n`;

        const uploadResponse = await request(app)
          .post(`/api/import/availability/${FEB_2027}`)
          .attach('file', Buffer.from(csv), { filename: 'availability.csv', contentType: 'text/csv' });
        expect(uploadResponse.status).toBe(202);
        const { jobId } = uploadResponse.body as { jobId: string };

        // Poll GET /api/jobs/:id until the job reaches a terminal state.
        let result: unknown = null;
        for (let attempt = 0; attempt < 60; attempt++) {
          const jobResponse = await request(app).get(`/api/jobs/${jobId}`);
          if (jobResponse.body.state === 'completed' || jobResponse.body.state === 'failed') {
            result = jobResponse.body.result;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        expect(result).toMatchObject({ totalRows: 3, applied: 1, failed: 2 });
        const rows = await prisma.workerAvailability.findMany({ where: { workerId: good.id } });
        expect(rows).toHaveLength(1);
      }, 20_000);
    });
  });
});
