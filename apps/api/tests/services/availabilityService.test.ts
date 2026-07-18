import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidIsraeliId, type Month, type MonthAvailability, type ShiftType } from '@rostering/shared';

import { availabilityCsvHeader, dayColumns, serializeAvailabilityCsv } from '../../src/csv/availability.js';
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
  const service = new AvailabilityService(prisma);

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  async function makeWorker(prefix: number) {
    const company = await prisma.company.findFirst({ where: { name: 'Shamir Security Ltd' } });
    const companyId =
      company?.id ?? (await prisma.company.create({ data: { name: 'Shamir Security Ltd' } })).id;
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
      const worker = await makeWorker(605);
      await service.replaceMonth(FEB_2027, { [String(worker.id)]: { '2027-02-01': ['A', 'B'] } });

      const rows = await prisma.workerAvailability.findMany({ where: { workerId: worker.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.shifts).toBe('AB');
    });

    it('fully replaces the month window: an old row for a date absent from the new payload is deleted', async () => {
      const worker = await makeWorker(606);
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2027-02-05T00:00:00.000Z'), shifts: 'ABC' },
      });

      await service.replaceMonth(FEB_2027, { [String(worker.id)]: { '2027-02-01': ['A'] } });

      const rows = await prisma.workerAvailability.findMany({ where: { workerId: worker.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.shifts).toBe('A');
    });

    it('leaves rows outside the month window untouched', async () => {
      const worker = await makeWorker(607);
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2027-03-01T00:00:00.000Z'), shifts: 'ABC' },
      });

      await service.replaceMonth(FEB_2027, { [String(worker.id)]: { '2027-02-01': ['A'] } });

      const marchRows = await prisma.workerAvailability.findMany({
        where: { workerId: worker.id, date: new Date('2027-03-01T00:00:00.000Z') },
      });
      expect(marchRows).toHaveLength(1);
    });

    it('an empty payload clears the entire month for every worker', async () => {
      const workerA = await makeWorker(608);
      const workerB = await makeWorker(609);
      await prisma.workerAvailability.createMany({
        data: [
          { workerId: workerA.id, date: new Date('2027-02-01T00:00:00.000Z'), shifts: 'A' },
          { workerId: workerB.id, date: new Date('2027-02-02T00:00:00.000Z'), shifts: 'B' },
        ],
      });

      await service.replaceMonth(FEB_2027, {});

      expect(await prisma.workerAvailability.findMany({})).toHaveLength(0);
    });

    it('rejects (400) an unknown workerId without writing anything', async () => {
      const nonExistentWorkerId = 999_999;
      await expect(
        service.replaceMonth(FEB_2027, { [String(nonExistentWorkerId)]: { '2027-02-01': ['A'] } }),
      ).rejects.toThrow();

      expect(await prisma.workerAvailability.findMany({})).toHaveLength(0);
    });

    it('rejects (400) a payload whose total entry count exceeds MAX_AVAILABILITY_ENTRIES', async () => {
      // Doesn't need real workers -- the entry-count cap is checked before the workerId-existence
      // lookup, so this never touches the DB for a worker row.
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

      await expect(service.replaceMonth(FEB_2027, payload)).rejects.toThrow();
    });
  });

  describe('importCsv', () => {
    it('applies a well-formed row, replacing that worker\'s month', async () => {
      const worker = await makeWorker(610);
      const csv = serializeAvailabilityCsv(
        [{ nationalId: worker.nationalId, entries: [{ date: '2027-02-01', shifts: ['A'] }] }],
        FEB_2027,
      );

      const result = await service.importCsv(csv, FEB_2027);

      expect(result).toEqual({ totalRows: 1, applied: 1, failed: 0, errors: [] });
      const rows = await prisma.workerAvailability.findMany({ where: { workerId: worker.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.shifts).toBe('A');
    });

    it('reports an unknown national_id as a row error without creating any row', async () => {
      const csv = serializeAvailabilityCsv(
        [{ nationalId: validNationalId(699), entries: [{ date: '2027-02-01', shifts: ['A'] }] }],
        FEB_2027,
      );

      const result = await service.importCsv(csv, FEB_2027);

      expect(result.applied).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.row).toBe(1);
      expect(await prisma.workerAvailability.findMany({})).toHaveLength(0);
    });

    it('reports an illegal shift-letter cell (e.g. AD) as a row error with the offending dNN field', async () => {
      const worker = await makeWorker(611);
      const header = availabilityCsvHeader(FEB_2027).join(',');
      const cells = dayColumns(FEB_2027).map((_c, i) => (i === 0 ? 'AD' : ''));
      const csv = `${header}\n${[worker.nationalId, ...cells].join(',')}\n`;

      const result = await service.importCsv(csv, FEB_2027);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({ row: 1, field: 'd01' });
    });

    it('reports a duplicate-letter cell (e.g. AA) as a row error', async () => {
      const worker = await makeWorker(612);
      const header = availabilityCsvHeader(FEB_2027).join(',');
      const cells = dayColumns(FEB_2027).map((_c, i) => (i === 0 ? 'AA' : ''));
      const csv = `${header}\n${[worker.nationalId, ...cells].join(',')}\n`;

      const result = await service.importCsv(csv, FEB_2027);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({ row: 1, field: 'd01' });
    });

    it('processes multiple rows without aborting the batch: bad rows fail, good rows apply', async () => {
      const good = await makeWorker(613);
      const badLetters = await makeWorker(614);
      const header = availabilityCsvHeader(FEB_2027).join(',');
      const goodRow = [good.nationalId, 'A', ...Array(27).fill('')].join(',');
      const badRow = [badLetters.nationalId, 'AD', ...Array(27).fill('')].join(',');
      const unknownRow = [validNationalId(698), '', ...Array(27).fill('')].join(',');
      const csv = `${header}\n${goodRow}\n${badRow}\n${unknownRow}\n`;

      const result = await service.importCsv(csv, FEB_2027);

      expect(result.totalRows).toBe(3);
      expect(result.applied).toBe(1);
      expect(result.failed).toBe(2);
      expect(result.errors.map((e) => e.row).sort()).toEqual([2, 3]);
      const goodRows = await prisma.workerAvailability.findMany({ where: { workerId: good.id } });
      expect(goodRows).toHaveLength(1);
    });

    it('does NOT deactivate or otherwise touch a worker absent from the file', async () => {
      const present = await makeWorker(615);
      const absent = await makeWorker(616);
      await prisma.workerAvailability.create({
        data: { workerId: absent.id, date: new Date('2027-02-10T00:00:00.000Z'), shifts: 'ABC' },
      });
      const csv = serializeAvailabilityCsv(
        [{ nationalId: present.nationalId, entries: [{ date: '2027-02-01', shifts: ['A'] }] }],
        FEB_2027,
      );

      await service.importCsv(csv, FEB_2027);

      const absentWorker = await prisma.worker.findUnique({ where: { id: absent.id } });
      expect(absentWorker?.status).toBe('ACTIVE'); // no deactivation sweep
      const absentRows = await prisma.workerAvailability.findMany({ where: { workerId: absent.id } });
      expect(absentRows).toHaveLength(1); // untouched, not cleared
      expect(absentRows[0]?.shifts).toBe('ABC');
    });

    it('an all-empty row (worker present, no cells set) clears that worker\'s month without error', async () => {
      const worker = await makeWorker(617);
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2027-02-01T00:00:00.000Z'), shifts: 'A' },
      });
      const csv = serializeAvailabilityCsv([{ nationalId: worker.nationalId, entries: [] }], FEB_2027);

      const result = await service.importCsv(csv, FEB_2027);

      expect(result).toEqual({ totalRows: 1, applied: 1, failed: 0, errors: [] });
      expect(await prisma.workerAvailability.findMany({ where: { workerId: worker.id } })).toHaveLength(0);
    });
  });

  describe('exportCsv', () => {
    it('round-trips through importCsv unmodified', async () => {
      const worker = await makeWorker(618);
      await prisma.workerAvailability.createMany({
        data: [
          { workerId: worker.id, date: new Date('2027-02-01T00:00:00.000Z'), shifts: 'A' },
          { workerId: worker.id, date: new Date('2027-02-15T00:00:00.000Z'), shifts: 'ABC' },
        ],
      });

      const csv = await service.exportCsv(FEB_2027);
      expect(csv.split('\n')[0]).toBe(availabilityCsvHeader(FEB_2027).join(','));

      await resetDatabase(prisma); // wipe, then re-import from the exported CSV to prove round-trip
      const worker2 = await prisma.worker.create({
        data: {
          nationalId: worker.nationalId,
          name: worker.name,
          role: worker.role,
          status: worker.status,
          companyId: (await prisma.company.create({ data: { name: 'Shamir Security Ltd' } })).id,
        },
      });
      const result = await service.importCsv(csv, FEB_2027);
      expect(result).toEqual({ totalRows: 1, applied: 1, failed: 0, errors: [] });
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
