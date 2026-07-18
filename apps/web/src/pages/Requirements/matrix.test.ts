import { describe, expect, it } from 'vitest';

import {
  CELLS,
  buildMatrixState,
  cellKey,
  mapBadRequestErrors,
  setCell,
  validateMatrix,
} from './matrix.js';

describe('CELLS', () => {
  it('is 9 cells, 3 roles x 3 shifts, in a fixed order', () => {
    expect(CELLS).toHaveLength(9);
    expect(CELLS[0]).toEqual({ role: 'GENERAL_GUARD', shift: 'A' });
    expect(CELLS[8]).toEqual({ role: 'SCREENER', shift: 'C' });
  });
});

describe('buildMatrixState', () => {
  it('defaults every cell to "0" when there are no rows yet', () => {
    const state = buildMatrixState([]);
    expect(Object.keys(state)).toHaveLength(9);
    expect(state[cellKey('SUPERVISOR', 'B')]).toBe('0');
  });

  it('fills in known rows and defaults the rest', () => {
    const state = buildMatrixState([
      { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 2 },
      { role: 'SUPERVISOR', shift: 'B', requiredCount: 1 },
    ]);
    expect(state[cellKey('GENERAL_GUARD', 'A')]).toBe('2');
    expect(state[cellKey('SUPERVISOR', 'B')]).toBe('1');
    expect(state[cellKey('SCREENER', 'C')]).toBe('0');
  });
});

describe('setCell', () => {
  it('immutably updates exactly the targeted cell', () => {
    const start = buildMatrixState([]);
    const next = setCell(start, 'SCREENER', 'C', '3');
    expect(next[cellKey('SCREENER', 'C')]).toBe('3');
    expect(start[cellKey('SCREENER', 'C')]).toBe('0');
  });
});

describe('validateMatrix', () => {
  it('returns rows in CELLS order when every cell is a valid non-negative integer', () => {
    const matrix = buildMatrixState([{ role: 'GENERAL_GUARD', shift: 'A', requiredCount: 2 }]);
    const result = validateMatrix(matrix);
    expect(result.cellErrors).toEqual({});
    expect(result.rows).toHaveLength(9);
    expect(result.rows?.[0]).toEqual({ role: 'GENERAL_GUARD', shift: 'A', requiredCount: 2 });
  });

  it('flags a negative cell and omits rows entirely (no partial submission)', () => {
    const matrix = setCell(buildMatrixState([]), 'SUPERVISOR', 'A', '-1');
    const result = validateMatrix(matrix);
    expect(result.rows).toBeUndefined();
    expect(result.cellErrors[cellKey('SUPERVISOR', 'A')]).toBe("Headcount can't be negative.");
  });

  it('flags a non-integer cell', () => {
    const matrix = setCell(buildMatrixState([]), 'SCREENER', 'B', '1.5');
    const result = validateMatrix(matrix);
    expect(result.cellErrors[cellKey('SCREENER', 'B')]).toBe('Enter a whole number.');
  });

  it('flags an empty cell', () => {
    const matrix = setCell(buildMatrixState([]), 'SCREENER', 'B', '');
    const result = validateMatrix(matrix);
    expect(result.cellErrors[cellKey('SCREENER', 'B')]).toBe('Enter a whole number.');
  });
});

describe('mapBadRequestErrors', () => {
  it('maps an indexed path back to the corresponding cell', () => {
    // CELLS[2] = { role: 'GENERAL_GUARD', shift: 'C' }
    const result = mapBadRequestErrors([{ path: '2.requiredCount', message: 'Number must be >= 0' }]);
    expect(result.cellErrors[cellKey('GENERAL_GUARD', 'C')]).toBe('Number must be >= 0');
    expect(result.generalErrors).toEqual([]);
  });

  it('puts a path-less error (e.g. the duplicate-cell refine) into generalErrors', () => {
    const result = mapBadRequestErrors([{ path: '', message: 'Duplicate role+shift cell' }]);
    expect(result.generalErrors).toEqual(['Duplicate role+shift cell']);
    expect(result.cellErrors).toEqual({});
  });

  it('handles multiple errors across cells and general', () => {
    const result = mapBadRequestErrors([
      { path: '0.requiredCount', message: 'bad 0' },
      { path: '8.requiredCount', message: 'bad 8' },
      { path: '', message: 'dup' },
    ]);
    expect(result.cellErrors[cellKey('GENERAL_GUARD', 'A')]).toBe('bad 0');
    expect(result.cellErrors[cellKey('SCREENER', 'C')]).toBe('bad 8');
    expect(result.generalErrors).toEqual(['dup']);
  });
});
