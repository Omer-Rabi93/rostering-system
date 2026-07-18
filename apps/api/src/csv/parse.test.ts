import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS } from './columns.js';
import { CsvHeaderError, CsvRowShapeError, parseWorkersCsv } from './parse.js';

const HEADER = CSV_COLUMNS.join(',');
const SAMPLE_ROW = '123456782,Dana Levi,Supervisor,Active,62.50,120,182';

describe('parseWorkersCsv', () => {
  it('parses a well-formed file into raw rows keyed by the documented columns', () => {
    const rows = parseWorkersCsv(`${HEADER}\n${SAMPLE_ROW}\n`);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (!row) throw new Error('expected exactly one parsed row');
    expect(row.national_id).toBe('123456782');
    expect(row.name).toBe('Dana Levi');
    expect(row.max_monthly_hours).toBe('182');
  });

  it('uses a real CSV parser: a quoted field containing a comma is one cell, not two', () => {
    const quotedRow = SAMPLE_ROW.replace('Dana Levi', '"Levi, Dana"');
    const [row] = parseWorkersCsv(`${HEADER}\n${quotedRow}\n`);
    if (!row) throw new Error('expected exactly one parsed row');
    expect(row.name).toBe('Levi, Dana');
  });

  it('strips the formula-injection guard prefix while parsing', () => {
    const guardedRow = SAMPLE_ROW.replace('Dana Levi', "'=SUM(A1)");
    const [row] = parseWorkersCsv(`${HEADER}\n${guardedRow}\n`);
    if (!row) throw new Error('expected exactly one parsed row');
    expect(row.name).toBe('=SUM(A1)');
  });

  it('rejects a header missing a column', () => {
    const badHeader = CSV_COLUMNS.filter((c) => c !== 'max_monthly_hours').join(',');
    expect(() => parseWorkersCsv(`${badHeader}\n`)).toThrow(CsvHeaderError);
  });

  it('rejects a header with an extra column', () => {
    const badHeader = `${HEADER},extra_column`;
    expect(() => parseWorkersCsv(`${badHeader}\n`)).toThrow(CsvHeaderError);
  });

  it('rejects a header with columns out of order', () => {
    // Swap the (well-known) first two column names rather than indexing into `CSV_COLUMNS`.
    const shuffled = ['name', 'national_id', ...CSV_COLUMNS.slice(2)];
    expect(() => parseWorkersCsv(`${shuffled.join(',')}\n`)).toThrow(CsvHeaderError);
  });

  it('rejects a data row with fewer fields than the header', () => {
    const shortRow = SAMPLE_ROW.split(',').slice(0, -1).join(',');
    expect(() => parseWorkersCsv(`${HEADER}\n${shortRow}\n`)).toThrow(CsvRowShapeError);
  });

  it('rejects a data row with more fields than the header', () => {
    const longRow = `${SAMPLE_ROW},extra`;
    expect(() => parseWorkersCsv(`${HEADER}\n${longRow}\n`)).toThrow(CsvRowShapeError);
  });

  it('returns an empty array for a header-only file', () => {
    expect(parseWorkersCsv(`${HEADER}\n`)).toEqual([]);
  });
});
