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
  it('replaceMonthAvailability invalidates only that (companyId, month)\'s Availability tag, not other cached months', async () => {
    const store = makeStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(augustFixture)) // getMonthAvailability(companyId 1, '2026-08')
      .mockResolvedValueOnce(jsonResponse(septemberFixture)) // getMonthAvailability(companyId 1, '2026-09')
      .mockResolvedValueOnce(jsonResponse({ month: '2026-08' })) // replaceMonthAvailability(companyId 1, '2026-08')
      .mockResolvedValueOnce(jsonResponse({ '1': { '2026-08-03': ['A', 'B'] } })); // refetched getMonthAvailability(companyId 1, '2026-08')
    vi.stubGlobal('fetch', fetchMock);

    await store.dispatch(availabilityApi.endpoints.getMonthAvailability.initiate({ companyId: 1, month: '2026-08' }));
    await store.dispatch(availabilityApi.endpoints.getMonthAvailability.initiate({ companyId: 1, month: '2026-09' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await store.dispatch(
      availabilityApi.endpoints.replaceMonthAvailability.initiate({
        month: '2026-08',
        companyId: 1,
        body: { '1': { '2026-08-03': ['A', 'B'] } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Mutation itself (1 call) + only August's getMonthAvailability refetched (1 more call) —
    // September's cached entry must NOT be refetched by an August save.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('replaceMonthAvailability for one company does NOT invalidate another company\'s cached entry for the SAME month (v4 company scoping)', async () => {
    const store = makeStore();
    const companyAAugust: MonthAvailability = { '1': { '2026-08-03': ['A'] } };
    const companyBAugust: MonthAvailability = { '2': { '2026-08-03': ['B'] } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(companyAAugust)) // getMonthAvailability(companyId 1, '2026-08')
      .mockResolvedValueOnce(jsonResponse(companyBAugust)) // getMonthAvailability(companyId 2, '2026-08')
      .mockResolvedValueOnce(jsonResponse({ month: '2026-08' })) // replaceMonthAvailability(companyId 1, '2026-08')
      .mockResolvedValueOnce(jsonResponse(companyAAugust)); // refetched getMonthAvailability(companyId 1, '2026-08')
    vi.stubGlobal('fetch', fetchMock);

    await store.dispatch(availabilityApi.endpoints.getMonthAvailability.initiate({ companyId: 1, month: '2026-08' }));
    await store.dispatch(availabilityApi.endpoints.getMonthAvailability.initiate({ companyId: 2, month: '2026-08' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await store.dispatch(
      availabilityApi.endpoints.replaceMonthAvailability.initiate({
        month: '2026-08',
        companyId: 1,
        body: { '1': { '2026-08-03': ['A'] } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Mutation itself (1 call) + company 1's own cached entry refetched (1 more call) — company 2's
    // cached entry for the SAME month must NOT be refetched by company 1's save. A month-only tag
    // (no companyId in the id) would over-invalidate here and produce 5 calls instead of 4.
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
      availabilityApi.endpoints.replaceMonthAvailability.initiate({ month: '2026-08', companyId: 1, body: {} }),
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

    await store.dispatch(availabilityApi.endpoints.getMonthAvailability.initiate({ companyId: 1, month: '2026-08' }));
    await store.dispatch(
      availabilityApi.endpoints.importAvailabilityCsv.initiate({
        month: '2026-08',
        companyId: 1,
        file: new File(['x'], 'a.csv', { type: 'text/csv' }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
