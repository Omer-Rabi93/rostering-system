import { describe, expect, it } from 'vitest';
import { workerSchema } from '../index.js';

const validWorker = {
  nationalId: '111111118',
  name: 'Dana Levi',
  role: 'SUPERVISOR',
  status: 'ACTIVE',
  companyId: 1,
};

describe('workerSchema', () => {
  it('accepts a valid worker payload', () => {
    const result = workerSchema.safeParse(validWorker);
    expect(result.success).toBe(true);
  });

  it('rejects a nationalId that fails the Israeli ID checksum', () => {
    const result = workerSchema.safeParse({ ...validWorker, nationalId: '111111111' });
    expect(result.success).toBe(false);
  });

  it('rejects a name longer than 120 characters', () => {
    const result = workerSchema.safeParse({ ...validWorker, name: 'x'.repeat(121) });
    expect(result.success).toBe(false);
  });

  it('rejects an unrecognized role value', () => {
    const result = workerSchema.safeParse({ ...validWorker, role: 'MANAGER' });
    expect(result.success).toBe(false);
  });

  it('rejects an unrecognized status value', () => {
    const result = workerSchema.safeParse({ ...validWorker, status: 'ON_LEAVE' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys', () => {
    const result = workerSchema.safeParse({ ...validWorker, extra: 'nope' });
    expect(result.success).toBe(false);
  });
});
