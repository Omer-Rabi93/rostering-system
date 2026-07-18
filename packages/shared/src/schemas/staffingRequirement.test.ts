import { describe, expect, it } from 'vitest';
import { staffingRequirementSchema } from '../index.js';

const validCell = { role: 'SUPERVISOR', shift: 'A', requiredCount: 2 };

describe('staffingRequirementSchema', () => {
  it('accepts a valid role x shift requirement cell', () => {
    const result = staffingRequirementSchema.safeParse(validCell);
    expect(result.success).toBe(true);
  });

  it('rejects a negative requiredCount', () => {
    const result = staffingRequirementSchema.safeParse({ ...validCell, requiredCount: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys', () => {
    const result = staffingRequirementSchema.safeParse({ ...validCell, extra: 'nope' });
    expect(result.success).toBe(false);
  });
});
