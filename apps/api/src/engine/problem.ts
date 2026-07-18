// Builds the CP-SAT solver's problem JSON (stdin) from plain input data, and parses/validates the
// solver's solution JSON (stdout) before it is ever treated as trustworthy data.
//
// This module MUST NOT import from express, @prisma/client, or pg-boss — see
// `no-restricted-imports` in eslint.config.js scoped to `src/engine/**`.

import { z } from 'zod';
import { ROLES, SHIFT_TYPES } from '@rostering/shared';
import type { Role, ShiftType } from '@rostering/shared';
import { monthDays } from './calendar.js';

export interface EngineWorkerInput {
  readonly id: number;
  readonly role: Role;
  readonly minMonthlyHours: number;
  readonly maxMonthlyHours: number;
}

/**
 * One `WorkerAvailability` row as the service layer fetches it for the month window: this worker
 * can work this exact calendar date only for the shifts listed (non-empty subset of A/B/C — a row
 * is never stored/passed with an empty `shifts`, per Availability v2's "absence of the row IS the
 * unavailable state" rule). `buildProblem` is the pure function that crosses a flat list of these
 * rows into each worker's per-date map in the solver problem.
 */
export interface EngineAvailabilityRow {
  readonly workerId: number;
  readonly date: string; // "YYYY-MM-DD"
  readonly shifts: readonly ShiftType[];
}

/**
 * One worker as the solver problem JSON actually carries it: the plain `EngineWorkerInput` fields
 * plus a plain, JSON-serializable `date -> shifts` object (never a `Map` — `JSON.stringify` can't
 * serialize one). `noUncheckedIndexedAccess` means `availability[date]` here is
 * `readonly ShiftType[] | undefined` — a missing key is the real "unavailable that date" state,
 * exactly like `engine/types.ts`'s `AvailabilityByDate.get(date)`; this is that same information
 * in the wire shape JSON transport requires instead of a `Map`.
 */
export interface SolverWorkerInput extends EngineWorkerInput {
  readonly availability: Readonly<Record<string, readonly ShiftType[]>>;
}

/** One cell of the role×shift staffing-requirements matrix (`packages/shared`'s `staffingRequirementSchema`). */
export interface EngineRequirementInput {
  readonly role: Role;
  readonly shift: ShiftType;
  readonly requiredCount: number;
}

export interface BuildProblemInput {
  readonly month: string; // "YYYY-MM"
  readonly workers: readonly EngineWorkerInput[];
  readonly requirements: readonly EngineRequirementInput[];
  /** Flat availability rows for (at least) the workers above, for the month window — the caller
   * (a service) is responsible for fetching these from `WorkerAvailability`; `buildProblem` only
   * does the pure crossing into each worker's per-date map. */
  readonly availability: readonly EngineAvailabilityRow[];
}

/**
 * One day-scoped coverage target the solver's role-coverage constraint consumes directly (design
 * doc: `for (d, s, role, required) in p.requirements`). The staffing-requirements matrix itself
 * has no date dimension — it applies uniformly to every day of the month — so `buildProblem` is
 * responsible for crossing it with `days` before it ever reaches the solver.
 */
export interface SolverRequirement {
  readonly date: string;
  readonly shift: ShiftType;
  readonly role: Role;
  readonly requiredCount: number;
}

export interface SolverProblem {
  readonly days: readonly string[];
  readonly workers: readonly SolverWorkerInput[];
  readonly requirements: readonly SolverRequirement[];
}

export function buildProblem(input: BuildProblemInput): SolverProblem {
  const days = monthDays(input.month);
  const requirements = days.flatMap((date) =>
    input.requirements.map((r) => ({
      date,
      shift: r.shift,
      role: r.role,
      requiredCount: r.requiredCount,
    })),
  );

  // Assemble per-worker date->shifts as nested `Map`s first — `.get()` stays `T | undefined` by
  // construction throughout this loop, with no repeated `noUncheckedIndexedAccess` undefined-checks
  // needed while building it up — and only flatten to the plain, JSON-serializable object shape at
  // this final wire boundary, once per worker.
  const availabilityByWorker = new Map<number, Map<string, readonly ShiftType[]>>();
  for (const row of input.availability) {
    let byDate = availabilityByWorker.get(row.workerId);
    if (!byDate) {
      byDate = new Map();
      availabilityByWorker.set(row.workerId, byDate);
    }
    byDate.set(row.date, row.shifts);
  }

  const workers = input.workers.map((worker) => {
    const byDate = availabilityByWorker.get(worker.id);
    return {
      ...worker,
      // No rows for this worker -> empty object, i.e. unavailable every date (not a fabricated
      // default of "every date allowed").
      availability: byDate ? Object.fromEntries(byDate) : {},
    };
  });

  return {
    days,
    workers,
    requirements,
  };
}

// --- Solver solution (stdout) parsing -------------------------------------------------------
//
// The solver speaks its own JSON vocabulary (lower-case alert `type` strings, no `id` /
// `acknowledged` bookkeeping — those are added when a Phase 6 job persists the solution as DB
// `Alert` rows). These schemas validate that native shape; they are intentionally distinct from
// `@rostering/shared`'s `alertSchema`, which describes the *persisted* alert shape.

const solverAssignmentSchema = z
  .object({
    workerId: z.number().int(),
    date: z.string(),
    shift: z.enum(SHIFT_TYPES),
  })
  .strict();

const solverUnfillableSlotAlertSchema = z
  .object({
    type: z.literal('unfillable_slot'),
    date: z.string(),
    shift: z.enum(SHIFT_TYPES),
    role: z.enum(ROLES),
    missing: z.number().int().nonnegative(),
  })
  .strict();

const solverMinHoursShortfallAlertSchema = z
  .object({
    type: z.literal('min_hours_shortfall'),
    workerId: z.number().int(),
    deficitHours: z.number().nonnegative(),
  })
  .strict();

const solverAlertSchema = z.discriminatedUnion('type', [
  solverUnfillableSlotAlertSchema,
  solverMinHoursShortfallAlertSchema,
]);

export const solverSolutionSchema = z
  .object({
    assignments: z.array(solverAssignmentSchema),
    alerts: z.array(solverAlertSchema),
  })
  .strict();

export type SolverAssignment = z.infer<typeof solverAssignmentSchema>;
export type SolverAlert = z.infer<typeof solverAlertSchema>;
export type SolverSolution = z.infer<typeof solverSolutionSchema>;

/**
 * Parses and Zod-validates the solver's raw stdout text. Throws (never returns partially-trusted
 * data) if the text is not valid JSON, or if it is valid JSON that does not match the solver's
 * solution contract — malformed solver output must never be treated as a valid roster.
 */
export function parseSolverSolution(rawStdout: string): SolverSolution {
  let data: unknown;
  try {
    data = JSON.parse(rawStdout);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Solver produced invalid JSON: ${reason}`);
  }
  return solverSolutionSchema.parse(data);
}
