import type { Month, MonthAvailability } from '@rostering/shared';

import { baseApi } from './baseApi.js';

export interface ReplaceMonthAvailabilityResponse {
  readonly month: Month;
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
 * `GET/PUT /api/availability/:month` (bulk JSON, `AvailabilityGrid.tsx`'s manual-editing data
 * source). The month-scoped availability CSV import/export that used to live here merged into the
 * combined workforce-CSV pipeline (`workforceCsv.api.ts`, `WorkforceCsvPanel.tsx`) — see the Part
 * G design doc. This grid path is deliberately untouched by that merge.
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
 * v4: `getMonthAvailability` (bulk `GET`) and `replaceMonthAvailability` (bulk `PUT`) both require
 * a `companyId`, matching `apps/api/src/routes/availability.ts`'s company-scoping — sent as a
 * query param (`companyIdQuerySchema`).
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
  }),
});

export const { useGetMonthAvailabilityQuery, useReplaceMonthAvailabilityMutation } = availabilityApi;

export { availabilityTag };
