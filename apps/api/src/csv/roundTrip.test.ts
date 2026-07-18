import { describe, expect, it } from 'vitest';
import { parseWorkersCsv } from './parse.js';
import { serializeWorkersCsv } from './serialize.js';
import { toWorkerRecord, type CsvWorkerRecord } from './record.js';

function record(overrides: Partial<CsvWorkerRecord> = {}): CsvWorkerRecord {
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

/** export -> import must reproduce the original record exactly, for every fixture below. This is
 * the property the design doc calls for: "export -> import produces an unchanged worker+contract
 * record", proved across edge-case records and the formula-injection guard. */
function roundTrip(input: CsvWorkerRecord): CsvWorkerRecord {
  const csv = serializeWorkersCsv([input]);
  const rows = parseWorkersCsv(csv);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error('expected exactly one parsed row');
  return toWorkerRecord(row);
}

describe('CSV round-trip property (export -> import unchanged)', () => {
  it('round-trips a plain record unchanged', () => {
    expect(roundTrip(record())).toEqual(record());
  });

  it('round-trips every role and status combination', () => {
    for (const role of ['GENERAL_GUARD', 'SUPERVISOR', 'SCREENER'] as const) {
      for (const status of ['ACTIVE', 'INACTIVE'] as const) {
        expect(roundTrip(record({ role, status }))).toEqual(record({ role, status }));
      }
    }
  });

  it('round-trips a name that looks like a spreadsheet formula (formula-injection guard)', () => {
    const withFormula = record({ name: '=SUM(A1:A99)' });
    const csv = serializeWorkersCsv([withFormula]);
    // The guard prefix must actually be on the wire, not just conceptually applied.
    expect(csv).toContain("'=SUM(A1:A99)");
    expect(roundTrip(withFormula)).toEqual(withFormula);
  });

  it('round-trips every documented formula-trigger character as the first character of a name', () => {
    for (const trigger of ['=', '+', '-', '@']) {
      const withTrigger = record({ name: `${trigger}malicious` });
      expect(roundTrip(withTrigger)).toEqual(withTrigger);
    }
  });

  it('round-trips a company name containing a comma', () => {
    const withComma = record({ companyName: 'Shamir, Levi & Co.' });
    expect(roundTrip(withComma)).toEqual(withComma);
  });

  it('round-trips a batch of multiple distinct records together', () => {
    const records = [
      record({ nationalId: '123456782' }),
      record({ nationalId: '000000019', name: 'Second Worker' }),
      record({ nationalId: '111111117', name: 'Third, Worker' }),
    ];
    const csv = serializeWorkersCsv(records);
    const rows = parseWorkersCsv(csv);
    expect(rows.map(toWorkerRecord)).toEqual(records);
  });
});
