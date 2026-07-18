import { describe, expect, it } from 'vitest';
import { alertSchema } from '../index.js';

describe('alertSchema', () => {
  it('accepts a valid unfillable_slot alert', () => {
    const result = alertSchema.safeParse({
      id: 1,
      type: 'UNFILLABLE_SLOT',
      detail: { date: '2026-07-01', shift: 'A', role: 'SUPERVISOR' },
      acknowledged: false,
      acknowledgedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid min_hours_shortfall alert', () => {
    const result = alertSchema.safeParse({
      id: 2,
      type: 'MIN_HOURS_SHORTFALL',
      detail: { workerId: 7, deficitHours: 12 },
      acknowledged: true,
      acknowledgedAt: '2026-07-15T10:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unfillable_slot alert carrying min_hours_shortfall detail fields', () => {
    const result = alertSchema.safeParse({
      id: 3,
      type: 'UNFILLABLE_SLOT',
      detail: { workerId: 7, deficitHours: 12 },
      acknowledged: false,
      acknowledgedAt: null,
    });
    expect(result.success).toBe(false);
  });
});
