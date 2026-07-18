import { describe, expect, it } from 'vitest';
import { companySchema } from '../index.js';

describe('companySchema', () => {
  it('accepts a valid company payload', () => {
    const result = companySchema.safeParse({ name: 'Shamir Security Ltd' });
    expect(result.success).toBe(true);
  });

  it('rejects a name longer than 120 characters', () => {
    const result = companySchema.safeParse({ name: 'x'.repeat(121) });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys', () => {
    const result = companySchema.safeParse({ name: 'Shamir Security Ltd', extra: 'nope' });
    expect(result.success).toBe(false);
  });
});
