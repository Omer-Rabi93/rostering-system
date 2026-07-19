import { describe, expect, it } from 'vitest';
import { jobSchema } from '../index.js';

describe('jobSchema', () => {
  it('accepts an in-flight job with a null result', () => {
    const result = jobSchema.safeParse({
      id: '8f1c2b3a-0000-4000-8000-000000000000',
      name: 'workforce-import',
      state: 'active',
      createdAt: '2026-07-17T06:00:00.000Z',
      completedAt: null,
      result: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a completed workforce-import job with a full ImportResult', () => {
    const result = jobSchema.safeParse({
      id: '8f1c2b3a-0000-4000-8000-000000000000',
      name: 'workforce-import',
      state: 'completed',
      createdAt: '2026-07-17T06:00:00.000Z',
      completedAt: '2026-07-17T06:00:05.000Z',
      result: {
        totalRows: 12,
        inserted: 2,
        updated: 8,
        failed: 1,
        errors: [{ row: 4, nationalId: '000000000', field: 'role', message: 'Unknown role' }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a completed workforce-import job whose result is missing required ImportResult fields', () => {
    const result = jobSchema.safeParse({
      id: '8f1c2b3a-0000-4000-8000-000000000000',
      name: 'workforce-import',
      state: 'completed',
      createdAt: '2026-07-17T06:00:00.000Z',
      completedAt: '2026-07-17T06:00:05.000Z',
      result: { totalRows: 12 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a completed workforce-import result carrying the removed v4 deactivation-sweep fields', () => {
    const result = jobSchema.safeParse({
      id: '8f1c2b3a-0000-4000-8000-000000000005',
      name: 'workforce-import',
      state: 'completed',
      createdAt: '2026-07-17T06:00:00.000Z',
      completedAt: '2026-07-17T06:00:05.000Z',
      result: {
        totalRows: 1,
        inserted: 1,
        updated: 0,
        failed: 0,
        deactivated: 0,
        deactivatedWorkers: [],
        errors: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a completed roster-generation job result', () => {
    const result = jobSchema.safeParse({
      id: '8f1c2b3a-0000-4000-8000-000000000001',
      name: 'roster-generation',
      state: 'completed',
      createdAt: '2026-07-17T06:00:00.000Z',
      completedAt: '2026-07-17T06:00:05.000Z',
      result: { rosterId: 42, alertCount: 3 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a failed job carrying an error result', () => {
    const result = jobSchema.safeParse({
      id: '8f1c2b3a-0000-4000-8000-000000000002',
      name: 'roster-generation',
      state: 'failed',
      createdAt: '2026-07-17T06:00:00.000Z',
      completedAt: '2026-07-17T06:00:05.000Z',
      result: { error: 'solver timed out' },
    });
    expect(result.success).toBe(true);
  });
});
