import type { CostSummary } from '@rostering/shared';

import type { WorkerDto } from '../../api/workers.api.js';

export interface CompanyCostRow {
  readonly companyId: number;
  readonly companyName: string;
  readonly workers: number;
  readonly shifts: number;
  readonly hours: number;
  readonly costIls: number;
}

export interface WorkerCostRow {
  readonly workerId: number;
  readonly name: string;
  readonly companyName: string;
  readonly role: WorkerDto['role'] | null;
  readonly shifts: number;
  readonly hours: number;
  readonly costIls: number;
}

/**
 * `CostSummary.perCompany` (from `GET /api/rosters/:month/cost-summary`) only carries
 * `{companyId, name, costIls}` — no per-company worker/shift/hour breakdown, since that isn't
 * something the cost-summary endpoint itself computes (only total cost per company). The
 * Cost Dashboard mockup's "Workers / Shifts / Hours" columns are derived here instead, client
 * side, by joining `perWorker` (which DOES carry shifts/hours per worker) against the worker
 * list's `companyId` — no new backend endpoint needed for Phase 9 to match the design.
 */
export function buildCompanyCostRows(summary: CostSummary, workers: readonly WorkerDto[]): CompanyCostRow[] {
  const companyIdByWorkerId = new Map(workers.map((w) => [w.id, w.companyId]));

  return summary.perCompany.map((company) => {
    const workersInCompany = summary.perWorker.filter(
      (w) => companyIdByWorkerId.get(w.workerId) === company.companyId,
    );
    return {
      companyId: company.companyId,
      companyName: company.name,
      workers: workersInCompany.length,
      shifts: workersInCompany.reduce((sum, w) => sum + w.shifts, 0),
      hours: workersInCompany.reduce((sum, w) => sum + w.hours, 0),
      costIls: company.costIls,
    };
  });
}

/** Joins `perWorker` (shifts/hours/cost, keyed only by `workerId`) against the worker list for
 * display fields (name/company/role) the cost-summary endpoint itself doesn't carry. A worker
 * present in `perWorker` but no longer in the (possibly filtered) worker list falls back to a
 * placeholder name rather than being silently dropped from the report. */
export function buildWorkerCostRows(summary: CostSummary, workers: readonly WorkerDto[]): WorkerCostRow[] {
  const workerById = new Map(workers.map((w) => [w.id, w]));
  const companyNameById = new Map(summary.perCompany.map((c) => [c.companyId, c.name]));

  return summary.perWorker.map((row) => {
    const worker = workerById.get(row.workerId);
    return {
      workerId: row.workerId,
      name: worker?.name ?? `Worker #${row.workerId}`,
      companyName: worker ? (companyNameById.get(worker.companyId) ?? '—') : '—',
      role: worker?.role ?? null,
      shifts: row.shifts,
      hours: row.hours,
      costIls: row.costIls,
    };
  });
}

export interface CostStats {
  readonly totalIls: number;
  readonly totalShifts: number;
  readonly totalHours: number;
  readonly totalWorkers: number;
  readonly avgCostPerShift: number;
  readonly avgCostPerWorker: number;
}

export function computeCostStats(summary: CostSummary): CostStats {
  const totalShifts = summary.perWorker.reduce((sum, w) => sum + w.shifts, 0);
  const totalHours = summary.perWorker.reduce((sum, w) => sum + w.hours, 0);
  const totalWorkers = summary.perWorker.length;
  return {
    totalIls: summary.totalIls,
    totalShifts,
    totalHours,
    totalWorkers,
    avgCostPerShift: totalShifts > 0 ? summary.totalIls / totalShifts : 0,
    avgCostPerWorker: totalWorkers > 0 ? summary.totalIls / totalWorkers : 0,
  };
}
