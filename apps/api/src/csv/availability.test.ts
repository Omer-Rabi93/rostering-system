import { describe, expect, it } from 'vitest';
import type { Month } from '@rostering/shared';

import {
  AvailabilityCsvCellError,
  AvailabilityCsvHeaderError,
  AvailabilityCsvRowShapeError,
  availabilityCsvHeader,
  dayColumns,
  parseAvailabilityCsv,
  serializeAvailabilityCsv,
  toAvailabilityEntries,
  type AvailabilityCsvExportRow,
} from './availability.js';

const FEB_2027 = '2027-02' as Month; // 28 days, non-leap
const FEB_2028 = '2028-02' as Month; // 29 days, leap
const APRIL_2027 = '2027-04' as Month; // 30 days
const JAN_2027 = '2027-01' as Month; // 31 days

describe('availabilityCsvHeader / dayColumns', () => {
  it.each([
    [FEB_2027, 28],
    [FEB_2028, 29],
    [APRIL_2027, 30],
    [JAN_2027, 31],
  ])('produces national_id + exactly the day count of %s (%i days)', (month, dayCount) => {
    expect(dayColumns(month)).toHaveLength(dayCount);
    expect(availabilityCsvHeader(month)).toHaveLength(dayCount + 1);
    expect(availabilityCsvHeader(month)[0]).toBe('national_id');
    expect(availabilityCsvHeader(month)[1]).toBe('d01');
    expect(availabilityCsvHeader(month).at(-1)).toBe(`d${String(dayCount).padStart(2, '0')}`);
  });
});

describe('parseAvailabilityCsv', () => {
  const header = availabilityCsvHeader(FEB_2027).join(',');

  function row(nationalId: string, cells: Record<string, string>): string {
    return [nationalId, ...dayColumns(FEB_2027).map((c) => cells[c] ?? '')].join(',');
  }

  it('parses a well-formed file into raw rows keyed by day column, unguarded', () => {
    const csv = `${header}\n${row('123456782', { d01: 'A', d02: 'ABC' })}\n`;
    const rows = parseAvailabilityCsv(csv, FEB_2027);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nationalId).toBe('123456782');
    expect(rows[0]?.cells.d01).toBe('A');
    expect(rows[0]?.cells.d02).toBe('ABC');
    expect(rows[0]?.cells.d03).toBe('');
    expect(rows[0]?.rowNumber).toBe(1);
  });

  it('rejects a header with the wrong day count for the target month (wrong-month-shape import)', () => {
    const wrongMonthHeader = availabilityCsvHeader(JAN_2027).join(','); // 31-day header
    expect(() => parseAvailabilityCsv(`${wrongMonthHeader}\n`, FEB_2027)).toThrow(AvailabilityCsvHeaderError);
  });

  it('rejects a header with columns out of order', () => {
    const cols = [...availabilityCsvHeader(FEB_2027)];
    const shuffled = [cols[0], cols[2], cols[1], ...cols.slice(3)];
    expect(() => parseAvailabilityCsv(`${shuffled.join(',')}\n`, FEB_2027)).toThrow(AvailabilityCsvHeaderError);
  });

  it('rejects an empty file', () => {
    expect(() => parseAvailabilityCsv('', FEB_2027)).toThrow(AvailabilityCsvHeaderError);
  });

  it('rejects a data row with the wrong number of fields', () => {
    const shortRow = row('123456782', { d01: 'A' }).split(',').slice(0, -1).join(',');
    expect(() => parseAvailabilityCsv(`${header}\n${shortRow}\n`, FEB_2027)).toThrow(AvailabilityCsvRowShapeError);
  });

  it('strips the formula-injection guard prefix off both national_id and dNN cells while parsing', () => {
    // Framing-level test only (mirrors csv/parse.test.ts's own guard test): these guarded values
    // need not be otherwise legal (a guarded national_id will separately fail the unknown-national-id
    // check, and a guarded dNN cell will separately fail shift-subset validation) -- this proves
    // `unguardCell` runs uniformly on every cell during parse, not that the guard was ever needed
    // for a real value.
    const guardedRow = `'=cmd|/C calc,${dayColumns(FEB_2027)
      .map((_, i) => (i === 0 ? "'-A" : ''))
      .join(',')}`;
    const [parsed] = parseAvailabilityCsv(`${header}\n${guardedRow}\n`, FEB_2027);
    expect(parsed?.nationalId).toBe('=cmd|/C calc');
    expect(parsed?.cells.d01).toBe('-A');
  });

  it('returns an empty array for a header-only file', () => {
    expect(parseAvailabilityCsv(`${header}\n`, FEB_2027)).toEqual([]);
  });
});

