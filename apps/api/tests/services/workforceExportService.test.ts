import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { isValidIsraeliId, type Month } from '@rostering/shared';

import { WorkforceExportService } from '../../src/services/workforceExportService.js';
import { WorkforceImportService } from '../../src/services/workforceImportService.js';
import { createBoss } from '../../src/jobs/queue.js';
import { parseWorkforceCsv, toWorkforceRow, workforceCsvHeader } from '../../src/csv/index.js';
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
const ID_A = validNationalId(301);

describe('WorkforceExportService.exportCsv', () => {
  const prisma = getTestPrismaClient();
  const exportService = new WorkforceExportService(prisma);
  let boss: PgBoss;

  beforeAll(() => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set for the WorkforceExportService test suite');
    boss = createBoss(databaseUrl);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
    await boss.stop({ graceful: false, close: true });
  });

  it('produces a re-importable payload for every worker with a contract, including that month\'s availability', async () => {
    const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
    const worker = await prisma.worker.create({
      data: { nationalId: ID_A, name: 'Dana Levi', role: 'SUPERVISOR', status: 'ACTIVE', companyId: company.id },
    });
    await prisma.contract.create({
      data: { workerId: worker.id, hourlyCostIls: 62.5, minMonthlyHours: 120, maxMonthlyHours: 182 },
    });
    await prisma.workerAvailability.create({
      data: { workerId: worker.id, date: new Date('2027-02-01T00:00:00.000Z'), excludedShifts: 'A' },
    });

    const csv = await exportService.exportCsv(FEB_2027, company.id);
    expect(csv.split('\n')[0]).toBe(workforceCsvHeader(FEB_2027).join(','));

    const [row] = parseWorkforceCsv(csv, FEB_2027);
    if (!row) throw new Error('expected exactly one exported row');
    const parsed = toWorkforceRow(row, FEB_2027);
    expect(parsed.record).toMatchObject({
      nationalId: ID_A,
      name: 'Dana Levi',
      role: 'SUPERVISOR',
      status: 'ACTIVE',
      hourlyCostIls: 62.5,
      minMonthlyHours: 120,
      maxMonthlyHours: 182,
    });
    expect(parsed.entries).toEqual([{ date: '2027-02-01', shifts: ['A'] }]);
  });

  it('is re-importable: export then import upserts the same worker+availability unchanged', async () => {
    const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
    const worker = await prisma.worker.create({
      data: { nationalId: ID_A, name: 'Dana Levi', role: 'SUPERVISOR', status: 'ACTIVE', companyId: company.id },
    });
    await prisma.contract.create({
      data: { workerId: worker.id, hourlyCostIls: 62.5, minMonthlyHours: 120, maxMonthlyHours: 182 },
    });
    await prisma.workerAvailability.create({
      data: { workerId: worker.id, date: new Date('2027-02-01T00:00:00.000Z'), excludedShifts: 'AB' },
    });

    const csv = await exportService.exportCsv(FEB_2027, company.id);
    const importService = new WorkforceImportService(prisma, boss);
    const result = await importService.importCsv(csv, FEB_2027, company.id);

    expect(result.failed).toBe(0);
    expect(result.updated).toBe(1);

    const workers = await prisma.worker.findMany();
    expect(workers).toHaveLength(1);
    const rows = await prisma.workerAvailability.findMany({ where: { workerId: worker.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.excludedShifts).toBe('AB');
  });

  it('never exports another company\'s workers (company-scoped)', async () => {
    const companyA = await prisma.company.create({ data: { name: 'Company A' } });
    const companyB = await prisma.company.create({ data: { name: 'Company B' } });
    const workerA = await prisma.worker.create({
      data: { nationalId: ID_A, name: 'Worker A', role: 'SUPERVISOR', status: 'ACTIVE', companyId: companyA.id },
    });
    await prisma.contract.create({
      data: { workerId: workerA.id, hourlyCostIls: 50, minMonthlyHours: 100, maxMonthlyHours: 160 },
    });
    const workerB = await prisma.worker.create({
      data: { nationalId: validNationalId(302), name: 'Worker B', role: 'SUPERVISOR', status: 'ACTIVE', companyId: companyB.id },
    });
    await prisma.contract.create({
      data: { workerId: workerB.id, hourlyCostIls: 50, minMonthlyHours: 100, maxMonthlyHours: 160 },
    });

    const csv = await exportService.exportCsv(FEB_2027, companyA.id);
    const rows = parseWorkforceCsv(csv, FEB_2027);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.worker.national_id).toBe(ID_A);
  });

  it('excludes a worker with no contract', async () => {
    const company = await prisma.company.create({ data: { name: 'No Contract Co' } });
    await prisma.worker.create({
      data: { nationalId: ID_A, name: 'No Contract', role: 'SUPERVISOR', status: 'ACTIVE', companyId: company.id },
    });

    const csv = await exportService.exportCsv(FEB_2027, company.id);
    expect(csv.trim().split('\n')).toHaveLength(1); // header only
  });

  it('a worker with a contract but zero availability rows this month exports all-empty dNN cells', async () => {
    const company = await prisma.company.create({ data: { name: 'Zero Availability Co' } });
    const worker = await prisma.worker.create({
      data: { nationalId: ID_A, name: 'Dana Levi', role: 'SUPERVISOR', status: 'ACTIVE', companyId: company.id },
    });
    await prisma.contract.create({
      data: { workerId: worker.id, hourlyCostIls: 50, minMonthlyHours: 100, maxMonthlyHours: 160 },
    });

    const csv = await exportService.exportCsv(FEB_2027, company.id);
    const [row] = parseWorkforceCsv(csv, FEB_2027);
    if (!row) throw new Error('expected exactly one exported row');
    expect(toWorkforceRow(row, FEB_2027).entries).toEqual([]);
  });

  it("guards a worker name that looks like a spreadsheet formula, so it stays formula-injection-safe", async () => {
    const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
    const worker = await prisma.worker.create({
      data: { nationalId: ID_A, name: '=SUM(A1)', role: 'SUPERVISOR', status: 'ACTIVE', companyId: company.id },
    });
    await prisma.contract.create({
      data: { workerId: worker.id, hourlyCostIls: 62.5, minMonthlyHours: 120, maxMonthlyHours: 182 },
    });

    const csv = await exportService.exportCsv(FEB_2027, company.id);
    expect(csv).toContain("'=SUM(A1)");

    const [row] = parseWorkforceCsv(csv, FEB_2027);
    if (!row) throw new Error('expected exactly one exported row');
    expect(toWorkforceRow(row, FEB_2027).record.name).toBe('=SUM(A1)');
  });
});
