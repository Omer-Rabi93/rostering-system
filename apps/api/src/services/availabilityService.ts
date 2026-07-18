// Availability v2 business logic: the bulk `GET`/`PUT /api/availability/:month` JSON endpoints
// (planner grid data source) and the month-scoped availability CSV import (`csv/availability.ts`
// framing + guard, this module's job: worker lookup, per-row apply, error reporting). No Express,
// no pg-boss -- `PrismaClient` constructor-injected, directly testable, exactly like
// `CsvImportService`/`RosterGenerationService`.

import type { AvailabilityImportResult, Month, MonthAvailability } from '@rostering/shared';
import type { ShiftType } from '@rostering/shared';

import { monthDays } from '../engine/calendar.js';
import { BadRequestError } from '../errors.js';
import { formatDate } from './alertRecompute.js';
import {
  AvailabilityCsvCellError,
  parseAvailabilityCsv,
  serializeAvailabilityCsv,
  toAvailabilityEntries,
  type AvailabilityCsvExportRow,
  type AvailabilityCsvRawRow,
} from '../csv/availability.js';
import type { PrismaClient } from '../db/client.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * DoS bound on the `PUT /api/availability/:month` payload, checked after Zod's `.strict()` shape
 * validation and before opening the replace transaction -- analogous to `routes/importExport.ts`'s
 * `MAX_ROWS`, comfortably above the plan's own stated 500-worker x 31-date = 15,500 worst case.
 */
export const MAX_AVAILABILITY_ENTRIES = 20_000;

function monthDateRange(month: string): { readonly start: Date; readonly end: Date } {
  const days = monthDays(month);
  const [first] = days;
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error(`Month ${month} produced no calendar days`);
  }
  return { start: new Date(`${first}T00:00:00.000Z`), end: new Date(`${last}T00:00:00.000Z`) };
}

/** `WorkerAvailability.shifts` stores the canonical subset as a plain string (e.g. "A", "ABC") --
 * every stored row was Zod-validated on write to only ever contain A/B/C in canonical order, so
 * splitting into characters is exact, not a parse that can fail here (mirrors
 * `shiftWorkerService.ts`'s own `parseShiftSubset`). */
function shiftsStringFromArray(shifts: readonly ShiftType[]): string {
  return shifts.join('');
}
function shiftsArrayFromString(shifts: string): ShiftType[] {
  return shifts.split('') as ShiftType[];
}

function toImportRowError(
  row: number,
  nationalId: string,
  err: unknown,
): AvailabilityImportResult['errors'][number] {
  if (err instanceof AvailabilityCsvCellError) {
    return { row, nationalId, field: err.field, message: err.message };
  }
  return { row, nationalId, message: err instanceof Error ? err.message : String(err) };
}

