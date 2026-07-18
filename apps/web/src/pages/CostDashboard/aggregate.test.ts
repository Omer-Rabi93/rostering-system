import { describe, expect, it } from 'vitest';
import type { CostSummary } from '@rostering/shared';

import type { WorkerDto } from '../../api/workers.api.js';
import { buildCompanyCostRows, buildWorkerCostRows, computeCostStats } from './aggregate.js';

function makeWorker(overrides: Partial<WorkerDto> = {}): WorkerDto {
  return {
    id: 1,
    nationalId: '123456782',
    name: 'Dana Levi',
    role: 'SUPERVISOR',
    status: 'ACTIVE',
    companyId: 1,
    shareToken: 'tok',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    contract: null,
    ...overrides,
  };
}

const SUMMARY: CostSummary = {
  totalIls: 1000,
  perCompany: [
    { companyId: 1, name: 'Shamir Security Ltd', costIls: 700 },
    { companyId: 2, name: 'Magen Guard Co.', costIls: 300 },
  ],
  perWorker: [
    { workerId: 1, shifts: 10, hours: 80, costIls: 700 },
    { workerId: 2, shifts: 5, hours: 40, costIls: 300 },
  ],
};

const WORKERS: WorkerDto[] = [
  makeWorker({ id: 1, name: 'Dana Levi', companyId: 1, role: 'SUPERVISOR' }),
  makeWorker({ id: 2, name: 'Omer Cohen', companyId: 2, role: 'GENERAL_GUARD' }),
];

describe('buildCompanyCostRows', () => {
  it('derives per-company workers/shifts/hours by joining perWorker against the worker list', () => {
    const rows = buildCompanyCostRows(SUMMARY, WORKERS);
    expect(rows).toEqual([
      { companyId: 1, companyName: 'Shamir Security Ltd', workers: 1, shifts: 10, hours: 80, costIls: 700 },
      { companyId: 2, companyName: 'Magen Guard Co.', workers: 1, shifts: 5, hours: 40, costIls: 300 },
    ]);
  });

  it('a company with no matching workers in perWorker gets all-zero derived figures, not dropped', () => {
    const summary: CostSummary = {
      totalIls: 0,
      perCompany: [{ companyId: 9, name: 'Harel Protective Services', costIls: 0 }],
      perWorker: [],
    };
    expect(buildCompanyCostRows(summary, WORKERS)).toEqual([
      { companyId: 9, companyName: 'Harel Protective Services', workers: 0, shifts: 0, hours: 0, costIls: 0 },
    ]);
  });
});

describe('buildWorkerCostRows', () => {
  it('joins name/company/role from the worker list onto each perWorker row', () => {
    const rows = buildWorkerCostRows(SUMMARY, WORKERS);
    expect(rows).toEqual([
      { workerId: 1, name: 'Dana Levi', companyName: 'Shamir Security Ltd', role: 'SUPERVISOR', shifts: 10, hours: 80, costIls: 700 },
      { workerId: 2, name: 'Omer Cohen', companyName: 'Magen Guard Co.', role: 'GENERAL_GUARD', shifts: 5, hours: 40, costIls: 300 },
    ]);
  });

  it('falls back to a placeholder name for a worker no longer in the (possibly filtered) worker list', () => {
    const [onlyWorker] = WORKERS;
    if (!onlyWorker) throw new Error('expected at least one fixture worker');
    const rows = buildWorkerCostRows(SUMMARY, [onlyWorker]);
    expect(rows[1]).toEqual({
      workerId: 2,
      name: 'Worker #2',
      companyName: '—',
      role: null,
      shifts: 5,
      hours: 40,
      costIls: 300,
    });
  });
});

describe('computeCostStats', () => {
  it('sums totals and computes averages', () => {
    expect(computeCostStats(SUMMARY)).toEqual({
      totalIls: 1000,
      totalShifts: 15,
      totalHours: 120,
      totalWorkers: 2,
      avgCostPerShift: 1000 / 15,
      avgCostPerWorker: 500,
    });
  });

  it('avoids division by zero when there are no workers/shifts yet', () => {
    const empty: CostSummary = { totalIls: 0, perCompany: [], perWorker: [] };
    expect(computeCostStats(empty)).toEqual({
      totalIls: 0,
      totalShifts: 0,
      totalHours: 0,
      totalWorkers: 0,
      avgCostPerShift: 0,
      avgCostPerWorker: 0,
    });
  });
});
