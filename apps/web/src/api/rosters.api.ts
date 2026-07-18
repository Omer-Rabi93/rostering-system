import type { Alert, Month, Role, Roster } from '@rostering/shared';

import { baseApi } from './baseApi.js';

/** `POST /shifts/:shiftId/workers` (+ move/remove) don't have a dedicated response schema in
 * `@rostering/shared` (only request bodies are schema'd there) — built from the shared `Role`
 * and `Alert` types rather than re-declared from scratch. */
export interface ShiftWorkerEditResult {
  readonly shiftId: number;
  readonly workerId: number;
  readonly role: Role;
  readonly alerts: readonly Alert[];
}

export interface GenerateRosterResponse {
  readonly jobId: string;
}

export interface PublishRosterResponse {
  readonly status: 'published';
}

function rosterTag(month: Month) {
  return { type: 'Roster' as const, id: month };
}

function costSummaryTag(month: Month) {
  return { type: 'CostSummary' as const, id: month };
}

function confirmQuery(confirm: boolean | undefined): string {
  return confirm ? '?confirm=true' : '';
}

export const rostersApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getRoster: builder.query<Roster, Month>({
      query: (month) => `/rosters/${month}`,
      providesTags: (_result, _error, month) => [rosterTag(month)],
    }),

    /** 202 {jobId} — the roster isn't actually regenerated until the `roster-generation` job
     * reaches `completed` (see `jobs.api.ts`'s polling hook), so this mutation deliberately does
     * NOT invalidate the `Roster` tag itself; the job-completion handler does. */
    generateRoster: builder.mutation<GenerateRosterResponse, { month: Month; force?: boolean }>({
      query: (body) => ({ url: '/rosters/generate', method: 'POST', body }),
    }),

    ackAlert: builder.mutation<Alert, { rosterId: number; alertId: number; month: Month }>({
      query: ({ rosterId, alertId }) => ({ url: `/rosters/${rosterId}/alerts/${alertId}/ack`, method: 'POST' }),
      invalidatesTags: (_result, _error, { month }) => [rosterTag(month)],
    }),

    publishRoster: builder.mutation<PublishRosterResponse, { rosterId: number; month: Month }>({
      query: ({ rosterId }) => ({ url: `/rosters/${rosterId}/publish`, method: 'POST' }),
      invalidatesTags: (_result, _error, { month }) => [rosterTag(month)],
    }),

    addShiftWorker: builder.mutation<
      ShiftWorkerEditResult,
      { shiftId: number; workerId: number; month: Month; confirm?: boolean }
    >({
      query: ({ shiftId, workerId, confirm }) => ({
        url: `/shifts/${shiftId}/workers${confirmQuery(confirm)}`,
        method: 'POST',
        body: { workerId },
      }),
      invalidatesTags: (_result, _error, { month }) => [rosterTag(month), costSummaryTag(month)],
    }),

    moveShiftWorker: builder.mutation<
      ShiftWorkerEditResult,
      { shiftId: number; workerId: number; targetShiftId: number; month: Month; confirm?: boolean }
    >({
      query: ({ shiftId, workerId, targetShiftId, confirm }) => ({
        url: `/shifts/${shiftId}/workers/${workerId}/move${confirmQuery(confirm)}`,
        method: 'POST',
        body: { targetShiftId },
      }),
      invalidatesTags: (_result, _error, { month }) => [rosterTag(month), costSummaryTag(month)],
    }),

    removeShiftWorker: builder.mutation<
      void,
      { shiftId: number; workerId: number; month: Month; confirm?: boolean }
    >({
      query: ({ shiftId, workerId, confirm }) => ({
        url: `/shifts/${shiftId}/workers/${workerId}${confirmQuery(confirm)}`,
        method: 'DELETE',
      }),
      invalidatesTags: (_result, _error, { month }) => [rosterTag(month), costSummaryTag(month)],
    }),
  }),
});

export const {
  useGetRosterQuery,
  useGenerateRosterMutation,
  useAckAlertMutation,
  usePublishRosterMutation,
  useAddShiftWorkerMutation,
  useMoveShiftWorkerMutation,
  useRemoveShiftWorkerMutation,
} = rostersApi;
