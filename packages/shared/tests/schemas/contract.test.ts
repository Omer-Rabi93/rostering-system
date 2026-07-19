import { describe, expect, it } from 'vitest';
import { contractSchema } from '../../src/index.js';

const validContract = {
  hourlyCostIls: 62.5,
  minMonthlyHours: 120,
  maxMonthlyHours: 182,
};

describe('contractSchema', () => {
  it('accepts a valid contract payload (rate/min/max only)', () => {
    const result = contractSchema.safeParse(validContract);
    expect(result.success).toBe(true);
  });

  it('rejects a negative hourlyCostIls', () => {
    const result = contractSchema.safeParse({ ...validContract, hourlyCostIls: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects minMonthlyHours greater than maxMonthlyHours', () => {
    const result = contractSchema.safeParse({
      ...validContract,
      minMonthlyHours: 200,
      maxMonthlyHours: 180,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer monthly hours', () => {
    expect(contractSchema.safeParse({ ...validContract, minMonthlyHours: 12.5 }).success).toBe(false);
    expect(contractSchema.safeParse({ ...validContract, maxMonthlyHours: 182.5 }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    const result = contractSchema.safeParse({ ...validContract, extra: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects the removed v1 availability fields as unknown keys (availability moved to WorkerAvailability)', () => {
    expect(
      contractSchema.safeParse({
        ...validContract,
        availableDays: [true, true, true, true, true, true, true],
      }).success,
    ).toBe(false);
    expect(
      contractSchema.safeParse({ ...validContract, availableShifts: [true, true, true] }).success,
    ).toBe(false);
    expect(
      contractSchema.safeParse({ ...validContract, availability: [[true, true, true]] }).success,
    ).toBe(false);
  });
});
