// Availability v3 business logic: the bulk `GET`/`PUT /api/availability/:month` JSON endpoints
// (planner grid data source, `AvailabilityGrid.tsx`'s only data dependency). This is deliberately
// the whole surface of this file now -- the month-scoped availability CSV import that used to live
// here (and the separate worker-only CSV import in the now-deleted `csvImportService.ts`) merged
// into one combined workforce-CSV pipeline, `services/workforceImportService.ts` (see the Part G
// design doc). The manual/grid editing path below is untouched by that merge: it never went
// through CSV framing or the `ImportTask`/queue machinery, and still doesn't.
//
// v4: `getMonth`/`replaceMonth` are company-scoped end to end -- see the v4 design doc, Part A
// ("Same-company nationalId matching, cross-company conflict as an error").

import type { Month, MonthAvailability } from '@rostering/shared';
import type { ShiftType } from '@rostering/shared';

import { monthDays } from '../engine/calendar.js';
import { BadRequestError, type FieldError } from '../errors.js';
import { formatDate } from './alertRecompute.js';
import type { PrismaClient } from '../db/client.js';

/**
 * DoS bound on the `PUT /api/availability/:month` payload, checked after Zod's `.strict()` shape
 * validation and before opening the replace transaction. Sized for this system's stated
 * 10,000-worker-per-company ceiling: 10,000 workers x 31 dates (the longest possible calendar
 * month) = 310,000 possible (workerId, date) entries in the absolute worst case (every worker has
 * an entry for every date of the month). 350,000 gives ~13% headroom above that exact worst case,
 * matching `AVAILABILITY_JSON_BODY_LIMIT`'s own headroom convention just below.
 */
export const MAX_AVAILABILITY_ENTRIES = 350_000;

function monthDateRange(month: string): { readonly start: Date; readonly end: Date } {
  const days = monthDays(month);
  const [first] = days;
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error(`Month ${month} produced no calendar days`);
  }
  return { start: new Date(`${first}T00:00:00.000Z`), end: new Date(`${last}T00:00:00.000Z`) };
}

/** `WorkerAvailability.excludedShifts` stores the canonical subset as a plain string (e.g. "A",
 * "ABC") -- every stored row was Zod-validated on write to only ever contain A/B/C in canonical
 * order, so splitting into characters is exact, not a parse that can fail here (mirrors
 * `shiftWorkerService.ts`'s own `parseShiftSubset`). Availability v3: the grid's `GET`/`PUT
 * /api/availability/:month` payload shape (`MonthAvailability`'s `shifts` field) carries the SAME
 * excluded-shifts letters the DB stores 1:1 (Option A: no inversion at this boundary) -- these two
 * helpers are a plain string<->array conversion, not an excluded->available computation. */
function shiftsStringFromArray(shifts: readonly ShiftType[]): string {
  return shifts.join('');
}
function shiftsArrayFromString(shifts: string): ShiftType[] {
  return shifts.split('') as ShiftType[];
}

export class AvailabilityService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * All `WorkerAvailability` rows in `month`'s date window BELONGING TO `companyId` (v4: scoped
   * end to end, matching `replaceMonth`'s own `worker: { companyId }` join -- never another
   * company's rows), grouped per worker: `{ [workerId]: { [date]: shifts } }`. A worker/date with
   * no row simply has no key -- built by only ever assigning entries that exist, never a `date:
   * undefined` placeholder (Availability v2's sparse representation, `exactOptionalPropertyTypes`-
   * safe by construction).
   */
  async getMonth(month: Month, companyId: number): Promise<MonthAvailability> {
    const { start, end } = monthDateRange(month);
    const rows = await this.prisma.workerAvailability.findMany({
      where: { date: { gte: start, lte: end }, worker: { companyId } },
      orderBy: [{ workerId: 'asc' }, { date: 'asc' }],
    });

    // Assemble via a `Map` first (no repeated `noUncheckedIndexedAccess` undefined-checks while
    // building), only flattening to the plain JSON-serializable shape `monthAvailabilitySchema`
    // describes at this final wire boundary -- mirrors `engine/problem.ts#buildProblem`'s own
    // Map-then-flatten convention for the identical reason.
    const byWorker = new Map<number, Map<string, ShiftType[]>>();
    for (const row of rows) {
      let byDate = byWorker.get(row.workerId);
      if (!byDate) {
        byDate = new Map();
        byWorker.set(row.workerId, byDate);
      }
      byDate.set(formatDate(row.date), shiftsArrayFromString(row.excludedShifts));
    }

    const result: Record<string, Record<string, ShiftType[]>> = {};
    for (const [workerId, byDate] of byWorker) {
      result[String(workerId)] = Object.fromEntries(byDate);
    }
    return result;
  }

  /**
   * Full-replaces `month`'s entire `WorkerAvailability` window for every worker BELONGING TO
   * `companyId` (never another company's rows -- the delete/insert window is additionally scoped
   * to `companyId`'s own workers, v4) with exactly what `payload` specifies, in one transaction.
   * 400s (never a masked 500) on an unknown `workerId`, a `workerId` belonging to a DIFFERENT
   * company (v4: per-entry error, not a silent cross-company write), or a payload over the entry
   * cap -- all checked BEFORE the transaction opens. Duplicate `(workerId, date)` pairs are
   * unrepresentable by construction (`payload` is a date-keyed object, per
   * `monthAvailabilitySchema`), so there is nothing further to de-duplicate here.
   */
  async replaceMonth(month: Month, payload: MonthAvailability, companyId: number): Promise<void> {
    const { start, end } = monthDateRange(month);

    const workerIdKeys = Object.keys(payload);
    type InsertRow = { workerId: number; date: Date; excludedShifts: string };
    const insertRows: InsertRow[] = [];
    let totalEntries = 0;
    for (const key of workerIdKeys) {
      const workerId = Number(key);
      const byDate = payload[key] ?? {};
      for (const [date, shifts] of Object.entries(byDate)) {
        totalEntries++;
        insertRows.push({ workerId, date: new Date(`${date}T00:00:00.000Z`), excludedShifts: shiftsStringFromArray(shifts) });
      }
    }

    if (totalEntries > MAX_AVAILABILITY_ENTRIES) {
      throw new BadRequestError([
        {
          path: 'body',
          message: `Payload has ${totalEntries} (workerId, date) entries, exceeding the ${MAX_AVAILABILITY_ENTRIES}-entry limit`,
        },
      ]);
    }

    const workerIds = [...new Set(workerIdKeys.map((k) => Number(k)))];
    if (workerIds.length > 0) {
      const existing = await this.prisma.worker.findMany({
        where: { id: { in: workerIds } },
        select: { id: true, companyId: true },
      });
      const existingById = new Map(existing.map((w) => [w.id, w]));
      const fieldErrors: FieldError[] = [];
      for (const id of workerIds) {
        const worker = existingById.get(id);
        if (!worker) {
          fieldErrors.push({ path: String(id), message: `Unknown workerId ${id}` });
        } else if (worker.companyId !== companyId) {
          fieldErrors.push({ path: String(id), message: `Worker ${id} belongs to a different company` });
        }
      }
      if (fieldErrors.length > 0) {
        throw new BadRequestError(fieldErrors);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.workerAvailability.deleteMany({
        where: { date: { gte: start, lte: end }, worker: { companyId } },
      });
      if (insertRows.length > 0) {
        await tx.workerAvailability.createMany({ data: insertRows });
      }
    });
  }
}
