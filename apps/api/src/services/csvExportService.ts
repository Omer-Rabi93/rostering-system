// Builds the CSV export payload -- every worker (both statuses, so an unmodified re-import is a
// true full sync of the current workforce) with its contract, via the same shared `csv/` module
// import uses, so export and import always agree on column order, display mapping, and the
// formula-injection guard. Availability v2: this export carries no availability data at all (the
// worker CSV is now 8 columns of identity + contract fields only) -- see `csv/availability.ts` /
// `availabilityService.ts` for the separate date-specific, month-scoped availability CSV.

import type { PrismaClient } from '../db/client.js';
import { serializeWorkersCsv, type CsvWorkerRecord } from '../csv/index.js';

export class CsvExportService {
  constructor(private readonly prisma: PrismaClient) {}

  async exportCsv(): Promise<string> {
    const workers = await this.prisma.worker.findMany({
      include: { contract: true, company: true },
      orderBy: { id: 'asc' },
    });

    // A worker with no contract yet has no row to export -- every documented column beyond the
    // worker identity fields comes from the contract, so there is nothing meaningful to write.
    const records: CsvWorkerRecord[] = workers
      .filter((w) => w.contract !== null)
      .map((w) => {
        return {
          nationalId: w.nationalId,
          name: w.name,
          companyName: w.company.name,
          role: w.role,
          status: w.status,
          hourlyCostIls: Number(w.contract?.hourlyCostIls),
          minMonthlyHours: w.contract?.minMonthlyHours ?? 0,
          maxMonthlyHours: w.contract?.maxMonthlyHours ?? 0,
        };
      });

    return serializeWorkersCsv(records);
  }
}
