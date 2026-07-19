import { describe, expect, it } from 'vitest';
import type { Month } from '@rostering/shared';

import { CsvFieldError } from '../../src/csv/record.js';
import { AvailabilityCsvCellError, dayColumns } from '../../src/csv/availability.js';
import {
  WorkforceCsvHeaderError,
  WorkforceCsvRowShapeError,
  parseWorkforceCsv,
  serializeWorkforceCsv,
  toWorkforceRow,
  workforceCsvHeader,
  type WorkforceCsvExportRow,
} from '../../src/csv/workforce.js';

const FEB_2027 = '2027-02' as Month; // 28 days, non-leap
const JAN_2027 = '2027-01' as Month; // 31 days

const WORKER_FIELDS = ['123456782', 'Dana Levi', 'Supervisor', 'Active', '62.50', '120', '182'];

function row(fields: string[] = WORKER_FIELDS, cells: Record<string, string> = {}): string {
  return [...fields, ...dayColumns(FEB_2027).map((c) => cells[c] ?? '')].join(',');
}

describe('workforceCsvHeader', () => {
  it('is the 7 worker columns followed by the month\'s day columns', () => {
    const header = workforceCsvHeader(FEB_2027);
    expect(header.slice(0, 7)).toEqual([
      'national_id',
      'name',
      'role',
      'status',
      'hourly_cost_ils',
      'min_monthly_hours',
      'max_monthly_hours',
    ]);
    expect(header).toHaveLength(7 + 28);
    expect(header[7]).toBe('d01');
    expect(header.at(-1)).toBe('d28');
  });
});

describe('parseWorkforceCsv', () => {
  const header = workforceCsvHeader(FEB_2027).join(',');

  it('parses a well-formed row into worker fields + day cells, unguarded', () => {
    const csv = `${header}\n${row(WORKER_FIELDS, { d01: 'A', d02: 'ABC' })}\n`;
    const rows = parseWorkforceCsv(csv, FEB_2027);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rowNumber).toBe(1);
    expect(rows[0]?.worker).toEqual({
      national_id: '123456782',
      name: 'Dana Levi',
      role: 'Supervisor',
      status: 'Active',
      hourly_cost_ils: '62.50',
      min_monthly_hours: '120',
      max_monthly_hours: '182',
    });
    expect(rows[0]?.cells.d01).toBe('A');
    expect(rows[0]?.cells.d02).toBe('ABC');
    expect(rows[0]?.cells.d03).toBe('');
  });

  it('rejects a header with the wrong day count for the target month', () => {
    const wrongMonthHeader = workforceCsvHeader(JAN_2027).join(','); // 31-day header
    expect(() => parseWorkforceCsv(`${wrongMonthHeader}\n`, FEB_2027)).toThrow(WorkforceCsvHeaderError);
  });

  it('rejects a header missing the worker columns entirely', () => {
    const availabilityOnlyHeader = ['national_id', ...dayColumns(FEB_2027)].join(',');
    expect(() => parseWorkforceCsv(`${availabilityOnlyHeader}\n`, FEB_2027)).toThrow(WorkforceCsvHeaderError);
  });

  it('rejects an empty file', () => {
    expect(() => parseWorkforceCsv('', FEB_2027)).toThrow(WorkforceCsvHeaderError);
  });

  it('rejects a data row with the wrong number of fields', () => {
    const shortRow = row().split(',').slice(0, -1).join(',');
    expect(() => parseWorkforceCsv(`${header}\n${shortRow}\n`, FEB_2027)).toThrow(WorkforceCsvRowShapeError);
  });

  it('strips the formula-injection guard prefix off worker cells and dNN cells alike', () => {
    const guardedRow = row(["'=cmd|/C calc", 'Dana Levi', 'Supervisor', 'Active', '62.50', '120', '182'], { d01: "'-A" });
    const [parsed] = parseWorkforceCsv(`${header}\n${guardedRow}\n`, FEB_2027);
    expect(parsed?.worker.national_id).toBe('=cmd|/C calc');
    expect(parsed?.cells.d01).toBe('-A');
  });

  it('returns an empty array for a header-only file', () => {
    expect(parseWorkforceCsv(`${header}\n`, FEB_2027)).toEqual([]);
  });
});

describe('toWorkforceRow', () => {
  it('validates worker fields and day cells together into domain shape', () => {
    const [raw] = parseWorkforceCsv(
      `${workforceCsvHeader(FEB_2027).join(',')}\n${row(WORKER_FIELDS, { d01: 'A', d03: 'BC' })}\n`,
      FEB_2027,
    );
    if (!raw) throw new Error('expected one row');
    const result = toWorkforceRow(raw, FEB_2027);
    expect(result.record).toEqual({
      nationalId: '123456782',
      name: 'Dana Levi',
      role: 'SUPERVISOR',
      status: 'ACTIVE',
      hourlyCostIls: 62.5,
      minMonthlyHours: 120,
      maxMonthlyHours: 182,
    });
    expect(result.entries).toEqual([
      { date: '2027-02-01', shifts: ['A'] },
      { date: '2027-02-03', shifts: ['B', 'C'] },
    ]);
  });

  it('an all-empty availability row produces zero entries (fully available, not a crash)', () => {
    const [raw] = parseWorkforceCsv(`${workforceCsvHeader(FEB_2027).join(',')}\n${row()}\n`, FEB_2027);
    if (!raw) throw new Error('expected one row');
    expect(toWorkforceRow(raw, FEB_2027).entries).toEqual([]);
  });

  it('a bad worker field throws CsvFieldError attributed to that field, BEFORE any day cell is examined', () => {
    const [raw] = parseWorkforceCsv(
      `${workforceCsvHeader(FEB_2027).join(',')}\n${row(
        ['123456782', 'Dana Levi', 'Not A Role', 'Active', '62.50', '120', '182'],
        { d01: 'AD' }, // also-illegal day cell -- must never be reached
      )}\n`,
      FEB_2027,
    );
    if (!raw) throw new Error('expected one row');
    try {
      toWorkforceRow(raw, FEB_2027);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CsvFieldError);
      expect((err as CsvFieldError).field).toBe('role');
    }
  });

  it('a bad dNN cell throws AvailabilityCsvCellError attributed to that column', () => {
    const [raw] = parseWorkforceCsv(
      `${workforceCsvHeader(FEB_2027).join(',')}\n${row(WORKER_FIELDS, { d05: 'AD' })}\n`,
      FEB_2027,
    );
    if (!raw) throw new Error('expected one row');
    try {
      toWorkforceRow(raw, FEB_2027);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AvailabilityCsvCellError);
      expect((err as AvailabilityCsvCellError).field).toBe('d05');
    }
  });
});

