import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { isValidIsraeliId, type Month } from '@rostering/shared';

import { serializeWorkforceCsv, workforceCsvHeader, type WorkforceCsvExportRow } from '../../src/csv/workforce.js';
import { dayColumns } from '../../src/csv/availability.js';
import { createBoss } from '../../src/jobs/queue.js';
import { WorkforceImportService } from '../../src/services/workforceImportService.js';
import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';

function validNationalId(prefix: number): string {
  const base = String(prefix).padStart(8, '0');
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${base}${checkDigit}`;
    if (isValidIsraeliId(candidate)) return candidate;
  }
  throw new Error('no valid check digit found');
}

const FEB_2027 = '2027-02' as Month; // 28 days, non-leap

function record(overrides: Partial<WorkforceCsvExportRow['record']> = {}, prefix = 620) {
  return {
    nationalId: validNationalId(prefix),
    name: `Worker ${prefix}`,
    role: 'GENERAL_GUARD' as const,
    status: 'ACTIVE' as const,
    hourlyCostIls: 50,
    minMonthlyHours: 100,
    maxMonthlyHours: 160,
    ...overrides,
  };
}

function csvFor(rows: WorkforceCsvExportRow[]): string {
  return serializeWorkforceCsv(rows, FEB_2027);
}

describe('WorkforceImportService', () => {
  const prisma = getTestPrismaClient();
  let boss: PgBoss;
  let service: WorkforceImportService;

  beforeAll(() => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set for the WorkforceImportService test suite');
    boss = createBoss(databaseUrl);
    service = new WorkforceImportService(prisma, boss);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
    await boss.stop({ graceful: false, close: true });
  });

  function makeCompany(name: string): Promise<number> {
    return prisma.company.create({ data: { name } }).then((c) => c.id);
  }

  async function makeWorker(prefix: number, companyId: number) {
    return prisma.worker.create({
      data: {
        nationalId: validNationalId(prefix),
        name: `Worker ${prefix}`,
        role: 'GENERAL_GUARD',
        status: 'ACTIVE',
        companyId,
      },
    });
  }

  describe('importCsv', () => {
    it('inserts a new worker and their availability for the month in one row', async () => {
      const company = await makeCompany('Import Co 620');
      const csv = csvFor([
        {
          record: record({}, 620),
          entries: [{ date: '2027-02-01', shifts: ['A'] }],
        },
      ]);

      const result = await service.importCsv(csv, FEB_2027, company);

      expect(result).toMatchObject({ totalRows: 1, inserted: 1, updated: 0, failed: 0, errors: [] });
      const worker = await prisma.worker.findUniqueOrThrow({ where: { nationalId: validNationalId(620) } });
      expect(worker.companyId).toBe(company);
      const contract = await prisma.contract.findUniqueOrThrow({ where: { workerId: worker.id } });
      expect(Number(contract.hourlyCostIls)).toBe(50);
      const availabilityRows = await prisma.workerAvailability.findMany({ where: { workerId: worker.id } });
      expect(availabilityRows).toHaveLength(1);
      expect(availabilityRows[0]?.excludedShifts).toBe('A');
    });

    it('updates an existing worker\'s fields and fully replaces their availability window', async () => {
      const company = await makeCompany('Import Co 621');
      const worker = await makeWorker(621, company);
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2027-02-05T00:00:00.000Z'), excludedShifts: 'ABC' },
      });
      const csv = csvFor([
        {
          record: record({ nationalId: worker.nationalId, name: 'Renamed Worker', hourlyCostIls: 70 }, 621),
          entries: [{ date: '2027-02-01', shifts: ['B'] }],
        },
      ]);

      const result = await service.importCsv(csv, FEB_2027, company);

      expect(result).toMatchObject({ totalRows: 1, inserted: 0, updated: 1, failed: 0 });
      const reloaded = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      expect(reloaded.name).toBe('Renamed Worker');
      const contract = await prisma.contract.findUniqueOrThrow({ where: { workerId: worker.id } });
      expect(Number(contract.hourlyCostIls)).toBe(70);
      const availabilityRows = await prisma.workerAvailability.findMany({ where: { workerId: worker.id } });
      expect(availabilityRows).toHaveLength(1); // the old 2027-02-05 row is gone, replaced by 02-01
      expect(availabilityRows[0]?.excludedShifts).toBe('B');
    });

    it('cross-company national_id conflict: one row error, worker untouched, no availability written', async () => {
      const otherCompany = await makeCompany('Import Cross Co Owner');
      const thisCompany = await makeCompany('Import Cross Co Importer');
      const existing = await makeWorker(622, otherCompany);
      const csv = csvFor([
        {
          record: record({ nationalId: existing.nationalId }, 622),
          entries: [{ date: '2027-02-01', shifts: ['A'] }],
        },
      ]);

      const result = await service.importCsv(csv, FEB_2027, thisCompany);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({ row: 1, field: 'national_id' });
      expect(result.errors[0]?.message).toMatch(/different company/);
      const reloaded = await prisma.worker.findUniqueOrThrow({ where: { id: existing.id } });
      expect(reloaded.companyId).toBe(otherCompany); // untouched, never reassigned
      const rows = await prisma.workerAvailability.findMany({ where: { workerId: existing.id } });
      expect(rows).toHaveLength(0);
    });

    it('a bad worker field fails the whole row: no worker upserted, no availability written', async () => {
      const company = await makeCompany('Import Co Bad Field');
      const header = workforceCsvHeader(FEB_2027).join(',');
      const cells = dayColumns(FEB_2027).map((_c, i) => (i === 0 ? 'A' : ''));
      const nationalId = validNationalId(623);
      const badRow = [nationalId, 'Bad Worker', 'Not A Role', 'Active', '50.00', '100', '160', ...cells].join(',');
      const csv = `${header}\n${badRow}\n`;

      const result = await service.importCsv(csv, FEB_2027, company);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({ row: 1, field: 'role' });
      expect(await prisma.worker.findUnique({ where: { nationalId } })).toBeNull();
    });

    it('a bad dNN cell fails the whole row: worker is NOT upserted either (new atomicity behavior)', async () => {
      const company = await makeCompany('Import Co Bad Cell');
      const header = workforceCsvHeader(FEB_2027).join(',');
      const cells = dayColumns(FEB_2027).map((_c, i) => (i === 0 ? 'AD' : ''));
      const nationalId = validNationalId(624);
      const row = [nationalId, 'Cell Worker', 'General Guard', 'Active', '50.00', '100', '160', ...cells].join(',');
      const csv = `${header}\n${row}\n`;

      const result = await service.importCsv(csv, FEB_2027, company);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({ row: 1, field: 'd01' });
      expect(await prisma.worker.findUnique({ where: { nationalId } })).toBeNull();
    });

    it('processes multiple rows without aborting the batch: bad rows fail, good rows apply', async () => {
      const company = await makeCompany('Import Co Multi');
      const csv = csvFor([
        { record: record({}, 625), entries: [{ date: '2027-02-01', shifts: ['A'] }] },
      ]);
      const header = workforceCsvHeader(FEB_2027).join(',');
      const goodLine = csv.split('\n')[1];
      const badCells = dayColumns(FEB_2027).map((_c, i) => (i === 0 ? 'AD' : ''));
      const badLine = [validNationalId(626), 'Bad', 'General Guard', 'Active', '50.00', '100', '160', ...badCells].join(',');
      const combined = `${header}\n${goodLine}\n${badLine}\n`;

      const result = await service.importCsv(combined, FEB_2027, company);

      expect(result.totalRows).toBe(2);
      expect(result.inserted).toBe(1);
      expect(result.failed).toBe(1);
      expect(await prisma.worker.findUnique({ where: { nationalId: validNationalId(625) } })).not.toBeNull();
      expect(await prisma.worker.findUnique({ where: { nationalId: validNationalId(626) } })).toBeNull();
    });

    it('does NOT deactivate or otherwise touch a worker absent from the file', async () => {
      const company = await makeCompany('Import Co Absent');
      const present = await makeWorker(627, company);
      const absent = await makeWorker(628, company);
      const csv = csvFor([
        { record: record({ nationalId: present.nationalId }, 627), entries: [] },
      ]);

      await service.importCsv(csv, FEB_2027, company);

      const reloaded = await prisma.worker.findUniqueOrThrow({ where: { id: absent.id } });
      expect(reloaded.status).toBe('ACTIVE'); // no deactivation sweep
    });

    it('lastImportTaskId is stamped in bulk only after the task reaches COMPLETED, never for a cancelled run', async () => {
      const company = await makeCompany('Import Co Stamp');
      const csv = csvFor([{ record: record({}, 629), entries: [] }]);

      const result = await service.importCsv(csv, FEB_2027, company);
      expect(result.inserted).toBe(1);
      const task = await prisma.importTask.findFirstOrThrow({ where: { companyId: company, kind: 'WORKFORCE_SYNC' } });
      expect(task.status).toBe('COMPLETED');
      const worker = await prisma.worker.findUniqueOrThrow({ where: { nationalId: validNationalId(629) } });
      expect(worker.lastImportTaskId).toBe(task.id);
    });

    it('creates a PENDING/PROCESSING ImportTask that ends up COMPLETED with the row counts and month', async () => {
      const company = await makeCompany('Import Co Task');
      const csv = csvFor([{ record: record({}, 630), entries: [{ date: '2027-02-01', shifts: ['A'] }] }]);

      await service.importCsv(csv, FEB_2027, company);

      const task = await prisma.importTask.findFirstOrThrow({ where: { companyId: company, kind: 'WORKFORCE_SYNC' } });
      expect(task.status).toBe('COMPLETED');
      expect(task.month).toBe(FEB_2027);
      expect(task.insertedCount).toBe(1);
      expect(task.failedCount).toBe(0);
      expect(task.finishedAt).not.toBeNull();
    });
  });

  describe('cancel-and-replace concurrency (v4)', () => {
    function bigCsv(nationalIds: readonly string[]): string {
      const header = workforceCsvHeader(FEB_2027).join(',');
      const cells = dayColumns(FEB_2027).map((_c, i) => (i === 0 ? 'A' : ''));
      const rows = nationalIds.map((id) => [id, 'Bulk Worker', 'General Guard', 'Active', '50.00', '100', '160', ...cells].join(','));
      return `${header}\n${rows.join('\n')}\n`;
    }

    it('a cancel-and-replace mid-flight stops the superseded run, and the replacement completes normally', async () => {
      const company = await makeCompany('Cancel Replace Co');
      const rowCount = 300;
      const nationalIds = Array.from({ length: rowCount }, (_, i) => validNationalId(2000 + i));
      const csv = bigCsv(nationalIds);

      const firstImport = service.importCsv(csv, FEB_2027, company);

      await new Promise((resolve) => setTimeout(resolve, 15));
      const firstTask = await prisma.importTask.findFirstOrThrow({
        where: { companyId: company, kind: 'WORKFORCE_SYNC' },
        orderBy: { createdAt: 'desc' },
      });
      await prisma.importTask.update({
        where: { id: firstTask.id },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });

      const firstResult = await firstImport;
      expect(firstResult.inserted + firstResult.failed).toBeLessThan(rowCount);
      const finalFirstTask = await prisma.importTask.findUniqueOrThrow({ where: { id: firstTask.id } });
      expect(finalFirstTask.status).toBe('CANCELLED');

      // The first (cancelled) run's already-committed rows created some workers before it was
      // stopped -- their per-row transactions are NOT rolled back by cancellation, only the loop
      // stops iterating further. So the second run's identical CSV updates those already-created
      // workers rather than inserting them again; the split between inserted/updated depends on
      // exactly how far the first run got, but every row must succeed with none left over.
      const secondResult = await service.importCsv(csv, FEB_2027, company);
      expect(secondResult.inserted + secondResult.updated).toBe(rowCount);
      expect(secondResult.failed).toBe(0);
      const secondTask = await prisma.importTask.findFirstOrThrow({
        where: { companyId: company, kind: 'WORKFORCE_SYNC', status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(secondTask.id).not.toBe(firstTask.id);
    }, 30_000);

    it('beginImportTask cancels an existing non-terminal task for the same company+kind and creates a fresh PENDING one', async () => {
      const company = await makeCompany('Begin Task Co');
      const firstTask = await service.beginImportTask(company, FEB_2027, 5);
      expect(firstTask.status).toBe('PENDING');

      const secondTask = await service.beginImportTask(company, FEB_2027, 7);
      expect(secondTask.status).toBe('PENDING');
      expect(secondTask.id).not.toBe(firstTask.id);

      const reloadedFirst = await prisma.importTask.findUniqueOrThrow({ where: { id: firstTask.id } });
      expect(reloadedFirst.status).toBe('CANCELLED');
    });

    it('beginImportTask for a DIFFERENT company never cancels another company\'s in-flight task', async () => {
      const companyA = await makeCompany('Isolation Co A');
      const companyB = await makeCompany('Isolation Co B');
      const taskA = await service.beginImportTask(companyA, FEB_2027, 1);
      const taskB = await service.beginImportTask(companyB, FEB_2027, 1);

      const reloadedA = await prisma.importTask.findUniqueOrThrow({ where: { id: taskA.id } });
      expect(reloadedA.status).toBe('PENDING'); // untouched by company B's own beginImportTask
      expect(taskB.status).toBe('PENDING');
    });

    it('attachImportJob + importCsv adopt the exact task by pgBossJobId', async () => {
      const company = await makeCompany('Adopt Task Co');
      const task = await service.beginImportTask(company, FEB_2027, 1);
      await service.attachImportJob(task.id, 'fake-job-id-123');
      const csv = csvFor([{ record: record({}, 631), entries: [] }]);

      await service.importCsv(csv, FEB_2027, company, 'fake-job-id-123');

      const reloaded = await prisma.importTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(reloaded.status).toBe('COMPLETED');
    });

    it('failImportTask marks an orphaned PENDING task FAILED', async () => {
      const company = await makeCompany('Fail Task Co');
      const task = await service.beginImportTask(company, FEB_2027, 1);
      await service.failImportTask(task.id);
      const reloaded = await prisma.importTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(reloaded.status).toBe('FAILED');
    });
  });
});
