import request from 'supertest';
import type { Express } from 'express';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidIsraeliId } from '@rostering/shared';

import { availabilityCsvHeader, dayColumns, serializeAvailabilityCsv } from '../../src/csv/availability.js';
import { createAvailabilityImportHandler } from '../../src/jobs/availabilityImport.job.js';
import { createBoss, ensureQueues, QUEUES, registerAvailabilityImportWorker } from '../../src/jobs/queue.js';
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
  let purgeBoss: PgBoss;

  beforeAll(async () => {
    app = buildTestApp();

    // This suite runs against a persistent, shared dev Postgres (not reset between runs like the
    // Prisma-backed `public` schema is, per `testDb.ts`'s own doc comment) -- and `resetDatabase`'s
    // `RESTART IDENTITY` means every test's freshly-created company tends to reuse the SAME low
    // integer ids (1, 2, 3, ...) run after run. A queued-but-never-consumed `availability-import`
    // job left over from an earlier run (e.g. `jobs/queue.test.ts`'s own `enqueueAvailabilityImport`
    // assertions, which never consume the jobs they send) can therefore still be occupying the
    // `<companyId>:AVAILABILITY_SYNC` singletonKey slot for a company id this run reuses. Purge
    // before this file's own tests run, mirroring `jobs/queue.test.ts`'s identical defensive
    // cleanup for the exact same reason.
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set for the availability route test suite');
    purgeBoss = createBoss(databaseUrl);
    await purgeBoss.start();
    await ensureQueues(purgeBoss);
    await purgeBoss.deleteQueuedJobs(QUEUES.AVAILABILITY_IMPORT);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
    await purgeBoss.stop({ graceful: false, close: true });
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
        data: { workerId: worker.id, date: new Date('2027-02-05T00:00:00.000Z'), shifts: 'AB' },
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
        data: { workerId: workerA.id, date: new Date('2027-02-05T00:00:00.000Z'), shifts: 'A' },
      });
      await prisma.workerAvailability.create({
        data: { workerId: workerB.id, date: new Date('2027-02-06T00:00:00.000Z'), shifts: 'B' },
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
        data: { workerId: workerB.id, date: new Date('2027-02-10T00:00:00.000Z'), shifts: 'ABC' },
      });

      const response = await request(app)
        .put(`/api/availability/${FEB_2027}`)
        .query({ companyId: companyA.id })
        .send({ [String(workerB.id)]: { '2027-02-01': ['A'] } });

      expect(response.status).toBe(400);
      const rows = await prisma.workerAvailability.findMany({ where: { workerId: workerB.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.shifts).toBe('ABC'); // untouched
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
      const company = await prisma.company.create({ data: { name: 'Import Co 706' } });
      const worker = await makeWorker(706, company.id);
      const csv = serializeAvailabilityCsv(
        [{ nationalId: worker.nationalId, entries: [{ date: '2027-02-01', shifts: ['A'] }] }],
        FEB_2027,
      );

      const response = await request(app)
        .post(`/api/import/availability/${FEB_2027}`)
        .field('companyId', String(company.id))
        .attach('file', Buffer.from(csv), { filename: 'availability.csv', contentType: 'text/csv' });

      expect(response.status).toBe(202);
      expect(typeof response.body.jobId).toBe('string');
    });

    it('rejects a malformed month with 400 before any file handling', async () => {
      const response = await request(app).post('/api/import/availability/not-a-month');
      expect(response.status).toBe(400);
    });

    it('returns 400 when no file is attached', async () => {
      const company = await prisma.company.create({ data: { name: 'No File Co' } });
      const response = await request(app)
        .post(`/api/import/availability/${FEB_2027}`)
        .field('companyId', String(company.id));
      expect(response.status).toBe(400);
    });

    it('returns 400 when no companyId field is attached', async () => {
      const csv = serializeAvailabilityCsv([], FEB_2027);
      const response = await request(app)
        .post(`/api/import/availability/${FEB_2027}`)
        .attach('file', Buffer.from(csv), { filename: 'availability.csv', contentType: 'text/csv' });
      expect(response.status).toBe(400);
    });

    it('returns 400 for a non-CSV file extension/mimetype', async () => {
      const company = await prisma.company.create({ data: { name: 'Non CSV Co' } });
      const response = await request(app)
        .post(`/api/import/availability/${FEB_2027}`)
        .field('companyId', String(company.id))
        .attach('file', Buffer.from('not a csv'), { filename: 'availability.txt', contentType: 'text/plain' });
      expect(response.status).toBe(400);
    });

    it('rejects (400, pre-enqueue) a header with the wrong month day-count (31-day export into a 28-day month)', async () => {
      const company = await prisma.company.create({ data: { name: 'Wrong Month Co' } });
      const worker = await makeWorker(707, company.id);
      const wrongMonthCsv = serializeAvailabilityCsv(
        [{ nationalId: worker.nationalId, entries: [{ date: '2027-01-01', shifts: ['A'] }] }],
        '2027-01', // 31 days
      );

      const response = await request(app)
        .post(`/api/import/availability/${FEB_2027}`) // target: 28-day month
        .field('companyId', String(company.id))
        .attach('file', Buffer.from(wrongMonthCsv), { filename: 'availability.csv', contentType: 'text/csv' });

      expect(response.status).toBe(400);
    });

    it('returns 400 when the file exceeds the multer size cap', async () => {
      const company = await prisma.company.create({ data: { name: 'Oversized Co' } });
      const oversized = Buffer.alloc(3 * 1024 * 1024, 'a');
      const response = await request(app)
        .post(`/api/import/availability/${FEB_2027}`)
        .field('companyId', String(company.id))
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
        // Earlier tests in THIS file (e.g. "accepts a well-formed CSV upload...") send real jobs
        // but never consume them (no worker runs during the top-level describe, per this file's own
        // convention -- see the comment above this nested describe). Each intervening test's own
        // `beforeEach` truncates `public` (RESTART IDENTITY), so those stale jobs' `companyId`s no
        // longer reference a real company by the time THIS worker starts -- and, worse, a low id can
        // coincide with a company THIS describe's own tests create. Purge before subscribing so this
        // dedicated worker only ever consumes jobs sent by ITS OWN tests below.
        await workerBoss.deleteQueuedJobs(QUEUES.AVAILABILITY_IMPORT);
        await registerAvailabilityImportWorker(workerBoss, createAvailabilityImportHandler(prisma, workerBoss));
      });

      afterAll(async () => {
        await workerBoss.stop({ graceful: false, close: true });
      });

      it('an illegal shift-letter cell and an unknown national_id are both reported without aborting the batch', async () => {
        const company = await prisma.company.create({ data: { name: 'Row Error Co' } });
        const good = await makeWorker(710, company.id);
        const header = availabilityCsvHeader(FEB_2027).join(',');
        const goodRow = [good.nationalId, 'A', ...Array(27).fill('')].join(',');
        const badRow = [validNationalId(711), 'AD', ...Array(27).fill('')].join(',');
        const unknownRow = [validNationalId(712), '', ...Array(27).fill('')].join(',');
        const csv = `${header}\n${goodRow}\n${badRow}\n${unknownRow}\n`;

        const uploadResponse = await request(app)
          .post(`/api/import/availability/${FEB_2027}`)
          .field('companyId', String(company.id))
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

        const task = await prisma.importTask.findFirstOrThrow({
          where: { companyId: company.id, kind: 'AVAILABILITY_SYNC' },
        });
        expect(task.status).toBe('COMPLETED');
      }, 20_000);

      it('a national_id that resolves to a worker under a DIFFERENT company is reported as a row error, never a cross-company write', async () => {
        const companyA = await prisma.company.create({ data: { name: 'Row Cross Co A' } });
        const companyB = await prisma.company.create({ data: { name: 'Row Cross Co B' } });
        const otherCompanyWorker = await makeWorker(713, companyB.id);
        const header = availabilityCsvHeader(FEB_2027).join(',');
        const row = [otherCompanyWorker.nationalId, 'A', ...Array(27).fill('')].join(',');
        const csv = `${header}\n${row}\n`;

        const uploadResponse = await request(app)
          .post(`/api/import/availability/${FEB_2027}`)
          .field('companyId', String(companyA.id))
          .attach('file', Buffer.from(csv), { filename: 'availability.csv', contentType: 'text/csv' });
        expect(uploadResponse.status).toBe(202);
        const { jobId } = uploadResponse.body as { jobId: string };

        let result: unknown = null;
        for (let attempt = 0; attempt < 60; attempt++) {
          const jobResponse = await request(app).get(`/api/jobs/${jobId}`);
          if (jobResponse.body.state === 'completed' || jobResponse.body.state === 'failed') {
            result = jobResponse.body.result;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        expect(result).toMatchObject({ totalRows: 1, applied: 0, failed: 1 });
        const rows = await prisma.workerAvailability.findMany({ where: { workerId: otherCompanyWorker.id } });
        expect(rows).toHaveLength(0);
      }, 20_000);
    });
  });
});