describe('toAvailabilityEntries', () => {
  it('produces one entry per non-empty dNN cell, in canonical shift order', () => {
    const [raw] = parseAvailabilityCsv(
      `${availabilityCsvHeader(FEB_2027).join(',')}\n${['123456782', 'A', '', 'BC', ...Array(25).fill('')].join(',')}\n`,
      FEB_2027,
    );
    if (!raw) throw new Error('expected one row');
    const entries = toAvailabilityEntries(raw, FEB_2027);
    expect(entries).toEqual([
      { date: '2027-02-01', shifts: ['A'] },
      { date: '2027-02-03', shifts: ['B', 'C'] },
    ]);
  });

  it('an all-empty row produces zero entries (unavailable every date, not a crash)', () => {
    const [raw] = parseAvailabilityCsv(`${availabilityCsvHeader(FEB_2027).join(',')}\n${['123456782', ...Array(28).fill('')].join(',')}\n`, FEB_2027);
    if (!raw) throw new Error('expected one row');
    expect(toAvailabilityEntries(raw, FEB_2027)).toEqual([]);
  });

  it('throws AvailabilityCsvCellError (with the dNN field name) for an illegal shift letter', () => {
    const [raw] = parseAvailabilityCsv(
      `${availabilityCsvHeader(FEB_2027).join(',')}\n${['123456782', 'AD', ...Array(27).fill('')].join(',')}\n`,
      FEB_2027,
    );
    if (!raw) throw new Error('expected one row');
    try {
      toAvailabilityEntries(raw, FEB_2027);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AvailabilityCsvCellError);
      expect((err as AvailabilityCsvCellError).field).toBe('d01');
    }
  });

  it('throws AvailabilityCsvCellError for a duplicate-letter cell', () => {
    const [raw] = parseAvailabilityCsv(
      `${availabilityCsvHeader(FEB_2027).join(',')}\n${['123456782', 'AA', ...Array(27).fill('')].join(',')}\n`,
      FEB_2027,
    );
    if (!raw) throw new Error('expected one row');
    expect(() => toAvailabilityEntries(raw, FEB_2027)).toThrow(AvailabilityCsvCellError);
  });

  it('throws AvailabilityCsvCellError for out-of-canonical-order letters', () => {
    const [raw] = parseAvailabilityCsv(
      `${availabilityCsvHeader(FEB_2027).join(',')}\n${['123456782', 'BA', ...Array(27).fill('')].join(',')}\n`,
      FEB_2027,
    );
    if (!raw) throw new Error('expected one row');
    expect(() => toAvailabilityEntries(raw, FEB_2027)).toThrow(AvailabilityCsvCellError);
  });
});

