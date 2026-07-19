import { describe, expect, it } from 'vitest';

import { dayOfWeekName, formatDayLabel, formatIls, formatMonthLong, isWeekend } from '../../src/lib/format.js';

describe('formatMonthLong', () => {
  it('formats a YYYY-MM month as "Month YYYY"', () => {
    expect(formatMonthLong('2026-08')).toBe('August 2026');
    expect(formatMonthLong('2026-01')).toBe('January 2026');
  });
});

describe('formatDayLabel', () => {
  it('formats a YYYY-MM-DD date as "Mon D"', () => {
    expect(formatDayLabel('2026-08-01')).toBe('Aug 1');
    expect(formatDayLabel('2026-08-12')).toBe('Aug 12');
  });
});

describe('dayOfWeekName / isWeekend', () => {
  it('2026-08-01 is a Saturday (matches the mockup)', () => {
    expect(dayOfWeekName('2026-08-01')).toBe('Saturday');
    expect(isWeekend('2026-08-01')).toBe(true);
  });

  it('2026-08-03 is a Monday and not a weekend day', () => {
    expect(dayOfWeekName('2026-08-03')).toBe('Monday');
    expect(isWeekend('2026-08-03')).toBe(false);
  });

  it('Friday is a weekend day (Israeli weekend = Fri+Sat)', () => {
    expect(dayOfWeekName('2026-08-07')).toBe('Friday');
    expect(isWeekend('2026-08-07')).toBe(true);
  });

  it('short style abbreviates the day name', () => {
    expect(dayOfWeekName('2026-08-01', 'short')).toBe('Sat');
  });
});

describe('formatIls', () => {
  it('formats with a ₪ prefix and thousands separators, no decimals', () => {
    expect(formatIls(612480)).toBe('₪612,480');
    expect(formatIls(0)).toBe('₪0');
    expect(formatIls(62.5)).toBe('₪63');
  });
});
