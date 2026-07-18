// Date-specific worker availability (Availability v2).
//
// A worker's availability is entered per real calendar date of the month being rostered: each
// `(worker, date)` pair carries a non-empty subset of the three daily shifts the worker can work
// that exact date. Absence of an entry means "unavailable that date" — an empty subset is never a
// stored/transported value (delete the entry instead).

import { z } from 'zod';
import { SHIFT_TYPES } from '../constants.js';
import { monthSchema, type Month } from './month.js';

/**
 * Non-empty subset of `SHIFT_TYPES` in canonical order (`A` < `B` < `C`): rejects the empty
 * array, duplicate letters, out-of-order letters, and anything outside `A`/`B`/`C`. The canonical
 * form makes subsets directly comparable as values (`['A','C']` is THE representation of "A and
 * C"; `['C','A']` is invalid rather than an alias).
 */
export const shiftSubsetSchema = z
  .array(z.enum(SHIFT_TYPES))
  .min(1, 'A shift subset is never empty — absence of the entry means unavailable')
  .refine(
    (shifts) =>
      shifts.every((shift, i) => {
        if (i === 0) return true;
        const previous = shifts[i - 1];
        return previous !== undefined && SHIFT_TYPES.indexOf(previous) < SHIFT_TYPES.indexOf(shift);
      }),
    { message: 'Shifts must be in canonical A<B<C order without duplicates' },
  );

export type ShiftSubset = z.infer<typeof shiftSubsetSchema>;

/** Number of calendar days in a `YYYY-MM` month (leap years included). */
function daysInMonth(month: Month): number {
  const [yearStr, monthStr] = month.split('-');
  return new Date(Date.UTC(Number(yearStr), Number(monthStr), 0)).getUTCDate();
}

/**
 * A `YYYY-MM-DD` calendar date that really exists inside the given `YYYY-MM` month — rejects
 * dates of other months and day numbers past the month's end (e.g. `2026-02-30`).
 */
export function dateInMonthSchema(month: Month): z.ZodEffects<z.ZodString, string, string> {
  const validatedMonth = monthSchema.parse(month);
  const dayCount = daysInMonth(validatedMonth);
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected format YYYY-MM-DD')
    .refine(
      (date) => {
        if (!date.startsWith(`${validatedMonth}-`)) return false;
        const day = Number(date.slice(8, 10));
        return day >= 1 && day <= dayCount;
      },
      { message: `Date must be a real calendar date inside ${validatedMonth}` },
    );
}

/**
 * One worker-availability entry for one calendar date of the given month:
 * `{ date: 'YYYY-MM-DD', shifts: ShiftSubset }`. Absence of an entry (not an empty `shifts`)
 * is how "unavailable that date" is represented.
 */
export function availabilityEntrySchema(month: Month) {
  return z
    .object({
      date: dateInMonthSchema(month),
      shifts: shiftSubsetSchema,
    })
    .strict();
}

export type AvailabilityEntry = z.infer<ReturnType<typeof availabilityEntrySchema>>;

/** Decimal-string worker id — JSON object keys are always strings, so `workerId` 7 travels as `"7"`. */
const workerIdKeySchema = z.string().regex(/^\d+$/, 'Worker key must be a decimal workerId string');

/**
 * A whole month of availability for many workers, as the `GET/PUT /api/availability/:month` bulk
 * endpoints exchange it: `{ [workerId]: { [date]: ShiftSubset } }`.
 *
 * The shape is sparse by construction: a worker/date with no availability simply has NO key (the
 * date-keyed object also makes duplicate `(workerId, date)` pairs unrepresentable). Builders of
 * this payload must OMIT absent keys — never assign `undefined` — since
 * `exactOptionalPropertyTypes` (repo-wide) makes `{ '2026-08-03': undefined }` a type error where
 * the key should be absent; under `noUncheckedIndexedAccess` a lookup like `map[workerId]?.[date]`
 * is `ShiftSubset | undefined`, and `undefined` IS the real "unavailable" state — handle it
 * explicitly, don't coalesce it away.
 */
export function monthAvailabilitySchema(month: Month) {
  return z.record(workerIdKeySchema, z.record(dateInMonthSchema(month), shiftSubsetSchema));
}

export type MonthAvailability = z.infer<ReturnType<typeof monthAvailabilitySchema>>;
