/** Each roster shift is a fixed 8-hour block: A 00:00–08:00, B 08:00–16:00, C 16:00–00:00. */
export const SHIFT_HOURS = 8;

/** The three fixed daily shifts, in order. */
export const SHIFT_TYPES = ['A', 'B', 'C'] as const;
export type ShiftType = (typeof SHIFT_TYPES)[number];

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
