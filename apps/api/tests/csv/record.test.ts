import { describe, expect, it } from 'vitest';
import type { CsvRawRow } from '../../src/csv/columns.js';
import { CSV_COLUMNS } from '../../src/csv/columns.js';
import { CsvFieldError, fromWorkerRecord, toWorkerRecord, type CsvWorkerRecord } from '../../src/csv/record.js';

function baseRecord(overrides: Partial<CsvWorkerRecord> = {}): CsvWorkerRecord {
  return {
    nationalId: '123456782',
    name: 'Dana Levi',
    role: 'SUPERVISOR',
    status: 'ACTIVE',
    hourlyCostIls: 62.5,
    minMonthlyHours: 120,
    maxMonthlyHours: 182,
    ...overrides,
  };
}

describe('fromWorkerRecord / toWorkerRecord (display mapping, no availability columns)', () => {
  it('produces exactly the 7 documented CSV columns, no more, no fewer', () => {
    const raw = fromWorkerRecord(baseRecord());
    expect(Object.keys(raw).sort()).toEqual([...CSV_COLUMNS].sort());
  });

  it('round-trips a record through flatten -> unflatten unchanged', () => {
    const record = baseRecord();
    const raw = fromWorkerRecord(record);
    expect(toWorkerRecord(raw)).toEqual(record);
  });

  it('maps internal role/status enums to display strings and back', () => {
    const record = baseRecord();
    const raw = fromWorkerRecord(record);
    expect(raw.role).toBe('Supervisor');
    expect(raw.status).toBe('Active');
    expect(toWorkerRecord(raw).role).toBe('SUPERVISOR');
    expect(toWorkerRecord(raw).status).toBe('ACTIVE');
  });

  it('throws a field-attributed CsvFieldError for an unknown role display string', () => {
    const raw: CsvRawRow = fromWorkerRecord(baseRecord());
    raw.role = 'Ninja';
    expect(() => toWorkerRecord(raw)).toThrow(CsvFieldError);
    try {
      toWorkerRecord(raw);
      expect.unreachable();
    } catch (err) {
      expect((err as CsvFieldError).field).toBe('role');
    }
  });

  it('throws a field-attributed CsvFieldError for a non-numeric hourly_cost_ils', () => {
    const raw: CsvRawRow = fromWorkerRecord(baseRecord());
    raw.hourly_cost_ils = 'not-a-number';
    try {
      toWorkerRecord(raw);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CsvFieldError);
      expect((err as CsvFieldError).field).toBe('hourly_cost_ils');
    }
  });

  it('throws a field-attributed CsvFieldError for a non-integer min_monthly_hours', () => {
    const raw: CsvRawRow = fromWorkerRecord(baseRecord());
    raw.min_monthly_hours = '12.5';
    try {
      toWorkerRecord(raw);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CsvFieldError);
      expect((err as CsvFieldError).field).toBe('min_monthly_hours');
    }
  });
});
