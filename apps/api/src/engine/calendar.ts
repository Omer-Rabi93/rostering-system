// Calendar helpers shared by the validator and the solver-problem builder.
//
// `weekdayIndex` below is Sunday-first: index 0 = Sunday … index 6 = Saturday. Under Availability
// v2, `engine/validator.ts` and `engine/problem.ts` no longer use weekday reasoning at all (worker
// availability is keyed by exact calendar date — see `engine/types.ts`'s `AvailabilityByDate`) —
// `weekdayIndex` is kept here only because the DB seed fixtures (`db/seedData.ts`) still use it to
// derive per-date `WorkerAvailability` rows from an old weekly-pattern shape.

import { SHIFT_TYPES } from '@rostering/shared';

/**
 * Sunday-first weekday index (0 = Sunday … 6 = Saturday) for a `YYYY-MM-DD` calendar date.
 * Parsed as UTC so the result never shifts with the host machine's timezone.
 */
export function weekdayIndex(isoDate: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  // Date#getUTCDay is already Sunday-first (0 = Sunday).
  return date.getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/** A DB `Date` (UTC-midnight `@db.Date` column) as its `YYYY-MM-DD` calendar string. */
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** First/last calendar dates of a `YYYY-MM` month as UTC-midnight `Date`s — the inclusive bounds
 * for a `WorkerAvailability` month-window query (`date: { gte: start, lte: end }`). */
export function monthDateRange(month: string): { readonly start: Date; readonly end: Date } {
  const days = monthDays(month);
  const [first] = days;
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error(`Month ${month} produced no calendar days`);
  }
  return { start: new Date(`${first}T00:00:00.000Z`), end: new Date(`${last}T00:00:00.000Z`) };
}

/** All calendar dates (`YYYY-MM-DD`) in a `YYYY-MM` month, in order, leap years included. */
export function monthDays(month: string): string[] {
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthNum = Number(monthStr);
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  return Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1;
    return `${yearStr}-${monthStr}-${String(day).padStart(2, '0')}`;
  });
}

export { SHIFT_TYPES };
