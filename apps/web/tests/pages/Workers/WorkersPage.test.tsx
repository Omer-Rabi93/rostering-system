import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../../src/testUtils/mockFetch.js';
import { renderWithProviders } from '../../../src/testUtils/renderWithProviders.js';
import { WorkersPage } from '../../../src/pages/Workers/WorkersPage.js';

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

    renderWithProviders(<WorkersPage />, { activeCompanyId: 1 });

    expect(await screen.findByText('Dana Levi')).toBeInTheDocument();
    const row = screen.getByText('Dana Levi').closest('tr');
    expect(row).not.toBeNull();
    expect(row ? within(row).getByText('Supervisor') : null).toBeInTheDocument();
    expect(row ? within(row).getByText('Active') : null).toBeInTheDocument();
    expect(row ? within(row).getByText('₪63') : null).toBeInTheDocument();
  });

  it('has no page-level "Company" filter — the list is scoped by the topbar\'s active company alone', async () => {
    installMockFetch([
      ...BASE_ROUTES,
      { method: 'GET', match: /^\/api\/workers/, respond: () => ({ status: 200, body: [makeWorker()] }) },
    ]);

    renderWithProviders(<WorkersPage />, { activeCompanyId: 1 });
    await screen.findByText('Dana Levi');

    expect(screen.queryByLabelText('Company', { exact: false })).not.toBeInTheDocument();
  });

  it('scopes the workers list request to the topbar\'s active company', async () => {
    const { calls } = installMockFetch([
      ...BASE_ROUTES,
      { method: 'GET', match: /^\/api\/workers/, respond: () => ({ status: 200, body: [makeWorker()] }) },
    ]);

    renderWithProviders(<WorkersPage />, { activeCompanyId: 1 });
    await screen.findByText('Dana Levi');

    const workersCall = calls.find((c) => c.method === 'GET' && c.path.startsWith('/api/workers'));
    expect(workersCall?.path).toContain('companyId=1');
  });

  it('switching the active company (topbar) shows only the new company\'s workers, never the previous company\'s', async () => {
    const companyAWorker = makeWorker({ id: 1, name: 'Dana Levi (Company A)' });
    const companyBWorker = makeWorker({ id: 2, name: 'Omer Cohen (Company B)', companyId: 2 });

    installMockFetch([
      ...BASE_ROUTES,
      {
        method: 'GET',
        match: /^\/api\/workers/,
        respond: (url) => ({
          status: 200,
          body: url.searchParams.get('companyId') === '2' ? [companyBWorker] : [companyAWorker],
        }),
      },
    ]);

    // Two separate mounts (each with its own fresh store/cache) rather than RTL's `rerender` —
    // `rerender` would re-render at the root and strip the `ActiveCompanyContext.Provider`
    // `renderWithProviders`'s `activeCompanyId` option wraps `WorkersPage` in.
    const companyA = renderWithProviders(<WorkersPage />, { activeCompanyId: 1 });
    expect(await screen.findByText('Dana Levi (Company A)')).toBeInTheDocument();
    expect(screen.queryByText('Omer Cohen (Company B)')).not.toBeInTheDocument();
    companyA.unmount();

    renderWithProviders(<WorkersPage />, { activeCompanyId: 2 });
    expect(await screen.findByText('Omer Cohen (Company B)')).toBeInTheDocument();
    expect(screen.queryByText('Dana Levi (Company A)')).not.toBeInTheDocument();
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

    renderWithProviders(<WorkersPage />, { activeCompanyId: 1 });
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

    renderWithProviders(<WorkersPage />, { activeCompanyId: 1 });
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

    renderWithProviders(<WorkersPage />, { activeCompanyId: 1 });
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

  it('mounts only a small, bounded number of rows for a large (3,000-worker) company, and row actions still work for a visible row', async () => {
    const user = userEvent.setup();
    const WORKER_COUNT = 3000;
    const manyWorkers = Array.from({ length: WORKER_COUNT }, (_, i) =>
      makeWorker({ id: i + 1, name: `Worker ${i + 1}`, nationalId: '123456782' }),
    );
    installMockFetch([
      ...BASE_ROUTES,
      { method: 'GET', match: /^\/api\/workers/, respond: () => ({ status: 200, body: manyWorkers }) },
      {
        method: 'DELETE',
        match: /^\/api\/workers\/1$/,
        respond: () => ({ status: 200, body: {} }),
      },
    ]);

    renderWithProviders(<WorkersPage />, { activeCompanyId: 1 });
    expect(await screen.findByText('Worker 1')).toBeInTheDocument();
    expect(screen.getByText(`${WORKER_COUNT} workers`)).toBeInTheDocument();

    // Windowing proof: with WORKER_COUNT rows unvirtualized, this would mount WORKER_COUNT <tr>s;
    // opting `Table` into `virtualized` (see WorkersPage.tsx) keeps the mounted row count small and
    // constant regardless of company size.
    const renderedRows = screen.getAllByRole('row').filter((row) => row.hasAttribute('data-index'));
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(50);
    expect(screen.queryByText('Worker 2999')).not.toBeInTheDocument();

    // Per-row actions (edit/deactivate/share-link buttons) are still wired correctly for a
    // rendered row once virtualized -- not lost/misattributed by the windowing.
    const row = screen.getByText('Worker 1').closest('tr');
    expect(row).not.toBeNull();
    if (!row) throw new Error('expected a row for Worker 1');
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('"Worker 1" deleted.')).toBeInTheDocument();
  });
});
