// CSV import business logic: parse + per-row validate + upsert-by-national_id + the "sync sweep"
// deactivation pass. Independent of pg-boss (testable by calling `importCsv` directly, as
// `tests/services/csvImportService.test.ts` does) -- the pg-boss job handler in
// `jobs/csvImport.job.ts` is a thin wrapper around this.
//
// Full-sync semantics (design doc): each row is validated in full; company_name is resolved to an
// existing company (case-insensitively) or a new one is created; then the worker+contract are
// upserted by national_id, ALL in one transaction per row, so a failing row rolls back only
// itself and the batch continues. After every row is processed, every existing ACTIVE worker whose
// national_id appears nowhere in the file is set INACTIVE (status update only -- never deleted; a
// worker whose row is present but failed validation is NOT deactivated, since the raw
// `national_id` cell shields it from the sweep regardless of whether the rest of the row validated).

import { contractSchema, workerSchema, type ImportResult } from '@rostering/shared';
import { ZodError } from 'zod';

import type { PrismaClient } from '../db/client.js';
import { CsvFieldError, parseWorkersCsv, toWorkerRecord } from '../csv/index.js';
import { CompanyService } from './companyService.js';

type ImportRowError = ImportResult['errors'][number];

function toRowError(row: number, nationalId: string | undefined, err: unknown): ImportRowError {
  if (err instanceof CsvFieldError) {
    return { row, nationalId, field: err.field, message: err.message };
  }
  if (err instanceof ZodError) {
    const [issue] = err.issues;
    return {
      row,
      nationalId,
      field: issue ? issue.path.join('.') || undefined : undefined,
      message: issue ? issue.message : 'Validation failed',
    };
  }
  return { row, nationalId, message: err instanceof Error ? err.message : String(err) };
}

/**
 * Worker + Contract CSV bulk import, `PrismaClient` constructor-injected. No pg-boss, no Express
 * -- plain input (CSV text) in, `ImportResult` out.
 */
export class CsvImportService {
  private readonly companyService: CompanyService;

  constructor(private readonly prisma: PrismaClient) {
    this.companyService = new CompanyService(prisma);
  }

  async importCsv(csvText: string): Promise<ImportResult> {
    const rawRows = parseWorkersCsv(csvText);

    let inserted = 0;
    let updated = 0;
    let failed = 0;
    const errors: ImportRowError[] = [];
    const presentNationalIds = new Set<string>();

    for (const [i, raw] of rawRows.entries()) {
      const rowNum = i + 1;
      // Shields this national_id from the sync sweep regardless of whether the rest of the row
      // validates -- "present but invalid" must never be deactivated.
      presentNationalIds.add(raw.national_id);

      try {
        const outcome = await this.prisma.$transaction(async (tx) => {
          const record = toWorkerRecord(raw);

          const company = await this.companyService.resolveOrCreate(record.companyName, tx);
          const workerInput = workerSchema.parse({
            nationalId: record.nationalId,
            name: record.name,
            role: record.role,
            status: record.status,
            companyId: company.id,
          });
          // Availability v2: the worker CSV carries no availability data at all (moved to the
          // date-specific `WorkerAvailability` table, populated via the separate month-scoped
          // availability CSV/import path -- see `csv/availability.ts`, `availabilityService.ts`).
          const contractInput = contractSchema.parse({
            hourlyCostIls: record.hourlyCostIls,
            minMonthlyHours: record.minMonthlyHours,
            maxMonthlyHours: record.maxMonthlyHours,
          });
          const contractColumns = {
            hourlyCostIls: contractInput.hourlyCostIls,
            minMonthlyHours: contractInput.minMonthlyHours,
            maxMonthlyHours: contractInput.maxMonthlyHours,
          };

          const existing = await tx.worker.findUnique({ where: { nationalId: workerInput.nationalId } });
          if (existing) {
            await tx.worker.update({
              where: { id: existing.id },
              data: {
                name: workerInput.name,
                role: workerInput.role,
                status: workerInput.status,
                companyId: workerInput.companyId,
              },
            });
            await tx.contract.upsert({
              where: { workerId: existing.id },
              create: { workerId: existing.id, ...contractColumns },
              update: { ...contractColumns },
            });
            return 'updated' as const;
          }

          const created = await tx.worker.create({
            data: {
              nationalId: workerInput.nationalId,
              name: workerInput.name,
              role: workerInput.role,
              status: workerInput.status,
              companyId: workerInput.companyId,
            },
          });
          await tx.contract.create({
            data: { workerId: created.id, ...contractColumns },
          });
          return 'inserted' as const;
        });

        if (outcome === 'inserted') inserted++;
        else updated++;
      } catch (err) {
        failed++;
        errors.push(toRowError(rowNum, raw.national_id, err));
      }
    }

    const toDeactivate = await this.prisma.worker.findMany({
      where: { status: 'ACTIVE', nationalId: { notIn: Array.from(presentNationalIds) } },
      orderBy: { id: 'asc' },
    });
    if (toDeactivate.length > 0) {
      await this.prisma.worker.updateMany({
        where: { id: { in: toDeactivate.map((w) => w.id) } },
        data: { status: 'INACTIVE' },
      });
    }

    return {
      totalRows: rawRows.length,
      inserted,
      updated,
      failed,
      deactivated: toDeactivate.length,
      deactivatedWorkers: toDeactivate.map((w) => ({ workerId: w.id, nationalId: w.nationalId, name: w.name })),
      errors,
    };
  }
}
