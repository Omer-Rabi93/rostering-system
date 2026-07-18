import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { isValidIsraeliId, type Month, type MonthAvailability, type ShiftType } from '@rostering/shared';

import { availabilityCsvHeader, dayColumns, serializeAvailabilityCsv } from '../../src/csv/availability.js';
import { createBoss } from '../../src/jobs/queue.js';
import { AvailabilityService, MAX_AVAILABILITY_ENTRIES } from '../../src/services/availabilityService.js';
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

describe('AvailabilityService', () => {
  const prisma = getTestPrismaClient();
  let boss: PgBoss;
  let service: AvailabilityService;

  beforeAll(() => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set for the AvailabilityService test suite');
    boss = createBoss(databaseUrl);
    service = new AvailabilityService(prisma, boss);
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

  async function makeWorker(prefix: number, companyId?: number) {
    const cid = companyId ?? (await makeCompany(`Shamir Security Ltd ${prefix}`));
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

  describe('getMonth', () => {
    it('returns an empty object when nobody has any rows this month', async () => {
      await makeWorker(601);
      expect(await service.getMonth(FEB_2027)).toEqual({});
    });

    it('groups rows per worker, sparse by date (no entry for a date with no row)', async () => {
      const workerA = await makeWorker(602);
      const workerB = await makeWorker(603);
      await prisma.workerAvailability.createMany({
        data: [
          { workerId: workerA.id, date: new Date('2027-02-01T00:00:00.000Z'), shifts: 'A' },
          { workerId: workerA.id, date: new Date('2027-02-03T00:00:00.000Z'), shifts: 'ABC' },
          { workerId: workerB.id, date: new Date('2027-02-01T00:00:00.000Z'), shifts: 'BC' },
        ],
      });

      const result = await service.getMonth(FEB_2027);
      expect(result).toEqual({
        [String(workerA.id)]: { '2027-02-01': ['A'], '2027-02-03': ['A', 'B', 'C'] },
        [String(workerB.id)]: { '2027-02-01': ['B', 'C'] },
      });
    });

    it('excludes rows outside the requested month window', async () => {
      const worker = await makeWorker(604);
      await prisma.workerAvailability.createMany({
        data: [
          { workerId: worker.id, date: new Date('2027-01-31T00:00:00.000Z'), shifts: 'A' },
          { workerId: worker.id, date: new Date('2027-02-01T00:00:00.000Z'), shifts: 'A' },
          { workerId: worker.id, date: new Date('2027-03-01T00:00:00.000Z'), shifts: 'A' },
        ],
      });

      const result = await service.getMonth(FEB_2027);
      expect(result).toEqual({ [String(worker.id)]: { '2027-02-01': ['A'] } });
    });
  });

  describe('replaceMonth', () => {
    it('inserts a fresh month with no prior rows', async () => {
      const company = await makeCompany('Replace Co 605');
      const worker = await makeWorker(605, company);
      await service.replaceMonth(FEB_2027, { [String(worker.id)]: { '2027-02-01': ['A', 'B'] } }, company);

      const rows = await prisma.workerAvailability.findMany({ where: { workerId: worker.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.shifts).toBe('AB');
    });

    it('fully replaces the month window: an old row for a date absent from the new payload is deleted', async () => {
      const company = await makeCompany('Replace Co 606');
      const worker = await makeWorker(606, company);
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2027-02-05T00:00:00.000Z'), shifts: 'ABC' },
      });

      await service.replaceMonth(FEB_2027, { [String(worker.id)]: { '2027-02-01': ['A'] } }, company);

      const rows = await prisma.workerAvailability.findMany({ where: { workerId: worker.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.shifts).toBe('A');
    });

    it('leaves rows outside the month window untouched', async () => {
      const company = await makeCompany('Replace Co 607');
      const worker = await makeWorker(607, company);
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2027-03-01T00:00:00.000Z'), shifts: 'ABC' },
      });

      await service.replaceMonth(FEB_2027, { [String(worker.id)]: { '2027-02-01': ['A'] } }, company);

      const marchRows = await prisma.workerAvailability.findMany({
        where: { workerId: worker.id, date: new Date('2027-03-01T00:00:00.000Z') },
      });
      expect(marchRows).toHaveLength(1);
    });

    it('an empty payload clears the entire month for every worker IN THAT COMPANY', async () => {
      const company = await makeCompany('Replace Co 608');
      const workerA = await makeWorker(608, company);
      const workerB = await makeWorker(609, company);
      await prisma.workerAvailability.createMany({
        data: [
          { workerId: workerA.id, date: new Date('2027-02-01T00:00:00.000Z'), shifts: 'A' },
          { workerId: workerB.id, date: new Date('2027-02-02T00:00:00.000Z'), shifts: 'B' },
        ],
      });

      await service.replaceMonth(FEB_2027, {}, company);

      expect(await prisma.workerAvailability.findMany({})).toHaveLength(0);
    });

    it('rejects (400) an unknown workerId without writing anything', async () => {
      const company = await makeCompany('Replace Co Unknown');
      const nonExistentWorkerId = 999_999;
      await expect(
        service.replaceMonth(FEB_2027, { [String(nonExistentWorkerId)]: { '2027-02-01': ['A'] } }, company),
      ).rejects.toThrow();

      expect(await prisma.workerAvailability.findMany({})).toHaveLength(0);
    });

    it('rejects (400) a payload whose total entry count exceeds MAX_AVAILABILITY_ENTRIES', async () => {
      // Doesn't need real workers -- the entry-count cap is checked before the workerId-existence
      // lookup, so this never touches the DB for a worker row.
      const company = await makeCompany('Replace Co Cap');
      const payload: MonthAvailability = {};
      const workersNeeded = Math.ceil((MAX_AVAILABILITY_ENTRIES + 1) / 28);
      for (let i = 0; i < workersNeeded; i++) {
        const byDate: Record<string, ShiftType[]> = {};
        for (const date of ['2027-02-01', '2027-02-02', '2027-02-03', '2027-02-04', '2027-02-05',
          '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11',
          '2027-02-12', '2027-02-13', '2027-02-14', '2027-02-15', '2027-02-16', '2027-02-17',
          '2027-02-18', '2027-02-19', '2027-02-20', '2027-02-21', '2027-02-22', '2027-02-23',
          '2027-02-24', '2027-02-25', '2027-02-26', '2027-02-27', '2027-02-28']) {
          byDate[date] = ['A'];
        }
        payload[String(i + 1)] = byDate;
      }

      await expect(service.replaceMonth(FEB_2027, payload, company)).rejects.toThrow();
    });

    it('v4: rejects (400) a workerId that belongs to a DIFFERENT company, without touching it or aborting silently', async () => {
      const companyA = await makeCompany('Replace Cross Co A');
      const companyB = await makeCompany('Replace Cross Co B');
      const workerB = await makeWorker(650, companyB);
      await prisma.workerAvailability.create({
        data: { workerId: workerB.id, date: new Date('2027-02-05T00:00:00.000Z'), shifts: 'ABC' },
      });

      await expect(
        service.replaceMonth(FEB_2027, { [String(workerB.id)]: { '2027-02-01': ['A'] } }, companyA),
      ).rejects.toThrow();

      const rows = await prisma.workerAvailability.findMany({ where: { workerId: workerB.id } });
      expect(rows).toHaveLength(1); // untouched
      expect(rows[0]?.shifts).toBe('ABC');
    });

    it('v4: company-scoped regression -- replacing company A\'s month never touches company B\'s rows for the same window', async () => {
      const companyA = await makeCompany('Replace Regression Co A');
      const companyB = await makeCompany('Replace Regression Co B');
      const workerA = await makeWorker(651, companyA);
      const workerB = await makeWorker(652, companyB);
      await prisma.workerAvailability.create({
        data: { workerId: workerB.id, date: new Date('2027-02-01T00:00:00.000Z'), shifts: 'A' },
      });

      // Company A's own replace (even an empty payload, which clears its own month) must never
      // touch company B's row for the same calendar window -- this is the exact bug the v4 design
      // doc calls out (`replaceMonth` had zero company awareness before).
      await service.replaceMonth(FEB_2027, { [String(workerA.id)]: { '2027-02-01': ['B'] } }, companyA);

      const rowsB = await prisma.workerAvailability.findMany({ where: { workerId: workerB.id } });
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0]?.shifts).toBe('A'); // untouched by company A's replace
    });
  });

  describe('importCsv', () => {
    it('applies a well-formed row, replacing that worker\'s month', async () => {
      const company = await makeCompany('Import Co 610');
      const worker = await makeWorker(610, company);
      const csv = serializeAvailabilityCsv(
        [{ nationalId: worker.nationalId, entries: [{ date: '2027-02-01', shifts: ['A'] }] }],
        FEB_2027,
      );

      const result = await service.importCsv(csv, FEB_2027, company);

      expect(result).toMatchObject({ totalRows: 1, applied: 1, failed: 0, errors: [] });
      const rows = await prisma.workerAvailability.findMany({ where: { workerId: worker.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.shifts).toBe('A');
    });

    it('reports an unknown national_id as a row error without creating any row', async () => {
      const company = await makeCompany('Import Co Unknown');
      const csv = serializeAvailabilityCsv(
        [{ nationalId: validNationalId(699), entries: [{ date: '2027-02-01', shifts: ['A'] }] }],
        FEB_2027,
      );

      const result = await service.importCsv(csv, FEB_2027, company);

      expect(result.applied).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.row).toBe(1);
      expect(await prisma.workerAvailability.findMany({})).toHaveLength(0);
    });

    it('v4: reports a national_id belonging to a DIFFERENT company as a row error, never a cross-company write', async () => {
      const companyA = await makeCompany('Import Cross Co A');
      const companyB = await makeCompany('Import Cross Co B');
      const otherCompanyWorker = await makeWorker(660, companyB);
      const csv = serializeAvailabilityCsv(
        [{ nationalId: otherCompanyWorker.nationalId, entries: [{ date: '2027-02-01', shifts: ['A'] }] }],
        FEB_2027,
      );

      const result = await service.importCsv(csv, FEB_2027, companyA);

      expect(result.applied).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0]?.row).toBe(1);
      expect(result.errors[0]?.message).toMatch(/different company/i);
      const rows = await prisma.workerAvailability.findMany({ where: { workerId: otherCompanyWorker.id } });
      expect(rows).toHaveLength(0);
    });

    it('v4: company-scoped regression -- importing for company A never touches company B\'s availability data', async () => {
      const companyA = await makeCompany('Import Regression Co A');
      const companyB = await makeCompany('Import Regression Co B');
      const workerA = await makeWorker(661, companyA);
      const workerB = await makeWorker(662, companyB);
      await prisma.workerAvailability.create({
        data: { workerId: workerB.id, date: new Date('2027-02-10T00:00:00.000Z'), shifts: 'ABC' },
      });
      const csv = serializeAvailabilityCsv(
        [{ nationalId: workerA.nationalId, entries: [{ date: '2027-02-01', shifts: ['A'] }] }],
        FEB_2027,
      );

      const result = await service.importCsv(csv, FEB_2027, companyA);

      expect(result).toMatchObject({ applied: 1, failed: 0 });
      const rowsB = await prisma.workerAvailability.findMany({ where: { workerId: workerB.id } });
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0]?.shifts).toBe('ABC'); // untouched
    });

    it('reports an illegal shift-letter cell (e.g. AD) as a row error with the offending dNN field', async () => {
      const company = await makeCompany('Import Co 611');
      const worker = await makeWorker(611, company);
      const header = availabilityCsvHeader(FEB_2027).join(',');
      const cells = dayColumns(FEB_2027).map((_c, i) => (i === 0 ? 'AD' : ''));
      const csv = `${header}\n${[worker.nationalId, ...cells].join(',')}\n`;

      const result = await service.importCsv(csv, FEB_2027, company);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({ row: 1, field: 'd01' });
    });

    it('reports a duplicate-letter cell (e.g. AA) as a row error', async () => {
      const company = await makeCompany('Import Co 612');
      const worker = await makeWorker(612, company);
      const header = availabilityCsvHeader(FEB_2027).join(',');
      const cells = dayColumns(FEB_2027).map((_c, i) => (i === 0 ? 'AA' : ''));
      const csv = `${header}\n${[worker.nationalId, ...cells].join(',')}\n`;

      const result = await service.importCsv(csv, FEB_2027, company);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({ row: 1, field: 'd01' });
    });

    it('processes multiple rows without aborting the batch: bad rows fail, good rows apply', async () => {
      const company = await makeCompany('Import Co Multi');
      const good = await makeWorker(613, company);
      const badLetters = await makeWorker(614, company);
      const header = availabilityCsvHeader(FEB_2027).join(',');
      const goodRow = [good.nationalId, 'A', ...Array(27).fill('')].join(',');
      const badRow = [badLetters.nationalId, 'AD', ...Array(27).fill('')].join(',');
      const unknownRow = [validNationalId(698), '', ...Array(27).fill('')].join(',');
      const csv = `${header}\n${goodRow}\n${badRow}\n${unknownRow}\n`;

      const result = await service.importCsv(csv, FEB_2027, company);

      expect(result.totalRows).toBe(3);
      expect(result.applied).toBe(1);
      expect(result.failed).toBe(2);
      expect(result.errors.map((e) => e.row).sort()).toEqual([2, 3]);
      const goodRows = await prisma.workerAvailability.findMany({ where: { workerId: good.id } });
      expect(goodRows).toHaveLength(1);
    });

    it('does NOT deactivate or otherwise touch a worker absent from the file', async () => {
      const company = await makeCompany('Import Co Absent');
      const present = await makeWorker(615, company);
      const absent = await makeWorker(616, company);
      await prisma.workerAvailability.create({
        data: { workerId: absent.id, date: new Date('2027-02-10T00:00:00.000Z'), shifts: 'ABC' },
      });
      const csv = serializeAvailabilityCsv(
        [{ nationalId: present.nationalId, entries: [{ date: '2027-02-01', shifts: ['A'] }] }],
        FEB_2027,
      );

      await service.importCsv(csv, FEB_2027, company);

      const absentWorker = await prisma.worker.findUnique({ where: { id: absent.id } });
      expect(absentWorker?.status).toBe('ACTIVE'); // no deactivation sweep
      const absentRows = await prisma.workerAvailability.findMany({ where: { workerId: absent.id } });
      expect(absentRows).toHaveLength(1); // untouched, not cleared
      expect(absentRows[0]?.shifts).toBe('ABC');
    });

    it('an all-empty row (worker present, no cells set) clears that worker\'s month without error', async () => {
      const company = await makeCompany('Import Co Empty Row');
      const worker = await makeWorker(617, company);
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2027-02-01T00:00:00.000Z'), shifts: 'A' },
      });
      const csv = serializeAvailabilityCsv([{ nationalId: worker.nationalId, entries: [] }], FEB_2027);

      const result = await service.importCsv(csv, FEB_2027, company);

      expect(result).toMatchObject({ totalRows: 1, applied: 1, failed: 0, errors: [] });
      expect(await prisma.workerAvailability.findMany({ where: { workerId: worker.id } })).toHaveLength(0);
    });

    it('creates a PENDING/PROCESSING ImportTask that ends up COMPLETED with the row counts', async () => {
      const company = await makeCompany('Import Co Task');
      const worker = await makeWorker(690, company);
      const csv = serializeAvailabilityCsv(
        [{ nationalId: worker.nationalId, entries: [{ date: '2027-02-01', shifts: ['A'] }] }],
        FEB_2027,
      );

      await service.importCsv(csv, FEB_2027, company);

      const task = await prisma.importTask.findFirstOrThrow({
        where: { companyId: company, kind: 'AVAILABILITY_SYNC' },
      });
      expect(task.status).toBe('COMPLETED');
      expect(task.month).toBe(FEB_2027);
      expect(task.insertedCount).toBe(1);
      expect(task.failedCount).toBe(0);
      expect(task.finishedAt).not.toBeNull();
    });
  });

  describe('cancel-and-replace concurrency (v4)', () => {
    function bigCsv(workerCount: number, nationalIds: readonly string[]): string {
      const header = availabilityCsvHeader(FEB_2027).join(',');
      const rows = nationalIds
        .slice(0, workerCount)
        .map((id) => [id, 'A', ...Array(27).fill('')].join(','));
      return `${header}\n${rows.join('\n')}\n`;
    }

    it('a cancel-and-replace mid-flight stops the superseded run, and the replacement completes normally', async () => {
      const company = await makeCompany('Cancel Replace Co');
      const rowCount = 300;
      const workers = [];
      for (let i = 0; i < rowCount; i++) {
        workers.push(await makeWorker(1000 + i, company));
      }
      const nationalIds = workers.map((w) => w.nationalId);
      const csv = bigCsv(rowCount, nationalIds);

      // Kick off a first import without awaiting it -- large enough (300 rows, checkpoints every
      // 50) that it is very likely still mid-loop when we cancel it below.
      const firstImport = service.importCsv(csv, FEB_2027, company);

      // Give it a brief head start so its own ImportTask row definitely exists, then cancel that
      // task directly -- exactly what a concurrent `beginImportTask` call (a second, superseding
      // upload) would do at the DB level.
      await new Promise((resolve) => setTimeout(resolve, 15));
      const firstTask = await prisma.importTask.findFirstOrThrow({
        where: { companyId: company, kind: 'AVAILABILITY_SYNC' },
        orderBy: { createdAt: 'desc' },
      });
      await prisma.importTask.update({
        where: { id: firstTask.id },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });

      const firstResult = await firstImport;

      // It stopped before processing every row (never got a chance to finish + never got flipped
      // back to COMPLETED by its own finalization step).
      expect(firstResult.applied + firstResult.failed).toBeLessThan(rowCount);
      const finalFirstTask = await prisma.importTask.findUniqueOrThrow({ where: { id: firstTask.id } });
      expect(finalFirstTask.status).toBe('CANCELLED');

      // A subsequent import for the SAME company completes normally, not blocked by the cancelled
      // task, and reaches COMPLETED.
      const secondResult = await service.importCsv(csv, FEB_2027, company);
      expect(secondResult.applied).toBe(rowCount);
      expect(secondResult.failed).toBe(0);
      const secondTask = await prisma.importTask.findFirstOrThrow({
        where: { companyId: company, kind: 'AVAILABILITY_SYNC', status: 'COMPLETED' },
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
  });

  describe('exportCsv', () => {
    it('round-trips through importCsv unmodified', async () => {
      const company = await makeCompany('Export Co 618');
      const worker = await makeWorker(618, company);
      await prisma.workerAvailability.createMany({
        data: [
          { workerId: worker.id, date: new Date('2027-02-01T00:00:00.000Z'), shifts: 'A' },
          { workerId: worker.id, date: new Date('2027-02-15T00:00:00.000Z'), shifts: 'ABC' },
        ],
      });

      const csv = await service.exportCsv(FEB_2027);
      expect(csv.split('\n')[0]).toBe(availabilityCsvHeader(FEB_2027).join(','));

      await resetDatabase(prisma); // wipe, then re-import from the exported CSV to prove round-trip
      const company2 = await makeCompany('Export Co 618 Reimport');
      const worker2 = await prisma.worker.create({
        data: {
          nationalId: worker.nationalId,
          name: worker.name,
          role: worker.role,
          status: worker.status,
          companyId: company2,
        },
      });
      const result = await service.importCsv(csv, FEB_2027, company2);
      expect(result).toMatchObject({ totalRows: 1, applied: 1, failed: 0, errors: [] });
      const rows = await prisma.workerAvailability.findMany({
        where: { workerId: worker2.id },
        orderBy: { date: 'asc' },
      });
      expect(rows.map((r) => r.shifts)).toEqual(['A', 'ABC']);
    });

    it('excludes a worker with zero rows this month', async () => {
      await makeWorker(619);
      const csv = await service.exportCsv(FEB_2027);
      expect(csv.trim().split('\n')).toHaveLength(1); // header only
    });
  });
});
