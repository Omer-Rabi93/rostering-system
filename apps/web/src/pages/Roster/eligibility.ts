import type { ContractDto, WorkerDto } from '../../api/workers.api.js';
import type { MonthAvailability, Roster, ShiftType } from '@rostering/shared';

/**
 * Client-side *advisory* eligibility hint for the manual-edit "Add a worker" picker — mirrors
 * (but does not replace) the server's hard rules in `apps/api/src/engine/validator.ts`
 * (`workerIsActive`, `withinAvailability`, `maxTwoShiftsPerDay`, `noDuplicateSlot`). The server
 * re-validates on every submit regardless of what this function says; this is purely a UI hint so
 * a planner doesn't waste a round-trip picking an obviously-ineligible worker. Returns a
 * human-readable reason when ineligible, or `null` when the worker looks eligible.
 *
 * Availability v2: eligibility is date-specific, not weekday-specific — `monthAvailability` is the
 * same `GET /api/availability/:month` cache entry (`{ [workerId]: { [date]: ShiftSubset } }`) the
 * `AvailabilityGrid` reads, keyed by the edit's exact `date` rather than a weekday index. Absence
 * of a `(workerId, date)` entry means unavailable that date — a sparse lookup, so both levels of
 * indexing are handled as explicitly-possibly-`undefined` (never a non-null assertion): a worker
 * with no rows in the month, or a worker with rows but none on this exact date, both fall through
 * to the same "unavailable" branch.
 */
export function getIneligibilityReason(
  worker: WorkerDto,
  contract: ContractDto | null,
  monthAvailability: MonthAvailability | undefined,
  roster: Roster,
  date: string,
  shift: ShiftType,
): string | null {
  if (worker.status !== 'ACTIVE') {
    return 'Inactive';
  }
  if (!contract) {
    return 'No contract on file';
  }

  const dateShifts = monthAvailability?.[String(worker.id)]?.[date];
  if (!dateShifts || !dateShifts.includes(shift)) {
    return 'Unavailable this shift';
  }

  const shiftsOnDate = roster.shifts.filter((s) => s.date === date);
  const alreadyOnThisSlot = shiftsOnDate.some(
    (s) => s.shiftType === shift && s.assignments.some((a) => a.workerId === worker.id),
  );
  if (alreadyOnThisSlot) {
    return 'Already assigned to this shift';
  }

  const shiftsTodayCount = shiftsOnDate.filter((s) =>
    s.assignments.some((a) => a.workerId === worker.id),
  ).length;
  if (shiftsTodayCount >= 2) {
    return 'Already 2 shifts today';
  }

  return null;
}
