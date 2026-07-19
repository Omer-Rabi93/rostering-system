import { describe, expect, it } from 'vitest';
import { rosterSchema } from '../../src/index.js';

const validRoster = {
  id: 1,
  month: '2026-07',
  status: 'DRAFT',
  generatedAt: '2026-06-25T06:00:00.000Z',
  publishedAt: null,
  shifts: [
    {
      id: 10,
      date: '2026-07-01',
      shiftType: 'A',
      assignments: [{ workerId: 5, name: 'Dana Levi', role: 'SUPERVISOR' }],
    },
  ],
  alerts: [],
};

describe('rosterSchema', () => {
  it('accepts a valid roster + shifts + assignments + alerts payload', () => {
    const result = rosterSchema.safeParse(validRoster);
    expect(result.success).toBe(true);
  });

  it('rejects a roster with a malformed month', () => {
    const result = rosterSchema.safeParse({ ...validRoster, month: '2026/07' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    const result = rosterSchema.safeParse({ ...validRoster, extra: 'nope' });
    expect(result.success).toBe(false);
  });
});
