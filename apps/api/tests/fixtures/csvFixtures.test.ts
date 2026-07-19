// Proves the `tests/fixtures/csv/*.csv` + `*.expected.json` pairs actually mean what their
// `.expected.json` claims, by loading a representative subset through the REAL
// `WorkforceImportService` (and, for the two file-level-error/route-only fixtures,
// `parseWorkforceCsv`/the real HTTP route). Not every fixture is exercised here -- the fixtures
// directory is a shared resource also meant for the `loadtest/` scripts and manual QA (see the v4
// design doc, Part C) -- but enough are covered to prove the fixture+expectation pairing is
// trustworthy, not just plausible-looking JSON nobody ever ran. All fixtures now use the combined
// workforce-CSV shape (7 worker columns + that month's `dNN` columns, month 2027-02 throughout) --
// see the Part G design doc for why the two prior CSV pipelines merged into one.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';
import type { Express } from 'express';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WorkforceCsvHeaderError, WorkforceCsvRowShapeError, parseWorkforceCsv } from '../../src/csv/index.js';
import { createBoss, ensureQueues, QUEUES } from '../../src/jobs/queue.js';
import { WorkforceImportService } from '../../src/services/workforceImportService.js';
import { buildTestApp } from '../helpers/testApp.js';
import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(here, 'csv');
const MONTH = '2027-02';

function loadFixture(name: string): { csv: string; expected: any } {
  const csv = readFileSync(path.join(FIXTURES_DIR, `${name}.csv`), 'utf8');
  const expected = JSON.parse(readFileSync(path.join(FIXTURES_DIR, `${name}.expected.json`), 'utf8'));
  return { csv, expected };
}

