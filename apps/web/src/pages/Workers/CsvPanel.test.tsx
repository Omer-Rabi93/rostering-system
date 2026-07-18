import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../testUtils/mockFetch.js';
import { renderWithProviders } from '../../testUtils/renderWithProviders.js';
import { CsvPanel } from './CsvPanel.js';

function makeCsvFile(): File {
  return new File(['national_id,name\n123456782,Dana Levi\n'], 'workers.csv', { type: 'text/csv' });
}

describe('CsvPanel', () => {
  it('gates the upload behind the full-sync confirm checkbox, then polls the job to completion and shows the result report', async () => {
    const user = userEvent.setup();
    let jobPollCount = 0;
    installMockFetch([
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
              result: {
                totalRows: 2,
                inserted: 1,
                updated: 0,
                failed: 0,
                deactivated: 1,
                deactivatedWorkers: [{ workerId: 9, nationalId: '111223344', name: 'Yossi Peretz' }],
                errors: [],
              },
            },
          };
        },
      },
    ]);

    renderWithProviders(<CsvPanel />);

    const fileInput = screen.getByLabelText('CSV file');
    await user.upload(fileInput, makeCsvFile());

    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm import — full workforce sync' });
    const importButton = within(confirmDialog).getByRole('button', { name: /Import workers\.csv/ });
    expect(importButton).toBeDisabled();

    await user.click(within(confirmDialog).getByLabelText(/I understand workers not in this file/));
    expect(importButton).toBeEnabled();
    await user.click(importButton);

    // Job progress modal, then the result report once the job completes (polling drives this,
    // not a manual re-fetch).
    await screen.findByRole('dialog', { name: 'Importing workers.csv' });
    expect(await screen.findByText('Import complete', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText('Deactivated workers (1)')).toBeInTheDocument();
    expect(screen.getByText('Yossi Peretz')).toBeInTheDocument();
    expect(screen.getByText('111223344')).toBeInTheDocument();
  });

  it('links straight to the export endpoint rather than fetching it through the RTK Query cache', () => {
    installMockFetch([]);
    renderWithProviders(<CsvPanel />);

    const exportLink = screen.getByRole('link', { name: /Export current workers/ });
    expect(exportLink).toHaveAttribute('href', '/api/export/workers');
  });

  it('surfaces the real 400 error message on a rejected import instead of silently closing the dialog', async () => {
    const user = userEvent.setup();
    installMockFetch([
      {
        method: 'POST',
        match: '/api/import/workers',
        respond: () => ({
          status: 400,
          body: { errors: [{ path: 'file', message: 'Not a CSV file' }] },
        }),
      },
    ]);

    renderWithProviders(<CsvPanel />);

    const fileInput = screen.getByLabelText('CSV file');
    await user.upload(fileInput, makeCsvFile());

    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm import — full workforce sync' });
    await user.click(within(confirmDialog).getByLabelText(/I understand workers not in this file/));
    await user.click(within(confirmDialog).getByRole('button', { name: /Import workers\.csv/ }));

    // The confirm dialog must close (no silent success state), but the failure must be surfaced,
    // not swallowed.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText(/Not a CSV file/)).toBeInTheDocument();
  });
});
