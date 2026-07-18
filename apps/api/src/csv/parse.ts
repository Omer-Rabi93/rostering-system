// Parses raw CSV text into rows keyed by the documented 7 columns. Uses `csv-parse` (a real CSV
// tokenizer -- handles quoted fields, embedded commas/newlines, escaped quotes) rather than
// hand-rolled `split(',')`, which breaks the moment a worker name contains a comma.

import { parse as parseCsvSync } from 'csv-parse/sync';
import { CSV_COLUMNS } from './columns.js';
import type { CsvRawRow } from './columns.js';
import { unguardCell } from './guard.js';

/** The header row is missing, extra, or out of order relative to the 7 documented columns (or
 * the file could not be tokenized as CSV at all). A file-level problem -- never a per-row one. */
export class CsvHeaderError extends Error {}

/** A data row has a different number of fields than the header (unescaped comma, truncated line,
 * ...). Also file-level: a malformed row shape means the file's framing is broken, not that one
 * row's data is merely invalid. */
export class CsvRowShapeError extends Error {}

/** Parses `csvText` and returns one raw (formula-guard-stripped) row per data row, in file order.
 * Throws `CsvHeaderError`/`CsvRowShapeError` (never returns partially-parsed data) if the file's
 * structure does not match the documented schema exactly. */
export function parseWorkersCsv(csvText: string): CsvRawRow[] {
  let records: string[][];
  try {
    records = parseCsvSync(csvText, {
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true, // we validate row width ourselves, with a distinct error type
    });
  } catch (err) {
    throw new CsvHeaderError(`Could not parse CSV: ${err instanceof Error ? err.message : String(err)}`);
  }

  const [header, ...dataRows] = records;
  if (!header) {
    throw new CsvHeaderError('CSV file is empty; expected a header row');
  }

  const headerMatches =
    header.length === CSV_COLUMNS.length && CSV_COLUMNS.every((col, i) => header[i] === col);
  if (!headerMatches) {
    throw new CsvHeaderError(
      `CSV header must be exactly: ${CSV_COLUMNS.join(',')} (got: ${header.join(',')})`,
    );
  }

  return dataRows.map((cells, index) => {
    if (cells.length !== CSV_COLUMNS.length) {
      throw new CsvRowShapeError(
        `Row ${index + 1} has ${cells.length} fields, expected ${CSV_COLUMNS.length}`,
      );
    }
    const row = {} as CsvRawRow;
    CSV_COLUMNS.forEach((col, i) => {
      row[col] = unguardCell(cells[i] ?? '');
    });
    return row;
  });
}
