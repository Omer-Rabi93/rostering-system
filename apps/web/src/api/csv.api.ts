import { baseApi } from './baseApi.js';

export interface EnqueueJobResponse {
  readonly jobId: string;
}

/**
 * `POST /api/import/workers` — full-workforce-sync CSV upload. Doesn't invalidate `Worker`
 * itself: like `generateRoster` (see `rosters.api.ts`), the import isn't applied until the
 * `csv-import` job reaches `completed` — `jobs.api.ts`'s `onQueryStarted` invalidates `Worker`
 * at that point, not here.
 *
 * `GET /api/export/workers` has no dedicated RTK Query endpoint: it's a plain file download
 * (`Content-Disposition: attachment`), so the page links straight to it (`<a href="/api/export/workers">`)
 * rather than fetching it through the cache.
 */
export const csvApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    importWorkersCsv: builder.mutation<EnqueueJobResponse, File>({
      query: (file) => {
        const formData = new FormData();
        formData.append('file', file);
        return { url: '/import/workers', method: 'POST', body: formData };
      },
    }),
  }),
});

export const { useImportWorkersCsvMutation } = csvApi;

export const EXPORT_WORKERS_CSV_URL = '/api/export/workers';
