import request from 'supertest';
import type { Express } from 'express';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidIsraeliId } from '@rostering/shared';

import { workforceCsvHeader } from '../../src/csv/workforce.js';
import { dayColumns } from '../../src/csv/availability.js';
import { createWorkforceImportHandler } from '../../src/jobs/workforceImport.job.js';
import { createBoss, ensureQueues, QUEUES, registerWorkforceImportWorker } from '../../src/jobs/queue.js';
import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';
import { buildTestApp } from '../helpers/testApp.js';
import { MAX_WORKFORCE_CSV_ROWS } from '../../src/routes/workforce.js';
import { MAX_CSV_FILE_SIZE_BYTES } from '../../src/routes/csvUpload.js';

function validNationalId(prefix: number): string {
  const base = String(prefix).padStart(8, '0');
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${base}${checkDigit}`;
    if (isValidIsraeliId(candidate)) return candidate;
  }
  throw new Error('no valid check digit found');
}

const FEB_2027 = '2027-02'; // 28 days

// This suite runs against a persistent, shared dev Postgres across repeated local invocations
// (not a fresh disposable DB per run) -- a per-process random salt keeps every run's national IDs
// disjoint from whatever a previous run may have left behind (e.g. a dangling never-consumed
// pg-boss job's payload), rather than relying on fixed literal prefixes that would collide on
// repeat runs.
const RUN_SALT = Math.floor(Math.random() * 900) * 100;

const ID_A = validNationalId(501 + RUN_SALT);
const HEADER = workforceCsvHeader(FEB_2027).join(',');
const EMPTY_CELLS = dayColumns(FEB_2027).map(() => '').join(',');
const SAMPLE_ROW = `${ID_A},Dana Levi,Supervisor,Active,62.50,120,182,${EMPTY_CELLS}`;

describe('/api/import/workforce/:month and /api/export/workforce/:month', () => {
  const prisma = getTestPrismaClient();
  let app: Express;
  let cleanupBoss: PgBoss;

  beforeAll(async () => {
    app = buildTestApp();

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set for the workforce route test suite');
    cleanupBoss = createBoss(databaseUrl);
    await cleanupBoss.start();
    await ensureQueues(cleanupBoss);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await cleanupBoss.deleteQueuedJobs(QUEUES.WORKFORCE_IMPORT);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
    await cleanupBoss.stop({ graceful: false, close: true });
  });

  describe('POST /api/import/workforce/:month', () => {
    it('accepts a well-formed CSV upload and returns 202 with a jobId', async () => {
      const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });

      const response = await request(app)
        .post(`/api/import/workforce/${FEB_2027}`)
        .field('companyId', String(company.id))
        .attach('file', Buffer.from(`${HEADER}\n${SAMPLE_ROW}\n`), { filename: 'workforce.csv', contentType: 'text/csv' });

      expect(response.status).toBe(202);
      expect(typeof response.body.jobId).toBe('string');

      const task = await prisma.importTask.findFirstOrThrow({
        where: { companyId: company.id, kind: 'WORKFORCE_SYNC' },
      });
      expect(task.pgBossJobId).toBe(response.body.jobId);
      expect(task.month).toBe(FEB_2027);
    });

    it('rejects a malformed month with 400 before any file handling', async () => {
      const response = await request(app).post('/api/import/workforce/not-a-month');
      expect(response.status).toBe(400);
    });

    it('returns 400 when no file is attached', async () => {
      const company = await prisma.company.create({ data: { name: 'No File Co' } });
      const response = await request(app).post(`/api/import/workforce/${FEB_2027}`).field('companyId', String(company.id));
      expect(response.status).toBe(400);
    });

    it('returns 400 when no companyId field is attached', async () => {
      const response = await request(app)
        .post(`/api/import/workforce/${FEB_2027}`)
        .attach('file', Buffer.from(`${HEADER}\n${SAMPLE_ROW}\n`), { filename: 'workforce.csv', contentType: 'text/csv' });
      expect(response.status).toBe(400);
    });

    it('returns 400 for a non-CSV file extension/mimetype', async () => {
      const company = await prisma.company.create({ data: { name: 'Non CSV Co' } });
      const response = await request(app)
        .post(`/api/import/workforce/${FEB_2027}`)
        .field('companyId', String(company.id))
        .attach('file', Buffer.from('not a csv'), { filename: 'workforce.txt', contentType: 'text/plain' });

      expect(response.status).toBe(400);
    });

    it('returns 400 for a CSV with a missing/wrong header', async () => {
      const company = await prisma.company.create({ data: { name: 'Wrong Header Co' } });
      const response = await request(app)
        .post(`/api/import/workforce/${FEB_2027}`)
        .field('companyId', String(company.id))
        .attach('file', Buffer.from('a,b,c\n1,2,3\n'), { filename: 'workforce.csv', contentType: 'text/csv' });

      expect(response.status).toBe(400);
    });

    it('rejects (400, pre-enqueue) a header with the wrong month day-count (31-day shape into a 28-day month)', async () => {
      const company = await prisma.company.create({ data: { name: 'Wrong Month Co' } });
      const wrongHeader = workforceCsvHeader('2027-01').join(','); // 31 days
      const wrongCells = dayColumns('2027-01').map(() => '').join(',');
      const wrongRow = `${ID_A},Dana Levi,Supervisor,Active,62.50,120,182,${wrongCells}`;

      const response = await request(app)
        .post(`/api/import/workforce/${FEB_2027}`) // target: 28-day month
        .field('companyId', String(company.id))
        .attach('file', Buffer.from(`${wrongHeader}\n${wrongRow}\n`), { filename: 'workforce.csv', contentType: 'text/csv' });

      expect(response.status).toBe(400);
    });

    it('returns 400 when the file exceeds the size cap', async () => {
      const company = await prisma.company.create({ data: { name: 'Oversized Co' } });
      // Comfortably over MAX_CSV_FILE_SIZE_BYTES -- derived from the real cap rather than a
      // hardcoded literal, so this stays a real over-the-cap case if that cap changes again.
      const oversized = Buffer.alloc(MAX_CSV_FILE_SIZE_BYTES + 1024 * 1024, 'a');
      const response = await request(app)
        .post(`/api/import/workforce/${FEB_2027}`)
        .field('companyId', String(company.id))
        .attach('file', oversized, { filename: 'workforce.csv', contentType: 'text/csv' });

      expect(response.status).toBe(400);
    });

    it('returns 400 when the row count exceeds the max-row cap', async () => {
      const company = await prisma.company.create({ data: { name: 'Too Many Rows Co' } });
      const tooManyRows = Array.from({ length: MAX_WORKFORCE_CSV_ROWS + 1 }, () => SAMPLE_ROW).join('\n');
      const response = await request(app)
        .post(`/api/import/workforce/${FEB_2027}`)
        .field('companyId', String(company.id))
        .attach('file', Buffer.from(`${HEADER}\n${tooManyRows}\n`), { filename: 'workforce.csv', contentType: 'text/csv' });

      expect(response.status).toBe(400);
    }, 20_000);

    it('a second upload for the same company cancels the first uploaded task (cancel-and-replace)', async () => {
      const company = await prisma.company.create({ data: { name: 'Cancel Replace Co' } });

      const firstResponse = await request(app)
        .post(`/api/import/workforce/${FEB_2027}`)
        .field('companyId', String(company.id))
        .attach('file', Buffer.from(`${HEADER}\n${SAMPLE_ROW}\n`), { filename: 'workforce.csv', contentType: 'text/csv' });
      expect(firstResponse.status).toBe(202);

      const secondResponse = await request(app)
        .post(`/api/import/workforce/${FEB_2027}`)
        .field('companyId', String(company.id))
        .attach('file', Buffer.from(`${HEADER}\n${SAMPLE_ROW}\n`), { filename: 'workforce.csv', contentType: 'text/csv' });
      expect(secondResponse.status).toBe(202);
      expect(secondResponse.body.jobId).not.toBe(firstResponse.body.jobId);

      const tasks = await prisma.importTask.findMany({
        where: { companyId: company.id, kind: 'WORKFORCE_SYNC' },
        orderBy: { createdAt: 'asc' },
      });
      expect(tasks).toHaveLength(2);
      expect(tasks[0]?.status).toBe('CANCELLED');
      expect(tasks[1]?.status).toBe('PENDING');
    });

    // The rest of the suite only asserts the 202/jobId HTTP contract -- no pg-boss worker runs
    // during the suite, so a sent job just sits queued. This nested block runs its own dedicated
    // `workforce-import` worker (against the same shared Postgres) so the full route -> job ->
    // service pipeline, including per-row error reporting and the ImportTask lifecycle, can be
    // proven end-to-end exactly once.
    describe('end-to-end per-row error reporting (dedicated worker)', () => {
      let workerBoss: PgBoss;

      beforeAll(async () => {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) throw new Error('DATABASE_URL is not set for the workforce-import worker test');
        workerBoss = createBoss(databaseUrl);
        await workerBoss.start();
        await ensureQueues(workerBoss);
        await workerBoss.deleteQueuedJobs(QUEUES.WORKFORCE_IMPORT);
        await registerWorkforceImportWorker(workerBoss, createWorkforceImportHandler(prisma, workerBoss));
      });

      afterAll(async () => {
        await workerBoss.stop({ graceful: false, close: true });
      });

      async function pollJobResult(jobId: string): Promise<unknown> {
        for (let attempt = 0; attempt < 60; attempt++) {
          const jobResponse = await request(app).get(`/api/jobs/${jobId}`);
          if (jobResponse.body.state === 'completed' || jobResponse.body.state === 'failed') {
            return jobResponse.body.result;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(`Job ${jobId} never reached a terminal state`);
      }

      it('a bad row and a good row are both reported without aborting the batch, and the ImportTask completes', async () => {
        const company = await prisma.company.create({ data: { name: 'Row Error Co' } });
        const goodRow = `${validNationalId(801 + RUN_SALT)},Good Worker,Supervisor,Active,62.50,120,182,${EMPTY_CELLS}`;
        const badRow = `${validNationalId(802 + RUN_SALT)},Bad Worker,Supervisor,Active,not-a-number,120,182,${EMPTY_CELLS}`;
        const csv = `${HEADER}\n${goodRow}\n${badRow}\n`;

        const uploadResponse = await request(app)
          .post(`/api/import/workforce/${FEB_2027}`)
          .field('companyId', String(company.id))
          .attach('file', Buffer.from(csv), { filename: 'workforce.csv', contentType: 'text/csv' });
        expect(uploadResponse.status).toBe(202);

        const result = await pollJobResult(uploadResponse.body.jobId as string);
        expect(result).toMatchObject({ totalRows: 2, inserted: 1, failed: 1 });

        const worker = await prisma.worker.findUnique({ where: { nationalId: validNationalId(801 + RUN_SALT) } });
        expect(worker).not.toBeNull();
        expect(worker?.companyId).toBe(company.id);

        const task = await prisma.importTask.findFirstOrThrow({
          where: { companyId: company.id, kind: 'WORKFORCE_SYNC' },
        });
        expect(task.status).toBe('COMPLETED');
        expect(worker?.lastImportTaskId).toBe(task.id);
      }, 20_000);

      it('a national_id already registered under a DIFFERENT company is reported as a row error, never a cross-company write', async () => {
        const companyA = await prisma.company.create({ data: { name: 'Row Cross Co A' } });
        const companyB = await prisma.company.create({ data: { name: 'Row Cross Co B' } });
        const otherCompanyWorker = await prisma.worker.create({
          data: {
            nationalId: validNationalId(803 + RUN_SALT),
            name: 'Other Co Worker',
            role: 'GENERAL_GUARD',
            status: 'ACTIVE',
            companyId: companyB.id,
          },
        });
        const row = `${otherCompanyWorker.nationalId},Attempted Reassignment,Supervisor,Active,62.50,120,182,${EMPTY_CELLS}`;
        const csv = `${HEADER}\n${row}\n`;

        const uploadResponse = await request(app)
          .post(`/api/import/workforce/${FEB_2027}`)
          .field('companyId', String(companyA.id))
          .attach('file', Buffer.from(csv), { filename: 'workforce.csv', contentType: 'text/csv' });
        expect(uploadResponse.status).toBe(202);

        const result = await pollJobResult(uploadResponse.body.jobId as string);
        expect(result).toMatchObject({ totalRows: 1, inserted: 0, updated: 0, failed: 1 });

        const reloaded = await prisma.worker.findUnique({ where: { id: otherCompanyWorker.id } });
        expect(reloaded?.companyId).toBe(companyB.id); // untouched, never reassigned
      }, 20_000);

      it('a bad dNN cell fails the whole row -- worker not upserted, availability not written either', async () => {
        const company = await prisma.company.create({ data: { name: 'Bad Cell Co' } });
        const badCells = dayColumns(FEB_2027).map((_c, i) => (i === 0 ? 'AD' : '')).join(',');
        const nationalId = validNationalId(806 + RUN_SALT);
        const row = `${nationalId},Cell Worker,General Guard,Active,50.00,100,160,${badCells}`;
        const csv = `${HEADER}\n${row}\n`;

        const uploadResponse = await request(app)
          .post(`/api/import/workforce/${FEB_2027}`)
          .field('companyId', String(company.id))
          .attach('file', Buffer.from(csv), { filename: 'workforce.csv', contentType: 'text/csv' });
        expect(uploadResponse.status).toBe(202);

        const result = await pollJobResult(uploadResponse.body.jobId as string);
        expect(result).toMatchObject({ totalRows: 1, inserted: 0, failed: 1 });
        expect(await prisma.worker.findUnique({ where: { nationalId } })).toBeNull();
      }, 20_000);

      it('company-scoped regression -- importing for company A never touches company B\'s workers', async () => {
        const companyA = await prisma.company.create({ data: { name: 'Regression Route Co A' } });
        const companyB = await prisma.company.create({ data: { name: 'Regression Route Co B' } });
        const workerB = await prisma.worker.create({
          data: {
            nationalId: validNationalId(804 + RUN_SALT),
            name: 'Company B Worker',
            role: 'GENERAL_GUARD',
            status: 'ACTIVE',
            companyId: companyB.id,
          },
        });
        const row = `${validNationalId(805 + RUN_SALT)},New Worker A,Supervisor,Active,62.50,120,182,${EMPTY_CELLS}`;
        const csv = `${HEADER}\n${row}\n`;

        const uploadResponse = await request(app)
          .post(`/api/import/workforce/${FEB_2027}`)
          .field('companyId', String(companyA.id))
          .attach('file', Buffer.from(csv), { filename: 'workforce.csv', contentType: 'text/csv' });
        expect(uploadResponse.status).toBe(202);
        await pollJobResult(uploadResponse.body.jobId as string);

        const reloadedB = await prisma.worker.findUnique({ where: { id: workerB.id } });
        expect(reloadedB?.status).toBe('ACTIVE');
        expect(reloadedB?.companyId).toBe(companyB.id);
        expect(reloadedB?.lastImportTaskId).toBeNull();
      }, 20_000);
    });
  });

  describe('GET /api/export/workforce/:month', () => {
    it('rejects a malformed month with 400', async () => {
      const company = await prisma.company.create({ data: { name: 'Malformed Export Month Co' } });
      const response = await request(app)
        .get('/api/export/workforce/bad-month')
        .query({ companyId: company.id });
      expect(response.status).toBe(400);
    });

    it('rejects (400) a request with no companyId query param', async () => {
      const response = await request(app).get(`/api/export/workforce/${FEB_2027}`);
      expect(response.status).toBe(400);
    });

    it('returns text/csv with the security headers and a re-importable body', async () => {
      const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
      const worker = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Dana Levi', role: 'SUPERVISOR', status: 'ACTIVE', companyId: company.id },
      });
      await prisma.contract.create({
        data: { workerId: worker.id, hourlyCostIls: 62.5, minMonthlyHours: 120, maxMonthlyHours: 182 },
      });

      const response = await request(app).get(`/api/export/workforce/${FEB_2027}`).query({ companyId: company.id });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/csv/);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-disposition']).toMatch(/attachment/);
      expect(response.text.split('\n')[0]).toBe(HEADER);
      expect(response.text).toContain(ID_A);
    });

    it('round-trips through the import route: exported CSV re-uploads unmodified', async () => {
      const company = await prisma.company.create({ data: { name: 'Roundtrip Co' } });
      const worker = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Dana Levi', role: 'SUPERVISOR', status: 'ACTIVE', companyId: company.id },
      });
      await prisma.contract.create({
        data: { workerId: worker.id, hourlyCostIls: 62.5, minMonthlyHours: 120, maxMonthlyHours: 182 },
      });
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2027-02-01T00:00:00.000Z'), excludedShifts: 'A' },
      });

      const exportResponse = await request(app).get(`/api/export/workforce/${FEB_2027}`).query({ companyId: company.id });
      expect(exportResponse.status).toBe(200);

      const reimportResponse = await request(app)
        .post(`/api/import/workforce/${FEB_2027}`)
        .field('companyId', String(company.id))
        .attach('file', Buffer.from(exportResponse.text), { filename: 'workforce.csv', contentType: 'text/csv' });
      expect(reimportResponse.status).toBe(202);
    });
  });
});
