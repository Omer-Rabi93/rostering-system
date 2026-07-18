import { configureStore } from '@reduxjs/toolkit';
import type { MonthAvailability } from '@rostering/shared';
import { describe, expect, it, vi } from 'vitest';

import { baseApi } from './baseApi.js';
import { availabilityApi } from './availability.api.js';

function makeStore() {
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const augustFixture: MonthAvailability = { '1': { '2026-08-03': ['A'] } };
const septemberFixture: MonthAvailability = { '1': { '2026-09-03': ['A', 'B'] } };

describe('availability.api cache invalidation', () => {
  it('replaceMonthAvailability invalidates only that month\'s Availability tag, not other cached months', async () => {
    const store = makeStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(augustFixture)) // getMonthAvailability('2026-08')
      .mockResolvedValueOnce(jsonResponse(septemberFixture)) // getMonthAvailability('2026-09')
      .mockResolvedValueOnce(jsonResponse({ month: '2026-08' })) // replaceMonthAvailability('2026-08')
      .mockResolvedValueOnce(jsonResponse({ '1': { '2026-08-03': ['A', 'B'] } })); // refetched getMonthAvailability('2026-08')
    vi.stubGlobal('fetch', fetchMock);

    await store.dispatch(availabilityApi.endpoints.getMonthAvailability.initiate('2026-08'));
    await store.dispatch(availabilityApi.endpoints.getMonthAvailability.initiate('2026-09'));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await store.dispatch(
      availabilityApi.endpoints.replaceMonthAvailability.initiate({
        month: '2026-08',
        body: { '1': { '2026-08-03': ['A', 'B'] } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Mutation itself (1 call) + only August's getMonthAvailability refetched (1 more call) —
    // September's cached entry must NOT be refetched by an August save.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('replaceMonthAvailability does not invalidate Roster or CostSummary — only a roster-generation job completion does that (see jobs.api.ts)', async () => {
    const store = makeStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 1, month: '2026-08', status: 'DRAFT', generatedAt: null, publishedAt: null, shifts: [], alerts: [] })) // getRoster
      .mockResolvedValueOnce(jsonResponse({ totalIls: 0, perCompany: [], perWorker: [] })) // getCostSummary
      .mockResolvedValueOnce(jsonResponse({ month: '2026-08' })); // replaceMonthAvailability
    vi.stubGlobal('fetch', fetchMock);

    const { rostersApi } = await import('./rosters.api.js');
    const { costSummaryApi } = await import('./costSummary.api.js');

    await store.dispatch(rostersApi.endpoints.getRoster.initiate({ companyId: 1, month: '2026-08' }));
    await store.dispatch(costSummaryApi.endpoints.getCostSummary.initiate({ companyId: 1, month: '2026-08' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await store.dispatch(
      availabilityApi.endpoints.replaceMonthAvailability.initiate({ month: '2026-08', body: {} }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Only the mutation's own call is added — no Roster/CostSummary refetch.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('importAvailabilityCsv does not invalidate Availability itself — only the job-completion caller does that (see AvailabilityCsvPanel)', async () => {
    const store = makeStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(augustFixture)) // getMonthAvailability
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' })); // importAvailabilityCsv
    vi.stubGlobal('fetch', fetchMock);

    await store.dispatch(availabilityApi.endpoints.getMonthAvailability.initiate('2026-08'));
    await store.dispatch(
      availabilityApi.endpoints.importAvailabilityCsv.initiate({
        month: '2026-08',
        file: new File(['x'], 'a.csv', { type: 'text/csv' }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
