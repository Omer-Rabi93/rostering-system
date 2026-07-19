// Builds the combined workforce-CSV export payload for one company + one target month: every
// ACTIVE-or-INACTIVE worker in that company who has a contract, with that contract's fields plus
// their `WorkerAvailability` excluded-shifts for every day of `month` -- via the same shared
// `csv/workforce.ts` module import uses, so export and import always agree on column order,
// display mapping, and the formula-injection guard. Supersedes `CsvExportService` (worker-only,
// notably NOT company-scoped -- a latent inconsistency with every other v4 surface, fixed here as
// a natural side effect of requiring `companyId`) and `AvailabilityService.exportCsv`
// (availability-only) -- see the Part G design doc.

import { shiftSubsetFromString, type Month } from '@rostering/shared';

import { formatDate, monthDateRange } from '../engine/calendar.js';
import type { PrismaClient } from '../db/client.js';
import { serializeWorkforceCsv, type WorkforceCsvRow } from '../csv/index.js';

export class WorkforceExportService {
  constructor(private readonly prisma: PrismaClient) {}

  async exportCsv(month: Month, companyId: number): Promise<string> {
    const { start, end } = monthDateRange(month);

    const workers = await this.prisma.worker.findMany({
      where: { companyId },
      include: {
        contract: true,
        availability: { where: { date: { gte: start, lte: end } }, orderBy: { date: 'asc' } },
      },
      orderBy: { id: 'asc' },
    });

    // A worker with no contract yet has no row to export -- every documented column beyond the
    // worker identity fields comes from the contract, so there is nothing meaningful to write.
    const rows: WorkforceCsvRow[] = workers.flatMap((w) => {
      const { contract } = w;
      if (contract === null) {
        return [];
      }
      return [
        {
          record: {
            nationalId: w.nationalId,
            name: w.name,
            role: w.role,
            status: w.status,
            hourlyCostIls: Number(contract.hourlyCostIls),
            minMonthlyHours: contract.minMonthlyHours,
            maxMonthlyHours: contract.maxMonthlyHours,
          },
          entries: w.availability.map((row) => ({
            date: formatDate(row.date),
            shifts: shiftSubsetFromString(row.excludedShifts),
          })),
        },
      ];
    });

    return serializeWorkforceCsv(rows, month);
  }
}
