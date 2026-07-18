import { describe, expect, it } from 'vitest';
import { jobSchema } from '../index.js';

describe('jobSchema', () => {
  it('accepts an in-flight job with a null result', () => {
    const result = jobSchema.safeParse({
      id: '8f1c2b3a-0000-4000-8000-000000000000',
      name: 'csv-import',
      state: 'active',
      createdAt: '2026-07-17T06:00:00.000Z',
      completedAt: null,
      result: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a completed csv-import job with a full ImportResult', () => {
    const result = jobSchema.safeParse({
      id: '8f1c2b3a-0000-4000-8000-000000000000',
      name: 'csv-import',
      state: 'completed',
      createdAt: '2026-07-17T06:00:00.000Z',
      completedAt: '2026-07-17T06:00:05.000Z',
      result: {
        totalRows: 12,
        inserted: 2,
        updated: 8,
        failed: 1,
        deactivated: 1,
        deactivatedWorkers: [{ workerId: 3, nationalId: '111111118', name: 'Old Worker' }],
        errors: [{ row: 4, nationalId: '000000000', field: 'role', message: 'Unknown role' }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a completed csv-import job whose result is missing required ImportResult fields', () => {
    const result = jobSchema.safeParse({
      id: '8f1c2b3a-0000-4000-8000-000000000000',
      name: 'csv-import',
      state: 'completed',
      createdAt: '2026-07-17T06:00:00.000Z',
      completedAt: '2026-07-17T06:00:05.000Z',
      result: { totalRows: 12 },
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

  it('accepts a completed availability-import job result (no deactivation fields)', () => {
    const result = jobSchema.safeParse({
      id: '8f1c2b3a-0000-4000-8000-000000000003',
      name: 'availability-import',
      state: 'completed',
      createdAt: '2026-07-17T06:00:00.000Z',
      completedAt: '2026-07-17T06:00:05.000Z',
      result: {
        totalRows: 3,
        applied: 2,
        failed: 1,
        errors: [{ row: 2, nationalId: '000000000', field: 'd05', message: 'Illegal shift subset "AD"' }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an availability-import result carrying a worker-CSV-only deactivation field', () => {
    const result = jobSchema.safeParse({
      id: '8f1c2b3a-0000-4000-8000-000000000004',
      name: 'availability-import',
      state: 'completed',
      createdAt: '2026-07-17T06:00:00.000Z',
      completedAt: '2026-07-17T06:00:05.000Z',
      result: { totalRows: 1, applied: 1, failed: 0, deactivated: 0, errors: [] },
    });
    expect(result.success).toBe(false);
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
