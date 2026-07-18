import { describe, expect, it } from 'vitest';

import { buildMonthDays, shiftMonth } from './calendar.js';

describe('buildMonthDays', () => {
  it('builds 31 days for August 2026, first day Aug 1 (Saturday, weekend)', () => {
    const days = buildMonthDays('2026-08');
    expect(days).toHaveLength(31);
    expect(days[0]).toEqual({
      date: '2026-08-01',
      label: 'Aug 1',
      dayOfWeek: 'Saturday',
      isWeekend: true,
    });
    expect(days[30]?.date).toBe('2026-08-31');
  });

  it('builds 28 days for February 2026 (not a leap year)', () => {
    expect(buildMonthDays('2026-02')).toHaveLength(28);
  });

  it('builds 29 days for February 2028 (a leap year)', () => {
    expect(buildMonthDays('2028-02')).toHaveLength(29);
  });
});

describe('shiftMonth', () => {
  it('moves forward within a year', () => {
    expect(shiftMonth('2026-08', 1)).toBe('2026-09');
  });

  it('rolls over into the next year', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  });

  it('rolls back into the previous year', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });
});
