import type { Company } from '@rostering/shared';

import { baseApi } from './baseApi.js';

/**
 * `GET /api/companies` returns the persisted row, not just the request-body
 * shape `companySchema` validates (`name`) — `id`/`createdAt` are DB-generated
 * and have no dedicated Zod schema in `@rostering/shared` (that package only
 * schemas request-validation boundaries). `CompanyDto` extends the shared
 * `Company` type rather than re-declaring its fields, so `name`'s shape still
 * comes from `@rostering/shared`.
 */
export interface CompanyDto extends Company {
  readonly id: number;
  readonly createdAt: string;
}

const LIST_TAG = { type: 'Company' as const, id: 'LIST' as const };

export const companiesApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    listCompanies: builder.query<CompanyDto[], void>({
      query: () => '/companies',
      providesTags: (result) =>
        result
          ? [...result.map((company) => ({ type: 'Company' as const, id: company.id })), LIST_TAG]
          : [LIST_TAG],
    }),

    createCompany: builder.mutation<CompanyDto, Company>({
      query: (body) => ({ url: '/companies', method: 'POST', body }),
      invalidatesTags: [LIST_TAG],
    }),

    renameCompany: builder.mutation<CompanyDto, { id: number; body: Company }>({
      query: ({ id, body }) => ({ url: `/companies/${id}`, method: 'PATCH', body }),
      invalidatesTags: (_result, _error, { id }) => [{ type: 'Company', id }, LIST_TAG],
    }),

    deleteCompany: builder.mutation<void, number>({
      query: (id) => ({ url: `/companies/${id}`, method: 'DELETE' }),
      invalidatesTags: (_result, _error, id) => [{ type: 'Company', id }, LIST_TAG],
    }),
  }),
});

export const {
  useListCompaniesQuery,
  useCreateCompanyMutation,
  useRenameCompanyMutation,
  useDeleteCompanyMutation,
} = companiesApi;
