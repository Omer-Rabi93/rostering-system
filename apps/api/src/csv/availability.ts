// Month-scoped availability CSV (Availability v2): `national_id` + one `dNN` column per calendar
// date of the target month, cell value = a canonical shift-subset string (`A`, `AB`, `ABC`, ...)
// or empty (= unavailable that date). Deliberately mirrors the worker CSV's structure
// (`csv/{parse,serialize,record}.ts`): real CSV tokenizer/writer (`csv-parse`/`csv-stringify`),
// the exact same `guardCell`/`unguardCell` formula-injection guard applied to EVERY cell
// (including `national_id` and every `dNN` cell -- not special-cased out just because their
// legal values happen never to start with a formula-trigger character; the guard is uniform
// defense-in-depth, run before any shape/value validation), and the same two-tier error model:
// `AvailabilityCsvHeaderError`/`AvailabilityCsvRowShapeError` are file-level (abort the whole
// import), while a bad cell inside an otherwise well-framed row is reported per-row by the
// service layer (`services/availabilityService.ts`) without aborting the batch.

import { parse as parseCsvSync } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { SHIFT_TYPES, shiftSubsetSchema, type Month, type ShiftType } from '@rostering/shared';

import { monthDays } from '../engine/calendar.js';
import { guardCell, unguardCell } from './guard.js';

export const NATIONAL_ID_COLUMN = 'national_id';

/** Zero-padded `dNN` column name for the Nth day of the month (1-based), e.g. `d01`, `d31`. */
function dayColumn(dayNumber: number): string {
  return `d${String(dayNumber).padStart(2, '0')}`;
}

/** The `dNN` columns for `month`, in calendar order -- one per real calendar date (28-31,
 * computed from the month, never hardcoded to 30/31). */
export function dayColumns(month: Month): readonly string[] {
  return monthDays(month).map((_, i) => dayColumn(i + 1));
}

/** Full header row for `month`'s availability CSV: `national_id` followed by that month's `dNN`
 * columns. Export and import both derive this from `month` so a file for one month is never
 * silently accepted as another month's shape. */
export function availabilityCsvHeader(month: Month): readonly string[] {
  return [NATIONAL_ID_COLUMN, ...dayColumns(month)];
}

/** Maps a `dNN` column name back to the `YYYY-MM-DD` calendar date it represents within `month`. */
function dateForColumn(month: Month, column: string): string {
  const days = monthDays(month);
  const index = dayColumns(month).indexOf(column);
  const date = days[index];
  if (date === undefined) {
    throw new Error(`Column "${column}" is not a valid day column for month ${month}`);
  }
  return date;
}

/** The header row does not match `month`'s exact `national_id` + `dNN...` shape (wrong day count,
 * wrong order, wrong names) -- or the file could not be tokenized as CSV at all. File-level, never
 * a per-row problem. */
export class AvailabilityCsvHeaderError extends Error {}

/** A data row has a different number of fields than the header. Also file-level, for the same
 * reason `CsvRowShapeError` is in the worker CSV: a malformed row shape means the file's framing
 * is broken, not that one row's data is merely invalid. */
export class AvailabilityCsvRowShapeError extends Error {}

/** One raw (formula-guard-stripped) row: the worker's `national_id` cell plus every `dNN` cell as
 * an untouched raw string (`''` = no cell value = candidate "unavailable that date", a non-empty
 * string = an as-yet-unvalidated shift-subset candidate). Validating those strings into real
 * `ShiftType[]` entries is `toAvailabilityEntries`'s job, deliberately kept separate from framing
 * so a bad cell can be reported as a per-row error without the whole file failing to parse. */
export interface AvailabilityCsvRawRow {
  readonly rowNumber: number; // 1-based, matching the worker CSV's `ImportRowError.row` convention
  readonly nationalId: string;
  readonly cells: Readonly<Record<string, string>>;
}

/** Parses `csvText` against exactly `month`'s header shape and returns one raw (guard-stripped)
 * row per data row, in file order. Throws `AvailabilityCsvHeaderError`/`AvailabilityCsvRowShapeError`
 * (never returns partially-parsed data) if the file's structure does not match. */
