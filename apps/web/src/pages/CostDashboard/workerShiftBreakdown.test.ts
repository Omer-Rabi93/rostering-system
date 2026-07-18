import { describe, expect, it } from 'vitest';
import type { Roster } from '@rostering/shared';

import { buildWorkerComparisonRows, buildWorkerShiftRows, type WorkerShiftRow } from './workerShiftBreakdown.js';

function makeRoster(overrides: Partial<Roster> = {}): Roster {
  return {
    id: 1,
    month: '2026-08',
    status: 'DRAFT',
    generatedAt: '2026-08-01T00:00:00.000Z',
    publishedAt: null,
    shifts: [],
    alerts: [],
    ...overrides,
  };
}

const DANA = { workerId: 1, name: 'Dana Levi', role: 'SUPERVISOR' as const };
const OMER = { workerId: 2, name: 'Omer Cohen', role: 'GENERAL_GUARD' as const };

describe('buildWorkerShiftRows', () => {
  it('picks only the shifts the given worker is assigned to, with hours/cost from SHIFT_HOURS × hourlyRate', () => {
    const roster = makeRoster({
      shifts: [
        { id: 10, date: '2026-08-03', shiftType: 'A', assignments: [DANA] },
        { id: 11, date: '2026-08-05', shiftType: 'B', assignments: [OMER] },
        { id: 12, date: '2026-08-07', shiftType: 'C', assignments: [DANA, OMER] },
      ],
    });

    const rows = buildWorkerShiftRows(roster, 1, 65);
    expect(rows).toEqual([
      { shiftId: 10, date: '2026-08-03', shiftType: 'A', hours: 8, costIls: 520 },
      { shiftId: 12, date: '2026-08-07', shiftType: 'C', hours: 8, costIls: 520 },
    ]);
  });

  it('sorts the resulting rows by date ascending regardless of the roster shifts order', () => {
    const roster = makeRoster({
      shifts: [
        { id: 20, date: '2026-08-20', shiftType: 'A', assignments: [DANA] },
        { id: 21, date: '2026-08-01', shiftType: 'B', assignments: [DANA] },
        { id: 22, date: '2026-08-10', shiftType: 'C', assignments: [DANA] },
      ],
    });

    const rows = buildWorkerShiftRows(roster, 1, 45);
    expect(rows.map((r) => r.date)).toEqual(['2026-08-01', '2026-08-10', '2026-08-20']);
  });

  it('returns an empty array when the worker has no shifts this month', () => {
    const roster = makeRoster({
      shifts: [{ id: 30, date: '2026-08-03', shiftType: 'A', assignments: [OMER] }],
    });
    expect(buildWorkerShiftRows(roster, 1, 45)).toEqual([]);
  });

  it('a zero hourly rate (no contract on file) yields zero-cost rows, not an error', () => {
    const roster = makeRoster({
      shifts: [{ id: 40, date: '2026-08-03', shiftType: 'A', assignments: [DANA] }],
    });
    expect(buildWorkerShiftRows(roster, 1, 0)).toEqual([
      { shiftId: 40, date: '2026-08-03', shiftType: 'A', hours: 8, costIls: 0 },
    ]);
  });
});

describe('buildWorkerComparisonRows', () => {
  const DANA_ROWS: WorkerShiftRow[] = [
    { shiftId: 10, date: '2026-08-03', shiftType: 'A', hours: 8, costIls: 520 },
    { shiftId: 12, date: '2026-08-07', shiftType: 'C', hours: 8, costIls: 520 },
  ];
  const OMER_ROWS: WorkerShiftRow[] = [{ shiftId: 11, date: '2026-08-05', shiftType: 'B', hours: 8, costIls: 360 }];

  it('reduces each worker\'s shift rows to totals (shifts/hours/cost), sorted by cost descending', () => {
    const result = buildWorkerComparisonRows([
      { workerId: 2, name: 'Omer Cohen', companyName: 'Magen Guard Co.', role: 'GENERAL_GUARD', rows: OMER_ROWS },
      { workerId: 1, name: 'Dana Levi', companyName: 'Shamir Security Ltd', role: 'SUPERVISOR', rows: DANA_ROWS },
    ]);

    expect(result).toEqual([
      {
        workerId: 1,
        name: 'Dana Levi',
        companyName: 'Shamir Security Ltd',
        role: 'SUPERVISOR',
        totalShifts: 2,
        totalHours: 16,
        totalCostIls: 1040,
      },
      {
        workerId: 2,
        name: 'Omer Cohen',
        companyName: 'Magen Guard Co.',
        role: 'GENERAL_GUARD',
        totalShifts: 1,
        totalHours: 8,
        totalCostIls: 360,
      },
    ]);
  });

  it('a worker with zero shifts this month reduces to all-zero totals rather than being dropped', () => {
    const result = buildWorkerComparisonRows([
      { workerId: 3, name: 'Roi Ben-David', companyName: 'Shamir Security Ltd', role: 'SCREENER', rows: [] },
    ]);

    expect(result).toEqual([
      {
        workerId: 3,
        name: 'Roi Ben-David',
        companyName: 'Shamir Security Ltd',
        role: 'SCREENER',
        totalShifts: 0,
        totalHours: 0,
        totalCostIls: 0,
      },
    ]);
  });

  it('returns an empty array for an empty input list', () => {
    expect(buildWorkerComparisonRows([])).toEqual([]);
  });
});
