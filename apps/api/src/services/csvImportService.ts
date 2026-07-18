// CSV import business logic: parse + per-row validate + upsert-by-national_id. Independent of
// pg-boss (testable by calling `importCsv` directly, as `tests/services/csvImportService.test.ts`
// does) -- the pg-boss job handler in `jobs/csvImport.job.ts` is a thin wrapper around this.
//
// v4: the worker CSV is now scoped to one company at upload time (the app's "active company" --
// no more per-row `company_name` resolution/creation, see `csv/columns.ts`'s 7-column schema), and
// the old GLOBAL "sync sweep" deactivation pass (any ACTIVE worker anywhere whose national_id
// wasn't in the file got set INACTIVE) is REMOVED ENTIRELY -- it was a real bug (uploading one
// company's roster silently deactivated every other company's workers) as well as being replaced
// by a better mechanism: a worker absent from a new upload simply keeps its current status, and
// becomes ineligible for roster generation only if `lastImportTaskId` no longer matches the
// company's latest COMPLETED `WORKER_SYNC` task (see `RosterGenerationService`'s eligibility
// query). `lastImportTaskId` is stamped optimistically on every row this service
// matches/creates/updates, inside the same per-row transaction -- if the task is later cancelled
// (superseded by a newer upload) rather than reaching COMPLETED, that stamp is simply never "the
// latest COMPLETED task's id" for eligibility purposes, so it's inert, not wrong.
//
// `ImportTask` two-phase lifecycle, split across two entry points -- identical shape to
// `AvailabilityService`'s independently-implemented version (some duplication between the two
// services for this one release is expected/documented in the v4 design doc; worker-CSV import
// additionally needs the `lastImportTaskId` eligibility-gating stamp, which availability sync does
// not):
//   - `beginImportTask`/`attachImportJob`/`failImportTask` -- called from the ROUTE at upload time
//     (synchronous with the HTTP request/response), before the job is even sent to pg-boss: does
//     the cancel-and-replace dance (cancel any existing non-terminal WORKER_SYNC task+job for this
//     company, create a fresh PENDING task, with a P2002 retry backstop against the DB-level
//     partial unique index `import_tasks_company_kind_active_key`), so a subsequent rapid
//     re-upload can find and cancel it even if the job it's attached to hasn't started yet.
//   - `importCsv` -- called from the pg-boss job handler once the job is actually dequeued: adopts
//     the specific task the route created (matched by `pgBossJobId`, which the job handler knows
//     as its own `job.id`), marks it PROCESSING, runs the per-row loop with a cooperative-
//     cancellation check every ~50 rows (re-reads the task's own status; a concurrent
//     cancel-and-replace from a newer upload marks it non-PROCESSING, at which point this loop
//     stops without ever marking the task COMPLETED), then finalizes it COMPLETED. When called
//     directly (as this file's own tests do) with no `pgBossJobId` -- i.e. bypassing the route
//     entirely -- `importCsv` self-bootstraps its own task via the same cancel-and-replace helper,
//     so it stays fully testable in isolation without any pg-boss involved.

import { contractSchema, workerSchema, type ImportResult } from '@rostering/shared';
import type { PgBoss } from 'pg-boss';
import { ZodError } from 'zod';

import type { PrismaClient } from '../db/client.js';
import { isUniqueConstraintViolation } from '../db/prismaErrors.js';
import type { ImportTask } from '../generated/prisma/client.js';
import { cancelJob, QUEUES } from '../jobs/queue.js';
import { CsvFieldError, parseWorkersCsv, toWorkerRecord, type CsvRawRow } from '../csv/index.js';

type ImportRowError = ImportResult['errors'][number];

/** Re-read the task's own status this often (row count) inside the import loop -- matches the v4
 * design doc's "every 50 rows" figure and `AvailabilityService`'s identical constant. */
const CANCELLATION_CHECK_INTERVAL = 50;

const WORKER_SYNC_KIND = 'WORKER_SYNC' as const;

