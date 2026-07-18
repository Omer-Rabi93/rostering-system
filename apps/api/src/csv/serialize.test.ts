import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS } from './columns.js';
import { serializeWorkersCsv } from './serialize.js';
import type { CsvWorkerRecord } from './record.js';

function baseRecord(overrides: Partial<CsvWorkerRecord> = {}): CsvWorkerRecord {
  return {
    nationalId: '123456782',
    name: 'Dana Levi',
    companyName: 'Shamir Security Ltd',
    role: 'SUPERVISOR',
    status: 'ACTIVE',
    hourlyCostIls: 62.5,
    minMonthlyHours: 120,
    maxMonthlyHours: 182,
    ...overrides,
  };
}

describe('serializeWorkersCsv', () => {
  it('writes the exact 8-column header as the first line', () => {
    const csv = serializeWorkersCsv([baseRecord()]);
    expect(csv.split('\n')[0]).toBe(CSV_COLUMNS.join(','));
  });

  it('writes one CSV data line per record, with display strings for role/status', () => {
    const csv = serializeWorkersCsv([baseRecord()]);
    const dataLine = csv.split('\n')[1];
    expect(dataLine).toContain('Supervisor');
    expect(dataLine).toContain('Active');
    expect(dataLine).toContain('62.50');
  });

  it('quotes a field containing a comma so it survives re-parsing as one cell', () => {
    const csv = serializeWorkersCsv([baseRecord({ name: 'Levi, Dana' })]);
    expect(csv).toContain('"Levi, Dana"');
  });

  it('formula-guards a cell whose value starts with a trigger character', () => {
    const csv = serializeWorkersCsv([baseRecord({ name: '=SUM(A1)' })]);
    expect(csv).toContain("'=SUM(A1)");
  });
});
