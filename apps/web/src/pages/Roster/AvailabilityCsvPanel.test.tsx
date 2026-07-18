import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../testUtils/mockFetch.js';
import { renderWithProviders } from '../../testUtils/renderWithProviders.js';
import { AvailabilityCsvPanel } from './AvailabilityCsvPanel.js';

function makeCsvFile(): File {
  return new File(['national_id,d01\n123456782,A\n'], 'availability.csv', { type: 'text/csv' });
}

describe('AvailabilityCsvPanel', () => {
  it('links straight to the month-scoped export endpoint rather than fetching it through the RTK Query cache', () => {
    installMockFetch([]);
    renderWithProviders(<AvailabilityCsvPanel month="2026-08" />);

    const exportLink = screen.getByRole('link', { name: /Export 2026-08 availability/ });
    expect(exportLink).toHaveAttribute('href', '/api/export/availability/2026-08');
  });

  it('gates the upload behind the confirm checkbox, then polls the job to completion and shows the applied/failed report (no deactivation table)', async () => {
    const user = userEvent.setup();
    let jobPollCount = 0;
    installMockFetch([
      {
        method: 'POST',
        match: '/api/import/availability/2026-08',
        respond: () => ({ status: 202, body: { jobId: 'job-9' } }),
      },
      {
        method: 'GET',
        match: '/api/jobs/job-9',
        respond: () => {
          jobPollCount += 1;
          if (jobPollCount < 2) {
            return {
              status: 200,
              body: { id: 'job-9', name: 'availability-import', state: 'active', createdAt: '2026-01-01T00:00:00.000Z', completedAt: null, result: null },
            };
          }
          return {
            status: 200,
            body: {
              id: 'job-9',
              name: 'availability-import',
              state: 'completed',
              createdAt: '2026-01-01T00:00:00.000Z',
              completedAt: '2026-01-01T00:01:00.000Z',
              result: { totalRows: 2, applied: 1, failed: 1, errors: [{ row: 2, nationalId: '999999999', message: 'Unknown national_id' }] },
            },
          };
        },
      },
    ]);

    renderWithProviders(<AvailabilityCsvPanel month="2026-08" />);

    const fileInput = screen.getByLabelText('CSV file');
    await user.upload(fileInput, makeCsvFile());

    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm import — 2026-08 availability' });
    await user.click(within(confirmDialog).getByLabelText(/I understand this replaces availability/));
    await user.click(within(confirmDialog).getByRole('button', { name: /Import availability\.csv/ }));

    await screen.findByRole('dialog', { name: 'Importing 2026-08 availability' });
    expect(await screen.findByText('Import complete', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText('Applied')).toBeInTheDocument();
    expect(screen.getByText('999999999')).toBeInTheDocument();
    // No deactivation-sweep table for this import kind, unlike the worker CsvPanel.
    expect(screen.queryByText(/Deactivated/)).not.toBeInTheDocument();
  });

  it('surfaces the real 400 error message on a rejected import instead of silently closing the dialog', async () => {
    const user = userEvent.setup();
    installMockFetch([
      {
        method: 'POST',
        match: '/api/import/availability/2026-08',
        respond: () => ({
          status: 400,
          body: { errors: [{ path: 'file', message: 'Header day-count mismatch for 2026-08' }] },
        }),
      },
    ]);

    renderWithProviders(<AvailabilityCsvPanel month="2026-08" />);

    const fileInput = screen.getByLabelText('CSV file');
    await user.upload(fileInput, makeCsvFile());

    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm import — 2026-08 availability' });
    await user.click(within(confirmDialog).getByLabelText(/I understand this replaces availability/));
    await user.click(within(confirmDialog).getByRole('button', { name: /Import availability\.csv/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText(/Header day-count mismatch for 2026-08/)).toBeInTheDocument();
  });
});
