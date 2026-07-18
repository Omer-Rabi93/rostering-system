import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../testUtils/mockFetch.js';
import { renderWithProviders } from '../../testUtils/renderWithProviders.js';
import { CsvPanel } from './CsvPanel.js';

function makeCsvFile(): File {
  return new File(['national_id,name\n123456782,Dana Levi\n'], 'workers.csv', { type: 'text/csv' });
}

/** No in-flight import for this company+kind — the common case, upload proceeds without any
 * extra confirm dialog. */
const NO_ACTIVE_TASK_ROUTE = {
  method: 'GET' as const,
  match: '/api/import-tasks/active',
  respond: () => ({ status: 200, body: null }),
};

describe('CsvPanel', () => {
  it('gates the upload behind the full-sync confirm checkbox, sends companyId alongside the file, then polls the job to completion and shows the result report', async () => {
    const user = userEvent.setup();
    let jobPollCount = 0;
    const { fetchMock, calls } = installMockFetch([
      NO_ACTIVE_TASK_ROUTE,
      {
        method: 'POST',
        match: '/api/import/workers',
        respond: () => ({ status: 202, body: { jobId: 'job-1' } }),
      },
      {
        method: 'GET',
        match: '/api/jobs/job-1',
        respond: () => {
          jobPollCount += 1;
          if (jobPollCount < 2) {
            return {
              status: 200,
              body: { id: 'job-1', name: 'csv-import', state: 'active', createdAt: '2026-01-01T00:00:00.000Z', completedAt: null, result: null },
            };
          }
          return {
            status: 200,
            body: {
              id: 'job-1',
              name: 'csv-import',
              state: 'completed',
              createdAt: '2026-01-01T00:00:00.000Z',
              completedAt: '2026-01-01T00:01:00.000Z',
              result: { totalRows: 2, inserted: 1, updated: 0, failed: 0, errors: [] },
            },
          };
        },
      },
    ]);

    renderWithProviders(<CsvPanel />, { activeCompanyId: 1 });

    const fileInput = screen.getByLabelText('CSV file');
    await user.upload(fileInput, makeCsvFile());

    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm import — full workforce sync' });
    const importButton = within(confirmDialog).getByRole('button', { name: /Import workers\.csv/ });
    expect(importButton).toBeDisabled();

    await user.click(within(confirmDialog).getByLabelText(/I understand this file becomes the authoritative/));
    expect(importButton).toBeEnabled();
    await user.click(importButton);

    // Job progress modal, then the result report once the job completes (polling drives this,
    // not a manual re-fetch). No "Deactivated" stat/table — the global deactivation sweep is gone.
    await screen.findByRole('dialog', { name: 'Importing workers.csv' });
    expect(await screen.findByText('Import complete', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/Deactivated/)).not.toBeInTheDocument();

    const postIndex = calls.findIndex((c) => c.method === 'POST' && c.path === '/api/import/workers');
    expect(postIndex).toBeGreaterThanOrEqual(0);
    const postRequest = fetchMock.mock.calls[postIndex]?.[0] as { body?: FormData };
    expect(postRequest.body).toBeInstanceOf(FormData);
    expect(postRequest.body?.get('companyId')).toBe('1');
    expect((postRequest.body?.get('file') as File).name).toBe('workers.csv');
  });

  it('checks for an in-flight import for this company before submitting, and proceeds without any extra dialog when none is in flight', async () => {
    const user = userEvent.setup();
    const { calls } = installMockFetch([
      NO_ACTIVE_TASK_ROUTE,
      { method: 'POST', match: '/api/import/workers', respond: () => ({ status: 202, body: { jobId: 'job-1' } }) },
      {
        method: 'GET',
        match: '/api/jobs/job-1',
        respond: () => ({
          status: 200,
          body: { id: 'job-1', name: 'csv-import', state: 'active', createdAt: '2026-01-01T00:00:00.000Z', completedAt: null, result: null },
        }),
      },
    ]);

    renderWithProviders(<CsvPanel />, { activeCompanyId: 1 });

    const fileInput = screen.getByLabelText('CSV file');
    await user.upload(fileInput, makeCsvFile());

    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm import — full workforce sync' });
    await user.click(within(confirmDialog).getByLabelText(/I understand this file becomes the authoritative/));
    await user.click(within(confirmDialog).getByRole('button', { name: /Import workers\.csv/ }));

    await screen.findByRole('dialog', { name: 'Importing workers.csv' });
    expect(screen.queryByRole('dialog', { name: 'Import already in progress' })).not.toBeInTheDocument();

    const checkIndex = calls.findIndex((c) => c.method === 'GET' && c.path.startsWith('/api/import-tasks/active'));
    expect(checkIndex).toBeGreaterThanOrEqual(0);
    expect(calls[checkIndex]?.path).toBe('/api/import-tasks/active?companyId=1&kind=WORKER_SYNC');
  });

  it('shows a second confirm dialog when an import is already in flight for this company, and blocks submission until confirmed', async () => {
    const user = userEvent.setup();
    let postCount = 0;
    const { calls } = installMockFetch([
      {
        method: 'GET',
        match: '/api/import-tasks/active',
        respond: () => ({
          status: 200,
          body: { id: 9, companyId: 1, kind: 'WORKER_SYNC', status: 'PROCESSING' },
        }),
      },
      {
        method: 'POST',
        match: '/api/import/workers',
        respond: () => {
          postCount += 1;
          return { status: 202, body: { jobId: 'job-2' } };
        },
      },
      {
        method: 'GET',
        match: '/api/jobs/job-2',
        respond: () => ({
          status: 200,
          body: { id: 'job-2', name: 'csv-import', state: 'active', createdAt: '2026-01-01T00:00:00.000Z', completedAt: null, result: null },
        }),
      },
    ]);

    renderWithProviders(<CsvPanel />, { activeCompanyId: 1 });

    const fileInput = screen.getByLabelText('CSV file');
    await user.upload(fileInput, makeCsvFile());

    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm import — full workforce sync' });
    await user.click(within(confirmDialog).getByLabelText(/I understand this file becomes the authoritative/));
    await user.click(within(confirmDialog).getByRole('button', { name: /Import workers\.csv/ }));

    const inProgressDialog = await screen.findByRole('dialog', { name: 'Import already in progress' });
    expect(postCount).toBe(0);
    expect(screen.getByText(/An import is still processing for this company/)).toBeInTheDocument();

    await user.click(within(inProgressDialog).getByRole('button', { name: 'Continue' }));

    await screen.findByRole('dialog', { name: 'Importing workers.csv' });
    expect(postCount).toBe(1);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/import/workers')).toBe(true);
  });

  it('cancelling the in-flight-import confirm dialog does not submit the upload', async () => {
    const user = userEvent.setup();
    let postCount = 0;
    installMockFetch([
      {
        method: 'GET',
        match: '/api/import-tasks/active',
        respond: () => ({
          status: 200,
          body: { id: 9, companyId: 1, kind: 'WORKER_SYNC', status: 'PENDING' },
        }),
      },
      {
        method: 'POST',
        match: '/api/import/workers',
        respond: () => {
          postCount += 1;
          return { status: 202, body: { jobId: 'job-3' } };
        },
      },
    ]);

    renderWithProviders(<CsvPanel />, { activeCompanyId: 1 });

    const fileInput = screen.getByLabelText('CSV file');
    await user.upload(fileInput, makeCsvFile());

    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm import — full workforce sync' });
    await user.click(within(confirmDialog).getByLabelText(/I understand this file becomes the authoritative/));
    await user.click(within(confirmDialog).getByRole('button', { name: /Import workers\.csv/ }));

    const inProgressDialog = await screen.findByRole('dialog', { name: 'Import already in progress' });
    await user.click(within(inProgressDialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(postCount).toBe(0);
  });

  it('links straight to the export endpoint rather than fetching it through the RTK Query cache', () => {
    installMockFetch([]);
    renderWithProviders(<CsvPanel />, { activeCompanyId: 1 });

    const exportLink = screen.getByRole('link', { name: /Export current workers/ });
    expect(exportLink).toHaveAttribute('href', '/api/export/workers');
  });

  it('surfaces the real 400 error message on a rejected import instead of silently closing the dialog', async () => {
    const user = userEvent.setup();
    installMockFetch([
      NO_ACTIVE_TASK_ROUTE,
      {
        method: 'POST',
        match: '/api/import/workers',
        respond: () => ({
          status: 400,
          body: { errors: [{ path: 'file', message: 'Not a CSV file' }] },
        }),
      },
    ]);

    renderWithProviders(<CsvPanel />, { activeCompanyId: 1 });

    const fileInput = screen.getByLabelText('CSV file');
    await user.upload(fileInput, makeCsvFile());

    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm import — full workforce sync' });
    await user.click(within(confirmDialog).getByLabelText(/I understand this file becomes the authoritative/));
    await user.click(within(confirmDialog).getByRole('button', { name: /Import workers\.csv/ }));

    // The confirm dialog must close (no silent success state), but the failure must be surfaced,
    // not swallowed.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText(/Not a CSV file/)).toBeInTheDocument();
  });
});
