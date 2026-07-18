import { SHIFT_HOURS, type Role, type Roster, type Shift } from '@rostering/shared';

export interface WorkerShiftRow {
  readonly shiftId: number;
  readonly date: string;
  readonly shiftType: Shift['shiftType'];
  readonly hours: number;
  readonly costIls: number;
}

/**
 * Per-worker shift-by-shift breakdown for the worker cost detail page, derived straight from the
 * roster's `shifts[].assignments[]` (rather than the cost-summary endpoint's `perWorker`, which
 * only carries aggregate shifts/hours/cost — no per-shift dates) crossed with `hourlyRate` (the
 * worker's contract rate) so hours/cost here are computed the same way `costSummaryService` does
 * (`SHIFT_HOURS × hourlyRate` per shift), just at the individual-shift level. Sorted by date
 * ascending so the detail page's table reads chronologically regardless of roster shift order.
 */
export function buildWorkerShiftRows(roster: Roster, workerId: number, hourlyRate: number): WorkerShiftRow[] {
  const rows = roster.shifts
    .filter((shift) => shift.assignments.some((a) => a.workerId === workerId))
    .map((shift) => ({
      shiftId: shift.id,
      date: shift.date,
      shiftType: shift.shiftType,
      hours: SHIFT_HOURS,
      costIls: SHIFT_HOURS * hourlyRate,
    }));

  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/** One worker's already-computed shift breakdown (`buildWorkerShiftRows`'s output) plus the
 * display fields (name/company/role) needed to render a comparison row, for
 * `buildWorkerComparisonRows` to reduce down to totals. */
export interface WorkerComparisonInput {
  readonly workerId: number;
  readonly name: string;
  readonly companyName: string;
  readonly role: Role | null;
  readonly rows: readonly WorkerShiftRow[];
}

export interface WorkerComparisonRow {
  readonly workerId: number;
  readonly name: string;
  readonly companyName: string;
  readonly role: Role | null;
  readonly totalShifts: number;
  readonly totalHours: number;
  readonly totalCostIls: number;
}

/**
 * Reduces each selected worker's `WorkerShiftRow[]` (already computed by `buildWorkerShiftRows`
 * per worker, on the Worker Compare page — see that page's doc comment for why the per-worker
 * shift rows are the single source of truth rather than a second read of `CostSummary`) down to
 * one totals row per worker, for the compare page's combined summary table. Sorted by
 * `totalCostIls` descending so the highest earner appears first, matching the "By worker" table's
 * default sort on the main Cost Dashboard.
 */
export function buildWorkerComparisonRows(inputs: readonly WorkerComparisonInput[]): WorkerComparisonRow[] {
  const rows = inputs.map((input) => ({
    workerId: input.workerId,
    name: input.name,
    companyName: input.companyName,
    role: input.role,
    totalShifts: input.rows.length,
    totalHours: input.rows.reduce((sum, r) => sum + r.hours, 0),
    totalCostIls: input.rows.reduce((sum, r) => sum + r.costIls, 0),
  }));

  return rows.sort((a, b) => b.totalCostIls - a.totalCostIls);
}
