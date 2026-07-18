// Pure `RosterValidator` — gates every manual roster edit before it is persisted.
//
// HARD rule violation -> `{ ok: false, violations }` (HTTP 422 upstream, no override).
// SOFT rule violation -> `{ ok: true, warnings }` (HTTP 409 upstream unless `?confirm=true`).
//
// This module MUST NOT import from express, @prisma/client, or pg-boss — see
// `no-restricted-imports` in eslint.config.js scoped to `src/engine/**`.

import { SHIFT_HOURS } from '@rostering/shared';
import type { Edit, HardViolation, MonthContext, SoftWarning, Verdict } from './types.js';

type HardRule = (edit: Edit, ctx: MonthContext) => HardViolation | null;
type SoftRule = (edit: Edit, ctx: MonthContext) => SoftWarning | null;

const workerIsActive: HardRule = (edit, ctx) => {
  // A plain `remove` never places the worker into a slot — it only vacates one they already hold
  // — so it must stay allowed regardless of current status. Without this guard, deactivating a
  // worker who already holds shifts in the draft would make those shifts permanently un-removable
  // through the manual-edit API (only a full regeneration, which excludes inactive workers from
  // the solver's problem entirely, could clear them), which is exactly backwards: removing an
  // inactive worker's stale assignment is the corrective action, not one that should be blocked.
  if (edit.kind === 'remove') {
    return null;
  }
  if (ctx.worker.status !== 'ACTIVE') {
    return { rule: 'workerIsActive', message: `Worker ${ctx.worker.id} is not active` };
  }
  return null;
};

const roleMatchesSlot: HardRule = (edit, ctx) => {
  const target = edit.kind === 'remove' ? null : edit.to;
  if (target && target.role !== ctx.worker.role) {
    return {
      rule: 'roleMatchesSlot',
      message: `Worker ${ctx.worker.id} has role ${ctx.worker.role}, slot requires ${target.role}`,
    };
  }
  return null;
};

const withinAvailability: HardRule = (edit, ctx) => {
  const target = edit.kind === 'remove' ? null : edit.to;
  if (!target) {
    return null;
  }
  // Allowed iff the edit's EXACT calendar date has an availability entry AND that entry contains
  // the slot's shift. A missing entry is the real "unavailable that date" state (Availability v2:
  // absence of a `WorkerAvailability` row = unavailable) — treated explicitly here, never coalesced
  // into "assume available" via `??`/`!`.
  const shiftsForDate = ctx.worker.availability.get(target.date);
  const available = shiftsForDate !== undefined && shiftsForDate.includes(target.shiftType);
  if (!available) {
    return {
      rule: 'withinAvailability',
      message: `Worker ${ctx.worker.id} is not available for ${target.date} shift ${target.shiftType}`,
    };
  }
  return null;
};

const noDuplicateSlot: HardRule = (edit, ctx) => {
  const target = edit.kind === 'remove' ? null : edit.to;
  if (!target) {
    return null;
  }
  const alreadyHeld = ctx.existingShifts.some(
    (s) => s.date === target.date && s.shiftType === target.shiftType,
  );
  if (alreadyHeld) {
    return {
      rule: 'noDuplicateSlot',
      message: `Worker ${ctx.worker.id} is already assigned to ${target.date} shift ${target.shiftType}`,
    };
  }
  return null;
};

const maxTwoShiftsPerDay: HardRule = (edit, ctx) => {
  const target = edit.kind === 'remove' ? null : edit.to;
  if (!target) {
    return null;
  }
  const shiftsThatCalendarDate = ctx.existingShifts.filter((s) => s.date === target.date).length;
  // `ctx.existingShifts` excludes the shift(s) the edit itself touches, so the new slot adds one.
  if (shiftsThatCalendarDate + 1 > 2) {
    return {
      rule: 'maxTwoShiftsPerDay',
      message: `Worker ${ctx.worker.id} would have more than 2 shifts on ${target.date}`,
    };
  }
  return null;
};

const HARD_RULES: readonly HardRule[] = [
  workerIsActive,
  roleMatchesSlot,
  withinAvailability,
  noDuplicateSlot,
  maxTwoShiftsPerDay,
];
const exceedsMaxMonthlyHours: SoftRule = (edit, ctx) => {
  if (edit.kind === 'remove') {
    return null;
  }
  const monthHoursAfterEdit = (ctx.existingShifts.length + 1) * SHIFT_HOURS;
  if (monthHoursAfterEdit > ctx.worker.maxMonthlyHours) {
    return {
      rule: 'exceedsMaxMonthlyHours',
      message: `Worker ${ctx.worker.id} would have ${monthHoursAfterEdit}h, over the ${ctx.worker.maxMonthlyHours}h contracted max`,
    };
  }
  return null;
};

const belowMinMonthlyHours: SoftRule = (edit, ctx) => {
  if (edit.kind === 'add') {
    return null;
  }
  // `ctx.existingShifts` already excludes every slot the edit touches. A plain `remove` gives up
  // the `from` slot with nothing gained back, but a `move` also lands the worker in a new `to`
  // slot, so its hours must be added back in — a move-away is not a net loss of a shift.
  const monthHoursAfterEdit =
    edit.kind === 'move'
      ? (ctx.existingShifts.length + 1) * SHIFT_HOURS
      : ctx.existingShifts.length * SHIFT_HOURS;
  if (monthHoursAfterEdit < ctx.worker.minMonthlyHours) {
    return {
      rule: 'belowMinMonthlyHours',
      message: `Worker ${ctx.worker.id} would have ${monthHoursAfterEdit}h, under the ${ctx.worker.minMonthlyHours}h contracted min`,
    };
  }
  return null;
};

const SOFT_RULES: readonly SoftRule[] = [exceedsMaxMonthlyHours, belowMinMonthlyHours];

export function validateEdit(edit: Edit, ctx: MonthContext): Verdict {
  const violations = HARD_RULES.map((rule) => rule(edit, ctx)).filter(
    (v): v is HardViolation => v !== null,
  );
  if (violations.length > 0) {
    return { ok: false, violations };
  }

  const warnings = SOFT_RULES.map((rule) => rule(edit, ctx)).filter(
    (w): w is SoftWarning => w !== null,
  );
  return { ok: true, warnings };
}
