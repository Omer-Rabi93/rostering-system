// Availability v2 business logic: the bulk `GET`/`PUT /api/availability/:month` JSON endpoints
// (planner grid data source) and the month-scoped availability CSV import (`csv/availability.ts`
// framing + guard, this module's job: worker lookup, per-row apply, error reporting). No Express
// -- `PrismaClient`/`PgBoss` constructor-injected, directly testable, exactly like
// `CsvImportService`/`RosterGenerationService`.
//
// v4: both write paths (`replaceMonth`, `importCsv`) are now company-scoped end to end -- see the
// v4 design doc, Part A ("Same-company nationalId matching, cross-company conflict as an error").
// The CSV import path additionally gets the full `ImportTask` lifecycle (pending/processing/
// completed/cancelled, cancel-and-replace, cooperative cancellation) that worker-CSV import gets in
// `csvImportService.ts` -- implemented independently here since availability sync does NOT need
// the `lastImportTaskId` eligibility-gating mechanism (worker-CSV-only), only the task-tracking/
// queue/cancel-and-replace treatment; some duplication between the two services for this one
// release is expected, see the design doc.
//
// `ImportTask` two-phase lifecycle, split across two entry points:
//   - `beginImportTask`/`attachImportJob`/`failImportTask` -- called from the ROUTE at upload time
//     (synchronous with the HTTP request/response), before the job is even sent to pg-boss: does
//     the cancel-and-replace dance (cancel any existing non-terminal task+job for this company,
//     create a fresh PENDING task, with a P2002 retry backstop against the DB-level partial unique
//     index), so a subsequent rapid re-upload can find and cancel it even if the job it's attached
//     to hasn't started running yet.
//   - `importCsv` -- called from the pg-boss job handler once the job is actually dequeued: adopts
//     the specific task the route created (matched by `pgBossJobId`, which the job handler knows as
//     its own `job.id`), marks it PROCESSING, runs the per-row loop with a cooperative-cancellation
//     check every ~50 rows (re-reads the task's own status; a concurrent cancel-and-replace from a
//     newer upload marks it non-PROCESSING, at which point this loop stops without ever marking the
//     task COMPLETED), then finalizes it COMPLETED. When called directly (as this codebase's tests
//     do, and as the worker-CSV service's own tests do for its analogous path) with no `pgBossJobId`
//     -- i.e. bypassing the route entirely -- `importCsv` self-bootstraps its own task via the same
//     cancel-and-replace helper, so it stays fully testable in isolation without any pg-boss
//     involved, per this codebase's existing testability convention.

import type { AvailabilityImportResult, Month, MonthAvailability } from '@rostering/shared';
import type { ShiftType } from '@rostering/shared';
import type { PgBoss } from 'pg-boss';

import { monthDays } from '../engine/calendar.js';
import { BadRequestError, type FieldError } from '../errors.js';
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
import { isUniqueConstraintViolation } from '../db/prismaErrors.js';
import type { ImportTask, Prisma } from '../generated/prisma/client.js';
import { cancelJob, QUEUES } from '../jobs/queue.js';

/**
 * DoS bound on the `PUT /api/availability/:month` payload, checked after Zod's `.strict()` shape
 * validation and before opening the replace transaction -- analogous to `routes/importExport.ts`'s
 * `MAX_ROWS`, comfortably above the plan's own stated 500-worker x 31-date = 15,500 worst case.
 */
export const MAX_AVAILABILITY_ENTRIES = 20_000;

/** Re-read the task's own status this often (row count) inside the import loop -- the cooperative-
 * cancellation check a `boss.cancel()` call alone cannot guarantee (it cannot forcibly interrupt
 * Node.js code already executing inside a running handler). Matches the v4 design doc's "every 50
 * rows" figure. */
const CANCELLATION_CHECK_INTERVAL = 50;

/** Bounded retry count for `cancelAndCreateTask`'s P2002 backstop against near-simultaneous
 * uploads for the same company+kind. See that method's catch block for why a single retry isn't
 * enough under genuine concurrent load -- 20, not 5, because this is ALSO the inner half of the
 * route-level retry (`routes/availability.ts`'s `MAX_ENQUEUE_ATTEMPTS`), and an exhausted-retries
 * throw here propagates uncaught up through that outer loop's `beginImportTask` call. Matches
 * `CsvImportService`'s identical constant/reasoning. */
const MAX_CANCEL_AND_CREATE_ATTEMPTS = 20;

