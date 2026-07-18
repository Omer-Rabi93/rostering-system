import { describe, expect, it } from 'vitest';
import type { MonthAvailability, Roster } from '@rostering/shared';

import type { ContractDto, WorkerDto } from '../../api/workers.api.js';
import { getIneligibilityReason } from './eligibility.js';

const AVAILABLE_ALL_SHIFTS: MonthAvailability = {
  '1': {
    '2026-08-03': ['A', 'B', 'C'],
  },
};

function makeWorker(overrides: Partial<WorkerDto> = {}): WorkerDto {
  return {
    id: 1,
    nationalId: '123456782',
    name: 'Dana Levi',
    role: 'GENERAL_GUARD',
    status: 'ACTIVE',
    companyId: 1,
    shareToken: 'tok',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    contract: null,
    ...overrides,
  };
}

function makeContract(overrides: Partial<ContractDto> = {}): ContractDto {
  return {
    workerId: 1,
    hourlyCostIls: 50,
    minMonthlyHours: 100,
    maxMonthlyHours: 186,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

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

describe('getIneligibilityReason', () => {
  it('returns null (eligible) for an active worker, available on that exact date/shift, with room in the day', () => {
    const worker = makeWorker();
    const contract = makeContract();
    const roster = makeRoster();

    expect(getIneligibilityReason(worker, contract, AVAILABLE_ALL_SHIFTS, roster, '2026-08-03', 'A')).toBeNull();
  });

  it('flags an inactive worker', () => {
    const worker = makeWorker({ status: 'INACTIVE' });
    const contract = makeContract();
    const roster = makeRoster();

    expect(getIneligibilityReason(worker, contract, AVAILABLE_ALL_SHIFTS, roster, '2026-08-03', 'A')).toBe(
      'Inactive',
    );
  });

  it('flags a worker with no contract on file', () => {
    const worker = makeWorker();
    const roster = makeRoster();

    expect(getIneligibilityReason(worker, null, AVAILABLE_ALL_SHIFTS, roster, '2026-08-03', 'A')).toBe(
      'No contract on file',
    );
  });

  it('flags a worker with no availability row at all for the month (undefined monthAvailability)', () => {
    const worker = makeWorker();
    const contract = makeContract();
    const roster = makeRoster();

    expect(getIneligibilityReason(worker, contract, undefined, roster, '2026-08-03', 'A')).toBe(
      'Unavailable this shift',
    );
  });

  it('flags a worker who has other dates in the month but no entry for this exact date', () => {
    const worker = makeWorker();
    const contract = makeContract();
    const roster = makeRoster();
    const monthAvailability: MonthAvailability = { '1': { '2026-08-04': ['A', 'B', 'C'] } };

    expect(getIneligibilityReason(worker, contract, monthAvailability, roster, '2026-08-03', 'A')).toBe(
      'Unavailable this shift',
    );
  });

  it('flags a worker whose subset for this exact date excludes the requested shift', () => {
    const worker = makeWorker();
    const contract = makeContract();
    const roster = makeRoster();
    const monthAvailability: MonthAvailability = { '1': { '2026-08-03': ['B', 'C'] } };

    expect(getIneligibilityReason(worker, contract, monthAvailability, roster, '2026-08-03', 'A')).toBe(
      'Unavailable this shift',
    );
  });

  it('does not flag a worker whose subset for this exact date includes the requested shift', () => {
    const worker = makeWorker();
    const contract = makeContract();
    const roster = makeRoster();
    const monthAvailability: MonthAvailability = { '1': { '2026-08-03': ['A'] } };

    expect(getIneligibilityReason(worker, contract, monthAvailability, roster, '2026-08-03', 'A')).toBeNull();
  });

  it('flags a worker already assigned to this exact slot', () => {
    const worker = makeWorker();
    const contract = makeContract();
    const roster = makeRoster({
      shifts: [
        {
          id: 10,
          date: '2026-08-03',
          shiftType: 'A',
          assignments: [{ workerId: 1, name: 'Dana Levi', role: 'GENERAL_GUARD' }],
        },
      ],
    });

    expect(getIneligibilityReason(worker, contract, AVAILABLE_ALL_SHIFTS, roster, '2026-08-03', 'A')).toBe(
      'Already assigned to this shift',
    );
  });

  it('flags a worker who already has 2 shifts that calendar day', () => {
    const worker = makeWorker();
    const contract = makeContract();
    const roster = makeRoster({
      shifts: [
        {
          id: 10,
          date: '2026-08-03',
          shiftType: 'A',
          assignments: [{ workerId: 1, name: 'Dana Levi', role: 'GENERAL_GUARD' }],
        },
        {
          id: 11,
          date: '2026-08-03',
          shiftType: 'B',
          assignments: [{ workerId: 1, name: 'Dana Levi', role: 'GENERAL_GUARD' }],
        },
      ],
    });

    // Trying to add to Shift C of the same day, the 3rd shift.
    expect(getIneligibilityReason(worker, contract, AVAILABLE_ALL_SHIFTS, roster, '2026-08-03', 'C')).toBe(
      'Already 2 shifts today',
    );
  });

  it('does not flag a worker with 1 shift that day when adding a 2nd', () => {
    const worker = makeWorker();
    const contract = makeContract();
    const roster = makeRoster({
      shifts: [
        {
          id: 10,
          date: '2026-08-03',
          shiftType: 'A',
          assignments: [{ workerId: 1, name: 'Dana Levi', role: 'GENERAL_GUARD' }],
        },
      ],
    });

    expect(getIneligibilityReason(worker, contract, AVAILABLE_ALL_SHIFTS, roster, '2026-08-03', 'B')).toBeNull();
  });
});
