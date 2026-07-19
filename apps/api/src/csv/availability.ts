// Cell-level primitives for the day-column (`dNN`) portion of the combined workforce CSV
// (`csv/workforce.ts`) — Availability v3 exclusion semantics: a cell's letters are the shifts a
// worker is EXCLUDED from (cannot work) that date, empty = no exclusions = fully available, `ABC`
// = unavailable all day. Framing (header shape, row parsing, serialization) used to live in this
// file too, back when the availability CSV was its own standalone upload; that's now owned by
// `csv/workforce.ts`, which imports these primitives rather than duplicating them.

import { SHIFT_TYPES, shiftSubsetSchema, type Month, type ShiftType } from '@rostering/shared';

import { monthDays } from '../engine/calendar.js';

/** Zero-padded `dNN` column name for the Nth day of the month (1-based), e.g. `d01`, `d31`. */
function dayColumn(dayNumber: number): string {
  return `d${String(dayNumber).padStart(2, '0')}`;
}

/** The `dNN` columns for `month`, in calendar order -- one per real calendar date (28-31,
 * computed from the month, never hardcoded to 30/31). */
export function dayColumns(month: Month): readonly string[] {
  return monthDays(month).map((_, i) => dayColumn(i + 1));
}

/** Maps a `dNN` column name back to the `YYYY-MM-DD` calendar date it represents within `month`. */
export function dateForDayColumn(month: Month, column: string): string {
  const days = monthDays(month);
  const index = dayColumns(month).indexOf(column);
  const date = days[index];
  if (date === undefined) {
    throw new Error(`Column "${column}" is not a valid day column for month ${month}`);
  }
  return date;
}

/** One validated (worker, date) exclusion entry parsed from a single `dNN` cell: the shifts the
 * worker is EXCLUDED from (cannot work) on `date`, not the shifts they can work. */
export interface AvailabilityCsvEntry {
  readonly date: string; // "YYYY-MM-DD"
  readonly shifts: readonly ShiftType[];
}

/** Thrown when a single `dNN` cell's value is not a legal canonical shift-subset string (illegal
 * letter, duplicate letter, out-of-order letters). Carries the offending column name, mirroring
 * the worker CSV's `CsvFieldError` so callers can attribute the failure precisely. */
export class AvailabilityCsvCellError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'AvailabilityCsvCellError';
    this.field = field;
  }
}

const SHIFT_LETTERS = new Set<string>(SHIFT_TYPES);

/** Validates one `dNN` cell's raw string against the canonical shift-subset rules
 * (`@rostering/shared`'s `shiftSubsetSchema`: non-empty, `A`<`B`<`C` order, no duplicates/unknown
 * letters). The letters name the shifts the worker is EXCLUDED from (cannot work), not the shifts
 * they can work. An empty cell is valid and means "no exclusions" -- represented as `null`, never
 * an empty array (Availability v3: absence of the row IS the fully-available state; a cell listing
 * all three letters, `ABC`, is how "unavailable all day" is now expressed). */
export function parseShiftSubsetCell(raw: string, field: string): readonly ShiftType[] | null {
  if (raw === '') {
    return null;
  }
  const letters = raw.split('');
  for (const letter of letters) {
    if (!SHIFT_LETTERS.has(letter)) {
      throw new AvailabilityCsvCellError(
        field,
        `Illegal shift letter "${letter}" in "${raw}"; expected only A/B/C`,
      );
    }
  }
  const result = shiftSubsetSchema.safeParse(letters);
  if (!result.success) {
    const [issue] = result.error.issues;
    throw new AvailabilityCsvCellError(field, issue ? issue.message : `Illegal shift subset "${raw}"`);
  }
  return result.data;
}

/** `ShiftType[]` -> the canonical cell string (`SHIFT_TYPES` order, e.g. `"AB"`, `"ABC"`) naming
 * the excluded (cannot-work) shifts. Every `WorkerAvailability` row is Zod-validated on write to
 * already be in canonical order, so this is a plain join, not a re-sort. */
export function shiftsToCell(shifts: readonly ShiftType[]): string {
  return shifts.join('');
}
