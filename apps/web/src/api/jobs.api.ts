import { useEffect, useState } from 'react';
import { skipToken } from '@reduxjs/toolkit/query/react';
import type { Job } from '@rostering/shared';

import { baseApi } from './baseApi.js';

const POLLING_INTERVAL_MS = 1500;
const TERMINAL_STATES: ReadonlySet<Job['state']> = new Set(['completed', 'failed']);

export const jobsApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getJob: builder.query<Job, string>({
      query: (id) => `/jobs/${id}`,
      providesTags: (_result, _error, id) => [{ type: 'Job', id }],
      /** Store-level plumbing for "job completion invalidates the tag it affects": a
       * `roster-generation` job invalidates `Roster` (+ `CostSummary`, since cost is computed from
       * the same shift assignments a regeneration rewrites), a `workforce-import` job invalidates
       * `Worker`. This runs once per fulfilled poll — invalidating an already-up-to-date tag on a
       * non-terminal poll is a harmless no-op refetch, but we only care about the terminal one, so
       * we still gate on `state === 'completed'`. */
      async onQueryStarted(_id, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          if (data.state !== 'completed') return;
          if (data.name === 'roster-generation') {
            dispatch(baseApi.util.invalidateTags(['Roster', 'CostSummary']));
          } else if (data.name === 'workforce-import') {
            dispatch(baseApi.util.invalidateTags(['Worker']));
          }
        } catch {
          // A failed/aborted poll is surfaced through the query's own error state; nothing to
          // invalidate here.
        }
      },
    }),
  }),
});

export const { useGetJobQuery } = jobsApi;

/**
 * Polls `GET /api/jobs/:id` every 1.5s and stops automatically once the job reaches a terminal
 * state (`completed`/`failed`) — RTK Query's `pollingInterval` option is static per-hook-call, so
 * "stop on terminal state" is implemented here by dropping the interval to `0` once a terminal
 * state is observed, which is RTK Query's documented way of turning polling off.
 *
 * Pass `undefined` for `jobId` (e.g. before a generate/import mutation has returned a `jobId`) to
 * skip the query entirely via `skipToken` rather than firing a request for `/jobs/undefined`.
 */
export function useJobPolling(jobId: string | undefined) {
  const [pollingInterval, setPollingInterval] = useState(POLLING_INTERVAL_MS);
  const result = useGetJobQuery(jobId ?? skipToken, { pollingInterval });

  useEffect(() => {
    if (result.data && TERMINAL_STATES.has(result.data.state)) {
      setPollingInterval(0);
    }
  }, [result.data]);

  // A fresh jobId (e.g. re-generating after a previous job finished) should resume polling.
  useEffect(() => {
    setPollingInterval(jobId ? POLLING_INTERVAL_MS : 0);
  }, [jobId]);

  return result;
}