export function parseAvailabilityCsv(csvText: string, month: Month): AvailabilityCsvRawRow[] {
  const expectedHeader = availabilityCsvHeader(month);

  let records: string[][];
  try {
    records = parseCsvSync(csvText, {
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true, // row width is validated separately, with a distinct error type
    });
  } catch (err) {
    throw new AvailabilityCsvHeaderError(
      `Could not parse CSV: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const [header, ...dataRows] = records;
  if (!header) {
    throw new AvailabilityCsvHeaderError('CSV file is empty; expected a header row');
  }

  const headerMatches =
    header.length === expectedHeader.length && expectedHeader.every((col, i) => header[i] === col);
  if (!headerMatches) {
    throw new AvailabilityCsvHeaderError(
      `CSV header for month ${month} must be exactly: ${expectedHeader.join(',')} (got: ${header.join(',')})`,
    );
  }

  return dataRows.map((row, index) => {
    if (row.length !== expectedHeader.length) {
      throw new AvailabilityCsvRowShapeError(
        `Row ${index + 1} has ${row.length} fields, expected ${expectedHeader.length}`,
      );
    }
    const cells: Record<string, string> = {};
    expectedHeader.forEach((col, i) => {
      cells[col] = unguardCell(row[i] ?? '');
    });
    const nationalId = cells[NATIONAL_ID_COLUMN] ?? '';
    delete cells[NATIONAL_ID_COLUMN];
    return { rowNumber: index + 1, nationalId, cells };
  });
}

/** One validated (worker, date) availability entry parsed from a single `dNN` cell. */
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
 * letters). An empty cell is valid and means "no entry" -- represented as `null`, never an empty
 * array (Availability v2: absence of the row IS the unavailable state). */
function parseShiftSubsetCell(raw: string, field: string): readonly ShiftType[] | null {
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

/** Raw (already formula-guard-stripped, framing-validated) row -> the worker's non-empty
 * availability entries for `month`. Throws `AvailabilityCsvCellError` on the FIRST illegal cell --
 * the caller (the import service) treats a row with any bad cell as one failed row (same
 * granularity as the worker CSV's per-row transaction), not a partial per-cell apply. */
export function toAvailabilityEntries(row: AvailabilityCsvRawRow, month: Month): AvailabilityCsvEntry[] {
  const entries: AvailabilityCsvEntry[] = [];
  for (const column of dayColumns(month)) {
    const raw = row.cells[column] ?? '';
    const shifts = parseShiftSubsetCell(raw, column);
    if (shifts !== null) {
      entries.push({ date: dateForColumn(month, column), shifts });
    }
  }
  return entries;
}

/** One worker's full month of availability, ready to serialize -- `entries` need only cover the
 * dates the worker has a row for; every other date in the month is written as an empty cell. */
export interface AvailabilityCsvExportRow {
  readonly nationalId: string;
  readonly entries: readonly AvailabilityCsvEntry[];
}

/** `ShiftType[]` -> the canonical cell string (`SHIFT_TYPES` order, e.g. `"AB"`, `"ABC"`). Every
 * `WorkerAvailability` row is Zod-validated on write to already be in canonical order, so this is
 * a plain join, not a re-sort. */
function shiftsToCell(shifts: readonly ShiftType[]): string {
  return shifts.join('');
}

export function serializeAvailabilityCsv(rows: readonly AvailabilityCsvExportRow[], month: Month): string {
  const header = availabilityCsvHeader(month);
  const lines = rows.map((row) => {
    const entryByDate = new Map(row.entries.map((e) => [e.date, e.shifts]));
    const record: Record<string, string> = { [NATIONAL_ID_COLUMN]: guardCell(row.nationalId) };
    dayColumns(month).forEach((column, i) => {
      const date = monthDays(month)[i];
      const shifts = date !== undefined ? entryByDate.get(date) : undefined;
      record[column] = guardCell(shifts ? shiftsToCell(shifts) : '');
    });
    return record;
  });

  return stringify(lines, { header: true, columns: [...header], record_delimiter: '\n' });
}
