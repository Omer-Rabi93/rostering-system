import request from 'supertest';
import type { Express } from 'express';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidIsraeliId } from '@rostering/shared';

import { CSV_COLUMNS } from '../../src/csv/index.js';
import { createCsvImportHandler } from '../../src/jobs/csvImport.job.js';
import { createBoss, ensureQueues, QUEUES, registerCsvImportWorker } from '../../src/jobs/queue.js';
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

// This suite runs against a persistent, shared dev Postgres across repeated local invocations
// (not a fresh disposable DB per run) -- a per-process random salt keeps every run's national IDs
// disjoint from whatever a previous run may have left behind (e.g. a dangling never-consumed
// pg-boss job's payload), rather than relying on fixed literal prefixes that would collide on
// repeat runs.
const RUN_SALT = Math.floor(Math.random() * 900) * 100;

const ID_A = validNationalId(501 + RUN_SALT);
const HEADER = CSV_COLUMNS.join(',');
const SAMPLE_ROW = `${ID_A},Dana Levi,Supervisor,Active,62.50,120,182`;

describe('/api/import/workers and /api/export/workers', () => {
  const prisma = getTestPrismaClient();
  let app: Express;
  let cleanupBoss: PgBoss;

  beforeAll(async () => {
    app = buildTestApp();

    // This suite runs against a persistent, shared dev Postgres (not reset between runs like the
    // Prisma-backed `public` schema is -- pg-boss owns its own separate `pgboss` schema, untouched
    // by `resetDatabase`). `companyId`s restart from 1 every `resetDatabase` (Postgres identity
    // reset), so a `csv-import` job this suite sends and nothing ever consumes (most tests below
    // never run a worker) would otherwise sit `created` forever and collide, via its
    // `singletonKey`, with a LATER test's freshly-reset company reusing that same id -- purged in
    // `beforeEach` too, not just once here, for exactly that reason. Mirrors
    // `tests/jobs/queue.test.ts`'s identical convention.
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set for the importExport route test suite');
    cleanupBoss = createBoss(databaseUrl);
    await cleanupBoss.start();
    await ensureQueues(cleanupBoss);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await cleanupBoss.deleteQueuedJobs(QUEUES.CSV_IMPORT);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
    await cleanupBoss.stop({ graceful: false, close: true });
  });

  describe('POST /api/import/workers', () => {
    it('accepts a well-formed CSV upload and returns 202 with a jobId', async () => {
      const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });

      const response = await request(app)
        .post('/api/import/workers')
        .field('companyId', String(company.id))
        .attach('file', Buffer.from(`${HEADER}\n${SAMPLE_ROW}\n`), { filename: 'workers.csv', contentType: 'text/csv' });

      expect(response.status).toBe(202);
      expect(typeof response.body.jobId).toBe('string');

      const task = await prisma.importTask.findFirstOrThrow({
        where: { companyId: company.id, kind: 'WORKER_SYNC' },
      });
      expect(task.pgBossJobId).toBe(response.body.jobId);
    });

    it('returns 400 when no file is attached', async () => {
      const company = await prisma.company.create({ data: { name: 'No File Co' } });
      const response = await request(app).post('/api/import/workers').field('companyId', String(company.id));
      expect(response.status).toBe(400);
    });

    it('returns 400 when no companyId field is attached', async () => {
      const response = await request(app)
        .post('/api/import/workers')
        .attach('file', Buffer.from(`${HEADER}\n${SAMPLE_ROW}\n`), { filename: 'workers.csv', contentType: 'text/csv' });
      expect(response.status).toBe(400);
    });

    it('returns 400 for a non-CSV file extension/mimetype', async () => {
      const company = await prisma.company.create({ data: { name: 'Non CSV Co' } });
      const response = await request(app)
        .post('/api/import/workers')
        .field('companyId', String(company.id))
        .attach('file', Buffer.from('not a csv'), { filename: 'workers.txt', contentType: 'text/plain' });

      expect(response.status).toBe(400);
    });

    it('returns 400 for a CSV with a missing/wrong header', async () => {
      const company = await prisma.company.create({ data: { name: 'Wrong Header Co' } });
      const response = await request(app)
        .post('/api/import/workers')
        .field('companyId', String(company.id))
        .attach('file', Buffer.from('a,b,c\n1,2,3\n'), { filename: 'workers.csv', contentType: 'text/csv' });

      expect(response.status).toBe(400);
    });

    it('returns 400 when the file exceeds the size cap', async () => {
      const company = await prisma.company.create({ data: { name: 'Oversized Co' } });
      // Comfortably over the 2 MB cap.
      const oversized = Buffer.alloc(3 * 1024 * 1024, 'a');
      const response = await request(app)
        .post('/api/import/workers')
        .field('companyId', String(company.id))
        .attach('file', oversized, { filename: 'workers.csv', contentType: 'text/csv' });

      expect(response.status).toBe(400);
    });

    it('returns 400 when the row count exceeds the max-row cap', async () => {
      const company = await prisma.company.create({ data: { name: 'Too Many Rows Co' } });
      const tooManyRows = Array.from({ length: 10_001 }, () => SAMPLE_ROW).join('\n');
      const response = await request(app)
        .post('/api/import/workers')
        .field('companyId', String(company.id))
        .attach('file', Buffer.from(`${HEADER}\n${tooManyRows}\n`), { filename: 'workers.csv', contentType: 'text/csv' });

      expect(response.status).toBe(400);
    }, 15_000);

    it('a second upload for the same company cancels the first uploaded task (cancel-and-replace)', async () => {
      const company = await prisma.company.create({ data: { name: 'Cancel Replace Co' } });

      const firstResponse = await request(app)
        .post('/api/import/workers')
        .field('companyId', String(company.id))
        .attach('file', Buffer.from(`${HEADER}\n${SAMPLE_ROW}\n`), { filename: 'workers.csv', contentType: 'text/csv' });
      expect(firstResponse.status).toBe(202);

      const secondResponse = await request(app)
        .post('/api/import/workers')
        .field('companyId', String(company.id))
        .attach('file', Buffer.from(`${HEADER}\n${SAMPLE_ROW}\n`), { filename: 'workers.csv', contentType: 'text/csv' });
      expect(secondResponse.status).toBe(202);
      expect(secondResponse.body.jobId).not.toBe(firstResponse.body.jobId);

      const tasks = await prisma.importTask.findMany({
        where: { companyId: company.id, kind: 'WORKER_SYNC' },
        orderBy: { createdAt: 'asc' },
      });
      expect(tasks).toHaveLength(2);
      expect(tasks[0]?.status).toBe('CANCELLED');
      expect(tasks[1]?.status).toBe('PENDING');
    });

    // The rest of the suite only asserts the 202/jobId HTTP contract -- no pg-boss worker runs
    // during the suite, so a sent job just sits queued. This nested block runs its own dedicated
    // `csv-import` worker (against the same shared Postgres) so the full route -> job -> service
    // pipeline, including per-row error reporting and the ImportTask lifecycle, can be proven
    // end-to-end exactly once (mirrors `tests/routes/availability.test.ts`'s identical convention).
    describe('end-to-end per-row error reporting (dedicated worker)', () => {
      let workerBoss: PgBoss;

      beforeAll(async () => {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) throw new Error('DATABASE_URL is not set for the csv-import worker test');
        workerBoss = createBoss(databaseUrl);
        await workerBoss.start();
        await ensureQueues(workerBoss);
        // Purge any `created` (never-consumed) jobs left dangling by the earlier plain-describe
        // tests above (which never run a worker, so a successfully-enqueued job just sits queued
        // forever) -- otherwise, the moment this worker registers, it would immediately claim and
        // process one of those stale jobs (built from an EARLIER test's now-truncated company/CSV
        // data) instead of only ever processing jobs THIS describe block's own tests send.
        await workerBoss.deleteQueuedJobs(QUEUES.CSV_IMPORT);
        await registerCsvImportWorker(workerBoss, createCsvImportHandler(prisma, workerBoss));
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
        const goodRow = `${validNationalId(801 + RUN_SALT)},Good Worker,Supervisor,Active,62.50,120,182`;
        const badRow = `${validNationalId(802 + RUN_SALT)},Bad Worker,Supervisor,Active,not-a-number,120,182`;
        const csv = `${HEADER}\n${goodRow}\n${badRow}\n`;

        const uploadResponse = await request(app)
          .post('/api/import/workers')
          .field('companyId', String(company.id))
          .attach('file', Buffer.from(csv), { filename: 'workers.csv', contentType: 'text/csv' });
        expect(uploadResponse.status).toBe(202);

        const result = await pollJobResult(uploadResponse.body.jobId as string);
        expect(result).toMatchObject({ totalRows: 2, inserted: 1, failed: 1 });

        const worker = await prisma.worker.findUnique({ where: { nationalId: validNationalId(801 + RUN_SALT) } });
        expect(worker).not.toBeNull();
        expect(worker?.companyId).toBe(company.id);

        const task = await prisma.importTask.findFirstOrThrow({
          where: { companyId: company.id, kind: 'WORKER_SYNC' },
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
        const row = `${otherCompanyWorker.nationalId},Attempted Reassignment,Supervisor,Active,62.50,120,182`;
        const csv = `${HEADER}\n${row}\n`;

        const uploadResponse = await request(app)
          .post('/api/import/workers')
          .field('companyId', String(companyA.id))
          .attach('file', Buffer.from(csv), { filename: 'workers.csv', contentType: 'text/csv' });
        expect(uploadResponse.status).toBe(202);

        const result = await pollJobResult(uploadResponse.body.jobId as string);
        expect(result).toMatchObject({ totalRows: 1, inserted: 0, updated: 0, failed: 1 });

        const reloaded = await prisma.worker.findUnique({ where: { id: otherCompanyWorker.id } });
        expect(reloaded?.companyId).toBe(companyB.id); // untouched, never reassigned
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
        const row = `${validNationalId(805 + RUN_SALT)},New Worker A,Supervisor,Active,62.50,120,182`;
        const csv = `${HEADER}\n${row}\n`;

        const uploadResponse = await request(app)
          .post('/api/import/workers')
          .field('companyId', String(companyA.id))
          .attach('file', Buffer.from(csv), { filename: 'workers.csv', contentType: 'text/csv' });
        expect(uploadResponse.status).toBe(202);
        await pollJobResult(uploadResponse.body.jobId as string);

        const reloadedB = await prisma.worker.findUnique({ where: { id: workerB.id } });
        expect(reloadedB?.status).toBe('ACTIVE');
        expect(reloadedB?.companyId).toBe(companyB.id);
        expect(reloadedB?.lastImportTaskId).toBeNull();
      }, 20_000);
    });
  });

  describe('GET /api/export/workers', () => {
    it('returns text/csv with the security headers and a re-importable body', async () => {
      const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
      const worker = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Dana Levi', role: 'SUPERVISOR', status: 'ACTIVE', companyId: company.id },
      });
      await prisma.contract.create({
        data: {
          workerId: worker.id,
          hourlyCostIls: 62.5,
          minMonthlyHours: 120,
          maxMonthlyHours: 182,
        },
      });

      const response = await request(app).get('/api/export/workers');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/csv/);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-disposition']).toMatch(/attachment/);
      expect(response.text.split('\n')[0]).toBe(HEADER);
      expect(response.text).toContain(ID_A);
    });
  });
});
