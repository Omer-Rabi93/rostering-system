import type { CostSummary } from '@rostering/shared';

import type { CompanyMonth } from './rosters.api.js';
import { baseApi } from './baseApi.js';

export const costSummaryApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    // Company-scoped rostering: a `Roster` (and its cost summary) is unique per
    // `(companyId, month)`, not per `month` alone -- the tag id below matches `rosters.api.ts`'s
    // own `costSummaryTag` shape exactly, so a roster-editing mutation there still invalidates
    // this query correctly.
    getCostSummary: builder.query<CostSummary, CompanyMonth>({
      query: ({ companyId, month }) => `/rosters/${month}/cost-summary?companyId=${companyId}`,
      providesTags: (_result, _error, { companyId, month }) => [
        { type: 'CostSummary', id: `${companyId}:${month}` },
      ],
    }),
  }),
});

export const { useGetCostSummaryQuery } = costSummaryApi;
