import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../testUtils/mockFetch.js';
import { renderWithProviders } from '../../testUtils/renderWithProviders.js';
import { CostDashboardPage } from './CostDashboardPage.js';

function worker(id: number, name: string, companyId: number, role: string) {
  return {
    id,
    nationalId: '123456782',
    name,
    role,
    status: 'ACTIVE',
    companyId,
    shareToken: `tok-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    contract: null,
  };
}

const SUMMARY = {
  totalIls: 1000,
  perCompany: [{ companyId: 1, name: 'Shamir Security Ltd', costIls: 1000 }],
  perWorker: [{ workerId: 1, shifts: 10, hours: 80, costIls: 1000 }],
};

describe('CostDashboardPage', () => {
  it('renders roster-total stats and per-company/per-worker tables from the cost-summary endpoint', async () => {
    installMockFetch([
      { method: 'GET', match: '/api/rosters/2026-08/cost-summary', respond: () => ({ status: 200, body: SUMMARY }) },
      { method: 'GET', match: /^\/api\/workers/, respond: () => ({ status: 200, body: [worker(1, 'Dana Levi', 1, 'SUPERVISOR')] }) },
    ]);

    renderWithProviders(<CostDashboardPage />, { initialEntries: ['/cost/2026-08'], path: '/cost/:month' });

    const totalTile = (await screen.findByText('Roster total (August 2026)')).closest<HTMLElement>('.stat-tile');
    expect(totalTile ? within(totalTile).getByText('₪1,000') : null).toBeInTheDocument();
    // "Shamir Security Ltd" appears in both the by-company and by-worker tables — the first match
    // is the by-company row.
    const companyRow = screen.getAllByText('Shamir Security Ltd')[0]?.closest('tr');
    expect(companyRow ? within(companyRow).getByText('10') : null).toBeInTheDocument();
    expect(screen.getByText('Dana Levi')).toBeInTheDocument();
  });

  it('shows an empty state with a link to Roster when the month has no cost data (404)', async () => {
    const user = userEvent.setup();
    installMockFetch([
      { method: 'GET', match: '/api/rosters/2026-09/cost-summary', respond: () => ({ status: 404, body: { message: 'Roster 2026-09 not found' } }) },
      { method: 'GET', match: /^\/api\/workers/, respond: () => ({ status: 200, body: [] }) },
    ]);

    renderWithProviders(<CostDashboardPage />, { initialEntries: ['/cost/2026-09'], path: '/cost/:month' });

    expect(await screen.findByText('No cost data for September 2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go to Roster' }));
  });
});