describe('serializeAvailabilityCsv / round-trip property', () => {
  it('writes the exact month header as the first line', () => {
    const csv = serializeAvailabilityCsv([], FEB_2027);
    expect(csv.split('\n')[0]).toBe(availabilityCsvHeader(FEB_2027).join(','));
  });

  it('round-trips a sparse row (only some dates set) through serialize -> parse -> toAvailabilityEntries', () => {
    const rows: AvailabilityCsvExportRow[] = [
      {
        nationalId: '123456782',
        entries: [
          { date: '2027-02-01', shifts: ['A'] },
          { date: '2027-02-04', shifts: ['A', 'B', 'C'] },
          { date: '2027-02-28', shifts: ['B'] },
        ],
      },
    ];
    const csv = serializeAvailabilityCsv(rows, FEB_2027);
    const [raw] = parseAvailabilityCsv(csv, FEB_2027);
    if (!raw) throw new Error('expected one row');
    expect(raw.nationalId).toBe('123456782');
    expect(toAvailabilityEntries(raw, FEB_2027)).toEqual(rows[0]?.entries);
  });

  it('round-trips a fully-unavailable worker (no entries) as all-empty cells', () => {
    const rows: AvailabilityCsvExportRow[] = [{ nationalId: '000000019', entries: [] }];
    const csv = serializeAvailabilityCsv(rows, FEB_2027);
    const [raw] = parseAvailabilityCsv(csv, FEB_2027);
    if (!raw) throw new Error('expected one row');
    expect(toAvailabilityEntries(raw, FEB_2027)).toEqual([]);
  });

  it('round-trips a full month of every-day availability', () => {
    const entries = dayColumns(FEB_2027).map((_, i) => ({
      date: `2027-02-${String(i + 1).padStart(2, '0')}`,
      shifts: ['A', 'B', 'C'] as const,
    }));
    const rows: AvailabilityCsvExportRow[] = [{ nationalId: '123456782', entries }];
    const csv = serializeAvailabilityCsv(rows, FEB_2027);
    const [raw] = parseAvailabilityCsv(csv, FEB_2027);
    if (!raw) throw new Error('expected one row');
    expect(toAvailabilityEntries(raw, FEB_2027)).toEqual(entries);
  });

  it('round-trips a national_id that looks like a spreadsheet formula (formula-injection guard, uniform across columns)', () => {
    const rows: AvailabilityCsvExportRow[] = [
      { nationalId: '=SUM(A1:A99)', entries: [{ date: '2027-02-01', shifts: ['A'] }] },
    ];
    const csv = serializeAvailabilityCsv(rows, FEB_2027);
    // The guard prefix must actually be on the wire, not just conceptually applied.
    expect(csv).toContain("'=SUM(A1:A99)");
    const [raw] = parseAvailabilityCsv(csv, FEB_2027);
    if (!raw) throw new Error('expected one row');
    expect(raw.nationalId).toBe('=SUM(A1:A99)');
    expect(toAvailabilityEntries(raw, FEB_2027)).toEqual(rows[0]?.entries);
  });

  it('round-trips a batch of multiple distinct workers together', () => {
    const rows: AvailabilityCsvExportRow[] = [
      { nationalId: '123456782', entries: [{ date: '2027-02-01', shifts: ['A'] }] },
      { nationalId: '000000019', entries: [] },
      {
        nationalId: '111111117',
        entries: [
          { date: '2027-02-10', shifts: ['B', 'C'] },
          { date: '2027-02-15', shifts: ['A', 'B'] },
        ],
      },
    ];
    const csv = serializeAvailabilityCsv(rows, FEB_2027);
    const parsed = parseAvailabilityCsv(csv, FEB_2027);
    expect(parsed.map((r) => r.nationalId)).toEqual(rows.map((r) => r.nationalId));
    parsed.forEach((raw, i) => {
      expect(toAvailabilityEntries(raw, FEB_2027)).toEqual(rows[i]?.entries);
    });
  });

  it('re-exports for each of the four day-count months unmodified', () => {
    for (const month of [FEB_2027, FEB_2028, APRIL_2027, JAN_2027]) {
      const dayCount = dayColumns(month).length;
      const lastDate = `${month}-${String(dayCount).padStart(2, '0')}`;
      const rows: AvailabilityCsvExportRow[] = [
        { nationalId: '123456782', entries: [{ date: lastDate, shifts: ['C'] }] },
      ];
      const csv = serializeAvailabilityCsv(rows, month);
      expect(csv.split('\n')[0]).toBe(availabilityCsvHeader(month).join(','));
      const [raw] = parseAvailabilityCsv(csv, month);
      if (!raw) throw new Error('expected one row');
      expect(toAvailabilityEntries(raw, month)).toEqual(rows[0]?.entries);
    }
  });
});
