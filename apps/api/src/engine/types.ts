// Plain data types for the scheduling engine (`engine/validator.ts`, `engine/problem.ts`).
//
// This module MUST NOT import from express, @prisma/client, or pg-boss (enforced by the
// `no-restricted-imports` ESLint rule scoped to `src/engine/**` in eslint.config.js) — the engine
// is a pure module over plain data so it can be unit-tested and reused by the API and the
// background worker alike.

import type { Role, ShiftType } from '@rostering/shared';

/**
 * Date-specific worker availability (Availability v3): every calendar date the worker has an
 * entry for maps to the non-empty subset of shifts they can work THAT exact date — already
 * inverted from the `WorkerAvailability` row's stored EXCLUDED shifts into the INCLUDED/available
 * ones by whichever service builds this map (e.g. `shiftWorkerService.ts#loadAvailability`, via
 * `@rostering/shared`'s `computeAvailableShifts`) — this type and its consumers (the validator)
 * only ever see the available-shifts meaning, never the raw excluded one. A date with no key is
 * the "available every shift that date" state — absence, not an empty array, is how it's
 * represented (mirrors `packages/shared`'s `monthAvailabilitySchema` sparsity rule, just with the
 * opposite polarity from Availability v2).
 *
 * Modeled as a `ReadonlyMap` rather than a plain `Record` so `.get(date)` is `T | undefined` by
 * construction, regardless of `noUncheckedIndexedAccess` — callers (the validator) still handle
 * `undefined` explicitly since it's the real "available every shift" signal now, not a value to
 * paper over with `!`. The JSON wire shape sent to the Python solver (`engine/problem.ts`) is a
 * *different*, plain `Record<string, readonly ShiftType[]>` — Maps don't serialize through
 * `JSON.stringify` — built only at that final boundary.
 */
export type AvailabilityByDate = ReadonlyMap<string, readonly ShiftType[]>;

/** Snapshot of everything the validator needs to know about the worker being edited.
 *
 * A worker is available for a given (date, shift) slot iff `availability.get(date)` is either
 * undefined (no entry = available every shift, Availability v3) OR defined and contains that
 * shift — the edit's exact calendar date, not a weekday/day-set. */
export interface WorkerSnapshot {
  readonly id: number;
  readonly role: Role;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly minMonthlyHours: number;
  readonly maxMonthlyHours: number;
  readonly availability: AvailabilityByDate;
}

/** One of the worker's existing shift assignments within the roster month being edited. */
export interface AssignedShift {
  /** Calendar date, `YYYY-MM-DD`. */
  readonly date: string;
  readonly shiftType: ShiftType;
}

/** Everything the validator needs about the surrounding month to judge one edit. */
export interface MonthContext {
  readonly worker: WorkerSnapshot;
  /** This worker's other shifts in the roster month, NOT including the shift(s) the edit touches. */
  readonly existingShifts: readonly AssignedShift[];
}

export interface SlotLocation {
  /** Calendar date, `YYYY-MM-DD`. */
  readonly date: string;
  readonly shiftType: ShiftType;
}

/** A slot being filled additionally carries the role the slot requires. */
export interface SlotTarget extends SlotLocation {
  readonly role: Role;
}

/** One manual roster edit submitted through the API, prior to validation. */
export type Edit =
  | { readonly kind: 'add'; readonly to: SlotTarget }
  | { readonly kind: 'remove'; readonly from: SlotLocation }
  | { readonly kind: 'move'; readonly from: SlotLocation; readonly to: SlotTarget };

export interface HardViolation {
  readonly rule: string;
  readonly message: string;
}

export interface SoftWarning {
  readonly rule: string;
  readonly message: string;
}

export type Verdict =
  | { readonly ok: true; readonly warnings: readonly SoftWarning[] }
  | { readonly ok: false; readonly violations: readonly HardViolation[] };
