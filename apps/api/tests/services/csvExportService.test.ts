import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { isValidIsraeliId } from '@rostering/shared';

import { CsvExportService } from '../../src/services/csvExportService.js';
import { CsvImportService } from '../../src/services/csvImportService.js';
import { createBoss } from '../../src/jobs/queue.js';
import { parseWorkersCsv, toWorkerRecord } from '../../src/csv/index.js';
import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';

function validNationalId(prefix: number): string {
  const base = String(prefix).padStart(8, '0');
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${base}${checkDigit}`;
    if (isValidIsraeliId(candidate)) return candidate;
  }
  throw new Error('no valid check digit found');
}

const ID_A = validNationalId(301);

describe('CsvExportService.exportCsv', () => {
  const prisma = getTestPrismaClient();
  const exportService = new CsvExportService(prisma);
  let boss: PgBoss;

  beforeAll(() => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set for the CsvExportService test suite');
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

  it('produces a re-importable text/csv payload for every worker with a contract', async () => {
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

    const csv = await exportService.exportCsv();
    const rows = parseWorkersCsv(csv);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (!row) throw new Error('expected exactly one exported row');
    const record = toWorkerRecord(row);
    expect(record).toMatchObject({
      nationalId: ID_A,
      name: 'Dana Levi',
      role: 'SUPERVISOR',
      status: 'ACTIVE',
      hourlyCostIls: 62.5,
      minMonthlyHours: 120,
      maxMonthlyHours: 182,
    });
  });

  it('is re-importable: export then import upserts the same worker unchanged', async () => {
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

    const csv = await exportService.exportCsv();
    const importService = new CsvImportService(prisma, boss);
    const result = await importService.importCsv(csv, company.id);

    expect(result.failed).toBe(0);
    expect(result.updated).toBe(1);

    const workers = await prisma.worker.findMany();
    expect(workers).toHaveLength(1);
  });

  it("guards a worker name that looks like a spreadsheet formula, so it stays formula-injection-safe", async () => {
    const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
    const worker = await prisma.worker.create({
      data: { nationalId: ID_A, name: '=SUM(A1)', role: 'SUPERVISOR', status: 'ACTIVE', companyId: company.id },
    });
    await prisma.contract.create({
      data: {
        workerId: worker.id,
        hourlyCostIls: 62.5,
        minMonthlyHours: 120,
        maxMonthlyHours: 182,
      },
    });

    const csv = await exportService.exportCsv();
    expect(csv).toContain("'=SUM(A1)");

    const [row] = parseWorkersCsv(csv);
    if (!row) throw new Error('expected exactly one exported row');
    expect(toWorkerRecord(row).name).toBe('=SUM(A1)');
  });
});