describe('CSV fixtures (apps/api/tests/fixtures/csv/)', () => {
  const prisma = getTestPrismaClient();
  let boss: PgBoss;
  let importService: WorkforceImportService;
  let app: Express;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set for the csvFixtures test suite');
    boss = createBoss(databaseUrl);
    await boss.start();
    await ensureQueues(boss);
    importService = new WorkforceImportService(prisma, boss);
    app = buildTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    // No worker process consumes jobs during this test run, and `resetDatabase` restarts every
    // identity sequence (companyId included) -- so a `workforce-import` job a PREVIOUS run left
    // sitting `created` (never picked up) can collide, via its `singletonKey` (`<companyId>:
    // WORKFORCE_SYNC`), with a fresh company that happens to reuse the same id this run. Mirrors
    // `tests/routes/workforce.test.ts`'s identical convention.
    await boss.deleteQueuedJobs(QUEUES.WORKFORCE_IMPORT);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
    await boss.stop({ graceful: false, close: true });
  });

  async function makeCompany(name: string): Promise<number> {
    return (await prisma.company.create({ data: { name } })).id;
  }

  it('bad-checksum: per-row error on the nationalId field, worker not created', async () => {
    const { csv, expected } = loadFixture('bad-checksum');
    const company = await makeCompany('Fixture Co Bad Checksum');

    const result = await importService.importCsv(csv, MONTH, company);

    expect(result.totalRows).toBe(expected.expectImportResult.totalRows);
    expect(result.failed).toBe(expected.expectImportResult.failed);
    const [expectedRow] = expected.expectImportResult.failedRows;
    expect(result.errors[0]).toMatchObject({ row: expectedRow.row, field: expectedRow.field });
    expect(result.errors[0]?.message).toContain('checksum');
  });

  it('unknown-role: per-row CsvFieldError on the role field', async () => {
    const { csv, expected } = loadFixture('unknown-role');
    const company = await makeCompany('Fixture Co Unknown Role');

    const result = await importService.importCsv(csv, MONTH, company);

    expect(result.failed).toBe(expected.expectImportResult.failed);
    const [expectedRow] = expected.expectImportResult.failedRows;
    expect(result.errors[0]).toMatchObject({ row: expectedRow.row, field: expectedRow.field });
    expect(result.errors[0]?.message).toContain('Unknown role');
  });

  it('negative-hours: Zod nonnegative violation on minMonthlyHours', async () => {
    const { csv, expected } = loadFixture('negative-hours');
    const company = await makeCompany('Fixture Co Negative Hours');

    const result = await importService.importCsv(csv, MONTH, company);

    expect(result.failed).toBe(expected.expectImportResult.failed);
    const [expectedRow] = expected.expectImportResult.failedRows;
    expect(result.errors[0]).toMatchObject({ row: expectedRow.row, field: expectedRow.field });
    expect(result.errors[0]?.message).toContain('greater than or equal to 0');
  });

  it('wrong-column-count-too-few: file-level WorkforceCsvRowShapeError, never reaches importCsv', () => {
    const { csv, expected } = loadFixture('wrong-column-count-too-few');
    expect(expected.fileError.type).toBe('WorkforceCsvRowShapeError');

    expect(() => parseWorkforceCsv(csv, MONTH)).toThrow(WorkforceCsvRowShapeError);
    expect(() => parseWorkforceCsv(csv, MONTH)).toThrow(/has 34 fields, expected 35/);
  });

  it('empty-file: file-level WorkforceCsvHeaderError', () => {
    const { csv, expected } = loadFixture('empty-file');
    expect(expected.fileError.type).toBe('WorkforceCsvHeaderError');

    expect(() => parseWorkforceCsv(csv, MONTH)).toThrow(WorkforceCsvHeaderError);
    expect(() => parseWorkforceCsv(csv, MONTH)).toThrow(/empty/);
  });

  it('header-only: zero data rows, importCsv completes with an all-zero COMPLETED task', async () => {
    const { csv, expected } = loadFixture('header-only');
    const company = await makeCompany('Fixture Co Header Only');

    const result = await importService.importCsv(csv, MONTH, company);

    expect(result).toMatchObject({
      totalRows: expected.expectImportResult.totalRows,
      inserted: expected.expectImportResult.inserted,
      updated: expected.expectImportResult.updated,
      failed: expected.expectImportResult.failed,
    });
    expect(result.errors).toHaveLength(expected.expectImportResult.failedRows.length);
    const task = await prisma.importTask.findFirstOrThrow({ where: { companyId: company, kind: 'WORKFORCE_SYNC' } });
    expect(task.status).toBe('COMPLETED');
  });

  it('duplicate-national-id: documents last-row-wins, NOT a validation error', async () => {
    const { csv, expected } = loadFixture('duplicate-national-id');
    const company = await makeCompany('Fixture Co Duplicate Id');

    const result = await importService.importCsv(csv, MONTH, company);

    expect(result).toMatchObject({
      totalRows: expected.expectImportResult.totalRows,
      inserted: expected.expectImportResult.inserted,
      updated: expected.expectImportResult.updated,
      failed: expected.expectImportResult.failed,
    });
    const worker = await prisma.worker.findUniqueOrThrow({
      where: { nationalId: expected.expectFinalWorker.nationalId },
    });
    expect(worker.name).toBe(expected.expectFinalWorker.name);
    expect(worker.role).toBe(expected.expectFinalWorker.role);
    expect(worker.status).toBe(expected.expectFinalWorker.status);
  });

  it('cross-company-conflict: rejected as a per-row error, never reassigns the worker', async () => {
    const { csv, expected } = loadFixture('cross-company-conflict');
    const otherCompany = await makeCompany('Fixture Co Cross Company Owner');
    const thisCompany = await makeCompany('Fixture Co Cross Company Importer');
    const existing = await prisma.worker.create({
      data: {
        nationalId: expected.setup.nationalId,
        name: 'Original Owner',
        role: 'GENERAL_GUARD',
        status: 'ACTIVE',
        companyId: otherCompany,
      },
    });

    const result = await importService.importCsv(csv, MONTH, thisCompany);

    expect(result.failed).toBe(expected.expectImportResult.failed);
    const [expectedRow] = expected.expectImportResult.failedRows;
    expect(result.errors[0]).toMatchObject({ row: expectedRow.row, field: expectedRow.field });
    expect(result.errors[0]?.message).toContain('different company');

    const reloaded = await prisma.worker.findUniqueOrThrow({ where: { id: existing.id } });
    expect(reloaded.companyId).toBe(otherCompany); // untouched, never reassigned
    expect(reloaded.name).toBe('Original Owner');
  });

  it('availability-malformed-cell: per-row AvailabilityCsvCellError on the dNN field, worker not upserted either', async () => {
    const { csv, expected } = loadFixture('availability-malformed-cell');
    const company = await makeCompany('Fixture Co Malformed Cell');

    const result = await importService.importCsv(csv, expected.month, company);

    expect(result.failed).toBe(expected.expectImportResult.failed);
    const [expectedRow] = expected.expectImportResult.failedRows;
    expect(result.errors[0]).toMatchObject({ row: expectedRow.row, field: expectedRow.field });
    expect(result.errors[0]?.message).toContain('Illegal shift letter');
    expect(await prisma.worker.findMany({})).toHaveLength(0); // row atomicity: no worker created either
  });

  it('availability-wrong-month-header: file-level WorkforceCsvHeaderError', () => {
    const { csv, expected } = loadFixture('availability-wrong-month-header');
    expect(expected.fileError.type).toBe('WorkforceCsvHeaderError');

    expect(() => parseWorkforceCsv(csv, '2027-02')).toThrow(WorkforceCsvHeaderError);
    expect(() => parseWorkforceCsv(csv, '2027-02')).toThrow(/header for month 2027-02 must be exactly/);
  });

  it('max-rows: exactly the row cap is accepted by the real route (202)', async () => {
    const { csv, expected } = loadFixture('max-rows');
    const company = await makeCompany('Fixture Co Max Rows');

    const response = await request(app)
      .post(`/api/import/workforce/${MONTH}`)
      .field('companyId', String(company))
      .attach('file', Buffer.from(csv), { filename: 'max-rows.csv', contentType: 'text/csv' });

    expect(response.status).toBe(expected.expectRoute.status);
    expect(typeof response.body.jobId).toBe('string');
  }, 20_000);

  it('max-rows-plus-one: row cap + 1 is rejected by the real route (400), never enqueued', async () => {
    const { csv, expected } = loadFixture('max-rows-plus-one');
    const company = await makeCompany('Fixture Co Max Rows Plus One');

    const response = await request(app)
      .post(`/api/import/workforce/${MONTH}`)
      .field('companyId', String(company))
      .attach('file', Buffer.from(csv), { filename: 'max-rows-plus-one.csv', contentType: 'text/csv' });

    expect(response.status).toBe(expected.expectRoute.status);
    expect(response.body.errors?.[0]?.message ?? JSON.stringify(response.body)).toContain('exceeding the 15000-row limit');

    const task = await prisma.importTask.findFirst({ where: { companyId: company, kind: 'WORKFORCE_SYNC' } });
    expect(task).toBeNull(); // rejected before beginImportTask ever runs
  }, 20_000);
});
