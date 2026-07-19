import type { FetchBaseQueryError } from '@reduxjs/toolkit/query';
import { describe, expect, it } from 'vitest';

import { classifyApiError, isConfirmRequiredError, isPublishBlockedError, isUnprocessableError } from '../../src/api/errors.js';

describe('classifyApiError', () => {
  it('classifies a 409 confirmRequired body into the ConfirmDialog shape', () => {
    const error: FetchBaseQueryError = {
      status: 409,
      data: { warnings: [{ code: 'exceedsMaxMonthlyHours', detail: { hours: 3 } }], confirmRequired: true },
    };

    const classified = classifyApiError(error);

    expect(classified.kind).toBe('confirmRequired');
    if (classified.kind === 'confirmRequired') {
      expect(classified.body.warnings).toHaveLength(1);
      expect(classified.body.confirmRequired).toBe(true);
    }
    expect(isConfirmRequiredError(error)).toBe(true);
    expect(isUnprocessableError(error)).toBe(false);
  });

  it('classifies a 422 body into the blocking-toast shape', () => {
    const error: FetchBaseQueryError = {
      status: 422,
      data: { violations: [{ code: 'maxTwoShiftsPerDay', detail: { message: 'blocked' } }] },
    };

    const classified = classifyApiError(error);

    expect(classified.kind).toBe('unprocessable');
    if (classified.kind === 'unprocessable') {
      expect(classified.body.violations[0]?.code).toBe('maxTwoShiftsPerDay');
    }
    expect(isUnprocessableError(error)).toBe(true);
    expect(isConfirmRequiredError(error)).toBe(false);
  });

  it('classifies a 409 publish-blocked body distinctly from a soft-warning 409', () => {
    const error: FetchBaseQueryError = { status: 409, data: { unacknowledgedAlertIds: [1, 2, 3] } };

    const classified = classifyApiError(error);

    expect(classified.kind).toBe('publishBlocked');
    if (classified.kind === 'publishBlocked') {
      expect(classified.body.unacknowledgedAlertIds).toEqual([1, 2, 3]);
    }
    expect(isPublishBlockedError(error)).toBe(true);
  });

  it('classifies a plain 409 message body (duplicate name, delete-with-dependents)', () => {
    const error: FetchBaseQueryError = { status: 409, data: { message: 'Company name "Acme" already exists' } };

    const classified = classifyApiError(error);

    expect(classified.kind).toBe('conflictMessage');
    if (classified.kind === 'conflictMessage') {
      expect(classified.body.message).toContain('already exists');
    }
  });

  it('classifies a 400 Zod validation body', () => {
    const error: FetchBaseQueryError = {
      status: 400,
      data: { errors: [{ path: 'nationalId', message: 'Invalid Israeli ID checksum' }] },
    };

    expect(classifyApiError(error).kind).toBe('badRequest');
  });

  it('classifies a 404 body', () => {
    const error: FetchBaseQueryError = { status: 404, data: { message: 'Worker 999 not found' } };

    expect(classifyApiError(error).kind).toBe('notFound');
  });

  it('falls back to "unknown" for a 500 or a body shape that fails every schema', () => {
    const generic500: FetchBaseQueryError = { status: 500, data: { stack: 'should never be surfaced' } };
    expect(classifyApiError(generic500).kind).toBe('unknown');

    const malformed409: FetchBaseQueryError = { status: 409, data: { unexpected: true } };
    expect(classifyApiError(malformed409).kind).toBe('unknown');
  });

  it('falls back to "unknown" for an undefined error (no error present)', () => {
    expect(classifyApiError(undefined).kind).toBe('unknown');
  });
});
