import type { Contract, Role, Worker, WorkerStatus } from '@rostering/shared';

import { baseApi } from './baseApi.js';

/**
 * `Contract` (from `@rostering/shared`) is the request-body shape; the API's
 * `GET`/`PUT .../contract` responses additionally carry the DB-generated
 * `workerId`/`updatedAt`, which have no dedicated shared schema (only request
 * validation is schema'd there) — `ContractDto` extends the shared type
 * rather than re-declaring its fields.
 */
export interface ContractDto extends Contract {
  readonly workerId: number;
  readonly updatedAt: string;
}

/** Same reasoning as `ContractDto`: extends the shared `Worker` request shape with the
 * DB-generated fields the read endpoints return. */
export interface WorkerDto extends Worker {
  readonly id: number;
  readonly shareToken: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contract: ContractDto | null;
}

export interface WorkerListFilters {
  readonly status?: WorkerStatus;
  readonly role?: Role;
  readonly companyId?: number;
  readonly q?: string;
}

export interface ShareLink {
  readonly url: string;
}

const LIST_TAG = { type: 'Worker' as const, id: 'LIST' as const };

function toQueryString(filters: WorkerListFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.role) params.set('role', filters.role);
  if (filters.companyId !== undefined) params.set('companyId', String(filters.companyId));
  if (filters.q) params.set('q', filters.q);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export const workersApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    listWorkers: builder.query<WorkerDto[], WorkerListFilters | void>({
      query: (filters) => `/workers${toQueryString(filters ?? {})}`,
      providesTags: (result) =>
        result ? [...result.map((worker) => ({ type: 'Worker' as const, id: worker.id })), LIST_TAG] : [LIST_TAG],
    }),

    getWorker: builder.query<WorkerDto, number>({
      query: (id) => `/workers/${id}`,
      providesTags: (_result, _error, id) => [{ type: 'Worker', id }],
    }),

    createWorker: builder.mutation<WorkerDto, Worker>({
      query: (body) => ({ url: '/workers', method: 'POST', body }),
      invalidatesTags: [LIST_TAG],
    }),

    updateWorker: builder.mutation<WorkerDto, { id: number; body: Worker }>({
      query: ({ id, body }) => ({ url: `/workers/${id}`, method: 'PUT', body }),
      invalidatesTags: (_result, _error, { id }) => [{ type: 'Worker', id }, LIST_TAG],
    }),

    deleteWorker: builder.mutation<void, number>({
      query: (id) => ({ url: `/workers/${id}`, method: 'DELETE' }),
      invalidatesTags: (_result, _error, id) => [{ type: 'Worker', id }, LIST_TAG],
    }),

    getWorkerContract: builder.query<ContractDto, number>({
      query: (workerId) => `/workers/${workerId}/contract`,
      providesTags: (_result, _error, workerId) => [{ type: 'Worker', id: workerId }],
    }),

    upsertWorkerContract: builder.mutation<ContractDto, { workerId: number; body: Contract }>({
      query: ({ workerId, body }) => ({ url: `/workers/${workerId}/contract`, method: 'PUT', body }),
      // Cost is computed live from contract.hourlyCostIls (see costSummaryService), so a rate
      // change silently stales every cached CostSummary the worker appears in — invalidate the
      // whole tag type since the client can't know which months are affected.
      invalidatesTags: (_result, _error, { workerId }) => [
        { type: 'Worker', id: workerId },
        { type: 'CostSummary' },
      ],
    }),

    getWorkerShareLink: builder.query<ShareLink, number>({
      query: (workerId) => `/workers/${workerId}/share-link`,
      providesTags: (_result, _error, workerId) => [{ type: 'Worker', id: workerId }],
    }),

    rotateWorkerShareLink: builder.mutation<ShareLink, number>({
      query: (workerId) => ({ url: `/workers/${workerId}/share-link/rotate`, method: 'POST' }),
      invalidatesTags: (_result, _error, workerId) => [{ type: 'Worker', id: workerId }],
    }),
  }),
});

export const {
  useListWorkersQuery,
  useGetWorkerQuery,
  useCreateWorkerMutation,
  useUpdateWorkerMutation,
  useDeleteWorkerMutation,
  useGetWorkerContractQuery,
  useUpsertWorkerContractMutation,
  useGetWorkerShareLinkQuery,
  useRotateWorkerShareLinkMutation,
} = workersApi;
