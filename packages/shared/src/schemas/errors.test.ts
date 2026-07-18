import { describe, expect, it } from 'vitest';
import {
  badRequestErrorSchema,
  conflictMessageErrorSchema,
  conflictWarningErrorSchema,
  notFoundErrorSchema,
  publishConflictErrorSchema,
  unprocessableErrorSchema,
} from '../index.js';

describe('badRequestErrorSchema (400 Zod validation failure envelope)', () => {
  it('accepts a valid { errors: [{path, message}] } envelope', () => {
    const result = badRequestErrorSchema.safeParse({
      errors: [{ path: 'nationalId', message: 'Invalid Israeli ID checksum' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an errors row missing the message field', () => {
    const result = badRequestErrorSchema.safeParse({ errors: [{ path: 'nationalId' }] });
    expect(result.success).toBe(false);
  });
});

describe('notFoundErrorSchema (404)', () => {
  it('accepts a valid { message } envelope', () => {
    expect(notFoundErrorSchema.safeParse({ message: 'Worker not found' }).success).toBe(true);
  });
});

describe('unprocessableErrorSchema (422 hard-rule violation)', () => {
  it('accepts a valid { violations: [{code, detail}] } envelope', () => {
    const result = unprocessableErrorSchema.safeParse({
      violations: [{ code: 'maxTwoShiftsPerDay', detail: { workerId: 5, date: '2026-07-01' } }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a violations row missing the code field', () => {
    const result = unprocessableErrorSchema.safeParse({
      violations: [{ detail: { workerId: 5 } }],
    });
    expect(result.success).toBe(false);
  });
});

describe('conflictWarningErrorSchema (409 soft-rule warning)', () => {
  it('accepts a valid { warnings, confirmRequired: true } envelope', () => {
    const result = conflictWarningErrorSchema.safeParse({
      warnings: [{ code: 'belowMinMonthlyHours', detail: { workerId: 5, deficitHours: 4 } }],
      confirmRequired: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects confirmRequired: false (must always be the literal true)', () => {
    const result = conflictWarningErrorSchema.safeParse({
      warnings: [{ code: 'belowMinMonthlyHours', detail: {} }],
      confirmRequired: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('conflictMessageErrorSchema (409 plain state conflict)', () => {
  it('accepts a valid { message } envelope', () => {
    const result = conflictMessageErrorSchema.safeParse({
      message: 'Company still has workers',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an optional machine-readable reason distinguishing roster-generation conflict causes', () => {
    const alreadyPublished = conflictMessageErrorSchema.safeParse({
      message: 'Roster for 2026-08 is already published',
      reason: 'already-published',
    });
    expect(alreadyPublished.success).toBe(true);

    const inProgress = conflictMessageErrorSchema.safeParse({
      message: 'A roster-generation job for 2026-08 is already in flight',
      reason: 'generation-in-progress',
    });
    expect(inProgress.success).toBe(true);
  });

  it('rejects an unrecognized reason value', () => {
    const result = conflictMessageErrorSchema.safeParse({
      message: 'x',
      reason: 'something-else',
    });
    expect(result.success).toBe(false);
  });
});

describe('publishConflictErrorSchema (409 unacknowledged alerts)', () => {
  it('accepts a valid { unacknowledgedAlertIds } envelope', () => {
    const result = publishConflictErrorSchema.safeParse({ unacknowledgedAlertIds: [1, 2, 3] });
    expect(result.success).toBe(true);
  });

  it('rejects a non-integer id in unacknowledgedAlertIds', () => {
    const result = publishConflictErrorSchema.safeParse({ unacknowledgedAlertIds: [1, 2.5] });
    expect(result.success).toBe(false);
  });
});
