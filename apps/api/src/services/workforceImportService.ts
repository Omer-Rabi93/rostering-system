// Combined workforce-CSV import business logic: parse + per-row validate + upsert-worker-and-
// replace-that-worker's-month-availability, both halves of one row in ONE transaction. Independent
// of pg-boss (testable by calling `importCsv` directly, as `tests/services/
// workforceImportService.test.ts` does) -- the pg-boss job handler in `jobs/workforceImport.job.ts`
// is a thin wrapper around this. Supersedes `CsvImportService` (worker-only) and
// `AvailabilityService`'s CSV-import half (availability-only) -- see the Part G design doc.
//
// v4 carryovers, preserved through the merge: the CSV is scoped to one company at upload time (the
// app's "active company"), and there is NO deactivation sweep -- a worker absent from a new upload
// simply keeps its current status, becoming ineligible for roster generation only if
// `lastImportTaskId` no longer matches the company's latest COMPLETED `WORKFORCE_SYNC` task (see
// `RosterGenerationService`'s eligibility query). `lastImportTaskId` is stamped in BULK, once, only
// after the task is confirmed COMPLETED (see `importCsv`'s bulk-stamp step) -- NOT per-row
// mid-loop: stamping per-row is unsafe, since a worker already correctly stamped by an EARLIER
// completed sync could have that valid stamp overwritten -- and lost -- by a LATER task that
// touched their row before itself getting cancelled, wrongly making them ineligible. This was a
// real, reproduced bug (found by the v4 load-test suite's spam/churn test) before the fix; tying
// the stamp to the same "did we reach COMPLETED" gate as the task status update closes that hole.
//
// Row atomicity (new in the merge): a bad cell ANYWHERE in a row -- a worker field (e.g. unknown
// role) OR a `dNN` availability cell (e.g. an illegal shift letter) -- fails that whole row as one
// unit. `toWorkforceRow` validates both halves BEFORE any transaction opens, so a bad row never
// upserts the worker either, unlike the old two-independent-files world where a worker-field error
// and an availability-cell error were unrelated failures in unrelated uploads.
//
// `ImportTask` two-phase lifecycle, split across two entry points:
//   - `beginImportTask`/`attachImportJob`/`failImportTask` -- called from the ROUTE at upload time
//     (synchronous with the HTTP request/response), before the job is even sent to pg-boss: does
//     the cancel-and-replace dance (cancel any existing non-terminal WORKFORCE_SYNC task+job for
//     this company, create a fresh PENDING task, with a P2002 retry backstop against the DB-level
//     partial unique index `import_tasks_company_kind_active_key`), so a subsequent rapid
//     re-upload can find and cancel it even if the job it's attached to hasn't started yet. Note
//     the cancel-and-replace slot is scoped to `(companyId, kind)` only, NOT month -- uploading a
//     different month for the same company still cancels an in-flight upload, matching this
//     app's pre-merge behavior for both source pipelines.
//   - `importCsv` -- called from the pg-boss job handler once the job is actually dequeued: adopts
//     the specific task the route created (matched by `pgBossJobId`, which the job handler knows
//     as its own `job.id`), marks it PROCESSING, runs the per-row loop with a cooperative-
//     cancellation check every ~50 rows (re-reads the task's own status; a concurrent
//     cancel-and-replace from a newer upload marks it non-PROCESSING, at which point this loop
//     stops without ever marking the task COMPLETED), then finalizes it COMPLETED. When called
//     directly (as this file's own tests do) with no `pgBossJobId` -- i.e. bypassing the route
//     entirely -- `importCsv` self-bootstraps its own task via the same cancel-and-replace helper,
//     so it stays fully testable in isolation without any pg-boss involved.

import { contractSchema, workerSchema, type ImportResult, type Month } from '@rostering/shared';
import type { PgBoss } from 'pg-boss';
import { ZodError } from 'zod';

import { monthDateRange } from '../engine/calendar.js';
import {
  AvailabilityCsvCellError,
  CsvFieldError,
  parseWorkforceCsv,
  shiftsToCell,
  toWorkforceRow,
  type WorkforceCsvRawRow,
} from '../csv/index.js';
import type { PrismaClient } from '../db/client.js';
import { isUniqueConstraintViolation } from '../db/prismaErrors.js';
import type { ImportTask } from '../generated/prisma/client.js';
import { cancelJob, QUEUES } from '../jobs/queue.js';

type ImportRowError = ImportResult['errors'][number];

/** Re-read the task's own status this often (row count) inside the import loop -- matches the v4
 * design doc's "every 50 rows" figure. */
const CANCELLATION_CHECK_INTERVAL = 50;

