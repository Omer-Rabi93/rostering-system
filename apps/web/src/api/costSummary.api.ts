import type { CostSummary, Month } from '@rostering/shared';

import { baseApi } from './baseApi.js';

export const costSummaryApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getCostSummary: builder.query<CostSummary, Month>({
      query: (month) => `/rosters/${month}/cost-summary`,
      providesTags: (_result, _error, month) => [{ type: 'CostSummary', id: month }],
    }),
  }),
});

export const { useGetCostSummaryQuery } = costSummaryApi;
