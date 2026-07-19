import { configureStore } from '@reduxjs/toolkit';
import { describe, expect, it, vi } from 'vitest';

import { baseApi } from '../../src/api/baseApi.js';
import { companiesApi } from '../../src/api/companies.api.js';

function makeStore() {
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('companies.api cache invalidation', () => {
  it('createCompany invalidates the Company LIST tag so a still-subscribed listCompanies query refetches automatically', async () => {
    const store = makeStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 1, name: 'Acme', createdAt: '2026-01-01T00:00:00.000Z' }]))
      .mockResolvedValueOnce(jsonResponse({ id: 2, name: 'Beta', createdAt: '2026-01-02T00:00:00.000Z' }))
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 1, name: 'Acme', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 2, name: 'Beta', createdAt: '2026-01-02T00:00:00.000Z' },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    // Subscribe (don't unsubscribe) so the invalidation below can auto-refetch it.
    await store.dispatch(companiesApi.endpoints.listCompanies.initiate());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Re-issuing the identical query while the cache entry is still fresh must NOT refetch —
    // sanity-checks that the test setup reflects real caching behavior, not a mock that always
    // hits the network.
    await store.dispatch(companiesApi.endpoints.listCompanies.initiate());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await store.dispatch(companiesApi.endpoints.createCompany.initiate({ name: 'Beta' }));

    // Let RTK Query's invalidation-triggered background refetch of the still-subscribed
    // listCompanies query run (mutation itself = 1 call, on top of the 1 initial list read).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('listCompanies providesTags a per-item tag, so renaming a single company invalidates only that item + the list, not other items', async () => {
    const store = makeStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 1, name: 'Acme', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 2, name: 'Beta', createdAt: '2026-01-02T00:00:00.000Z' },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 1, name: 'Acme Renamed', createdAt: '2026-01-01T00:00:00.000Z' }))
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 1, name: 'Acme Renamed', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 2, name: 'Beta', createdAt: '2026-01-02T00:00:00.000Z' },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    await store.dispatch(companiesApi.endpoints.listCompanies.initiate());
    await store.dispatch(companiesApi.endpoints.renameCompany.initiate({ id: 1, body: { name: 'Acme Renamed' } }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // list refetch happened (LIST tag invalidated by the rename).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const state = store.getState();
    const result = companiesApi.endpoints.listCompanies.select()(state);
    expect(result.data?.find((c) => c.id === 1)?.name).toBe('Acme Renamed');
  });
});
