import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contractSchema, workerSchema } from '@rostering/shared';

import { parseWorkersCsv, toWorkerRecord } from '../../src/csv/index.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.resolve(currentDir, '../../../../samples/workers-sample.csv');

describe('samples/workers-sample.csv', () => {
  it('has at least 10 workers and parses/validates cleanly against the shared schemas', () => {
    const csvText = readFileSync(SAMPLE_PATH, 'utf8');
    const rows = parseWorkersCsv(csvText);

    expect(rows.length).toBeGreaterThanOrEqual(10);

    for (const raw of rows) {
      const record = toWorkerRecord(raw);
      expect(() =>
        workerSchema.parse({
          nationalId: record.nationalId,
          name: record.name,
          role: record.role,
          status: record.status,
          companyId: 1, // placeholder -- companyId itself isn't part of the CSV
        }),
      ).not.toThrow();
      expect(() =>
        contractSchema.parse({
          hourlyCostIls: record.hourlyCostIls,
          minMonthlyHours: record.minMonthlyHours,
          maxMonthlyHours: record.maxMonthlyHours,
        }),
      ).not.toThrow();
    }
  });
});
