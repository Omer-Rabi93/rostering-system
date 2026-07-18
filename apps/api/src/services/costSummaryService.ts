import { SHIFT_HOURS, type CostSummary } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import { NotFoundError } from '../errors.js';

interface WorkerAccumulator {
  workerId: number;
  shifts: number;
  hours: number;
  costIls: number;
  companyId: number;
  companyName: string;
}

/**
 * Projected labor cost, computed at READ time — never stored — as `count × 8 × hourlyRate`,
 * grouped per worker and per company, so a total can never drift from the underlying assignments.
 */
export class CostSummaryService {
  constructor(private readonly prisma: PrismaClient) {}

  async getByMonth(companyId: number, month: string): Promise<CostSummary> {
    const roster = await this.prisma.roster.findUnique({ where: { companyId_month: { companyId, month } } });
    if (!roster) {
      throw new NotFoundError(`Roster for ${month} has not been generated yet`);
    }

    const shiftWorkers = await this.prisma.shiftWorker.findMany({
      where: { shift: { rosterId: roster.id } },
      include: { worker: { include: { contract: true, company: true } } },
    });

    const perWorker = new Map<number, WorkerAccumulator>();
    for (const sw of shiftWorkers) {
      const rate = sw.worker.contract ? Number(sw.worker.contract.hourlyCostIls) : 0;
      const cost = SHIFT_HOURS * rate;
      const existing = perWorker.get(sw.workerId) ?? {
        workerId: sw.workerId,
        shifts: 0,
        hours: 0,
        costIls: 0,
        companyId: sw.worker.companyId,
        companyName: sw.worker.company.name,
      };
      existing.shifts += 1;
      existing.hours += SHIFT_HOURS;
      existing.costIls += cost;
      perWorker.set(sw.workerId, existing);
    }

    const perCompany = new Map<number, { companyId: number; name: string; costIls: number }>();
    for (const w of perWorker.values()) {
      const existing = perCompany.get(w.companyId) ?? {
        companyId: w.companyId,
        name: w.companyName,
        costIls: 0,
      };
      existing.costIls += w.costIls;
      perCompany.set(w.companyId, existing);
    }

    const perWorkerRows = [...perWorker.values()]
      .map(({ workerId, shifts, hours, costIls }) => ({ workerId, shifts, hours, costIls }))
      .sort((a, b) => a.workerId - b.workerId);
    const perCompanyRows = [...perCompany.values()].sort((a, b) => a.companyId - b.companyId);
    const totalIls = perWorkerRows.reduce((sum, w) => sum + w.costIls, 0);

    return { totalIls, perCompany: perCompanyRows, perWorker: perWorkerRows };
  }
}