const AVAILABILITY_SYNC_KIND = 'AVAILABILITY_SYNC' as const;

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
  constructor(
    private readonly prisma: PrismaClient,
    private readonly boss: PgBoss,
  ) {}

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
      byDate.set(formatDate(row.date), shiftsArrayFromString(row.shifts));
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
   * Route-time half of cancel-and-replace (v4): cancels any existing non-terminal `ImportTask` for
   * `(companyId, AVAILABILITY_SYNC)` -- marking it `CANCELLED` in the DB first, then best-effort
   * `boss.cancel()`-ing its pg-boss job (a no-op if that job already started running; cooperative
   * cancellation inside `importCsv`'s row loop is what actually stops that case) -- then creates a
   * fresh `PENDING` task row for the new upload. Retries the whole cancel-then-create sequence once
   * if the DB-level partial unique index (`import_tasks_company_kind_active_key`) rejects the
   * insert with a unique-constraint violation, per the v4 design doc's required backstop against
   * two near-simultaneous uploads both reading "no existing task" and both trying to create one.
   * Called from the route BEFORE `enqueueAvailabilityImport`, so the returned task's id is available
   * to stamp `pgBossJobId` onto once the job is actually sent (`attachImportJob`).
   */
  async beginImportTask(companyId: number, month: Month, totalRows: number): Promise<ImportTask> {
    return this.cancelAndCreateTask(companyId, month, totalRows, undefined, 'PENDING');
  }

  /** Stamps the pg-boss job id onto a task created by `beginImportTask`, once
   * `enqueueAvailabilityImport` has actually sent the job -- this is the value a LATER upload's
   * `beginImportTask` call will `boss.cancel()` if it supersedes this one before it starts running. */
  async attachImportJob(taskId: number, pgBossJobId: string): Promise<void> {
    await this.prisma.importTask.update({ where: { id: taskId }, data: { pgBossJobId } });
  }

  /** Cleanup for the rare case `enqueueAvailabilityImport` itself returns `null` (a genuine
   * singleton-slot collision even after `beginImportTask`'s own cancel-and-replace) -- marks the
   * orphaned `PENDING` task `FAILED` rather than leaving it dangling as a phantom "non-terminal
   * task" that would block every future upload for this company. */
  async failImportTask(taskId: number): Promise<void> {
    await this.prisma.importTask.update({
      where: { id: taskId },
      data: { status: 'FAILED', finishedAt: new Date() },
    });
  }

  /**
   * Month-scoped availability CSV import: one transaction per row (mirroring
   * `CsvImportService.importCsv`'s per-row-transaction convention), each row replacing exactly
   * that worker's `WorkerAvailability` rows for `month`'s date window with what the row specifies.
   * An unknown `national_id`, a `national_id` belonging to a DIFFERENT company (v4), or any illegal
   * `dNN` cell fails that row as a whole -- reported by row number, batch not aborted. NO
   * deactivation sweep (that is worker-CSV-only semantics): a worker absent from the file is simply
   * untouched, keeping whatever rows they already have.
   *
   * `pgBossJobId`, when given, must be this run's own pg-boss job id (the job handler's `job.id`)
   * -- used to adopt the specific `ImportTask` row `beginImportTask` created for this exact upload.
   * Omitted entirely for a direct call (every existing unit test, and any other in-process caller
   * bypassing the route/queue) -- in that case a fresh task is self-bootstrapped via the same
   * cancel-and-replace helper `beginImportTask` uses, so this method stays fully testable in
   * isolation without a real pg-boss job ever having been sent.
   */
  async importCsv(csvText: string, month: Month, companyId: number, pgBossJobId?: string): Promise<AvailabilityImportResult> {
    const rawRows = parseAvailabilityCsv(csvText, month);
    const { start, end } = monthDateRange(month);

    const task = await this.claimTask(companyId, month, rawRows.length, pgBossJobId);

    let applied = 0;
    let failed = 0;
    let cancelled = false;
    const errors: AvailabilityImportResult['errors'] = [];

    for (const [index, raw] of rawRows.entries()) {
      if (index > 0 && index % CANCELLATION_CHECK_INTERVAL === 0) {
        const fresh = await this.prisma.importTask.findUnique({
          where: { id: task.id },
          select: { status: true },
        });
        if (fresh?.status !== 'PROCESSING') {
          cancelled = true;
          break;
        }
      }

      try {
        await this.applyRow(raw, month, start, end, companyId);
        applied++;
      } catch (err) {
        failed++;
        errors.push(toImportRowError(raw.rowNumber, raw.nationalId, err));
      }
    }

    const result: AvailabilityImportResult = { totalRows: rawRows.length, applied, failed, errors };

    if (!cancelled) {
      await this.prisma.importTask.update({
        where: { id: task.id },
        data: {
          status: 'COMPLETED',
          processedRows: applied + failed,
          insertedCount: applied,
          failedCount: failed,
          errors,
          finishedAt: new Date(),
        },
      });
    }
    // If `cancelled`, the task was already marked non-PROCESSING (CANCELLED) by whichever newer
    // upload superseded us -- leave it exactly as that upload's own `beginImportTask` left it,
    // never overwrite it back to COMPLETED.

    return result;
  }

  private async applyRow(
    raw: AvailabilityCsvRawRow,
    month: Month,
    start: Date,
    end: Date,
    companyId: number,
  ): Promise<void> {
    // Validate the row's cells before touching the DB -- a row that fails cell validation never
    // needs a worker lookup at all.
    const entries = toAvailabilityEntries(raw, month);

    const worker = await this.prisma.worker.findUnique({ where: { nationalId: raw.nationalId } });
    if (!worker) {
      throw new Error(`Unknown national_id "${raw.nationalId}"`);
    }
    if (worker.companyId !== companyId) {
      throw new Error(`Worker with national_id "${raw.nationalId}" is already registered under a different company`);
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

  /** `importCsv`'s task-acquisition step: adopt the task `beginImportTask` created for this exact
   * `pgBossJobId` (the real route -> queue -> job-handler pipeline), or self-bootstrap a fresh one
   * via the same cancel-and-replace helper (direct/test callers, or the defensive fallback if no
   * matching task is found -- e.g. this method somehow ran outside the normal pipeline). */
  private async claimTask(
    companyId: number,
    month: Month,
    totalRows: number,
    pgBossJobId: string | undefined,
  ): Promise<ImportTask> {
    if (pgBossJobId) {
      const existing = await this.prisma.importTask.findFirst({
        where: { companyId, kind: AVAILABILITY_SYNC_KIND, pgBossJobId },
      });
      if (existing) {
        return this.prisma.importTask.update({
          where: { id: existing.id },
          data: { status: 'PROCESSING', startedAt: new Date(), totalRows },
        });
      }
    }
    return this.cancelAndCreateTask(companyId, month, totalRows, pgBossJobId, 'PROCESSING');
  }

  /**
   * Shared cancel-and-replace primitive backing both `beginImportTask` (creates a `PENDING` task,
   * no `pgBossJobId` yet -- stamped later by `attachImportJob`) and `claimTask`'s self-bootstrap
   * fallback (creates a task already `PROCESSING`, since row processing starts immediately after).
   * See `beginImportTask`'s doc comment for the full cancel-and-replace + DB-backstop sequence --
   * identical here, just parameterized over the new task's initial status.
   */
  private async cancelAndCreateTask(
    companyId: number,
    month: Month,
    totalRows: number,
    pgBossJobId: string | undefined,
    initialStatus: 'PENDING' | 'PROCESSING',
    attempt = 0,
  ): Promise<ImportTask> {
    const existingTask = await this.prisma.importTask.findFirst({
      where: { companyId, kind: AVAILABILITY_SYNC_KIND, status: { in: ['PENDING', 'PROCESSING'] } },
    });
    if (existingTask) {
      await this.prisma.importTask.update({
        where: { id: existingTask.id },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
      if (existingTask.pgBossJobId) {
        // Best-effort: reliably stops a job that hasn't started yet; a no-op (never throws in a way
        // that should abort cancel-and-replace) for a job already executing -- that case is instead
        // handled by `importCsv`'s own cooperative-cancellation check against the DB row we just
        // marked CANCELLED above.
        await cancelJob(this.boss, QUEUES.AVAILABILITY_IMPORT, existingTask.pgBossJobId).catch(() => undefined);
      }
    }

    try {
      return await this.prisma.importTask.create({
        data: {
          companyId,
          kind: AVAILABILITY_SYNC_KIND,
          status: initialStatus,
          month,
          totalRows,
          pgBossJobId: pgBossJobId ?? null,
          startedAt: initialStatus === 'PROCESSING' ? new Date() : null,
        },
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err) && attempt < MAX_CANCEL_AND_CREATE_ATTEMPTS) {
        // The just-lost race means there IS now a non-terminal task to cancel, from the request
        // that won -- re-run the full sequence (v4 design doc, Part A's "Cancel-and-replace"). A
        // single retry (attempt === 0 only) is NOT enough under genuine concurrent load: with
        // several requests racing for the same company+kind slot, attempt 1 can itself lose to a
        // third racer, and so on -- confirmed as a real, reproduced bug (raw 500s under the v4
        // load-test suite's rapid-fire-reupload script, same root cause as `CsvImportService`'s
        // identical fix) before this fix. Each collision resolves as soon as any one racer's
        // transaction commits (microseconds), so a small bounded retry count comfortably absorbs
        // realistic contention without risking an unbounded loop against a genuinely broken DB.
        return this.cancelAndCreateTask(companyId, month, totalRows, pgBossJobId, initialStatus, attempt + 1);
      }
      throw err;
    }
  }
}
