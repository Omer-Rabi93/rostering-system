import type { FetchBaseQueryError } from '@reduxjs/toolkit/query';
import {
  badRequestErrorSchema,
  conflictMessageErrorSchema,
  conflictWarningErrorSchema,
  notFoundErrorSchema,
  publishConflictErrorSchema,
  unprocessableErrorSchema,
  type BadRequestError,
  type ConflictMessageError,
  type ConflictWarningError,
  type NotFoundError,
  type PublishConflictError,
  type UnprocessableError,
} from '@rostering/shared';

/**
 * Classifies an RTK Query `FetchBaseQueryError` into the app's known error-envelope shapes (per
 * `apps/api/src/middleware/errorHandler.ts` and `@rostering/shared`'s error schemas), so pages
 * (Phase 9) can drive UI off `error.kind` instead of re-deriving the shape from raw
 * `status`/`data` at every call site. Every known shape is re-validated at runtime with its Zod
 * schema (not just an HTTP-status switch) since the whole point of the shared schemas is that
 * they're the single source of truth for what a given status code's body looks like — a 409 with
 * an unrecognized body shape falls through to `unknown` rather than being misclassified.
 */
export type ApiError =
  | { readonly kind: 'badRequest'; readonly status: 400; readonly body: BadRequestError }
  | { readonly kind: 'notFound'; readonly status: 404; readonly body: NotFoundError }
  /** 409 soft-rule warning — the shape the `ConfirmDialog` flow consumes (resubmit with
   * `?confirm=true` on `onConfirm`). */
  | { readonly kind: 'confirmRequired'; readonly status: 409; readonly body: ConflictWarningError }
  /** 409 plain state conflict (duplicate name, delete-with-dependents) — no confirm flow, just a
   * message to surface. */
  | { readonly kind: 'conflictMessage'; readonly status: 409; readonly body: ConflictMessageError }
  /** 409 publish blocked by unacknowledged alerts. */
  | { readonly kind: 'publishBlocked'; readonly status: 409; readonly body: PublishConflictError }
  /** 422 hard-rule violation — the shape the blocking-toast flow consumes; never offers a confirm
   * override. */
  | { readonly kind: 'unprocessable'; readonly status: 422; readonly body: UnprocessableError }
  | { readonly kind: 'unknown'; readonly status: FetchBaseQueryError['status']; readonly body: unknown };

export function classifyApiError(error: FetchBaseQueryError | undefined): ApiError {
  if (!error) {
    return { kind: 'unknown', status: 'CUSTOM_ERROR', body: undefined };
  }

  const { status, data } = error;

  if (status === 400) {
    const parsed = badRequestErrorSchema.safeParse(data);
    if (parsed.success) return { kind: 'badRequest', status: 400, body: parsed.data };
  }
  if (status === 404) {
    const parsed = notFoundErrorSchema.safeParse(data);
    if (parsed.success) return { kind: 'notFound', status: 404, body: parsed.data };
  }
  if (status === 409) {
    const warning = conflictWarningErrorSchema.safeParse(data);
    if (warning.success) return { kind: 'confirmRequired', status: 409, body: warning.data };
    const publishBlocked = publishConflictErrorSchema.safeParse(data);
    if (publishBlocked.success) return { kind: 'publishBlocked', status: 409, body: publishBlocked.data };
    const message = conflictMessageErrorSchema.safeParse(data);
    if (message.success) return { kind: 'conflictMessage', status: 409, body: message.data };
  }
  if (status === 422) {
    const parsed = unprocessableErrorSchema.safeParse(data);
    if (parsed.success) return { kind: 'unprocessable', status: 422, body: parsed.data };
  }

  return { kind: 'unknown', status, body: data };
}

/** Narrows the `unknown` a `.unwrap()`ed RTK Query mutation promise rejects with (or a hook's
 * `error` field, typed `FetchBaseQueryError | SerializedError | undefined`) down to the
 * `FetchBaseQueryError` shape `classifyApiError` understands — a `SerializedError` (thrown for
 * network failures / bugs in a `queryFn`, not a normal HTTP error response) has no `status`. */
export function isFetchBaseQueryError(error: unknown): error is FetchBaseQueryError {
  return typeof error === 'object' && error !== null && 'status' in error;
}

/** Convenience wrapper combining {@link isFetchBaseQueryError} + {@link classifyApiError} for the
 * common case of classifying whatever a mutation's `catch` block or `error` field received,
 * without every call site re-deriving the same narrowing. */
export function classifyMutationError(error: unknown): ApiError {
  return classifyApiError(isFetchBaseQueryError(error) ? error : undefined);
}

export function isConfirmRequiredError(
  error: FetchBaseQueryError | undefined,
): error is FetchBaseQueryError & { status: 409; data: ConflictWarningError } {
  return classifyApiError(error).kind === 'confirmRequired';
}

export function isUnprocessableError(
  error: FetchBaseQueryError | undefined,
): error is FetchBaseQueryError & { status: 422; data: UnprocessableError } {
  return classifyApiError(error).kind === 'unprocessable';
}

export function isPublishBlockedError(
  error: FetchBaseQueryError | undefined,
): error is FetchBaseQueryError & { status: 409; data: PublishConflictError } {
  return classifyApiError(error).kind === 'publishBlocked';
}
