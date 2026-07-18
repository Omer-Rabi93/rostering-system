import { isValidIsraeliId } from '@rostering/shared';

/**
 * Live client-side Israeli-ID validation for the worker form's National ID field — surfaced
 * through `FormField`'s `aria-invalid`/`aria-describedby` (never a bare error `<div>`), checked
 * on every keystroke so a planner sees the checksum failure before ever submitting. The server
 * re-validates independently (`workerSchema` in `@rostering/shared`) and remains the source of
 * truth — a 409 duplicate-ID response is a separate, server-only error this function can't catch.
 */
export function validateNationalId(raw: string): string | null {
  if (raw.trim() === '') {
    return 'National ID is required.';
  }
  if (!/^\d{1,9}$/.test(raw)) {
    return 'National ID must be 1-9 digits.';
  }
  if (!isValidIsraeliId(raw)) {
    return 'Invalid Israeli ID — checksum failed.';
  }
  return null;
}