function toRowError(row: number, nationalId: string | undefined, err: unknown): ImportRowError {
  if (err instanceof CsvFieldError) {
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
 * Worker + Contract CSV bulk import, `PrismaClient`/`PgBoss` constructor-injected (the latter
 * needed for the cancel-and-replace lifecycle's `boss.cancel()` step -- see the file-level doc
 * comment). No Express -- plain input (CSV text + companyId) in, `ImportResult` out.
 */
export class CsvImportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly boss: PgBoss,
  ) {}

  /**
   * Route-time half of cancel-and-replace (v4): cancels any existing non-terminal `ImportTask` for
   * `(companyId, WORKER_SYNC)` -- marking it `CANCELLED` in the DB first, then best-effort
   * `boss.cancel()`-ing its pg-boss job (a no-op if that job already started running; cooperative
   * cancellation inside `importCsv`'s row loop is what actually stops that case) -- then creates a
   * fresh `PENDING` task row for the new upload. Retries the whole cancel-then-create sequence once
   * if the DB-level partial unique index (`import_tasks_company_kind_active_key`) rejects the
   * insert with a unique-constraint violation, per the v4 design doc's required backstop against
   * two near-simultaneous uploads both reading "no existing task" and both trying to create one.
   * Called from the route BEFORE `enqueueCsvImport`, so the returned task's id is available to
   * stamp `pgBossJobId` onto once the job is actually sent (`attachImportJob`).
   */
  async beginImportTask(companyId: number): Promise<ImportTask> {
    return this.cancelAndCreateTask(companyId, undefined, 'PENDING');
  }

  /** Stamps the pg-boss job id onto a task created by `beginImportTask`, once `enqueueCsvImport`
   * has actually sent the job -- this is the value a LATER upload's `beginImportTask` call will
   * `boss.cancel()` if it supersedes this one before it starts running. */
  async attachImportJob(taskId: number, pgBossJobId: string): Promise<void> {
    await this.prisma.importTask.update({ where: { id: taskId }, data: { pgBossJobId } });
  }

  /** Cleanup for the rare case `enqueueCsvImport` itself returns `null` (a genuine singleton-slot
   * collision even after `beginImportTask`'s own cancel-and-replace) -- marks the orphaned
   * `PENDING` task `FAILED` rather than leaving it dangling as a phantom "non-terminal task" that
   * would block every future upload for this company. */
  async failImportTask(taskId: number): Promise<void> {
    await this.prisma.importTask.update({
      where: { id: taskId },
      data: { status: 'FAILED', finishedAt: new Date() },
    });
  }

  /**
   * Full worker+contract CSV import for `companyId`. Every row's worker is definitively in
   * `companyId` -- no per-row company resolution/creation. Worker matching by `nationalId` stays
   * GLOBALLY unique: a row whose `national_id` already belongs to a DIFFERENT company is a per-row
   * validation error ("worker already registered under a different company"), never a silent
   * reassignment. Each row runs in its own transaction (mirroring the original convention) so a
   * failing row rolls back only itself and the batch continues. NO deactivation sweep -- a worker
   * absent from the file is simply untouched (status unchanged); see the file-level doc comment.
   *
   * `pgBossJobId`, when given, must be this run's own pg-boss job id (the job handler's `job.id`)
   * -- used to adopt the specific `ImportTask` row `beginImportTask` created for this exact upload.
   * Omitted entirely for a direct call (every existing unit test) -- in that case a fresh task is
   * self-bootstrapped via the same cancel-and-replace helper `beginImportTask` uses, so this method
   * stays fully testable in isolation without a real pg-boss job ever having been sent.
   */
  async importCsv(csvText: string, companyId: number, pgBossJobId?: string): Promise<ImportResult> {
    const rawRows = parseWorkersCsv(csvText);

    const task = await this.claimTask(companyId, rawRows.length, pgBossJobId);

    let inserted = 0;
    let updated = 0;
    let failed = 0;
    let cancelled = false;
    const errors: ImportRowError[] = [];

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
        const outcome = await this.importRow(raw, companyId, task.id);
        if (outcome === 'inserted') inserted++;
        else updated++;
      } catch (err) {
        failed++;
        errors.push(toRowError(rowNum, raw.national_id, err));
      }
    }

    const result: ImportResult = { totalRows: rawRows.length, inserted, updated, failed, errors };

    if (!cancelled) {
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
    // never overwrite it back to COMPLETED.

    return result;
  }

  /** One row = one transaction: resolve + validate, reject a cross-company `national_id` conflict,
   * then upsert-by-`national_id`, stamping `lastImportTaskId = taskId` on the touched worker. */
  private async importRow(raw: CsvRawRow, companyId: number, taskId: number): Promise<'inserted' | 'updated'> {
    return this.prisma.$transaction(async (tx) => {
      const record = toWorkerRecord(raw);

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

      if (existing) {
        await tx.worker.update({
          where: { id: existing.id },
          data: {
            name: workerInput.name,
            role: workerInput.role,
            status: workerInput.status,
            lastImportTaskId: taskId,
          },
        });
        await tx.contract.upsert({
          where: { workerId: existing.id },
          create: { workerId: existing.id, ...contractColumns },
          update: { ...contractColumns },
        });
        return 'updated';
      }

      const created = await tx.worker.create({
        data: {
          nationalId: workerInput.nationalId,
          name: workerInput.name,
          role: workerInput.role,
          status: workerInput.status,
          companyId,
          lastImportTaskId: taskId,
        },
      });
      await tx.contract.create({ data: { workerId: created.id, ...contractColumns } });
      return 'inserted';
    });
  }

  /** `importCsv`'s task-acquisition step: adopt the task `beginImportTask` created for this exact
   * `pgBossJobId` (the real route -> queue -> job-handler pipeline), or self-bootstrap a fresh one
   * via the same cancel-and-replace helper (direct/test callers, or the defensive fallback if no
   * matching task is found -- e.g. this method somehow ran outside the normal pipeline). */
  private async claimTask(companyId: number, totalRows: number, pgBossJobId: string | undefined): Promise<ImportTask> {
    if (pgBossJobId) {
      const existing = await this.prisma.importTask.findFirst({
        where: { companyId, kind: WORKER_SYNC_KIND, pgBossJobId },
      });
      if (existing) {
        return this.prisma.importTask.update({
          where: { id: existing.id },
          data: { status: 'PROCESSING', startedAt: new Date(), totalRows },
        });
      }
    }
    return this.cancelAndCreateTask(companyId, pgBossJobId, 'PROCESSING', 0, totalRows);
  }

  /**
   * Shared cancel-and-replace primitive backing both `beginImportTask` (creates a `PENDING` task,
   * no `pgBossJobId` yet -- stamped later by `attachImportJob`) and `claimTask`'s self-bootstrap
   * fallback (creates a task already `PROCESSING`, since row processing starts immediately after).
   * See `beginImportTask`'s doc comment for the full cancel-and-replace + DB-backstop sequence.
   */
  private async cancelAndCreateTask(
    companyId: number,
    pgBossJobId: string | undefined,
    initialStatus: 'PENDING' | 'PROCESSING',
    attempt = 0,
    totalRows?: number,
  ): Promise<ImportTask> {
    const existingTask = await this.prisma.importTask.findFirst({
      where: { companyId, kind: WORKER_SYNC_KIND, status: { in: ['PENDING', 'PROCESSING'] } },
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
        await cancelJob(this.boss, QUEUES.CSV_IMPORT, existingTask.pgBossJobId).catch(() => undefined);
      }
    }

    try {
      return await this.prisma.importTask.create({
        data: {
          companyId,
          kind: WORKER_SYNC_KIND,
          status: initialStatus,
          totalRows: totalRows ?? null,
          pgBossJobId: pgBossJobId ?? null,
          startedAt: initialStatus === 'PROCESSING' ? new Date() : null,
        },
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err) && attempt === 0) {
        // The just-lost race means there IS now a non-terminal task to cancel, from the request
        // that won -- re-run the full sequence once (v4 design doc, Part A's "Cancel-and-replace").
        return this.cancelAndCreateTask(companyId, pgBossJobId, initialStatus, attempt + 1, totalRows);
      }
      throw err;
    }
  }
}
