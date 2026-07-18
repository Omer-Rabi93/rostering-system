import type { Month } from '@rostering/shared';

import { dayOfWeekName, formatDayLabel, isWeekend, parseMonth } from './format.js';

export interface MonthDay {
  readonly date: string; // YYYY-MM-DD
  readonly label: string; // "Aug 12"
  readonly dayOfWeek: string; // "Monday"
  readonly isWeekend: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function daysInMonth(year: number, monthIndex: number): number {
  // Day 0 of the *next* month is the last day of this one.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Builds one `MonthDay` per calendar day (28-31 entries) for a `YYYY-MM` month, in order —
 * the data `CalendarGrid`'s `days` prop and the public schedule page's day list are both built
 * from. */
export function buildMonthDays(month: Month): MonthDay[] {
  const { year, monthIndex } = parseMonth(month);
  const total = daysInMonth(year, monthIndex);
  const days: MonthDay[] = [];
  for (let day = 1; day <= total; day++) {
    const date = `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
    days.push({
      date,
      label: formatDayLabel(date),
      dayOfWeek: dayOfWeekName(date),
      isWeekend: isWeekend(date),
    });
  }
  return days;
}

/** Shifts a `YYYY-MM` month by `delta` whole months (e.g. `-1` = previous month). */
export function shiftMonth(month: Month, delta: number): Month {
  const { year, monthIndex } = parseMonth(month);
  const total = year * 12 + monthIndex + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonthIndex = ((total % 12) + 12) % 12;
  return `${nextYear}-${pad2(nextMonthIndex + 1)}`;
}

/** The current month as `YYYY-MM`, in UTC (so it's stable regardless of host timezone). */
export function currentMonth(): Month {
  const now = new Date();
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;
}