export class AvailabilityService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * All `WorkerAvailability` rows in `month`'s date window, grouped per worker: `{ [workerId]:
   * { [date]: shifts } }`. A worker/date with no row simply has no key -- built by only ever
   * assigning entries that exist, never a `date: undefined` placeholder (Availability v2's sparse
   * representation, `exactOptionalPropertyTypes`-safe by construction).
   */
  async getMonth(month: Month): Promise<MonthAvailability> {
    const { start, end } = monthDateRange(month);
    const rows = await this.prisma.workerAvailability.findMany({
      where: { date: { gte: start, lte: end } },
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
      byDate.set(formatDate(row.date), shiftsArrayFromString(row.shifts));
    }

    const result: Record<string, Record<string, ShiftType[]>> = {};
    for (const [workerId, byDate] of byWorker) {
      result[String(workerId)] = Object.fromEntries(byDate);
    }
    return result;
  }

  /**
   * Full-replaces `month`'s entire `WorkerAvailability` window (every worker, not only those in
   * `payload`) with exactly what `payload` specifies, in one transaction: delete the month's date
   * window, then insert. 400s (never a masked 500) on an unknown `workerId` or a payload over the
   * entry cap -- both checked BEFORE the transaction opens. Duplicate `(workerId, date)` pairs are
   * unrepresentable by construction (`payload` is a date-keyed object, per
   * `monthAvailabilitySchema`), so there is nothing further to de-duplicate here.
   */
  async replaceMonth(month: Month, payload: MonthAvailability): Promise<void> {
    const { start, end } = monthDateRange(month);

    const workerIdKeys = Object.keys(payload);
    type InsertRow = { workerId: number; date: Date; shifts: string };
    const insertRows: InsertRow[] = [];
    let totalEntries = 0;
    for (const key of workerIdKeys) {
      const workerId = Number(key);
      const byDate = payload[key] ?? {};
      for (const [date, shifts] of Object.entries(byDate)) {
        totalEntries++;
        insertRows.push({ workerId, date: new Date(`${date}T00:00:00.000Z`), shifts: shiftsStringFromArray(shifts) });
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
        select: { id: true },
      });
      const existingIds = new Set(existing.map((w) => w.id));
      const unknownIds = workerIds.filter((id) => !existingIds.has(id));
      if (unknownIds.length > 0) {
        throw new BadRequestError(
          unknownIds.map((id) => ({ path: String(id), message: `Unknown workerId ${id}` })),
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.workerAvailability.deleteMany({ where: { date: { gte: start, lte: end } } });
      if (insertRows.length > 0) {
        await tx.workerAvailability.createMany({ data: insertRows });
      }
    });
  }

  /**
   * Month-scoped availability CSV export: one row per worker who has at least one
   * `WorkerAvailability` entry in `month`'s window (mirrors `getMonth`'s sparse convention -- a
   * worker with zero rows this month contributes nothing to either representation), formatted via
   * `csv/availability.ts#serializeAvailabilityCsv` so export -> import round-trips unmodified.
   */
  async exportCsv(month: Month): Promise<string> {
    const { start, end } = monthDateRange(month);
    const rows = await this.prisma.workerAvailability.findMany({
      where: { date: { gte: start, lte: end } },
      include: { worker: { select: { nationalId: true } } },
      orderBy: [{ workerId: 'asc' }, { date: 'asc' }],
    });

    const byWorker = new Map<string, AvailabilityCsvExportRow['entries'][number][]>();
    for (const row of rows) {
      const nationalId = row.worker.nationalId;
      let entries = byWorker.get(nationalId);
      if (!entries) {
        entries = [];
        byWorker.set(nationalId, entries);
      }
      entries.push({ date: formatDate(row.date), shifts: shiftsArrayFromString(row.shifts) });
    }

    const exportRows: AvailabilityCsvExportRow[] = [...byWorker.entries()].map(([nationalId, entries]) => ({
      nationalId,
      entries,
    }));
    return serializeAvailabilityCsv(exportRows, month);
  }

  /**
   * Month-scoped availability CSV import: one transaction per row (mirroring
   * `CsvImportService.importCsv`'s per-row-transaction convention), each row replacing exactly
   * that worker's `WorkerAvailability` rows for `month`'s date window with what the row specifies.
   * An unknown `national_id` or any illegal `dNN` cell fails that row as a whole -- reported by row
   * number, batch not aborted. NO deactivation sweep (that is worker-CSV-only semantics): a worker
   * absent from the file is simply untouched, keeping whatever rows they already have.
   */
  async importCsv(csvText: string, month: Month): Promise<AvailabilityImportResult> {
    const rawRows = parseAvailabilityCsv(csvText, month);
    const { start, end } = monthDateRange(month);

    let applied = 0;
    let failed = 0;
    const errors: AvailabilityImportResult['errors'] = [];

    for (const raw of rawRows) {
      try {
        await this.applyRow(raw, month, start, end);
        applied++;
      } catch (err) {
        failed++;
        errors.push(toImportRowError(raw.rowNumber, raw.nationalId, err));
      }
    }

    return { totalRows: rawRows.length, applied, failed, errors };
  }

  private async applyRow(raw: AvailabilityCsvRawRow, month: Month, start: Date, end: Date): Promise<void> {
    // Validate the row's cells before touching the DB -- a row that fails cell validation never
    // needs a worker lookup at all.
    const entries = toAvailabilityEntries(raw, month);

    const worker = await this.prisma.worker.findUnique({ where: { nationalId: raw.nationalId } });
    if (!worker) {
      throw new Error(`Unknown national_id "${raw.nationalId}"`);
    }

    const insertRows: Prisma.WorkerAvailabilityCreateManyInput[] = entries.map((entry) => ({
      workerId: worker.id,
      date: new Date(`${entry.date}T00:00:00.000Z`),
      shifts: shiftsStringFromArray(entry.shifts),
    }));

    await this.prisma.$transaction(async (tx) => {
      await tx.workerAvailability.deleteMany({ where: { workerId: worker.id, date: { gte: start, lte: end } } });
      if (insertRows.length > 0) {
        await tx.workerAvailability.createMany({ data: insertRows });
      }
    });
  }
}
