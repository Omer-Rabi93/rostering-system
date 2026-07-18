import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { isValidIsraeliId } from '@rostering/shared';

import { CSV_COLUMNS } from '../../src/csv/index.js';
import { createBoss } from '../../src/jobs/queue.js';
import { CsvImportService } from '../../src/services/csvImportService.js';
import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';

function validNationalId(prefix: number): string {
  const base = String(prefix).padStart(8, '0');
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${base}${checkDigit}`;
    if (isValidIsraeliId(candidate)) return candidate;
  }
  throw new Error('no valid check digit found');
}

const ID_A = validNationalId(701);
const ID_B = validNationalId(702);

const HEADER = CSV_COLUMNS.join(',');

/** Builds one 7-column CSV data row from field overrides -- the worker CSV no longer carries a
 * `company_name` column (v4: upload is scoped to one company at upload time, not resolved
 * per-row). */
function csvRow(overrides: Partial<Record<(typeof CSV_COLUMNS)[number], string>> = {}): string {
  const defaults: Record<(typeof CSV_COLUMNS)[number], string> = {
    national_id: ID_A,
    name: 'Dana Levi',
    role: 'Supervisor',
    status: 'Active',
    hourly_cost_ils: '62.50',
    min_monthly_hours: '120',
    max_monthly_hours: '182',
  };
  const row = { ...defaults, ...overrides };
  return CSV_COLUMNS.map((c) => row[c]).join(',');
}

function csvFile(rows: string[]): string {
  return [HEADER, ...rows].join('\n') + '\n';
}

describe('CsvImportService', () => {
  const prisma = getTestPrismaClient();
  let boss: PgBoss;
  let service: CsvImportService;

  beforeAll(() => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set for the CsvImportService test suite');
    boss = createBoss(databaseUrl);
    service = new CsvImportService(prisma, boss);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
    await boss.stop({ graceful: false, close: true });
  });

  async function makeCompany(name: string): Promise<number> {
    return (await prisma.company.create({ data: { name } })).id;
  }

  async function makeWorker(prefix: number, companyId: number, overrides: { status?: 'ACTIVE' | 'INACTIVE' } = {}) {
    return prisma.worker.create({
      data: {
        nationalId: validNationalId(prefix),
        name: `Worker ${prefix}`,
        role: 'GENERAL_GUARD',
        status: overrides.status ?? 'ACTIVE',
        companyId,
      },
    });
  }

  describe('importCsv', () => {
    it('inserts a new worker + contract under the given companyId', async () => {
      const company = await makeCompany('Shamir Security Ltd');

      const result = await service.importCsv(csvFile([csvRow({ national_id: ID_A })]), company);

      expect(result.totalRows).toBe(1);
      expect(result.inserted).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(0);

      const worker = await prisma.worker.findUnique({ where: { nationalId: ID_A }, include: { contract: true } });
      expect(worker).not.toBeNull();
      expect(worker?.name).toBe('Dana Levi');
      expect(worker?.role).toBe('SUPERVISOR');
      expect(worker?.status).toBe('ACTIVE');
      expect(worker?.companyId).toBe(company);
      expect(Number(worker?.contract?.hourlyCostIls)).toBe(62.5);
    });

    it('updates an existing worker (same company) matched by national_id instead of duplicating it', async () => {
      const company = await makeCompany('Shamir Security Ltd');
      const existing = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Old Name', role: 'GENERAL_GUARD', status: 'ACTIVE', companyId: company },
      });

      const result = await service.importCsv(
        csvFile([csvRow({ national_id: ID_A, name: 'Updated Name', role: 'Supervisor' })]),
        company,
      );

      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(1);

      const workers = await prisma.worker.findMany({ where: { nationalId: ID_A } });
      expect(workers).toHaveLength(1);
      const [worker] = workers;
      if (!worker) throw new Error('expected exactly one worker');
      expect(worker.id).toBe(existing.id);
      expect(worker.name).toBe('Updated Name');
      expect(worker.role).toBe('SUPERVISOR');
    });

    it('reports a bad row without aborting the rest of the batch', async () => {
      const company = await makeCompany('Shamir Security Ltd');

      const result = await service.importCsv(
        csvFile([
          csvRow({ national_id: ID_A, hourly_cost_ils: 'not-a-number' }),
          csvRow({ national_id: ID_B }),
        ]),
        company,
      );

      expect(result.totalRows).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.inserted).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ row: 1, field: 'hourly_cost_ils' });

      const goodWorker = await prisma.worker.findUnique({ where: { nationalId: ID_B } });
      expect(goodWorker).not.toBeNull();
      const badWorker = await prisma.worker.findUnique({ where: { nationalId: ID_A } });
      expect(badWorker).toBeNull();
    });

    it('reports a bad Israeli-ID checksum as a row error without creating a worker', async () => {
      const company = await makeCompany('Shamir Security Ltd');

      const result = await service.importCsv(csvFile([csvRow({ national_id: '123456789' })]), company);

      expect(result.failed).toBe(1);
      const [firstError] = result.errors;
      if (!firstError) throw new Error('expected one error entry');
      expect(firstError.row).toBe(1);
      const worker = await prisma.worker.findUnique({ where: { nationalId: '123456789' } });
      expect(worker).toBeNull();
    });

    it('v4: reports a national_id already registered under a DIFFERENT company as a row error, never a reassignment', async () => {
      const companyA = await makeCompany('Company A');
      const companyB = await makeCompany('Company B');
      const workerInB = await makeWorker(720, companyB);

      const result = await service.importCsv(
        csvFile([csvRow({ national_id: workerInB.nationalId, name: 'Attempted Reassignment' })]),
        companyA,
      );

      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({ row: 1, field: 'national_id' });
      expect(result.errors[0]?.message).toMatch(/different company/i);

      const reloaded = await prisma.worker.findUnique({ where: { id: workerInB.id } });
      expect(reloaded?.companyId).toBe(companyB); // untouched, never reassigned
      expect(reloaded?.name).toBe('Worker 720'); // untouched
    });

    it('v4: company-scoped regression -- importing for company A never touches company B\'s workers (including status)', async () => {
      const companyA = await makeCompany('Regression Co A');
      const companyB = await makeCompany('Regression Co B');
      const workerB = await makeWorker(721, companyB);

      const result = await service.importCsv(csvFile([csvRow({ national_id: ID_A })]), companyA);

      expect(result.inserted).toBe(1);
      // The old, now-removed global sweep would have deactivated `workerB` here (absent from the
      // file, no companyId scoping at all) -- this is the exact bug the v4 design doc calls out.
      const reloadedB = await prisma.worker.findUnique({ where: { id: workerB.id } });
      expect(reloadedB?.status).toBe('ACTIVE');
      expect(reloadedB?.companyId).toBe(companyB);
      expect(reloadedB?.name).toBe('Worker 721');
      expect(reloadedB?.lastImportTaskId).toBeNull();
    });

    it('v4: no deactivation sweep -- a worker absent from the file keeps its current status unchanged', async () => {
      const company = await makeCompany('No Sweep Co');
      const absentActive = await makeWorker(722, company, { status: 'ACTIVE' });
      const absentInactive = await makeWorker(723, company, { status: 'INACTIVE' });

      await service.importCsv(csvFile([csvRow({ national_id: ID_A })]), company);

      const reloadedActive = await prisma.worker.findUnique({ where: { id: absentActive.id } });
      const reloadedInactive = await prisma.worker.findUnique({ where: { id: absentInactive.id } });
      expect(reloadedActive?.status).toBe('ACTIVE');
      expect(reloadedInactive?.status).toBe('INACTIVE');
    });

    it('v4: stamps lastImportTaskId on inserted/updated workers for a COMPLETED task; an absent worker keeps its own stamp unchanged', async () => {
      const company = await makeCompany('Stamp Co');
      const preexisting = await prisma.worker.create({
        data: { nationalId: ID_B, name: 'Preexisting', role: 'GENERAL_GUARD', status: 'ACTIVE', companyId: company },
      });
      const absent = await makeWorker(724, company); // never mentioned in the CSV below

      const result = await service.importCsv(
        csvFile([csvRow({ national_id: ID_A }), csvRow({ national_id: ID_B, name: 'Updated Preexisting' })]),
        company,
      );
      expect(result).toMatchObject({ inserted: 1, updated: 1, failed: 0 });

      const task = await prisma.importTask.findFirstOrThrow({
        where: { companyId: company, kind: 'WORKER_SYNC', status: 'COMPLETED' },
      });

      const inserted = await prisma.worker.findUniqueOrThrow({ where: { nationalId: ID_A } });
      const updated = await prisma.worker.findUniqueOrThrow({ where: { id: preexisting.id } });
      const reloadedAbsent = await prisma.worker.findUniqueOrThrow({ where: { id: absent.id } });

      expect(inserted.lastImportTaskId).toBe(task.id);
      expect(updated.lastImportTaskId).toBe(task.id);
      // Absent from the file -- never touched by this task, so its stamp (null, "manually
      // managed") is left exactly as it was -- excluded from this task's eligibility even though
      // its status is unaffected.
      expect(reloadedAbsent.lastImportTaskId).toBeNull();
    });

    it('creates a PENDING/PROCESSING ImportTask that ends up COMPLETED with the row counts', async () => {
      const company = await makeCompany('Task Co');

      await service.importCsv(
        csvFile([csvRow({ national_id: ID_A }), csvRow({ national_id: 'not-checked', hourly_cost_ils: 'x' })]),
        company,
      );

      const task = await prisma.importTask.findFirstOrThrow({
        where: { companyId: company, kind: 'WORKER_SYNC' },
      });
      expect(task.status).toBe('COMPLETED');
      expect(task.insertedCount).toBe(1);
      expect(task.failedCount).toBe(1);
      expect(task.finishedAt).not.toBeNull();
      expect(task.startedAt).not.toBeNull();
    });
  });

  describe('cancel-and-replace concurrency (v4)', () => {
    function bigCsv(nationalIds: readonly string[]): string {
      const rows = nationalIds.map((id) => csvRow({ national_id: id }));
      return csvFile(rows);
    }

    it('a cancel-and-replace mid-flight stops the superseded run, and the replacement completes normally', async () => {
      const company = await makeCompany('Cancel Replace Co');
      const rowCount = 300;
      const nationalIds = Array.from({ length: rowCount }, (_unused, i) => validNationalId(2000 + i));
      const csv = bigCsv(nationalIds);

      // Kick off a first import without awaiting it -- large enough (300 rows, checkpoints every
      // 50) that it is very likely still mid-loop when we cancel it below.
      const firstImport = service.importCsv(csv, company);

      // Poll (rather than a fixed sleep -- flaky under real system load/DB contention) until its
      // own ImportTask row definitely exists, then cancel that task directly -- exactly what a
      // concurrent `beginImportTask` call (a second, superseding upload) would do at the DB level.
      let firstTask: { id: number } | null = null;
      for (let attempt = 0; attempt < 200 && !firstTask; attempt++) {
        firstTask = await prisma.importTask.findFirst({
          where: { companyId: company, kind: 'WORKER_SYNC' },
          orderBy: { createdAt: 'desc' },
        });
        if (!firstTask) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!firstTask) throw new Error('first import never created its ImportTask row in time');
      await prisma.importTask.update({
        where: { id: firstTask.id },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });

      const firstResult = await firstImport;

      // It stopped before processing every row, and never got flipped back to COMPLETED by its
      // own finalization step.
      expect(firstResult.inserted + firstResult.updated + firstResult.failed).toBeLessThan(rowCount);
      const finalFirstTask = await prisma.importTask.findUniqueOrThrow({ where: { id: firstTask.id } });
      expect(finalFirstTask.status).toBe('CANCELLED');

      // A subsequent import for the SAME company completes normally, not blocked by the cancelled
      // task, and reaches COMPLETED. Some rows may already have been inserted by the superseded
      // first run before it was cancelled, so this run legitimately sees a mix of inserts (new
      // nationalIds) and updates (re-processing a row the first run already got to) -- what
      // matters is that every row is accounted for and none failed.
      const secondResult = await service.importCsv(csv, company);
      expect(secondResult.inserted + secondResult.updated).toBe(rowCount);
      expect(secondResult.failed).toBe(0);
      const secondTask = await prisma.importTask.findFirstOrThrow({
        where: { companyId: company, kind: 'WORKER_SYNC', status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(secondTask.id).not.toBe(firstTask.id);

      // No worker anywhere ends up stamped with the CANCELLED task's id.
      const staleStamped = await prisma.worker.findMany({ where: { lastImportTaskId: firstTask.id } });
      expect(staleStamped).toHaveLength(0);
    }, 30_000);

    it('beginImportTask cancels an existing non-terminal task for the same company+kind and creates a fresh PENDING one', async () => {
      const company = await makeCompany('Begin Task Co');
      const firstTask = await service.beginImportTask(company);
      expect(firstTask.status).toBe('PENDING');

      const secondTask = await service.beginImportTask(company);
      expect(secondTask.status).toBe('PENDING');
      expect(secondTask.id).not.toBe(firstTask.id);

      const reloadedFirst = await prisma.importTask.findUniqueOrThrow({ where: { id: firstTask.id } });
      expect(reloadedFirst.status).toBe('CANCELLED');
    });

    it('beginImportTask for a DIFFERENT company never cancels another company\'s in-flight task', async () => {
      const companyA = await makeCompany('Isolation Co A');
      const companyB = await makeCompany('Isolation Co B');
      const taskA = await service.beginImportTask(companyA);
      const taskB = await service.beginImportTask(companyB);

      const reloadedA = await prisma.importTask.findUniqueOrThrow({ where: { id: taskA.id } });
      expect(reloadedA.status).toBe('PENDING'); // untouched by company B's own beginImportTask
      expect(taskB.status).toBe('PENDING');
    });

    it('attachImportJob stamps pgBossJobId, and importCsv adopts that exact task by matching it', async () => {
      const company = await makeCompany('Attach Task Co');
      const task = await service.beginImportTask(company);
      await service.attachImportJob(task.id, 'fake-job-id-123');

      const result = await service.importCsv(csvFile([csvRow({ national_id: ID_A })]), company, 'fake-job-id-123');
      expect(result.inserted).toBe(1);

      const reloaded = await prisma.importTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(reloaded.status).toBe('COMPLETED');
      expect(reloaded.pgBossJobId).toBe('fake-job-id-123');
    });

    it('failImportTask marks an orphaned PENDING task FAILED, freeing it from blocking future uploads', async () => {
      const company = await makeCompany('Fail Task Co');
      const task = await service.beginImportTask(company);

      await service.failImportTask(task.id);

      const reloaded = await prisma.importTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(reloaded.status).toBe('FAILED');
      expect(reloaded.finishedAt).not.toBeNull();

      // A fresh beginImportTask no longer needs to cancel anything (FAILED is already terminal).
      const nextTask = await service.beginImportTask(company);
      expect(nextTask.status).toBe('PENDING');
      expect(nextTask.id).not.toBe(task.id);
    });
  });
});
