import { describe, expect, it } from 'vitest';
import type { Month } from '@rostering/shared';

import {
  AvailabilityCsvCellError,
  dateForDayColumn,
  dayColumns,
  parseShiftSubsetCell,
  shiftsToCell,
} from '../../src/csv/availability.js';

const FEB_2027 = '2027-02' as Month; // 28 days, non-leap
const FEB_2028 = '2028-02' as Month; // 29 days, leap
const APRIL_2027 = '2027-04' as Month; // 30 days
const JAN_2027 = '2027-01' as Month; // 31 days

describe('dayColumns', () => {
  it.each([
    [FEB_2027, 28],
    [FEB_2028, 29],
    [APRIL_2027, 30],
    [JAN_2027, 31],
  ])('produces exactly the day count of %s (%i days)', (month, dayCount) => {
    expect(dayColumns(month)).toHaveLength(dayCount);
    expect(dayColumns(month)[0]).toBe('d01');
    expect(dayColumns(month).at(-1)).toBe(`d${String(dayCount).padStart(2, '0')}`);
  });
});

describe('dateForDayColumn', () => {
  it('maps a dNN column back to its calendar date within the month', () => {
    expect(dateForDayColumn(FEB_2027, 'd01')).toBe('2027-02-01');
    expect(dateForDayColumn(FEB_2027, 'd28')).toBe('2027-02-28');
    expect(dateForDayColumn(JAN_2027, 'd31')).toBe('2027-01-31');
  });

  it('throws for a column that does not exist in the month (e.g. d29 in a 28-day February)', () => {
    expect(() => dateForDayColumn(FEB_2027, 'd29')).toThrow(/not a valid day column/);
  });
});

describe('parseShiftSubsetCell', () => {
  it('an empty cell means no exclusions (null, not an empty array)', () => {
    expect(parseShiftSubsetCell('', 'd01')).toBeNull();
  });

  it('parses a single-letter exclusion', () => {
    expect(parseShiftSubsetCell('A', 'd01')).toEqual(['A']);
  });

  it('parses a multi-letter exclusion in canonical order', () => {
    expect(parseShiftSubsetCell('BC', 'd01')).toEqual(['B', 'C']);
  });

  it('parses "ABC" as unavailable all day', () => {
    expect(parseShiftSubsetCell('ABC', 'd01')).toEqual(['A', 'B', 'C']);
  });

  it('throws AvailabilityCsvCellError (with the field name) for an illegal letter', () => {
    try {
      parseShiftSubsetCell('AD', 'd05');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AvailabilityCsvCellError);
      expect((err as AvailabilityCsvCellError).field).toBe('d05');
      expect((err as Error).message).toContain('Illegal shift letter');
    }
  });

  it('throws AvailabilityCsvCellError for a duplicate letter', () => {
    expect(() => parseShiftSubsetCell('AA', 'd01')).toThrow(AvailabilityCsvCellError);
  });

  it('throws AvailabilityCsvCellError for out-of-canonical-order letters', () => {
    expect(() => parseShiftSubsetCell('BA', 'd01')).toThrow(AvailabilityCsvCellError);
  });
});

describe('shiftsToCell', () => {
  it('joins shifts in the order given (already-canonical input)', () => {
    expect(shiftsToCell(['A'])).toBe('A');
    expect(shiftsToCell(['B', 'C'])).toBe('BC');
    expect(shiftsToCell(['A', 'B', 'C'])).toBe('ABC');
  });

  it('round-trips through parseShiftSubsetCell', () => {
    for (const cell of ['A', 'B', 'C', 'AB', 'AC', 'BC', 'ABC']) {
      const shifts = parseShiftSubsetCell(cell, 'd01');
      expect(shifts).not.toBeNull();
      expect(shiftsToCell(shifts ?? [])).toBe(cell);
    }
  });
});
