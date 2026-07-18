import { describe, expect, it } from 'vitest';
import type { MonthAvailability } from '@rostering/shared';

import {
  cellShifts,
  clearWorkerRow,
  draftFromMonthAvailability,
  draftToPayload,
  setAllDatesForWorker,
  toggleCell,
} from './availabilityDraft.js';

describe('draftFromMonthAvailability', () => {
  it('returns an empty draft for undefined server data', () => {
    expect(draftFromMonthAvailability(undefined)).toEqual({});
  });

  it('copies the server payload as the starting draft', () => {
    const data: MonthAvailability = { '1': { '2026-08-03': ['A', 'B'] } };
    expect(draftFromMonthAvailability(data)).toEqual(data);
  });
});

describe('cellShifts', () => {
  it('returns an empty array (not undefined) for a worker/date with no entry — absence = unavailable', () => {
    const draft = draftFromMonthAvailability({ '1': { '2026-08-03': ['A'] } });
    expect(cellShifts(draft, 1, '2026-08-04')).toEqual([]);
    expect(cellShifts(draft, 2, '2026-08-03')).toEqual([]);
  });

  it('returns the stored subset for a worker/date that has one', () => {
    const draft = draftFromMonthAvailability({ '1': { '2026-08-03': ['A', 'C'] } });
    expect(cellShifts(draft, 1, '2026-08-03')).toEqual(['A', 'C']);
  });
});

describe('toggleCell', () => {
  it('adds a shift to an empty cell in canonical order', () => {
    const draft = draftFromMonthAvailability(undefined);
    const next = toggleCell(draft, 1, '2026-08-03', 'B');
    expect(cellShifts(next, 1, '2026-08-03')).toEqual(['B']);
  });

  it('inserts a shift into an existing subset in canonical A<B<C order regardless of toggle order', () => {
    let draft = draftFromMonthAvailability(undefined);
    draft = toggleCell(draft, 1, '2026-08-03', 'C');
    draft = toggleCell(draft, 1, '2026-08-03', 'A');
    expect(cellShifts(draft, 1, '2026-08-03')).toEqual(['A', 'C']);
  });

  it('removes a shift already present, leaving the rest', () => {
    const draft = draftFromMonthAvailability({ '1': { '2026-08-03': ['A', 'B', 'C'] } });
    const next = toggleCell(draft, 1, '2026-08-03', 'B');
    expect(cellShifts(next, 1, '2026-08-03')).toEqual(['A', 'C']);
  });

  it('removing the last shift in a cell drops just that date entry (sparse, not an empty array), keeping the worker\'s other dates', () => {
    const draft = draftFromMonthAvailability({ '1': { '2026-08-03': ['A'], '2026-08-04': ['B'] } });
    const next = toggleCell(draft, 1, '2026-08-03', 'A');
    expect(Object.keys(next['1'] ?? {})).toEqual(['2026-08-04']);
    expect(cellShifts(next, 1, '2026-08-03')).toEqual([]);
    expect(cellShifts(next, 1, '2026-08-04')).toEqual(['B']);
  });

  it('removing the only date for a worker drops the worker entry entirely', () => {
    const draft = draftFromMonthAvailability({ '1': { '2026-08-03': ['A'] } });
    const next = toggleCell(draft, 1, '2026-08-03', 'A');
    expect(Object.keys(next)).not.toContain('1');
  });

  it('does not mutate the original draft (immutable update)', () => {
    const original = draftFromMonthAvailability({ '1': { '2026-08-03': ['A'] } });
    toggleCell(original, 1, '2026-08-03', 'B');
    expect(cellShifts(original, 1, '2026-08-03')).toEqual(['A']);
  });

  it('leaves other workers and other dates untouched', () => {
    const draft = draftFromMonthAvailability({
      '1': { '2026-08-03': ['A'] },
      '2': { '2026-08-03': ['B'] },
    });
    const next = toggleCell(draft, 1, '2026-08-04', 'C');
    expect(cellShifts(next, 1, '2026-08-03')).toEqual(['A']);
    expect(cellShifts(next, 2, '2026-08-03')).toEqual(['B']);
    expect(cellShifts(next, 1, '2026-08-04')).toEqual(['C']);
  });
});

describe('setAllDatesForWorker', () => {
  it('sets the given shifts on every listed date for the worker, in canonical order', () => {
    const draft = draftFromMonthAvailability(undefined);
    const next = setAllDatesForWorker(draft, 1, ['2026-08-01', '2026-08-02'], ['C', 'A']);
    expect(cellShifts(next, 1, '2026-08-01')).toEqual(['A', 'C']);
    expect(cellShifts(next, 1, '2026-08-02')).toEqual(['A', 'C']);
  });

  it('overwrites any prior entries for that worker, including dates not in the new list', () => {
    const draft = draftFromMonthAvailability({ '1': { '2026-08-09': ['B'] } });
    const next = setAllDatesForWorker(draft, 1, ['2026-08-01'], ['A']);
    expect(cellShifts(next, 1, '2026-08-09')).toEqual([]);
    expect(cellShifts(next, 1, '2026-08-01')).toEqual(['A']);
  });

  it('an empty shifts array clears the worker entirely, same as clearWorkerRow', () => {
    const draft = draftFromMonthAvailability({ '1': { '2026-08-01': ['A'] } });
    const next = setAllDatesForWorker(draft, 1, ['2026-08-01', '2026-08-02'], []);
    expect(Object.keys(next)).not.toContain('1');
  });
});

describe('clearWorkerRow', () => {
  it('removes the worker entirely, leaving other workers untouched', () => {
    const draft = draftFromMonthAvailability({
      '1': { '2026-08-01': ['A'] },
      '2': { '2026-08-01': ['B'] },
    });
    const next = clearWorkerRow(draft, 1);
    expect(Object.keys(next)).toEqual(['2']);
    expect(cellShifts(next, 2, '2026-08-01')).toEqual(['B']);
  });

  it('is a no-op (same shape) for a worker with no existing entry', () => {
    const draft = draftFromMonthAvailability({ '2': { '2026-08-01': ['B'] } });
    const next = clearWorkerRow(draft, 1);
    expect(next).toEqual(draft);
  });
});

describe('draftToPayload', () => {
  it('produces the sparse MonthAvailability payload — no empty-array or empty-object entries', () => {
    let draft = draftFromMonthAvailability(undefined);
    draft = toggleCell(draft, 1, '2026-08-03', 'A');
    draft = toggleCell(draft, 1, '2026-08-04', 'B');
    draft = toggleCell(draft, 1, '2026-08-04', 'B'); // toggled back off -> should vanish from payload

    const payload = draftToPayload(draft);
    expect(payload).toEqual({ '1': { '2026-08-03': ['A'] } });
    expect(Object.prototype.hasOwnProperty.call(payload['1'] ?? {}, '2026-08-04')).toBe(false);
  });

  it('produces an empty object for an all-cleared draft', () => {
    expect(draftToPayload({})).toEqual({});
  });
});
