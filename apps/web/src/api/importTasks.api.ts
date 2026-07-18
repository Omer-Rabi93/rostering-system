import { baseApi } from './baseApi.js';

export type ImportTaskKind = 'WORKER_SYNC' | 'AVAILABILITY_SYNC';
export type ImportTaskStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/**
 * `GET /api/import-tasks/active`'s response shape (`apps/api/src/routes/importTasks.ts`) — the
 * live `ImportTask` row (v4's per-company import-task entity, shared between worker-CSV and
 * availability-CSV imports), or `null` when nothing is `PENDING`/`PROCESSING` for that
 * company+kind. Mirrors the Prisma model's scalar fields; only `id`/`status` are actually read by
 * the frontend today (a truthy result is enough to show the pre-upload confirm dialog below), but
 * the full scalar shape is typed here rather than a bespoke narrower DTO since the route returns
 * the whole row unfiltered.
 */
export interface ActiveImportTaskDto {
  readonly id: number;
  readonly companyId: number;
  readonly kind: ImportTaskKind;
  readonly status: ImportTaskStatus;
  readonly pgBossJobId: string | null;
  readonly month: string | null;
  readonly totalRows: number | null;
  readonly processedRows: number | null;
  readonly insertedCount: number | null;
  readonly updatedCount: number | null;
  readonly failedCount: number | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface GetActiveImportTaskArgs {
  readonly companyId: number;
  readonly kind: ImportTaskKind;
}

/**
 * `GET /api/import-tasks/active?companyId=&kind=` — v4's pre-upload "is an import already in
 * flight for this company+kind" check (see the v4 design doc, Part A's Frontend section). Both
 * `CsvPanel` and `AvailabilityCsvPanel` trigger this on demand, right before actually submitting a
 * selected file — via the auto-generated `useLazy...Query` trigger rather than the plain
 * `use...Query` hook, since this is a one-shot check driven by a user action, not something to
 * poll or keep mounted. A non-null result means a confirm dialog should gate the upload; this is a
 * UX nicety only — the backend's cancel-and-replace logic is the actual correctness guarantee
 * regardless of whether this check ran or raced.
 */
export const importTasksApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getActiveImportTask: builder.query<ActiveImportTaskDto | null, GetActiveImportTaskArgs>({
      query: ({ companyId, kind }) => `/import-tasks/active?companyId=${companyId}&kind=${kind}`,
    }),
  }),
});

export const { useLazyGetActiveImportTaskQuery } = importTasksApi;
