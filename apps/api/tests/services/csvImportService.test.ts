import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidIsraeliId } from '@rostering/shared';

import { CsvImportService } from '../../src/services/csvImportService.js';
import { CSV_COLUMNS } from '../../src/csv/index.js';
import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';

function validNationalId(prefix: number): string {
  const base = String(prefix).padStart(8, '0');
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${base}${checkDigit}`;
    if (isValidIsraeliId(candidate)) return candidate;
  }
  throw new Error('no valid check digit found');
}

const ID_A = validNationalId(201);
const ID_B = validNationalId(202);
const ID_C = validNationalId(203);

const HEADER = CSV_COLUMNS.join(',');

/** Builds one CSV data row from field overrides, defaulting to a Supervisor. */
function csvRow(overrides: Partial<Record<(typeof CSV_COLUMNS)[number], string>> = {}): string {
  const defaults: Record<(typeof CSV_COLUMNS)[number], string> = {
    national_id: ID_A,
    name: 'Dana Levi',
    company_name: 'Shamir Security Ltd',
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

describe('CsvImportService.importCsv', () => {
  const prisma = getTestPrismaClient();
  const importService = new CsvImportService(prisma);

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  it('inserts a new worker + contract, resolving/creating the company by name', async () => {
    const result = await importService.importCsv(csvFile([csvRow({ national_id: ID_A })]));

    expect(result.totalRows).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);

    const worker = await prisma.worker.findUnique({ where: { nationalId: ID_A }, include: { contract: true } });
    expect(worker).not.toBeNull();
    expect(worker?.name).toBe('Dana Levi');
    expect(worker?.role).toBe('SUPERVISOR');
    expect(worker?.status).toBe('ACTIVE');
    expect(Number(worker?.contract?.hourlyCostIls)).toBe(62.5);

    const company = await prisma.company.findFirst({ where: { name: 'Shamir Security Ltd' } });
    expect(company).not.toBeNull();
    expect(worker?.companyId).toBe(company?.id);
  });

  it('updates an existing worker matched by national_id instead of duplicating it', async () => {
    const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
    const existing = await prisma.worker.create({
      data: { nationalId: ID_A, name: 'Old Name', role: 'GENERAL_GUARD', status: 'ACTIVE', companyId: company.id },
    });

    const result = await importService.importCsv(
      csvFile([csvRow({ national_id: ID_A, name: 'Updated Name', role: 'Supervisor' })]),
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

  it('resolves the company case-insensitively rather than creating a second one', async () => {
    await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });

    await importService.importCsv(
      csvFile([csvRow({ national_id: ID_A, company_name: 'SHAMIR security ltd' })]),
    );

    const companies = await prisma.company.findMany();
    expect(companies).toHaveLength(1);
  });

  it('reports a bad row without aborting the rest of the batch', async () => {
    const result = await importService.importCsv(
      csvFile([
        csvRow({ national_id: ID_A, hourly_cost_ils: 'not-a-number' }),
        csvRow({ national_id: ID_B }),
      ]),
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
    // A known-bad checksum (same fixture used by tests/routes/workers.test.ts).
    const result = await importService.importCsv(csvFile([csvRow({ national_id: '123456789' })]));

    expect(result.failed).toBe(1);
    const [firstError] = result.errors;
    if (!firstError) throw new Error('expected one error entry');
    expect(firstError.row).toBe(1);
    const worker = await prisma.worker.findUnique({ where: { nationalId: '123456789' } });
    expect(worker).toBeNull();
  });

  describe('sync sweep (deactivation semantics)', () => {
    it('deactivates an existing ACTIVE worker whose national_id is absent from the imported file', async () => {
      const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
      const absentWorker = await prisma.worker.create({
        data: { nationalId: ID_C, name: 'Absent Worker', role: 'GENERAL_GUARD', status: 'ACTIVE', companyId: company.id },
      });

      const result = await importService.importCsv(csvFile([csvRow({ national_id: ID_A })]));

      expect(result.deactivated).toBe(1);
      expect(result.deactivatedWorkers).toEqual([
        { workerId: absentWorker.id, nationalId: ID_C, name: 'Absent Worker' },
      ]);

      const reloaded = await prisma.worker.findUnique({ where: { id: absentWorker.id } });
      expect(reloaded?.status).toBe('INACTIVE');
    });

    it('does NOT deactivate a worker whose row is present but fails validation', async () => {
      const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
      const worker = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Present But Bad', role: 'GENERAL_GUARD', status: 'ACTIVE', companyId: company.id },
      });

      const result = await importService.importCsv(
        csvFile([csvRow({ national_id: ID_A, hourly_cost_ils: 'garbage' })]),
      );

      expect(result.failed).toBe(1);
      expect(result.deactivated).toBe(0);

      const reloaded = await prisma.worker.findUnique({ where: { id: worker.id } });
      expect(reloaded?.status).toBe('ACTIVE');
    });

    it('leaves an already-inactive worker unchanged on a re-run (idempotent)', async () => {
      const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
      const inactiveWorker = await prisma.worker.create({
        data: { nationalId: ID_C, name: 'Already Inactive', role: 'GENERAL_GUARD', status: 'INACTIVE', companyId: company.id },
      });

      const first = await importService.importCsv(csvFile([csvRow({ national_id: ID_A })]));
      expect(first.deactivated).toBe(0); // was already inactive, not newly deactivated

      const second = await importService.importCsv(csvFile([csvRow({ national_id: ID_A })]));
      expect(second.deactivated).toBe(0);
      expect(second.deactivatedWorkers).toEqual([]);

      const reloaded = await prisma.worker.findUnique({ where: { id: inactiveWorker.id } });
      expect(reloaded?.status).toBe('INACTIVE');
    });

    it('never deletes a deactivated worker -- contract and shift history survive', async () => {
      const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
      const worker = await prisma.worker.create({
        data: { nationalId: ID_C, name: 'Keep Me', role: 'GENERAL_GUARD', status: 'ACTIVE', companyId: company.id },
      });
      await prisma.contract.create({
        data: {
          workerId: worker.id,
          hourlyCostIls: 50,
          minMonthlyHours: 100,
          maxMonthlyHours: 180,
        },
      });

      await importService.importCsv(csvFile([csvRow({ national_id: ID_A })]));

      const reloaded = await prisma.worker.findUnique({ where: { id: worker.id }, include: { contract: true } });
      expect(reloaded).not.toBeNull();
      expect(reloaded?.status).toBe('INACTIVE');
      expect(reloaded?.contract).not.toBeNull();
    });
  });
});
