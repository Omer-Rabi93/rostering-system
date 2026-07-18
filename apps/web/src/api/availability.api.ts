import type { Month, MonthAvailability } from '@rostering/shared';

import { baseApi } from './baseApi.js';

export interface ReplaceMonthAvailabilityResponse {
  readonly month: Month;
}

export interface EnqueueJobResponse {
  readonly jobId: string;
}

/** Company-scoped availability: `GET/PUT /api/availability/:month` are now scoped to a
 * `(companyId, month)` pair, not `month` alone -- mirrors `rosters.api.ts`'s own `CompanyMonth`. */
export interface CompanyMonth {
  readonly companyId: number;
  readonly month: Month;
}

/** `(companyId, month)`-scoped `Availability` tag — mirrors `rosterTag`/`costSummaryTag` in
 * `rosters.api.ts` — so replacing one company's month's availability only invalidates that
 * company's cached grid for that month, never a different company's cached data for the same
 * month (a flat `month`-only tag would over-invalidate across companies). */
function availabilityTag({ companyId, month }: CompanyMonth) {
  return { type: 'Availability' as const, id: `${companyId}:${month}` };
}

/**
 * `GET/PUT /api/availability/:month` (bulk JSON, Availability v2) + the month-scoped availability
 * CSV import/export.
 *
 * `replaceMonthAvailability` invalidates only that `(companyId, month)`'s `Availability` tag —
 * deliberately NOT `Roster`/`CostSummary`. Availability alone never changes an already-computed
 * roster or its cost;
 * only a *future regeneration* does, and `jobs.api.ts`'s `roster-generation` job-completion handler
 * already owns invalidating `['Roster', 'CostSummary']` at that point. Co-invalidating them here
 * (the way `addShiftWorker`/`moveShiftWorker`/`removeShiftWorker` co-invalidate `Roster` +
 * `CostSummary` together in `rosters.api.ts`, or the way `upsertWorkerContract` invalidates the
 * whole `CostSummary` tag on a rate change in `workers.api.ts`) would refetch data this mutation
 * never actually changed.
 *
 * `importAvailabilityCsv` is a 202 {jobId} response (same pattern as `csvApi.importWorkersCsv`):
 * the import isn't applied until the `availability-import` job reaches `completed`. Unlike the
 * generic `csv-import` -> `Worker` handling in `jobs.api.ts`'s `onQueryStarted` (a flat tag, so it
 * doesn't need to know *which* import), this job's effect is month-scoped and the `Job` schema
 * carries no month field — so the month-scoped invalidation is done by the caller (the component
 * that already knows both the jobId and the month it started the import for), not generically here.
 *
 * v4: `getMonthAvailability` (bulk `GET`), `replaceMonthAvailability` (bulk `PUT`), and
 * `importAvailabilityCsv` all require a `companyId`, matching
 * `apps/api/src/routes/availability.ts`'s new company-scoping — `getMonthAvailability`/
 * `replaceMonthAvailability` send it as a query param (`companyIdQuerySchema`), `importAvailabilityCsv`
 * sends it as a form field alongside `file` (`companyIdFormFieldSchema`), mirroring
 * `csvApi.importWorkersCsv`.
 */
export const availabilityApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getMonthAvailability: builder.query<MonthAvailability, CompanyMonth>({
      query: ({ month, companyId }) => `/availability/${month}?companyId=${companyId}`,
      providesTags: (_result, _error, arg) => [availabilityTag(arg)],
    }),

    replaceMonthAvailability: builder.mutation<
      ReplaceMonthAvailabilityResponse,
      { month: Month; companyId: number; body: MonthAvailability }
    >({
      query: ({ month, companyId, body }) => ({
        url: `/availability/${month}?companyId=${companyId}`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: (_result, _error, arg) => [availabilityTag(arg)],
    }),

    importAvailabilityCsv: builder.mutation<EnqueueJobResponse, { month: Month; companyId: number; file: File }>({
      query: ({ month, companyId, file }) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('companyId', String(companyId));
        return { url: `/import/availability/${month}`, method: 'POST', body: formData };
      },
    }),
  }),
});

export const {
  useGetMonthAvailabilityQuery,
  useReplaceMonthAvailabilityMutation,
  useImportAvailabilityCsvMutation,
} = availabilityApi;

export function exportAvailabilityCsvUrl(month: Month): string {
  return `/api/export/availability/${month}`;
}

export { availabilityTag };
