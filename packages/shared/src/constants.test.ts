import { describe, expect, it } from 'vitest';
import { ALERT_TYPES, ROLES, ROSTER_STATUSES, SHIFT_HOURS, SHIFT_TYPES, WORKER_STATUSES } from './index.js';

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
