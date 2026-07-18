import { describe, expect, it } from 'vitest';
import { monthSchema } from '../index.js';

describe('monthSchema', () => {
  it('accepts a valid YYYY-MM value', () => {
    expect(monthSchema.safeParse('2026-07').success).toBe(true);
  });

  it('rejects a value using the wrong separator', () => {
    expect(monthSchema.safeParse('2026/07').success).toBe(false);
  });

  it('rejects a month number outside 01-12', () => {
    expect(monthSchema.safeParse('2026-13').success).toBe(false);
  });
});
