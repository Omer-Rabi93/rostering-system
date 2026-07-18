import type { Month, MonthAvailability } from '@rostering/shared';

import { baseApi } from './baseApi.js';

export interface ReplaceMonthAvailabilityResponse {
  readonly month: Month;
}

export interface EnqueueJobResponse {
  readonly jobId: string;
}

/** Month-scoped `Availability` tag — mirrors `rosterTag(month)`/`costSummaryTag(month)` in
 * `rosters.api.ts` — so replacing one month's availability only invalidates that month's cached
 * grid, not every cached month. */
function availabilityTag(month: Month) {
  return { type: 'Availability' as const, id: month };
}

/**
 * `GET/PUT /api/availability/:month` (bulk JSON, Availability v2) + the month-scoped availability
 * CSV import/export.
 *
 * `replaceMonthAvailability` invalidates only that month's `Availability` tag — deliberately NOT
 * `Roster`/`CostSummary`. Availability alone never changes an already-computed roster or its cost;
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
 */
export const availabilityApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getMonthAvailability: builder.query<MonthAvailability, Month>({
      query: (month) => `/availability/${month}`,
      providesTags: (_result, _error, month) => [availabilityTag(month)],
    }),

    replaceMonthAvailability: builder.mutation<
      ReplaceMonthAvailabilityResponse,
      { month: Month; body: MonthAvailability }
    >({
      query: ({ month, body }) => ({ url: `/availability/${month}`, method: 'PUT', body }),
      invalidatesTags: (_result, _error, { month }) => [availabilityTag(month)],
    }),

    importAvailabilityCsv: builder.mutation<EnqueueJobResponse, { month: Month; file: File }>({
      query: ({ month, file }) => {
        const formData = new FormData();
        formData.append('file', file);
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