describe('serializeWorkforceCsv / round-trip property', () => {
  it('writes the exact combined header as the first line', () => {
    const csv = serializeWorkforceCsv([], FEB_2027);
    expect(csv.split('\n')[0]).toBe(workforceCsvHeader(FEB_2027).join(','));
  });

  it('round-trips a worker with sparse availability through serialize -> parse -> toWorkforceRow', () => {
    const rows: WorkforceCsvExportRow[] = [
      {
        record: {
          nationalId: '123456782',
          name: 'Dana Levi',
          role: 'SUPERVISOR',
          status: 'ACTIVE',
          hourlyCostIls: 62.5,
          minMonthlyHours: 120,
          maxMonthlyHours: 182,
        },
        entries: [
          { date: '2027-02-01', shifts: ['A'] },
          { date: '2027-02-04', shifts: ['A', 'B', 'C'] },
          { date: '2027-02-28', shifts: ['B'] },
        ],
      },
    ];
    const csv = serializeWorkforceCsv(rows, FEB_2027);
    const [raw] = parseWorkforceCsv(csv, FEB_2027);
    if (!raw) throw new Error('expected one row');
    const parsed = toWorkforceRow(raw, FEB_2027);
    expect(parsed.record).toEqual(rows[0]?.record);
    expect(parsed.entries).toEqual(rows[0]?.entries);
  });

  it('round-trips a worker with no availability entries as all-empty dNN cells', () => {
    const rows: WorkforceCsvExportRow[] = [
      {
        record: {
          nationalId: '000000019',
          name: 'Second Worker',
          role: 'GENERAL_GUARD',
          status: 'INACTIVE',
          hourlyCostIls: 45,
          minMonthlyHours: 80,
          maxMonthlyHours: 160,
        },
        entries: [],
      },
    ];
    const csv = serializeWorkforceCsv(rows, FEB_2027);
    const [raw] = parseWorkforceCsv(csv, FEB_2027);
    if (!raw) throw new Error('expected one row');
    expect(toWorkforceRow(raw, FEB_2027).entries).toEqual([]);
  });

  it('round-trips a name that looks like a spreadsheet formula (formula-injection guard, uniform across columns)', () => {
    const rows: WorkforceCsvExportRow[] = [
      {
        record: {
          nationalId: '123456782',
          name: '=SUM(A1:A99)',
          role: 'SCREENER',
          status: 'ACTIVE',
          hourlyCostIls: 50,
          minMonthlyHours: 100,
          maxMonthlyHours: 160,
        },
        entries: [{ date: '2027-02-01', shifts: ['A'] }],
      },
    ];
    const csv = serializeWorkforceCsv(rows, FEB_2027);
    expect(csv).toContain("'=SUM(A1:A99)");
    const [raw] = parseWorkforceCsv(csv, FEB_2027);
    if (!raw) throw new Error('expected one row');
    const parsed = toWorkforceRow(raw, FEB_2027);
    expect(parsed.record.name).toBe('=SUM(A1:A99)');
    expect(parsed.entries).toEqual(rows[0]?.entries);
  });

  it('round-trips a batch of multiple distinct workers together', () => {
    const rows: WorkforceCsvExportRow[] = [
      {
        record: {
          nationalId: '123456782',
          name: 'Dana Levi',
          role: 'SUPERVISOR',
          status: 'ACTIVE',
          hourlyCostIls: 62.5,
          minMonthlyHours: 120,
          maxMonthlyHours: 182,
        },
        entries: [{ date: '2027-02-01', shifts: ['A'] }],
      },
      {
        record: {
          nationalId: '000000019',
          name: 'Second, Worker',
          role: 'GENERAL_GUARD',
          status: 'INACTIVE',
          hourlyCostIls: 45,
          minMonthlyHours: 80,
          maxMonthlyHours: 160,
        },
        entries: [],
      },
    ];
    const csv = serializeWorkforceCsv(rows, FEB_2027);
    const parsed = parseWorkforceCsv(csv, FEB_2027);
    expect(parsed.map((r) => r.worker.national_id)).toEqual(rows.map((r) => r.record.nationalId));
    parsed.forEach((raw, i) => {
      const result = toWorkforceRow(raw, FEB_2027);
      expect(result.record).toEqual(rows[i]?.record);
      expect(result.entries).toEqual(rows[i]?.entries);
    });
  });
});
