// Minimal server-side logging helper. Errors are logged with full detail (for operators) but
// worker national IDs (9-digit Israeli IDs, `workers.nationalId`) must never appear in full in a
// structured log line — mask every 9-digit run down to its last 4 digits before it is written.

/** Masks a single national-ID-shaped value to its last 4 digits, e.g. "123456782" -> "*****6782". */
export function maskNationalId(nationalId: string): string {
  if (nationalId.length <= 4) {
    return '*'.repeat(nationalId.length);
  }
  return '*'.repeat(nationalId.length - 4) + nationalId.slice(-4);
}

/** Redacts every free-standing 9-digit run (the shape of a `workers.nationalId`) in a log line. */
export function redactNationalIds(text: string): string {
  return text.replace(/\b\d{9}\b/g, (match) => maskNationalId(match));
}

/**
 * Logs an unexpected error server-side only (full stack trace, redacted of national IDs). Callers
 * (the error-handling middleware) never forward this detail to the HTTP client — clients only ever
 * see the generic 500 envelope.
 */
export function logServerError(context: string, err: unknown): void {
  const raw = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[${context}]`, redactNationalIds(raw));
}