/** Bounded retry count for `cancelAndCreateTask`'s P2002 backstop against near-simultaneous
 * uploads for the same company+kind. See that method's catch block for why a single retry isn't
 * enough under genuine concurrent load -- 20, not 5, because this is ALSO the inner half of the
 * route-level retry (`routes/workforce.ts`'s `MAX_ENQUEUE_ATTEMPTS`), and an exhausted-retries
 * throw here propagates uncaught up through that outer loop's `beginImportTask` call (confirmed as
 * a real reproduced 500 with a genuine 10-way concurrent burst, pre-merge). Each individual
 * collision resolves in microseconds, so this bound is about comfortable headroom under realistic
 * worst-case concurrency, not a meaningfully longer wait. */
const MAX_CANCEL_AND_CREATE_ATTEMPTS = 20;

const WORKFORCE_SYNC_KIND = 'WORKFORCE_SYNC' as const;

function toRowError(row: number, nationalId: string | undefined, err: unknown): ImportRowError {
  if (err instanceof CsvFieldError || err instanceof AvailabilityCsvCellError) {
    return { row, nationalId, field: err.field, message: err.message };
  }
  if (err instanceof ZodError) {
    const [issue] = err.issues;
    return {
      row,
      nationalId,
      field: issue ? issue.path.join('.') || undefined : undefined,
      message: issue ? issue.message : 'Validation failed',
    };
  }
  return { row, nationalId, message: err instanceof Error ? err.message : String(err) };
}

/**
 * Combined workforce-CSV import for `companyId` and one target `month`, `PrismaClient`/`PgBoss`
 * constructor-injected (the latter needed for the cancel-and-replace lifecycle's `boss.cancel()`
 * step -- see the file-level doc comment). No Express -- plain input (CSV text + companyId +
 * month) in, `ImportResult` out.
 */
