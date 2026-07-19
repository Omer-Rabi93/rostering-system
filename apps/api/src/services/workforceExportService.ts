// Builds the combined workforce-CSV export payload for one company + one target month: every
// ACTIVE-or-INACTIVE worker in that company who has a contract, with that contract's fields plus
// their `WorkerAvailability` excluded-shifts for every day of `month` -- via the same shared
// `csv/workforce.ts` module import uses, so export and import always agree on column order,
// display mapping, and the formula-injection guard. Supersedes `CsvExportService` (worker-only,
// notably NOT company-scoped -- a latent inconsistency with every other v4 surface, fixed here as
// a natural side effect of requiring `companyId`) and `AvailabilityService.exportCsv`
// (availability-only) -- see the Part G design doc.

import type { Month } from '@rostering/shared';

import { monthDays } from '../engine/calendar.js';
import type { PrismaClient } from '../db/client.js';
import { serializeWorkforceCsv, type WorkforceCsvExportRow } from '../csv/index.js';
import { formatDate } from './alertRecompute.js';

function monthDateRange(month: string): { readonly start: Date; readonly end: Date } {
  const days = monthDays(month);
  const [first] = days;
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error(`Month ${month} produced no calendar days`);
  }
  return { start: new Date(`${first}T00:00:00.000Z`), end: new Date(`${last}T00:00:00.000Z`) };
}

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
    const rows: WorkforceCsvExportRow[] = workers
      .filter((w) => w.contract !== null)
      .map((w) => ({
        record: {
          nationalId: w.nationalId,
          name: w.name,
          role: w.role,
          status: w.status,
          hourlyCostIls: Number(w.contract?.hourlyCostIls),
          minMonthlyHours: w.contract?.minMonthlyHours ?? 0,
          maxMonthlyHours: w.contract?.maxMonthlyHours ?? 0,
        },
        entries: w.availability.map((row) => ({
          date: formatDate(row.date),
          shifts: row.excludedShifts.split('') as WorkforceCsvExportRow['entries'][number]['shifts'],
        })),
      }));

    return serializeWorkforceCsv(rows, month);
  }
}
