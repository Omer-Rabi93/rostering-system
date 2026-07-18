import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { errorHandler } from '../../src/middleware/errorHandler.js';
import {
  ConflictError,
  ConflictWarningError,
  NotFoundError,
  PublishConflictError,
  UnprocessableError,
} from '../../src/errors.js';

const fakeReq = { method: 'GET', path: '/api/whatever' } as unknown as Request;
const noopNext = vi.fn();

function firstJsonBody(jsonMock: ReturnType<typeof vi.fn>): unknown {
  const call = jsonMock.mock.calls[0];
  if (!call) {
    throw new Error('res.json was never called');
  }
  return call[0];
}

/** Minimal fake `Response` — just enough surface for `errorHandler` to call `.status().json()`,
 * with the mock functions kept as plain local variables so assertions never reference a method
 * through the `Response`-typed object (which would need to carry its own `this` binding). */
function fakeResponse(): { res: Response; statusMock: ReturnType<typeof vi.fn>; jsonMock: ReturnType<typeof vi.fn> } {
  const statusMock = vi.fn().mockReturnThis();
  const jsonMock = vi.fn().mockReturnThis();
  const res = { status: statusMock, json: jsonMock } as unknown as Response;
  return { res, statusMock, jsonMock };
}

describe('errorHandler', () => {
  it('maps a ZodError to a 400 envelope', () => {
    const schema = z.object({ name: z.string() }).strict();
    const result = schema.safeParse({});
    const { res, statusMock, jsonMock } = fakeResponse();

    errorHandler(result.error, fakeReq, res, noopNext);

    expect(statusMock).toHaveBeenCalledWith(400);
    const body = firstJsonBody(jsonMock) as { errors: unknown[] };
    expect(body.errors).toBeInstanceOf(Array);
  });

  it('maps NotFoundError to a 404 envelope', () => {
    const { res, statusMock, jsonMock } = fakeResponse();
    errorHandler(new NotFoundError('Company 1 not found'), fakeReq, res, noopNext);
    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith({ message: 'Company 1 not found' });
  });

  it('maps ConflictError to a 409 message envelope', () => {
    const { res, statusMock, jsonMock } = fakeResponse();
    errorHandler(new ConflictError('duplicate'), fakeReq, res, noopNext);
    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith({ message: 'duplicate' });
  });

  it('maps a ConflictError constructed with a reason to a 409 envelope that includes it', () => {
    const { res, statusMock, jsonMock } = fakeResponse();
    errorHandler(new ConflictError('already published', 'already-published'), fakeReq, res, noopNext);
    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith({ message: 'already published', reason: 'already-published' });
  });

  it('maps ConflictWarningError to a 409 warnings+confirmRequired envelope', () => {
    const { res, statusMock, jsonMock } = fakeResponse();
    errorHandler(
      new ConflictWarningError([{ code: 'exceedsMaxMonthlyHours', detail: { message: 'x' } }]),
      fakeReq,
      res,
      noopNext,
    );
    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith({
      warnings: [{ code: 'exceedsMaxMonthlyHours', detail: { message: 'x' } }],
      confirmRequired: true,
    });
  });

  it('maps UnprocessableError to a 422 violations envelope', () => {
    const { res, statusMock, jsonMock } = fakeResponse();
    errorHandler(
      new UnprocessableError([{ code: 'workerIsActive', detail: { message: 'x' } }]),
      fakeReq,
      res,
      noopNext,
    );
    expect(statusMock).toHaveBeenCalledWith(422);
    expect(jsonMock).toHaveBeenCalledWith({ violations: [{ code: 'workerIsActive', detail: { message: 'x' } }] });
  });

  it('maps PublishConflictError to a 409 unacknowledgedAlertIds envelope', () => {
    const { res, statusMock, jsonMock } = fakeResponse();
    errorHandler(new PublishConflictError([1, 2, 3]), fakeReq, res, noopNext);
    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith({ unacknowledgedAlertIds: [1, 2, 3] });
  });

  it('maps an unexpected error to a generic 500 with no stack trace or internal detail', () => {
    const { res, statusMock, jsonMock } = fakeResponse();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const internalError = new Error('relation "workers" violates constraint fk_company at line 42, query: SELECT *');
    errorHandler(internalError, fakeReq, res, noopNext);

    expect(statusMock).toHaveBeenCalledWith(500);
    const body = firstJsonBody(jsonMock);
    expect(body).toEqual({ message: 'Internal server error' });
    expect(JSON.stringify(body)).not.toContain('relation');
    expect(JSON.stringify(body)).not.toContain('query');

    // The full detail IS logged server-side (never silently dropped) — just never sent to the client.
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
