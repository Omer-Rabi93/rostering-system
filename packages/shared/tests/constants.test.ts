import { describe, expect, it } from 'vitest';
import {
  ALERT_TYPES,
  computeAvailableShifts,
  ROLES,
  ROSTER_STATUSES,
  SHIFT_HOURS,
  SHIFT_TYPES,
  WORKER_STATUSES,
} from '../src/index.js';

describe('constants', () => {
  it('defines SHIFT_HOURS as 8 (each shift is 8 hours per the design)', () => {
    expect(SHIFT_HOURS).toBe(8);
  });

  it('defines SHIFT_TYPES as the three daily shifts A, B, C in order', () => {
    expect(SHIFT_TYPES).toEqual(['A', 'B', 'C']);
  });

  it('defines ROLES as the three worker roles from the design', () => {
    expect(ROLES).toEqual(['GENERAL_GUARD', 'SUPERVISOR', 'SCREENER']);
  });

  it('defines WORKER_STATUSES as Active/Inactive', () => {
    expect(WORKER_STATUSES).toEqual(['ACTIVE', 'INACTIVE']);
  });

  it('defines ROSTER_STATUSES as Draft/Published', () => {
    expect(ROSTER_STATUSES).toEqual(['DRAFT', 'PUBLISHED']);
  });

  it('defines ALERT_TYPES as unfillable-slot / min-hours-shortfall', () => {
    expect(ALERT_TYPES).toEqual(['UNFILLABLE_SLOT', 'MIN_HOURS_SHORTFALL']);
  });
});

describe('computeAvailableShifts', () => {
  it('returns every shift when excludedShifts is undefined (no row = fully available)', () => {
    expect(computeAvailableShifts(undefined)).toEqual(['A', 'B', 'C']);
  });

  it('subtracts a partial excluded subset', () => {
    expect(computeAvailableShifts(['C'])).toEqual(['A', 'B']);
    expect(computeAvailableShifts(['A', 'C'])).toEqual(['B']);
  });

  it('returns an empty array when every shift is excluded (fully unavailable)', () => {
    expect(computeAvailableShifts(['A', 'B', 'C'])).toEqual([]);
  });

  it('returns every shift unchanged when excludedShifts is an empty array', () => {
    expect(computeAvailableShifts([])).toEqual(['A', 'B', 'C']);
  });
});
