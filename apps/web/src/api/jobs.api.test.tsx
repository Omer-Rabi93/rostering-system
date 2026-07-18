import type { ReactNode } from 'react';
import { configureStore } from '@reduxjs/toolkit';
import type { Roster } from '@rostering/shared';
import { renderHook, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { describe, expect, it, vi } from 'vitest';

import { baseApi } from './baseApi.js';
import { useJobPolling } from './jobs.api.js';
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
  generatedAt: null,
  publishedAt: null,
  shifts: [],
  alerts: [],
};

describe('useJobPolling', () => {
  it('invalidates the Roster tag once a roster-generation job reaches "completed", refetching a still-subscribed getRoster query', async () => {
    const store = makeStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(rosterFixture)) // getRoster
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'job-1',
          name: 'roster-generation',
          state: 'active',
          createdAt: '2026-07-25T06:00:00.000Z',
          completedAt: null,
          result: null,
        }),
      ) // first poll: still active
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'job-1',
          name: 'roster-generation',
          state: 'completed',
          createdAt: '2026-07-25T06:00:00.000Z',
          completedAt: '2026-07-25T06:00:20.000Z',
          result: { rosterId: 1, alertCount: 0 },
        }),
      ) // second poll: completed
      .mockResolvedValueOnce(jsonResponse({ ...rosterFixture, generatedAt: '2026-07-25T06:00:20.000Z' })); // refetch triggered by invalidation
    vi.stubGlobal('fetch', fetchMock);

    await store.dispatch(rostersApi.endpoints.getRoster.initiate({ companyId: 1, month: '2026-08' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    function wrapper({ children }: { children: ReactNode }) {
      return <Provider store={store}>{children}</Provider>;
    }

    const { result } = renderHook(() => useJobPolling('job-1'), { wrapper });

    await waitFor(() => expect(result.current.data?.state).toBe('active'));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Manually trigger the next poll rather than waiting on the real 1.5s timer.
    await result.current.refetch();

    await waitFor(() => expect(result.current.data?.state).toBe('completed'));

    // The Roster tag invalidation (dispatched from `onQueryStarted` on the completed poll)
    // triggers a background refetch of the still-subscribed getRoster query.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  });

  it('stops polling (pollingInterval drops to 0) once a terminal state is reached', async () => {
    const store = makeStore();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'job-2',
        name: 'csv-import',
        state: 'failed',
        createdAt: '2026-07-25T06:00:00.000Z',
        completedAt: '2026-07-25T06:00:05.000Z',
        result: { error: 'boom' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    function wrapper({ children }: { children: ReactNode }) {
      return <Provider store={store}>{children}</Provider>;
    }

    const { result } = renderHook(() => useJobPolling('job-2'), { wrapper });

    await waitFor(() => expect(result.current.data?.state).toBe('failed'));
    const callsAtTerminal = fetchMock.mock.calls.length;

    // Give the (now-disabled) polling interval a chance to fire if it were still active.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.length).toBe(callsAtTerminal);
  });

  it('skips the request entirely when jobId is undefined', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store = makeStore();

    function wrapper({ children }: { children: ReactNode }) {
      return <Provider store={store}>{children}</Provider>;
    }

    const { result } = renderHook(() => useJobPolling(undefined), { wrapper });

    expect(result.current.data).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
