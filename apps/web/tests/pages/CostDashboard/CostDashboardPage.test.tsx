import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { createAppStore } from '../../../src/store/index.js';
import { ActiveCompanyContext } from '../../../src/hooks/useActiveCompanyId.js';
import { installMockFetch } from '../../../src/testUtils/mockFetch.js';
import { renderWithProviders } from '../../../src/testUtils/renderWithProviders.js';
import { CostDashboardPage } from '../../../src/pages/CostDashboard/CostDashboardPage.js';

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

function company(id: number, name: string) {
  return { id, name, createdAt: '2026-01-01T00:00:00.000Z' };
}

/** Test-only helper that surfaces the router's current pathname+search so a test can assert
 * navigation (e.g. to the compare page) without adding any test-only hook to the page itself. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

const SUMMARY = {
  totalIls: 1000,
  perCompany: [{ companyId: 1, name: 'Shamir Security Ltd', costIls: 1000 }],
  perWorker: [{ workerId: 1, shifts: 10, hours: 80, costIls: 1000 }],
};

// Company-scoped rostering: a real `getCostSummary` response now only ever reflects the ONE
// company it was requested for (see `costSummaryService.ts`'s `getByMonth(companyId, month)`), so
// there is no cross-company data for this page to filter anymore — both fixture workers below
// belong to the same active company.
const TWO_WORKER_SUMMARY = {
  totalIls: 1000,
  perCompany: [{ companyId: 1, name: 'Shamir Security Ltd', costIls: 1000 }],
  perWorker: [
    { workerId: 1, shifts: 10, hours: 80, costIls: 700 },
    { workerId: 2, shifts: 5, hours: 40, costIls: 300 },
  ],
};

const TWO_WORKERS = [worker(1, 'Dana Levi', 1, 'SUPERVISOR'), worker(2, 'Omer Cohen', 1, 'GENERAL_GUARD')];

describe('CostDashboardPage', () => {
  it('renders roster-total stats and the per-worker table from the cost-summary endpoint', async () => {
    installMockFetch([
      { method: 'GET', match: '/api/rosters/2026-08/cost-summary', respond: () => ({ status: 200, body: SUMMARY }) },
      { method: 'GET', match: /^\/api\/workers$/, respond: () => ({ status: 200, body: [worker(1, 'Dana Levi', 1, 'SUPERVISOR')] }) },
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [company(1, 'Shamir Security Ltd')] }) },
    ]);

    renderWithProviders(<CostDashboardPage />, { initialEntries: ['/cost/2026-08'], path: '/cost/:month', activeCompanyId: 1 });

    const totalTile = (await screen.findByText('Roster total (August 2026)')).closest<HTMLElement>('.stat-tile');
    expect(totalTile ? within(totalTile).getByText('₪1,000') : null).toBeInTheDocument();
    expect(screen.getByText('Dana Levi')).toBeInTheDocument();
  });

  it('shows an empty state with a link to Roster when the month has no cost data (404)', async () => {
    const user = userEvent.setup();
    installMockFetch([
      { method: 'GET', match: '/api/rosters/2026-09/cost-summary', respond: () => ({ status: 404, body: { message: 'Roster 2026-09 not found' } }) },
      { method: 'GET', match: /^\/api\/workers$/, respond: () => ({ status: 200, body: [] }) },
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [] }) },
    ]);

    renderWithProviders(<CostDashboardPage />, { initialEntries: ['/cost/2026-09'], path: '/cost/:month', activeCompanyId: 1 });

    expect(await screen.findByText('No cost data for September 2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go to Roster' }));
  });

  it('a worker\'s name links to their per-worker cost detail page for the current month', async () => {
    installMockFetch([
      { method: 'GET', match: '/api/rosters/2026-08/cost-summary', respond: () => ({ status: 200, body: SUMMARY }) },
      { method: 'GET', match: /^\/api\/workers$/, respond: () => ({ status: 200, body: [worker(1, 'Dana Levi', 1, 'SUPERVISOR')] }) },
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [company(1, 'Shamir Security Ltd')] }) },
    ]);

    renderWithProviders(<CostDashboardPage />, { initialEntries: ['/cost/2026-08'], path: '/cost/:month', activeCompanyId: 1 });

    const link = await screen.findByRole('link', { name: 'Dana Levi' });
    expect(link).toHaveAttribute('href', '/cost/2026-08/worker/1');
  });

  describe('worker comparison selection', () => {
    async function renderTwoWorkerPage() {
      installMockFetch([
        { method: 'GET', match: '/api/rosters/2026-08/cost-summary', respond: () => ({ status: 200, body: TWO_WORKER_SUMMARY }) },
        { method: 'GET', match: /^\/api\/workers$/, respond: () => ({ status: 200, body: TWO_WORKERS }) },
        { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [company(1, 'Shamir Security Ltd')] }) },
      ]);

      const utils = renderWithProviders(
        <>
          <CostDashboardPage />
          <LocationProbe />
        </>,
        { initialEntries: ['/cost/2026-08'], path: '/cost/:month', activeCompanyId: 1 },
      );
      await screen.findByText('Dana Levi');
      return utils;
    }

    it('shows no Compare button until at least 2 workers are selected', async () => {
      const user = userEvent.setup();
      await renderTwoWorkerPage();

      expect(screen.queryByRole('button', { name: /compare/i })).not.toBeInTheDocument();

      await user.click(screen.getByLabelText('Select Dana Levi for comparison'));
      expect(screen.queryByRole('button', { name: /compare/i })).not.toBeInTheDocument();
    });

    it('selecting 2 workers shows a Compare button that navigates to the compare route with both worker ids', async () => {
      const user = userEvent.setup();
      installMockFetch([
        { method: 'GET', match: '/api/rosters/2026-08/cost-summary', respond: () => ({ status: 200, body: TWO_WORKER_SUMMARY }) },
        { method: 'GET', match: /^\/api\/workers$/, respond: () => ({ status: 200, body: TWO_WORKERS }) },
        { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [company(1, 'Shamir Security Ltd')] }) },
      ]);

      // `LocationProbe` is mounted OUTSIDE the `/cost/:month`-scoped `<Routes>` (unlike
      // `renderTwoWorkerPage`'s usage) specifically so it survives navigating to a route this test
      // doesn't otherwise render (`/cost/:month/compare`) — inside the same `<Routes>`, navigating
      // away would unmount it along with `CostDashboardPage`.
      const store = createAppStore();
      render(
        <Provider store={store}>
          <ActiveCompanyContext.Provider value={1}>
            <MemoryRouter initialEntries={['/cost/2026-08']}>
              <LocationProbe />
              <Routes>
                <Route path="/cost/:month" element={<CostDashboardPage />} />
                <Route path="*" element={null} />
              </Routes>
            </MemoryRouter>
          </ActiveCompanyContext.Provider>
        </Provider>,
      );
      await screen.findByText('Dana Levi');

      await user.click(screen.getByLabelText('Select Dana Levi for comparison'));
      await user.click(screen.getByLabelText('Select Omer Cohen for comparison'));

      const compareButton = await screen.findByRole('button', { name: 'Compare 2 workers' });
      await user.click(compareButton);

      expect(screen.getByTestId('location')).toHaveTextContent('/cost/2026-08/compare?workers=1,2');
    });

    it('deselecting a worker after reaching 2 hides the Compare button again and updates the count', async () => {
      const user = userEvent.setup();
      await renderTwoWorkerPage();

      const danaCheckbox = screen.getByLabelText('Select Dana Levi for comparison');
      const omerCheckbox = screen.getByLabelText('Select Omer Cohen for comparison');

      await user.click(danaCheckbox);
      await user.click(omerCheckbox);
      expect(await screen.findByRole('button', { name: 'Compare 2 workers' })).toBeInTheDocument();

      await user.click(danaCheckbox);
      expect(screen.queryByRole('button', { name: /compare/i })).not.toBeInTheDocument();
      expect(danaCheckbox).not.toBeChecked();
      expect(omerCheckbox).toBeChecked();
    });

    it('checkbox selection coexists with the worker-name link — neither interferes with the other', async () => {
      const user = userEvent.setup();
      await renderTwoWorkerPage();

      // The worker-name link to the single-worker detail page still works alongside the checkbox
      // column.
      const link = screen.getByRole('link', { name: 'Dana Levi' });
      expect(link).toHaveAttribute('href', '/cost/2026-08/worker/1');

      await user.click(screen.getByLabelText('Select Dana Levi for comparison'));
      expect(screen.getByLabelText('Select Dana Levi for comparison')).toBeChecked();
    });
  });
});
