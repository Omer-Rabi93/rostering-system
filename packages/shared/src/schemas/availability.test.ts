import { describe, expect, it } from 'vitest';
import { availabilityEntrySchema, monthAvailabilitySchema, shiftSubsetSchema } from '../index.js';

describe('shiftSubsetSchema', () => {
  it.each([[['A']], [['B']], [['C']], [['A', 'B']], [['A', 'C']], [['B', 'C']], [['A', 'B', 'C']]])(
    'accepts the canonical subset %j',
    (subset) => {
      expect(shiftSubsetSchema.safeParse(subset).success).toBe(true);
    },
  );

  it('rejects the empty subset (unavailable is represented by absence, never [])', () => {
    expect(shiftSubsetSchema.safeParse([]).success).toBe(false);
  });

  it('rejects duplicate letters', () => {
    expect(shiftSubsetSchema.safeParse(['A', 'A']).success).toBe(false);
  });

  it('rejects non-canonical order (must be A<B<C)', () => {
    expect(shiftSubsetSchema.safeParse(['B', 'A']).success).toBe(false);
    expect(shiftSubsetSchema.safeParse(['C', 'A', 'B']).success).toBe(false);
  });

  it('rejects unknown shift letters', () => {
    expect(shiftSubsetSchema.safeParse(['D']).success).toBe(false);
    expect(shiftSubsetSchema.safeParse(['A', 'D']).success).toBe(false);
  });

  it('rejects more than three entries', () => {
    expect(shiftSubsetSchema.safeParse(['A', 'B', 'C', 'C']).success).toBe(false);
  });

  it('rejects a plain string like "AB" (the CSV cell form is parsed elsewhere)', () => {
    expect(shiftSubsetSchema.safeParse('AB').success).toBe(false);
  });
});

describe('availabilityEntrySchema', () => {
  const schema = availabilityEntrySchema('2026-08');

  it('accepts an entry with a date inside the month and a legal subset', () => {
    const result = schema.safeParse({ date: '2026-08-03', shifts: ['A'] });
    expect(result.success).toBe(true);
  });

  it('rejects a date in a different month', () => {
    expect(schema.safeParse({ date: '2026-07-31', shifts: ['A'] }).success).toBe(false);
    expect(schema.safeParse({ date: '2026-09-01', shifts: ['A'] }).success).toBe(false);
  });

  it('rejects a day number past the end of the month', () => {
    expect(schema.safeParse({ date: '2026-08-32', shifts: ['A'] }).success).toBe(false);
    // Non-leap February: 29 does not exist.
    expect(availabilityEntrySchema('2026-02').safeParse({ date: '2026-02-29', shifts: ['A'] }).success).toBe(false);
  });

  it('accepts Feb 29 in a leap year', () => {
    expect(availabilityEntrySchema('2028-02').safeParse({ date: '2028-02-29', shifts: ['A'] }).success).toBe(true);
  });

  it('rejects day 00 and malformed dates', () => {
    expect(schema.safeParse({ date: '2026-08-00', shifts: ['A'] }).success).toBe(false);
    expect(schema.safeParse({ date: '2026-08-3', shifts: ['A'] }).success).toBe(false);
    expect(schema.safeParse({ date: 'not-a-date', shifts: ['A'] }).success).toBe(false);
  });

  it('rejects an empty or non-canonical shifts subset', () => {
    expect(schema.safeParse({ date: '2026-08-03', shifts: [] }).success).toBe(false);
    expect(schema.safeParse({ date: '2026-08-03', shifts: ['B', 'A'] }).success).toBe(false);
  });

  it('rejects unknown keys (.strict())', () => {
    expect(schema.safeParse({ date: '2026-08-03', shifts: ['A'], extra: 1 }).success).toBe(false);
  });

  it('rejects a missing shifts key entirely (sparse payloads omit the whole entry instead)', () => {
    expect(schema.safeParse({ date: '2026-08-03' }).success).toBe(false);
  });
});

describe('monthAvailabilitySchema', () => {
  const schema = monthAvailabilitySchema('2026-08');

  it('accepts a per-worker map of date -> shift subset (sparse: only available dates present)', () => {
    const result = schema.safeParse({
      '1': { '2026-08-03': ['A'], '2026-08-04': ['A', 'B', 'C'] },
      '2': { '2026-08-10': ['B', 'C'] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty map and a worker with an empty date map (worker entirely unavailable)', () => {
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ '1': {} }).success).toBe(true);
  });

  it('rejects non-numeric worker keys', () => {
    expect(schema.safeParse({ abc: { '2026-08-03': ['A'] } }).success).toBe(false);
    expect(schema.safeParse({ '1.5': { '2026-08-03': ['A'] } }).success).toBe(false);
  });

  it('rejects dates outside the month', () => {
    expect(schema.safeParse({ '1': { '2026-07-31': ['A'] } }).success).toBe(false);
    expect(schema.safeParse({ '1': { '2026-08-32': ['A'] } }).success).toBe(false);
  });

  it('rejects empty or non-canonical subsets as cell values', () => {
    expect(schema.safeParse({ '1': { '2026-08-03': [] } }).success).toBe(false);
    expect(schema.safeParse({ '1': { '2026-08-03': ['C', 'A'] } }).success).toBe(false);
  });

  it('rejects a non-object cell value', () => {
    expect(schema.safeParse({ '1': [['A']] }).success).toBe(false);
  });
});
