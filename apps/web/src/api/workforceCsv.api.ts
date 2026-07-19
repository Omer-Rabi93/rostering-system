import type { Month } from '@rostering/shared';

import { baseApi } from './baseApi.js';

export interface EnqueueJobResponse {
  readonly jobId: string;
}

/**
 * `POST /api/import/workforce/:month` — the combined workforce CSV: worker fields (a full-sync
 * eligibility gate, same as the pre-merge worker-only CSV) AND that month's availability
 * (`dNN` columns, a full-month replace per worker) in one file. Supersedes `csv.api.ts`
 * (worker-only) and `availability.api.ts`'s `importAvailabilityCsv`/`exportAvailabilityCsvUrl`
 * (availability-only) — see the Part G design doc. Doesn't invalidate `Worker` itself: like
 * `generateRoster` (see `rosters.api.ts`), the import isn't applied until the `workforce-import`
 * job reaches `completed` — `jobs.api.ts`'s `onQueryStarted` invalidates `Worker` at that point,
 * not here.
 *
 * The upload is scoped to one company at upload time (the app's active company) — `companyId`
 * travels alongside `file` as a plain string form field (multer parses it into `req.body`, per
 * `apps/api/src/routes/workforce.ts`'s `companyIdFormFieldSchema`).
 *
 * `GET /api/export/workforce/:month` has no dedicated RTK Query endpoint: it's a plain file
 * download (`Content-Disposition: attachment`), so the page links straight to it via
 * `exportWorkforceCsvUrl` rather than fetching it through the cache.
 */
export const workforceCsvApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    importWorkforceCsv: builder.mutation<EnqueueJobResponse, { month: Month; companyId: number; file: File }>({
      query: ({ month, companyId, file }) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('companyId', String(companyId));
        return { url: `/import/workforce/${month}`, method: 'POST', body: formData };
      },
    }),
  }),
});

export const { useImportWorkforceCsvMutation } = workforceCsvApi;

export function exportWorkforceCsvUrl(month: Month, companyId: number): string {
  return `/api/export/workforce/${month}?companyId=${companyId}`;
}
