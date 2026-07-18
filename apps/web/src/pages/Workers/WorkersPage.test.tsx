import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../testUtils/mockFetch.js';
import { renderWithProviders } from '../../testUtils/renderWithProviders.js';
import { WorkersPage } from './WorkersPage.js';

const COMPANY = { id: 1, name: 'Shamir Security Ltd', createdAt: '2026-01-01T00:00:00.000Z' };

function makeWorker(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    nationalId: '123456782',
    name: 'Dana Levi',
    role: 'SUPERVISOR',
    status: 'ACTIVE',
    companyId: 1,
    shareToken: 'tok-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    contract: {
      workerId: 1,
      hourlyCostIls: 62.5,
      minMonthlyHours: 120,
      maxMonthlyHours: 182,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

const BASE_ROUTES = [
  { method: 'GET' as const, match: '/api/companies', respond: () => ({ status: 200, body: [COMPANY] }) },
];

describe('WorkersPage', () => {
  it('lists workers and shows their role/status badges and contract figures', async () => {
    installMockFetch([
      ...BASE_ROUTES,
      { method: 'GET', match: /^\/api\/workers/, respond: () => ({ status: 200, body: [makeWorker()] }) },
    ]);

    renderWithProviders(<WorkersPage />);

    expect(await screen.findByText('Dana Levi')).toBeInTheDocument();
    const row = screen.getByText('Dana Levi').closest('tr');
    expect(row).not.toBeNull();
    expect(row ? within(row).getByText('Supervisor') : null).toBeInTheDocument();
    expect(row ? within(row).getByText('Active') : null).toBeInTheDocument();
    expect(row ? within(row).getByText('₪63') : null).toBeInTheDocument();
  });

  it('offers "Set Inactive" when deleting a worker with shift history (409)', async () => {
    const user = userEvent.setup();
    installMockFetch([
      ...BASE_ROUTES,
      { method: 'GET', match: /^\/api\/workers/, respond: () => ({ status: 200, body: [makeWorker()] }) },
      {
        method: 'DELETE',
        match: /^\/api\/workers\/1$/,
        respond: () => ({ status: 409, body: { message: 'Worker 1 has shift history and cannot be deleted' } }),
      },
      {
        method: 'PUT',
        match: '/api/workers/1',
        respond: () => ({ status: 200, body: makeWorker({ status: 'INACTIVE' }) }),
      },
    ]);

    renderWithProviders(<WorkersPage />);
    await screen.findByText('Dana Levi');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog', { name: "Can't delete this worker" });
    expect(within(dialog).getByText(/has shift history and can't be permanently deleted/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Set Inactive' }));
    expect(await screen.findByText('"Dana Levi" set to Inactive.')).toBeInTheDocument();
  });

  it('shows an inline duplicate-national-ID error (409) when creating a worker, without closing the form', async () => {
    const user = userEvent.setup();
    installMockFetch([
      ...BASE_ROUTES,
      { method: 'GET', match: /^\/api\/workers/, respond: () => ({ status: 200, body: [] }) },
      {
        method: 'POST',
        match: '/api/workers',
        respond: () => ({ status: 409, body: { message: 'A worker with nationalId "123456782" already exists' } }),
      },
    ]);

    renderWithProviders(<WorkersPage />);
    // With no workers at all, both the page-header's "+ New worker" and the EmptyState's own
    // "+ New worker" action button are on screen at once (matching
    // docs/design/ui/mockups/01-workers.html's "no workers yet" state) — either opens the same
    // create dialog, so `getAllByRole(...)[0]` (the header's) disambiguates deterministically.
    const [newWorkerButton] = await screen.findAllByRole('button', { name: '+ New worker' });
    if (!newWorkerButton) throw new Error('expected a "+ New worker" button');

    await user.click(newWorkerButton);
    const dialog = await screen.findByRole('dialog', { name: 'New worker' });

    await user.type(within(dialog).getByLabelText('National ID', { exact: false }), '123456782');
    await user.type(within(dialog).getByLabelText('Full name', { exact: false }), 'Omer Cohen');
    await user.selectOptions(within(dialog).getByLabelText('Company', { exact: false }), 'Shamir Security Ltd');
    await user.type(within(dialog).getByLabelText('Hourly cost, ILS', { exact: false }), '50');
    await user.type(within(dialog).getByLabelText('Min monthly hours', { exact: false }), '100');
    await user.type(within(dialog).getByLabelText('Max monthly hours', { exact: false }), '180');

    await user.click(within(dialog).getByRole('button', { name: 'Save worker' }));

    expect(
      await within(dialog).findByText('National ID 123456782 already belongs to another worker.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'New worker' })).toBeInTheDocument();
  });

  it('surfaces a live Israeli-ID checksum error before the form is even submitted', async () => {
    const user = userEvent.setup();
    installMockFetch([
      ...BASE_ROUTES,
      { method: 'GET', match: /^\/api\/workers/, respond: () => ({ status: 200, body: [] }) },
    ]);

    renderWithProviders(<WorkersPage />);
    const [newWorkerButton] = await screen.findAllByRole('button', { name: '+ New worker' });
    if (!newWorkerButton) throw new Error('expected a "+ New worker" button');
    await user.click(newWorkerButton);
    const dialog = await screen.findByRole('dialog', { name: 'New worker' });

    const nidInput = within(dialog).getByLabelText('National ID', { exact: false });
    await user.type(nidInput, '987654321');
    await user.click(within(dialog).getByRole('button', { name: 'Save worker' }));

    expect(nidInput).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByText('Invalid Israeli ID — checksum failed.')).toBeInTheDocument();
  });
});
