import { describe, expect, it } from 'vitest';
import { staffingRequirementsInputSchema } from '../../src/index.js';

describe('staffingRequirementsInputSchema', () => {
  it('accepts an array of unique role x shift cells', () => {
    const result = staffingRequirementsInputSchema.safeParse([
      { role: 'SUPERVISOR', shift: 'A', requiredCount: 1 },
      { role: 'SUPERVISOR', shift: 'B', requiredCount: 1 },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects an array with a duplicate role+shift cell', () => {
    const result = staffingRequirementsInputSchema.safeParse([
      { role: 'SUPERVISOR', shift: 'A', requiredCount: 1 },
      { role: 'SUPERVISOR', shift: 'A', requiredCount: 2 },
    ]);
    expect(result.success).toBe(false);
  });
});
