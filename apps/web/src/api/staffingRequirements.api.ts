import type { StaffingRequirement, StaffingRequirementsInput } from '@rostering/shared';

import { baseApi } from './baseApi.js';

const LIST_TAG = { type: 'StaffingRequirement' as const, id: 'LIST' as const };

function cellId(row: Pick<StaffingRequirement, 'role' | 'shift'>): string {
  return `${row.role}:${row.shift}`;
}

export const staffingRequirementsApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    listStaffingRequirements: builder.query<StaffingRequirement[], void>({
      query: () => '/staffing-requirements',
      providesTags: (result) =>
        result
          ? [...result.map((row) => ({ type: 'StaffingRequirement' as const, id: cellId(row) })), LIST_TAG]
          : [LIST_TAG],
    }),

    /** Full-matrix replace: PUT always sends every role×shift cell, so a single list-tag
     * invalidation is correct (there is no such thing as a partial staffing-requirements save). */
    replaceStaffingRequirements: builder.mutation<StaffingRequirement[], StaffingRequirementsInput>({
      query: (body) => ({ url: '/staffing-requirements', method: 'PUT', body }),
      invalidatesTags: [LIST_TAG],
    }),
  }),
});

export const { useListStaffingRequirementsQuery, useReplaceStaffingRequirementsMutation } = staffingRequirementsApi;
