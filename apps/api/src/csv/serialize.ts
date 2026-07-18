// Serializes typed worker+contract records into CSV text: the exact 8-column header, one line
// per record, quoting handled by `csv-stringify` (a real CSV writer -- correctly quotes any field
// containing a comma, quote, or newline) and the formula-injection guard applied to every cell.

import { stringify } from 'csv-stringify/sync';
import { CSV_COLUMNS } from './columns.js';
import { guardCell } from './guard.js';
import { fromWorkerRecord, type CsvWorkerRecord } from './record.js';

export function serializeWorkersCsv(records: readonly CsvWorkerRecord[]): string {
  const rows = records.map((record) => {
    const raw = fromWorkerRecord(record);
    const guarded: Record<string, string> = {};
    for (const col of CSV_COLUMNS) {
      guarded[col] = guardCell(raw[col]);
    }
    return guarded;
  });

  return stringify(rows, { header: true, columns: [...CSV_COLUMNS], record_delimiter: '\n' });
}
