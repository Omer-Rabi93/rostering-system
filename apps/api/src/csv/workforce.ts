// Combined workforce CSV: one row = one worker's full field set (the 7 documented worker columns)
// PLUS that worker's excluded-shifts for every calendar day of ONE target month (the `dNN`
// columns, Availability v3 exclusion semantics -- see `csv/availability.ts`'s doc comment). This
// supersedes the two CSVs that used to exist independently (worker-sync-only, availability-only):
// one file, one header, one upload. Uses `csv-parse`/`csv-stringify` (real tokenizers, not
// hand-rolled `split(',')`) and the same formula-injection guard (`guard.ts`) applied uniformly to
// every cell, worker column or `dNN` column alike.

import { parse as parseCsvSync } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import type { Month } from '@rostering/shared';

import { CSV_COLUMNS } from './columns.js';
import type { CsvRawRow } from './columns.js';
import { guardCell, unguardCell } from './guard.js';
import { fromWorkerRecord, toWorkerRecord, type CsvWorkerRecord } from './record.js';
import {
  dateForDayColumn,
  dayColumns,
  parseShiftSubsetCell,
  shiftsToCell,
  type AvailabilityCsvEntry,
} from './availability.js';

/** The header row is missing, extra, out of order, or doesn't match the target month's day count
 * (or the file could not be tokenized as CSV at all). A file-level problem -- never a per-row one. */
export class WorkforceCsvHeaderError extends Error {}

/** A data row has a different number of fields than the header. Also file-level: a malformed row
 * shape means the file's framing is broken, not that one row's data is merely invalid. */
export class WorkforceCsvRowShapeError extends Error {}

/** Full header for `month`'s combined workforce CSV: the 7 worker columns, then that month's `dNN`
 * columns. Import and export both derive this from `month` so a file for one month is never
 * silently accepted as another month's shape. */
export function workforceCsvHeader(month: Month): readonly string[] {
  return [...CSV_COLUMNS, ...dayColumns(month)];
}

/** One raw (formula-guard-stripped) row, split into its two logical halves: `worker` (the 7
 * documented worker columns, same shape as the old worker-only CSV's `CsvRawRow`) and `cells`
 * (`dNN` -> raw string, same shape the old availability-only CSV produced). Neither half is
 * validated yet -- that's `toWorkforceRow`'s job. */
export interface WorkforceCsvRawRow {
  readonly rowNumber: number; // 1-based
  readonly worker: CsvRawRow;
  readonly cells: Readonly<Record<string, string>>;
}

/** Parses `csvText` against exactly `month`'s combined header shape and returns one raw
 * (guard-stripped) row per data row, in file order. Throws `WorkforceCsvHeaderError`/
 * `WorkforceCsvRowShapeError` (never returns partially-parsed data) if the file's structure does
 * not match. */
export function parseWorkforceCsv(csvText: string, month: Month): WorkforceCsvRawRow[] {
  const expectedHeader = workforceCsvHeader(month);
  const dayCols = dayColumns(month);

  let records: string[][];
  try {
    records = parseCsvSync(csvText, {
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true, // row width is validated separately, with a distinct error type
    });
  } catch (err) {
    throw new WorkforceCsvHeaderError(`Could not parse CSV: ${err instanceof Error ? err.message : String(err)}`);
  }

  const [header, ...dataRows] = records;
  if (!header) {
    throw new WorkforceCsvHeaderError('CSV file is empty; expected a header row');
  }

  const headerMatches =
    header.length === expectedHeader.length && expectedHeader.every((col, i) => header[i] === col);
  if (!headerMatches) {
    throw new WorkforceCsvHeaderError(
      `CSV header for month ${month} must be exactly: ${expectedHeader.join(',')} (got: ${header.join(',')})`,
    );
  }

  return dataRows.map((row, index) => {
    if (row.length !== expectedHeader.length) {
      throw new WorkforceCsvRowShapeError(
        `Row ${index + 1} has ${row.length} fields, expected ${expectedHeader.length}`,
      );
    }
    const worker = {} as Record<string, string>;
    CSV_COLUMNS.forEach((col, i) => {
      worker[col] = unguardCell(row[i] ?? '');
    });
    const cells: Record<string, string> = {};
    dayCols.forEach((col, i) => {
      cells[col] = unguardCell(row[CSV_COLUMNS.length + i] ?? '');
    });
    return { rowNumber: index + 1, worker: worker as CsvRawRow, cells };
  });
}

/** One raw row, fully validated into domain shape: the worker's typed field record plus their
 * non-empty exclusion entries for `month` (a date with no entry means no exclusions, i.e. fully
 * available). Worker-field validation runs BEFORE day-cell validation (matching the CSV's own
 * column order: worker fields first, then `dNN`s) -- a bad worker field is reported without ever
 * looking at that row's day cells, and a row that passes worker validation but has one bad `dNN`
 * cell throws on the FIRST illegal cell (the caller, `WorkforceImportService`, treats a row with
 * ANY bad cell -- worker field or day cell -- as one failed row: the worker upsert and the
 * availability replace are one atomic unit per row, not two independent outcomes). */
export function toWorkforceRow(raw: WorkforceCsvRawRow, month: Month): WorkforceCsvRow {
  const record = toWorkerRecord(raw.worker);
  const entries: AvailabilityCsvEntry[] = [];
  for (const column of dayColumns(month)) {
    const cellRaw = raw.cells[column] ?? '';
    const shifts = parseShiftSubsetCell(cellRaw, column);
    if (shifts !== null) {
      entries.push({ date: dateForDayColumn(month, column), shifts });
    }
  }
  return { record, entries };
}

export interface WorkforceCsvRow {
  readonly record: CsvWorkerRecord;
  readonly entries: readonly AvailabilityCsvEntry[];
}

/** One worker's full combined row, ready to serialize -- `entries` need only cover the dates the
 * worker has an exclusion for; every other date in the month is written as an empty cell (no
 * exclusions, fully available). */
export interface WorkforceCsvExportRow {
  readonly record: CsvWorkerRecord;
  readonly entries: readonly AvailabilityCsvEntry[];
}

/** Serializes each row's worker fields + that month's exclusion entries back to one combined CSV. */
export function serializeWorkforceCsv(rows: readonly WorkforceCsvExportRow[], month: Month): string {
  const header = workforceCsvHeader(month);
  const dayCols = dayColumns(month);
  const monthDates = dayCols.map((col) => dateForDayColumn(month, col));

  const lines = rows.map((row) => {
    const workerRaw = fromWorkerRecord(row.record);
    const record: Record<string, string> = {};
    for (const col of CSV_COLUMNS) {
      record[col] = guardCell(workerRaw[col]);
    }
    const entryByDate = new Map(row.entries.map((e) => [e.date, e.shifts]));
    dayCols.forEach((column, i) => {
      const shifts = entryByDate.get(monthDates[i] ?? '');
      record[column] = guardCell(shifts ? shiftsToCell(shifts) : '');
    });
    return record;
  });

  return stringify(lines, { header: true, columns: [...header], record_delimiter: '\n' });
}
