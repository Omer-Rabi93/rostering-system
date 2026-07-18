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
