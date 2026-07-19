import { describe, expect, it } from 'vitest';
import { costSummarySchema } from '../../src/index.js';

const validSummary = {
  totalIls: 5000,
  perCompany: [{ companyId: 1, name: 'Shamir Security Ltd', costIls: 5000 }],
  perWorker: [{ workerId: 5, shifts: 10, hours: 80, costIls: 5000 }],
};

describe('costSummarySchema', () => {
  it('accepts a valid cost summary payload', () => {
    const result = costSummarySchema.safeParse(validSummary);
    expect(result.success).toBe(true);
  });

  it('rejects unknown top-level keys', () => {
    const result = costSummarySchema.safeParse({ ...validSummary, extra: 'nope' });
    expect(result.success).toBe(false);
  });
});
