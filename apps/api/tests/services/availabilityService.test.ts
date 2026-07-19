import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidIsraeliId, type Month, type MonthAvailability, type ShiftType } from '@rostering/shared';

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
  let service: AvailabilityService;

  beforeAll(() => {
    service = new AvailabilityService(prisma);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
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
      const company = await makeCompany('Empty Month Co 601');
      await makeWorker(601, company);
      expect(await service.getMonth(FEB_2027, company)).toEqual({});
    });

    it('groups rows per worker, sparse by date (no entry for a date with no row)', async () => {
      const company = await makeCompany('Group Rows Co');
      const workerA = await makeWorker(602, company);
      const workerB = await makeWorker(603, company);
      await prisma.workerAvailability.createMany({
        data: [
          { workerId: workerA.id, date: new Date('2027-02-01T00:00:00.000Z'), excludedShifts: 'A' },
          { workerId: workerA.id, date: new Date('2027-02-03T00:00:00.000Z'), excludedShifts: 'ABC' },
          { workerId: workerB.id, date: new Date('2027-02-01T00:00:00.000Z'), excludedShifts: 'BC' },
        ],
      });

      const result = await service.getMonth(FEB_2027, company);
      expect(result).toEqual({
        [String(workerA.id)]: { '2027-02-01': ['A'], '2027-02-03': ['A', 'B', 'C'] },
        [String(workerB.id)]: { '2027-02-01': ['B', 'C'] },
      });
    });

    it('excludes rows outside the requested month window', async () => {
      const company = await makeCompany('Window Co 604');
      const worker = await makeWorker(604, company);
      await prisma.workerAvailability.createMany({
        data: [
          { workerId: worker.id, date: new Date('2027-01-31T00:00:00.000Z'), excludedShifts: 'A' },
          { workerId: worker.id, date: new Date('2027-02-01T00:00:00.000Z'), excludedShifts: 'A' },
          { workerId: worker.id, date: new Date('2027-03-01T00:00:00.000Z'), excludedShifts: 'A' },
        ],
      });

      const result = await service.getMonth(FEB_2027, company);
      expect(result).toEqual({ [String(worker.id)]: { '2027-02-01': ['A'] } });
    });

    it('never returns another company\'s workers\' rows (v4 company scoping)', async () => {
      const companyA = await makeCompany('Cross Get Co A');
      const companyB = await makeCompany('Cross Get Co B');
      const workerA = await makeWorker(650, companyA);
      const workerB = await makeWorker(651, companyB);
      await prisma.workerAvailability.createMany({
        data: [
          { workerId: workerA.id, date: new Date('2027-02-01T00:00:00.000Z'), excludedShifts: 'A' },
          { workerId: workerB.id, date: new Date('2027-02-02T00:00:00.000Z'), excludedShifts: 'B' },
        ],
      });

      const resultA = await service.getMonth(FEB_2027, companyA);
      expect(resultA).toEqual({ [String(workerA.id)]: { '2027-02-01': ['A'] } });
      expect(resultA).not.toHaveProperty(String(workerB.id));

      const resultB = await service.getMonth(FEB_2027, companyB);
      expect(resultB).toEqual({ [String(workerB.id)]: { '2027-02-02': ['B'] } });
      expect(resultB).not.toHaveProperty(String(workerA.id));
    });
  });

  describe('replaceMonth', () => {
    it('inserts a fresh month with no prior rows', async () => {
      const company = await makeCompany('Replace Co 605');
      const worker = await makeWorker(605, company);
      await service.replaceMonth(FEB_2027, { [String(worker.id)]: { '2027-02-01': ['A', 'B'] } }, company);

      const rows = await prisma.workerAvailability.findMany({ where: { workerId: worker.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.excludedShifts).toBe('AB');
    });

    it('fully replaces the month window: an old row for a date absent from the new payload is deleted', async () => {
      const company = await makeCompany('Replace Co 606');
      const worker = await makeWorker(606, company);
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2027-02-05T00:00:00.000Z'), excludedShifts: 'ABC' },
      });

      await service.replaceMonth(FEB_2027, { [String(worker.id)]: { '2027-02-01': ['A'] } }, company);

      const rows = await prisma.workerAvailability.findMany({ where: { workerId: worker.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.excludedShifts).toBe('A');
    });

    it('leaves rows outside the month window untouched', async () => {
      const company = await makeCompany('Replace Co 607');
      const worker = await makeWorker(607, company);
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2027-03-01T00:00:00.000Z'), excludedShifts: 'ABC' },
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
          { workerId: workerA.id, date: new Date('2027-02-01T00:00:00.000Z'), excludedShifts: 'A' },
          { workerId: workerB.id, date: new Date('2027-02-02T00:00:00.000Z'), excludedShifts: 'B' },
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
        data: { workerId: workerB.id, date: new Date('2027-02-05T00:00:00.000Z'), excludedShifts: 'ABC' },
      });

      await expect(
        service.replaceMonth(FEB_2027, { [String(workerB.id)]: { '2027-02-01': ['A'] } }, companyA),
      ).rejects.toThrow();

      const rows = await prisma.workerAvailability.findMany({ where: { workerId: workerB.id } });
      expect(rows).toHaveLength(1); // untouched
      expect(rows[0]?.excludedShifts).toBe('ABC');
    });

    it('v4: company-scoped regression -- replacing company A\'s month never touches company B\'s rows for the same window', async () => {
      const companyA = await makeCompany('Replace Regression Co A');
      const companyB = await makeCompany('Replace Regression Co B');
      const workerA = await makeWorker(651, companyA);
      const workerB = await makeWorker(652, companyB);
      await prisma.workerAvailability.create({
        data: { workerId: workerB.id, date: new Date('2027-02-01T00:00:00.000Z'), excludedShifts: 'A' },
      });

      // Company A's own replace (even an empty payload, which clears its own month) must never
      // touch company B's row for the same calendar window -- this is the exact bug the v4 design
      // doc calls out (`replaceMonth` had zero company awareness before).
      await service.replaceMonth(FEB_2027, { [String(workerA.id)]: { '2027-02-01': ['B'] } }, companyA);

      const rowsB = await prisma.workerAvailability.findMany({ where: { workerId: workerB.id } });
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0]?.excludedShifts).toBe('A'); // untouched by company A's replace
    });
  });
});
