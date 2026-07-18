import { computeAvailableShifts } from '@rostering/shared';
import type { ShiftType } from '@rostering/shared';
import { validateEdit } from '../engine/validator.js';
import type { AssignedShift, AvailabilityByDate, Edit, MonthContext, Verdict } from '../engine/types.js';
import type { PrismaClient } from '../db/client.js';
import type { Contract as ContractRecord, Prisma, Worker as WorkerRecord } from '../generated/prisma/client.js';
import { ConflictWarningError, NotFoundError, UnprocessableError } from '../errors.js';
import { formatDate, recomputeRosterAlerts, type AlertDto } from './alertRecompute.js';

export interface ShiftWorkerResult {
  readonly shiftId: number;
  readonly workerId: number;
  readonly role: string;
  readonly alerts: readonly AlertDto[];
}

// `WorkerAvailability.excludedShifts` stores the canonical subset as a plain string (e.g. "A",
// "ABC") — every stored row was Zod-validated on write (`shiftSubsetSchema`) to only ever contain
// A/B/C in canonical order, so splitting into characters is exact, not a parse that can fail here.
function parseShiftSubset(excludedShifts: string): readonly ShiftType[] {
  return excludedShifts.split('') as ShiftType[];
}

/**
 * Fetches this worker's `WorkerAvailability` rows for exactly the given dates (the dates the edit
 * being validated actually touches — a manual edit only ever needs the target date(s), never the
 * whole month) and returns them as the `AvailabilityByDate` map `withinAvailability` consumes.
 * Availability v3: each row stores the shifts this worker is EXCLUDED from that date, inverted
 * here via `computeAvailableShifts` into the INCLUDED/available shifts `AvailabilityByDate`
 * actually carries -- `withinAvailability` itself never sees a raw excluded value. A date with no
 * matching row is simply absent from the returned map, which `withinAvailability`'s own
 * missing-date default now treats as "available for every shift" (the new semantics), not
 * "unavailable" (Availability v2's old rule).
 */
async function loadAvailability(
  tx: Prisma.TransactionClient,
  workerId: number,
  dates: readonly string[],
): Promise<AvailabilityByDate> {
  if (dates.length === 0) {
    return new Map();
  }
  const rows = await tx.workerAvailability.findMany({
    where: { workerId, date: { in: dates.map((d) => new Date(`${d}T00:00:00.000Z`)) } },
  });
  return new Map(
    rows.map((row) => [formatDate(row.date), computeAvailableShifts(parseShiftSubset(row.excludedShifts))]),
  );
}

function buildContext(
  worker: WorkerRecord,
  contract: ContractRecord,
  existingShifts: readonly AssignedShift[],
  availability: AvailabilityByDate,
): MonthContext {
  return {
    worker: {
      id: worker.id,
      role: worker.role,
      status: worker.status,
      minMonthlyHours: contract.minMonthlyHours,
      maxMonthlyHours: contract.maxMonthlyHours,
      availability,
    },
    existingShifts,
  };
}

/**
 * Re-validates hard rules regardless of `confirm` — a confirm can never bypass a hard (422) rule,
 * only acknowledge a soft (409) one. This is what makes the confirm flow stateless: the caller
 * just resubmits the identical request with `?confirm=true`.
 */
function enforceVerdict(verdict: Verdict, confirm: boolean): void {
  if (!verdict.ok) {
    throw new UnprocessableError(verdict.violations.map((v) => ({ code: v.rule, detail: { message: v.message } })));
  }
  if (verdict.warnings.length > 0 && !confirm) {
    throw new ConflictWarningError(verdict.warnings.map((w) => ({ code: w.rule, detail: { message: w.message } })));
  }
}

async function loadExistingShifts(
  tx: Prisma.TransactionClient,
  rosterId: number,
  workerId: number,
  excludeShiftIds: readonly number[],
): Promise<AssignedShift[]> {
  const rows = await tx.shiftWorker.findMany({
    where: {
      workerId,
      shift: {
        rosterId,
        ...(excludeShiftIds.length > 0 ? { id: { notIn: [...excludeShiftIds] } } : {}),
      },
    },
    include: { shift: true },
  });
  return rows.map((r) => ({ date: formatDate(r.shift.date), shiftType: r.shift.shiftType }));
}

/**
 * Manual roster edits (add / move / remove a worker on a shift), gated through the pure
 * `RosterValidator` (`engine/validator.ts`) on every write path. Mounted under `/api/shifts`
 * (separate route base from `RosterService`'s `/api/rosters`), sharing the alert-recompute helper.
 */
export class ShiftWorkerService {
  constructor(private readonly prisma: PrismaClient) {}

