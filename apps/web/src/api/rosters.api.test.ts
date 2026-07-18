import { configureStore } from '@reduxjs/toolkit';
import type { Roster } from '@rostering/shared';
import { describe, expect, it, vi } from 'vitest';

import { baseApi } from './baseApi.js';
import { rostersApi } from './rosters.api.js';

function makeStore() {
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const rosterFixture: Roster = {
  id: 1,
  month: '2026-08',
  status: 'DRAFT',
  generatedAt: '2026-07-25T06:00:00.000Z',
  publishedAt: null,
  shifts: [],
  alerts: [],
};

describe('rosters.api cache invalidation', () => {
  it('addShiftWorker invalidates the Roster tag for that month AND the CostSummary tag for that month (not other months)', async () => {
    const store = makeStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(rosterFixture)) // getRoster('2026-08')
      .mockResolvedValueOnce(
        jsonResponse({ totalIls: 0, perCompany: [], perWorker: [] }),
      ) // getCostSummary('2026-08')
      .mockResolvedValueOnce(jsonResponse({ shiftId: 10, workerId: 3, role: 'GENERAL_GUARD', alerts: [] })) // addShiftWorker
      .mockResolvedValueOnce(jsonResponse({ ...rosterFixture, generatedAt: '2026-07-25T06:05:00.000Z' })) // refetched getRoster
      .mockResolvedValueOnce(jsonResponse({ totalIls: 96, perCompany: [], perWorker: [] })); // refetched getCostSummary
    vi.stubGlobal('fetch', fetchMock);

    const { costSummaryApi } = await import('./costSummary.api.js');

    await store.dispatch(rostersApi.endpoints.getRoster.initiate({ companyId: 1, month: '2026-08' }));
    await store.dispatch(costSummaryApi.endpoints.getCostSummary.initiate({ companyId: 1, month: '2026-08' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await store.dispatch(
      rostersApi.endpoints.addShiftWorker.initiate({ shiftId: 10, workerId: 3, companyId: 1, month: '2026-08' }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Mutation itself (1 call) + both the roster and the cost summary for that month refetched
    // (2 more calls) on top of the 2 initial reads = 5 total.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('generateRoster does NOT invalidate the Roster tag itself — that only happens once the job completes (see jobs.api.ts)', async () => {
    const store = makeStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(rosterFixture)) // getRoster('2026-08')
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' })); // generateRoster
    vi.stubGlobal('fetch', fetchMock);

    await store.dispatch(rostersApi.endpoints.getRoster.initiate({ companyId: 1, month: '2026-08' }));
    await store.dispatch(rostersApi.endpoints.generateRoster.initiate({ companyId: 1, month: '2026-08' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Exactly 2 calls (the initial getRoster read + the generate POST) — no third fetch, since
    // generateRoster's 202 response alone must not trigger a Roster refetch.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
