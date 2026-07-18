/** Each roster shift is a fixed 8-hour block: A 00:00–08:00, B 08:00–16:00, C 16:00–00:00. */
export const SHIFT_HOURS = 8;

/** The three fixed daily shifts, in order. */
export const SHIFT_TYPES = ['A', 'B', 'C'] as const;
export type ShiftType = (typeof SHIFT_TYPES)[number];

/**
 * Availability v3 exclusion semantics: `WorkerAvailability.excludedShifts` stores the shifts a
 * worker CANNOT work a given date; absence of a row means available for every shift. This is the
 * single shared computation that turns a stored excluded-set into the actually-available subset,
 * reused by every call site that needs "what can this worker work" (the solver-problem feed in
 * `rosterGenerationService.ts` and the manual-edit validator's context feed in
 * `shiftWorkerService.ts`) rather than duplicating the `SHIFT_TYPES.filter(...)` line in both.
 *
 * `excludedShifts === undefined` covers BOTH "no `WorkerAvailability` row exists for this date"
 * and "the caller has nothing stored to exclude" -- either way, the worker is available for every
 * shift, per the new semantics. A row that exists always carries a non-empty subset (the schema
 * never stores/represents an empty one — see `schema.prisma`'s `WorkerAvailability` doc comment),
 * so `excludedShifts: []` is not a distinct case this function needs to special-case.
 */
export function computeAvailableShifts(excludedShifts: readonly ShiftType[] | undefined): readonly ShiftType[] {
  if (excludedShifts === undefined) {
    return SHIFT_TYPES;
  }
  return SHIFT_TYPES.filter((shift) => !excludedShifts.includes(shift));
}

/** The three worker roles. */
export const ROLES = ['GENERAL_GUARD', 'SUPERVISOR', 'SCREENER'] as const;
export type Role = (typeof ROLES)[number];

/** Worker lifecycle status. */
export const WORKER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

/** Roster lifecycle status. */
export const ROSTER_STATUSES = ['DRAFT', 'PUBLISHED'] as const;
export type RosterStatus = (typeof ROSTER_STATUSES)[number];

/** Alert types raised by the solver / validator. */
export const ALERT_TYPES = ['UNFILLABLE_SLOT', 'MIN_HOURS_SHORTFALL'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