  async addWorker(shiftId: number, workerId: number, confirm: boolean): Promise<ShiftWorkerResult> {
    return this.prisma.$transaction(async (tx) => {
      const shift = await tx.shift.findUnique({ where: { id: shiftId } });
      if (!shift) {
        throw new NotFoundError(`Shift ${shiftId} not found`);
      }
      const worker = await tx.worker.findUnique({ where: { id: workerId }, include: { contract: true } });
      if (!worker) {
        throw new NotFoundError(`Worker ${workerId} not found`);
      }
      if (!worker.contract) {
        throw new UnprocessableError([
          { code: 'missingContract', detail: { message: `Worker ${workerId} has no contract` } },
        ]);
      }

      const targetDate = formatDate(shift.date);
      const existingShifts = await loadExistingShifts(tx, shift.rosterId, workerId, []);
      const availability = await loadAvailability(tx, workerId, [targetDate]);
      const edit: Edit = {
        kind: 'add',
        to: { date: targetDate, shiftType: shift.shiftType, role: worker.role },
      };
      const verdict = validateEdit(edit, buildContext(worker, worker.contract, existingShifts, availability));
      enforceVerdict(verdict, confirm);

      await tx.shiftWorker.create({ data: { shiftId, workerId, role: worker.role } });
      const alerts = await recomputeRosterAlerts(tx, shift.rosterId);
      return { shiftId, workerId, role: worker.role, alerts };
    });
  }

  async moveWorker(
    sourceShiftId: number,
    workerId: number,
    targetShiftId: number,
    confirm: boolean,
  ): Promise<ShiftWorkerResult> {
    return this.prisma.$transaction(async (tx) => {
      const sourceShift = await tx.shift.findUnique({ where: { id: sourceShiftId } });
      if (!sourceShift) {
        throw new NotFoundError(`Shift ${sourceShiftId} not found`);
      }
      const targetShift = await tx.shift.findUnique({ where: { id: targetShiftId } });
      if (!targetShift || targetShift.rosterId !== sourceShift.rosterId) {
        throw new NotFoundError(`Shift ${targetShiftId} not found`);
      }
      const worker = await tx.worker.findUnique({ where: { id: workerId }, include: { contract: true } });
      if (!worker) {
        throw new NotFoundError(`Worker ${workerId} not found`);
      }
      if (!worker.contract) {
        throw new UnprocessableError([
          { code: 'missingContract', detail: { message: `Worker ${workerId} has no contract` } },
        ]);
      }

      const existingAssignment = await tx.shiftWorker.findUnique({
        where: { shiftId_workerId: { shiftId: sourceShiftId, workerId } },
      });
      if (!existingAssignment) {
        throw new NotFoundError(`Worker ${workerId} is not assigned to shift ${sourceShiftId}`);
      }

      const targetDate = formatDate(targetShift.date);
      const existingShifts = await loadExistingShifts(tx, sourceShift.rosterId, workerId, [sourceShiftId]);
      // Only the TARGET date gates `withinAvailability` (see `engine/validator.ts`) — the source
      // date needs no availability lookup here.
      const availability = await loadAvailability(tx, workerId, [targetDate]);
      const edit: Edit = {
        kind: 'move',
        from: { date: formatDate(sourceShift.date), shiftType: sourceShift.shiftType },
        to: { date: targetDate, shiftType: targetShift.shiftType, role: worker.role },
      };
      const verdict = validateEdit(edit, buildContext(worker, worker.contract, existingShifts, availability));
      enforceVerdict(verdict, confirm);

      // One atomic transaction: the worker leaves the source slot AND appears in the target slot,
      // or neither happens (the whole handler runs inside `prisma.$transaction`).
      await tx.shiftWorker.delete({ where: { shiftId_workerId: { shiftId: sourceShiftId, workerId } } });
      await tx.shiftWorker.create({ data: { shiftId: targetShiftId, workerId, role: worker.role } });
      const alerts = await recomputeRosterAlerts(tx, sourceShift.rosterId);
      return { shiftId: targetShiftId, workerId, role: worker.role, alerts };
    });
  }

  async removeWorker(shiftId: number, workerId: number, confirm: boolean): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const shift = await tx.shift.findUnique({ where: { id: shiftId } });
      if (!shift) {
        throw new NotFoundError(`Shift ${shiftId} not found`);
      }
      const worker = await tx.worker.findUnique({ where: { id: workerId }, include: { contract: true } });
      if (!worker) {
        throw new NotFoundError(`Worker ${workerId} not found`);
      }
      const existingAssignment = await tx.shiftWorker.findUnique({
        where: { shiftId_workerId: { shiftId, workerId } },
      });
      if (!existingAssignment) {
        throw new NotFoundError(`Worker ${workerId} is not assigned to shift ${shiftId}`);
      }

      // A worker with no contract has no min/max hours to check against, and a `remove` edit's
      // hard rules never depend on the worker snapshot (see the `workerIsActive` fix in
      // engine/validator.ts) — so removal is unconditionally safe in that case.
      if (worker.contract) {
        const existingShifts = await loadExistingShifts(tx, shift.rosterId, workerId, [shiftId]);
        const edit: Edit = { kind: 'remove', from: { date: formatDate(shift.date), shiftType: shift.shiftType } };
        // A plain `remove` edit has no `to` target, so `withinAvailability` never consults
        // availability for it (see `engine/validator.ts`) — an empty map is correct here, not a
        // shortcut around a real lookup.
        const verdict = validateEdit(edit, buildContext(worker, worker.contract, existingShifts, new Map()));
        enforceVerdict(verdict, confirm);
      }

      await tx.shiftWorker.delete({ where: { shiftId_workerId: { shiftId, workerId } } });
      await recomputeRosterAlerts(tx, shift.rosterId);
    });
  }
}
