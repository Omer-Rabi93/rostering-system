// Roster-generation business logic: build the solver problem from current DB state, run the
// CP-SAT solver, and persist the result as the month's draft roster. `PrismaClient` (and, for
// testability, the solve function) are constructor-injected -- no pg-boss import here; the
// `roster-generation` job handler in `jobs/rosterGeneration.job.ts` is a thin wrapper.
//
// Persistence is delete-and-rewrite of the target month's shifts + shift_workers + alerts inside
// ONE transaction, and the roster row itself is upserted by its unique `month`, so a pg-boss retry
// after a partial failure (or a legitimate `force`-regeneration of an already-published month)
// converges on the same state rather than doubling data -- see
// `tests/services/rosterGenerationService.test.ts` for the forced-failure-then-retry proof.

import type { ShiftType } from '@rostering/shared';

import { monthDays, SHIFT_TYPES } from '../engine/calendar.js';
import {
  buildProblem,
  type EngineAvailabilityRow,
  type SolverProblem,
  type SolverSolution,
} from '../engine/problem.js';
import { runSolver, type RunSolverOptions } from '../engine/runSolver.js';
import type { PrismaClient } from '../db/client.js';
import type { Prisma, Role } from '../generated/prisma/client.js';

export interface RosterGenerationResult {
  readonly rosterId: number;
  readonly alertCount: number;
}

export type SolveFn = (problem: SolverProblem, options?: RunSolverOptions) => Promise<SolverSolution>;

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** `WorkerAvailability.shifts` stores the canonical subset as a plain string (e.g. "A", "ABC") --
 * every stored row was Zod-validated on write to only ever contain A/B/C in canonical order, so
 * splitting into characters is exact, not a parse that can fail here (same convention as
 * `shiftWorkerService.ts`'s/`availabilityService.ts`'s own `parseShiftSubset`). */
function parseShiftSubset(shifts: string): readonly ShiftType[] {
  return shifts.split('') as ShiftType[];
}

/**
 * Fetches the real `WorkerAvailability` rows for `month`'s date window, scoped to (at least) the
 * given `workerIds` -- the bulk fetch this service was missing pre-Phase-V4 (it used to treat
 * every active worker as available every date/shift). A worker with zero rows in the month
 * contributes no `EngineAvailabilityRow`s at all, which `buildProblem`/`RosterValidator` already
 * correctly interpret as "unavailable every date" (Availability v2's absence-is-unavailable rule)
 * -- not a special case here, just an empty `findMany` result.
 */
async function loadMonthAvailabilityRows(
  prisma: PrismaClient,
  workerIds: readonly number[],
  month: string,
): Promise<EngineAvailabilityRow[]> {
  if (workerIds.length === 0) {
    return [];
  }
  const days = monthDays(month);
  const [firstDay] = days;
  const lastDay = days[days.length - 1];
  if (firstDay === undefined || lastDay === undefined) {
    throw new Error(`Month ${month} produced no calendar days`);
  }
  const rows = await prisma.workerAvailability.findMany({
    where: {
      workerId: { in: [...workerIds] },
      date: { gte: new Date(`${firstDay}T00:00:00.000Z`), lte: new Date(`${lastDay}T00:00:00.000Z`) },
    },
  });
  return rows.map((row) => ({
    workerId: row.workerId,
    date: row.date.toISOString().slice(0, 10),
    shifts: parseShiftSubset(row.shifts),
  }));
}

export class RosterGenerationService {
  private readonly solve: SolveFn;

  constructor(
    private readonly prisma: PrismaClient,
    solve: SolveFn = runSolver,
    private readonly solverOptions: RunSolverOptions = {},
  ) {
    this.solve = solve;
  }

  async generate(month: string): Promise<RosterGenerationResult> {
    const [activeWorkers, requirements] = await Promise.all([
      this.prisma.worker.findMany({ where: { status: 'ACTIVE' }, include: { contract: true } }),
      this.prisma.staffingRequirement.findMany(),
    ]);

    const workersWithContract = activeWorkers.filter(
      (w): w is typeof w & { contract: NonNullable<typeof w.contract> } => w.contract !== null,
    );
    const roleById = new Map<number, Role>(workersWithContract.map((w) => [w.id, w.role]));

    const availability = await loadMonthAvailabilityRows(
      this.prisma,
      workersWithContract.map((w) => w.id),
      month,
    );

    const problem = buildProblem({
      month,
      workers: workersWithContract.map((w) => ({
        id: w.id,
        role: w.role,
        minMonthlyHours: w.contract.minMonthlyHours,
        maxMonthlyHours: w.contract.maxMonthlyHours,
      })),
      requirements: requirements.map((r) => ({ role: r.role, shift: r.shift, requiredCount: r.requiredCount })),
      availability,
    });

    const solution = await this.solve(problem, this.solverOptions);

    return this.persistDraft(month, solution, roleById);
  }

  private async persistDraft(
    month: string,
    solution: SolverSolution,
    roleById: ReadonlyMap<number, Role>,
  ): Promise<RosterGenerationResult> {
    return this.prisma.$transaction(async (tx) => {
      const roster = await tx.roster.upsert({
        where: { month },
        create: { month, status: 'DRAFT', generatedAt: new Date() },
        // `force`-regeneration of a published month reopens it as draft (status flips back); the
        // HTTP-layer publish gate (unacknowledged alerts) applies fresh next time it is published,
        // since the alerts below are entirely recomputed.
        update: { status: 'DRAFT', generatedAt: new Date() },
      });

      // Delete-and-rewrite: `onDelete: Cascade` on `Shift -> ShiftWorker` means deleting the
      // roster's shifts also removes their shift_workers rows in the same statement.
      await tx.shift.deleteMany({ where: { rosterId: roster.id } });
      await tx.alert.deleteMany({ where: { rosterId: roster.id } });

      const days = monthDays(month);
      const shiftIdByKey = new Map<string, number>();
      for (const date of days) {
        for (const shiftType of SHIFT_TYPES) {
          const shift = await tx.shift.create({
            data: { rosterId: roster.id, date: new Date(`${date}T00:00:00.000Z`), shiftType },
          });
          shiftIdByKey.set(`${date}:${shiftType}`, shift.id);
        }
      }

      if (solution.assignments.length > 0) {
        await tx.shiftWorker.createMany({
          data: solution.assignments.map((a) => {
            const shiftId = shiftIdByKey.get(`${a.date}:${a.shift}`);
            if (shiftId === undefined) {
              throw new Error(`Solver assigned worker ${a.workerId} to an out-of-month slot ${a.date}:${a.shift}`);
            }
            const role = roleById.get(a.workerId);
            if (!role) {
              throw new Error(`Solver assigned unknown/inactive worker ${a.workerId}`);
            }
            return { shiftId, workerId: a.workerId, role };
          }),
        });
      }

      if (solution.alerts.length > 0) {
        await tx.alert.createMany({
          data: solution.alerts.map((a) => {
            if (a.type === 'unfillable_slot') {
              return {
                rosterId: roster.id,
                type: 'UNFILLABLE_SLOT' as const,
                detail: toJsonInput({ date: a.date, shift: a.shift, role: a.role }),
                acknowledged: false,
              };
            }
            return {
              rosterId: roster.id,
              type: 'MIN_HOURS_SHORTFALL' as const,
              detail: toJsonInput({ workerId: a.workerId, deficitHours: a.deficitHours }),
              acknowledged: false,
            };
          }),
        });
      }

      return { rosterId: roster.id, alertCount: solution.alerts.length };
    });
  }
}