export class WorkforceImportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly boss: PgBoss,
  ) {}

  /** See the file-level doc comment's "two-phase lifecycle" section. */
  async beginImportTask(companyId: number, month: Month, totalRows: number): Promise<ImportTask> {
    return this.cancelAndCreateTask(companyId, month, totalRows, undefined, 'PENDING');
  }

  /** Stamps the pg-boss job id onto a task created by `beginImportTask`, once
   * `enqueueWorkforceImport` has actually sent the job -- this is the value a LATER upload's
   * `beginImportTask` call will `boss.cancel()` if it supersedes this one before it starts running. */
  async attachImportJob(taskId: number, pgBossJobId: string): Promise<void> {
    await this.prisma.importTask.update({ where: { id: taskId }, data: { pgBossJobId } });
  }

  /** Cleanup for the rare case `enqueueWorkforceImport` itself returns `null` (a genuine
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
   * Full combined workforce-CSV import for `companyId`/`month`. Every row's worker is definitively
   * in `companyId` -- no per-row company resolution/creation. Worker matching by `nationalId`
   * stays GLOBALLY unique: a row whose `national_id` already belongs to a DIFFERENT company is a
   * per-row validation error ("worker already registered under a different company"), never a
   * silent reassignment. Each row runs in its own transaction so a failing row rolls back only
   * itself and the batch continues. NO deactivation sweep -- a worker absent from the file is
   * simply untouched (status unchanged); see the file-level doc comment.
   *
   * `pgBossJobId`, when given, must be this run's own pg-boss job id (the job handler's `job.id`)
   * -- used to adopt the specific `ImportTask` row `beginImportTask` created for this exact upload.
   * Omitted entirely for a direct call (every existing unit test) -- in that case a fresh task is
   * self-bootstrapped via the same cancel-and-replace helper `beginImportTask` uses, so this method
   * stays fully testable in isolation without a real pg-boss job ever having been sent.
   */
  async importCsv(csvText: string, month: Month, companyId: number, pgBossJobId?: string): Promise<ImportResult> {
    const rawRows = parseWorkforceCsv(csvText, month);
    const { start, end } = monthDateRange(month);

    const task = await this.claimTask(companyId, month, rawRows.length, pgBossJobId);

    let inserted = 0;
    let updated = 0;
    let failed = 0;
    let cancelled = false;
    const errors: ImportRowError[] = [];
    // Collected, not stamped, per row -- see the bulk-stamp step below for why the stamp itself
    // must wait until the task is confirmed COMPLETED, never written optimistically mid-loop.
    const touchedWorkerIds: number[] = [];

    for (const [index, raw] of rawRows.entries()) {
      const rowNum = index + 1;

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
        const { outcome, workerId } = await this.importRow(raw, month, start, end, companyId);
        if (outcome === 'inserted') inserted++;
        else updated++;
        touchedWorkerIds.push(workerId);
      } catch (err) {
        failed++;
        errors.push(toRowError(rowNum, raw.worker.national_id, err));
      }
    }

    const result: ImportResult = { totalRows: rawRows.length, inserted, updated, failed, errors };

    if (!cancelled) {
      // `lastImportTaskId` is stamped HERE, in bulk, only once the task is confirmed COMPLETED --
      // see the file-level doc comment for why per-row stamping is unsafe.
      if (touchedWorkerIds.length > 0) {
        await this.prisma.worker.updateMany({
          where: { id: { in: touchedWorkerIds } },
          data: { lastImportTaskId: task.id },
        });
      }
      await this.prisma.importTask.update({
        where: { id: task.id },
        data: {
          status: 'COMPLETED',
          processedRows: inserted + updated + failed,
          insertedCount: inserted,
          updatedCount: updated,
          failedCount: failed,
          errors,
          finishedAt: new Date(),
        },
      });
    }
    // If `cancelled`, the task was already marked non-PROCESSING (CANCELLED) by whichever newer
    // upload superseded us -- leave it exactly as that upload's own `beginImportTask` left it,
    // never overwrite it back to COMPLETED, and never stamp lastImportTaskId for the rows we
    // touched before noticing the cancellation.

    return result;
  }

  /** One row = one transaction: resolve + validate both halves (worker fields AND that month's
   * availability cells) via `toWorkforceRow` FIRST, outside any transaction -- a row with a bad
   * cell (worker field or `dNN`) never opens a transaction, so the worker is never upserted for a
   * row that fails on its availability side either (row atomicity, new in the merge). Inside the
   * transaction: reject a cross-company `national_id` conflict, upsert-by-`national_id`, then
   * replace that SAME worker's `WorkerAvailability` month window using the just-resolved workerId
   * (no second nationalId lookup, unlike the pre-merge availability-only path). Does NOT stamp
   * `lastImportTaskId` here -- see `importCsv`'s bulk-stamp-at-completion step. */
  private async importRow(
    raw: WorkforceCsvRawRow,
    month: Month,
    start: Date,
    end: Date,
    companyId: number,
  ): Promise<{ outcome: 'inserted' | 'updated'; workerId: number }> {
    const { record, entries } = toWorkforceRow(raw, month);

    return this.prisma.$transaction(async (tx) => {
      const workerInput = workerSchema.parse({
        nationalId: record.nationalId,
        name: record.name,
        role: record.role,
        status: record.status,
        companyId,
      });
      const contractInput = contractSchema.parse({
        hourlyCostIls: record.hourlyCostIls,
        minMonthlyHours: record.minMonthlyHours,
        maxMonthlyHours: record.maxMonthlyHours,
      });
      const contractColumns = {
        hourlyCostIls: contractInput.hourlyCostIls,
        minMonthlyHours: contractInput.minMonthlyHours,
        maxMonthlyHours: contractInput.maxMonthlyHours,
      };

      const existing = await tx.worker.findUnique({ where: { nationalId: workerInput.nationalId } });
      if (existing && existing.companyId !== companyId) {
        throw new CsvFieldError(
          'national_id',
          `Worker ${workerInput.nationalId} is already registered under a different company`,
        );
      }

      let workerId: number;
      let outcome: 'inserted' | 'updated';
      if (existing) {
        await tx.worker.update({
          where: { id: existing.id },
          data: { name: workerInput.name, role: workerInput.role, status: workerInput.status },
        });
        await tx.contract.upsert({
          where: { workerId: existing.id },
          create: { workerId: existing.id, ...contractColumns },
          update: { ...contractColumns },
        });
        workerId = existing.id;
        outcome = 'updated';
      } else {
        const created = await tx.worker.create({
          data: {
            nationalId: workerInput.nationalId,
            name: workerInput.name,
            role: workerInput.role,
            status: workerInput.status,
            companyId,
          },
        });
        await tx.contract.create({ data: { workerId: created.id, ...contractColumns } });
        workerId = created.id;
        outcome = 'inserted';
      }

      const insertRows = entries.map((entry) => ({
        workerId,
        date: new Date(`${entry.date}T00:00:00.000Z`),
        excludedShifts: shiftsToCell(entry.shifts),
      }));
      await tx.workerAvailability.deleteMany({ where: { workerId, date: { gte: start, lte: end } } });
      if (insertRows.length > 0) {
        await tx.workerAvailability.createMany({ data: insertRows });
      }

      return { outcome, workerId };
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
        where: { companyId, kind: WORKFORCE_SYNC_KIND, pgBossJobId },
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
   * Cancels by `(companyId, WORKFORCE_SYNC)` only -- NOT scoped by month, matching this app's
   * pre-merge behavior (neither prior service's slot was ever month-scoped either).
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
      where: { companyId, kind: WORKFORCE_SYNC_KIND, status: { in: ['PENDING', 'PROCESSING'] } },
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
        await cancelJob(this.boss, QUEUES.WORKFORCE_IMPORT, existingTask.pgBossJobId).catch(() => undefined);
      }
    }

    try {
      return await this.prisma.importTask.create({
        data: {
          companyId,
          kind: WORKFORCE_SYNC_KIND,
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
        // that won -- re-run the full sequence (v4 design doc, Part A's "Cancel-and-replace").
        return this.cancelAndCreateTask(companyId, month, totalRows, pgBossJobId, initialStatus, attempt + 1);
      }
      throw err;
    }
  }
}
