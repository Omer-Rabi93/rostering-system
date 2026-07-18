import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

/**
 * Root RTK Query API slice. Domain-specific endpoints are injected into
 * this slice from `<domain>.api.ts` files (one per domain) in later phases
 * via `baseApi.injectEndpoints(...)`, code-splitting the generated hooks
 * while sharing a single cache and tag-type registry.
 */
export const baseApi = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({
    baseUrl: '/api',
    // `fetchBaseQuery`'s own `fetchFn` default parameter resolves the global `fetch` binding
    // once, at the moment this `fetchBaseQuery(...)` call is evaluated (i.e. when this module
    // first loads) -- so anything that swaps out `globalThis.fetch` afterwards (e.g. a test's
    // `vi.stubGlobal('fetch', ...)`) would be invisible to it. Wrapping the call in an arrow
    // function instead defers the `fetch` identifier lookup to request time, so both the real
    // browser global and a test's stub are honored correctly.
    fetchFn: (...args) => fetch(...args),
  }),
  tagTypes: ['Company', 'Worker', 'Roster', 'StaffingRequirement', 'Job', 'CostSummary', 'Availability'],
  endpoints: () => ({}),
});
