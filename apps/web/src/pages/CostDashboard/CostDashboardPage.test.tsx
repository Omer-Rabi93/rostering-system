import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { createAppStore } from '../../store/index.js';
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

function company(id: number, name: string) {
  return { id, name, createdAt: '2026-01-01T00:00:00.000Z' };
}

/** Test-only helper that surfaces the router's current pathname+search so a test can assert the
 * company filter round-trips through the URL, without adding any test-only hook to the page
 * itself. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

const SUMMARY = {
  totalIls: 1000,
  perCompany: [{ companyId: 1, name: 'Shamir Security Ltd', costIls: 1000 }],
  perWorker: [{ workerId: 1, shifts: 10, hours: 80, costIls: 1000 }],
};

const TWO_COMPANY_SUMMARY = {
  totalIls: 1000,
  perCompany: [
    { companyId: 1, name: 'Shamir Security Ltd', costIls: 700 },
    { companyId: 2, name: 'Magen Guard Co.', costIls: 300 },
  ],
  perWorker: [
    { workerId: 1, shifts: 10, hours: 80, costIls: 700 },
    { workerId: 2, shifts: 5, hours: 40, costIls: 300 },
  ],
};

const TWO_COMPANY_WORKERS = [
  worker(1, 'Dana Levi', 1, 'SUPERVISOR'),
  worker(2, 'Omer Cohen', 2, 'GENERAL_GUARD'),
];

const TWO_COMPANIES = [company(1, 'Shamir Security Ltd'), company(2, 'Magen Guard Co.')];

describe('CostDashboardPage', () => {
  it('renders roster-total stats and per-company/per-worker tables from the cost-summary endpoint', async () => {
    installMockFetch([
      { method: 'GET', match: '/api/rosters/2026-08/cost-summary', respond: () => ({ status: 200, body: SUMMARY }) },
      { method: 'GET', match: /^\/api\/workers$/, respond: () => ({ status: 200, body: [worker(1, 'Dana Levi', 1, 'SUPERVISOR')] }) },
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [company(1, 'Shamir Security Ltd')] }) },
    ]);

    renderWithProviders(<CostDashboardPage />, { initialEntries: ['/cost/2026-08'], path: '/cost/:month' });

    const totalTile = (await screen.findByText('Roster total (August 2026)')).closest<HTMLElement>('.stat-tile');
    expect(totalTile ? within(totalTile).getByText('₪1,000') : null).toBeInTheDocument();
    // "Shamir Security Ltd" also appears as an <option> in the company filter select, so this is
    // scoped to the "By company" table specifically (via its caption) rather than a page-wide text
    // search.
    const companyTable = screen.getByRole('table', { name: 'Cost by company' });
    const companyRow = within(companyTable).getByText('Shamir Security Ltd').closest('tr');
    expect(companyRow ? within(companyRow).getByText('10') : null).toBeInTheDocument();
    expect(screen.getByText('Dana Levi')).toBeInTheDocument();
  });

  it('shows an empty state with a link to Roster when the month has no cost data (404)', async () => {
    const user = userEvent.setup();
    installMockFetch([
      { method: 'GET', match: '/api/rosters/2026-09/cost-summary', respond: () => ({ status: 404, body: { message: 'Roster 2026-09 not found' } }) },
      { method: 'GET', match: /^\/api\/workers$/, respond: () => ({ status: 200, body: [] }) },
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [] }) },
    ]);

    renderWithProviders(<CostDashboardPage />, { initialEntries: ['/cost/2026-09'], path: '/cost/:month' });

    expect(await screen.findByText('No cost data for September 2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go to Roster' }));
  });

  it('a worker\'s name links to their per-worker cost detail page for the current month', async () => {
    installMockFetch([
      { method: 'GET', match: '/api/rosters/2026-08/cost-summary', respond: () => ({ status: 200, body: SUMMARY }) },
      { method: 'GET', match: /^\/api\/workers$/, respond: () => ({ status: 200, body: [worker(1, 'Dana Levi', 1, 'SUPERVISOR')] }) },
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [company(1, 'Shamir Security Ltd')] }) },
    ]);

    renderWithProviders(<CostDashboardPage />, { initialEntries: ['/cost/2026-08'], path: '/cost/:month' });

    const link = await screen.findByRole('link', { name: 'Dana Levi' });
    expect(link).toHaveAttribute('href', '/cost/2026-08/worker/1');
  });

  it('the company filter persists as a ?company= URL search param, scopes stats/tables, and hides the By company table when a specific company is selected', async () => {
    const user = userEvent.setup();
    installMockFetch([
      { method: 'GET', match: '/api/rosters/2026-08/cost-summary', respond: () => ({ status: 200, body: TWO_COMPANY_SUMMARY }) },
      { method: 'GET', match: /^\/api\/workers$/, respond: () => ({ status: 200, body: TWO_COMPANY_WORKERS }) },
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: TWO_COMPANIES }) },
    ]);

    renderWithProviders(
      <>
        <CostDashboardPage />
        <LocationProbe />
      </>,
      { initialEntries: ['/cost/2026-08'], path: '/cost/:month' },
    );

    // Starting state ("All companies"): both tables render, and the roster total covers both
    // companies.
    await screen.findByText('Dana Levi');
    expect(screen.getByText('Omer Cohen')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'By company' })).toBeInTheDocument();
    const totalTileBefore = screen.getByText('Roster total (August 2026)').closest<HTMLElement>('.stat-tile');
    expect(totalTileBefore ? within(totalTileBefore).getByText('₪1,000') : null).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Company'), 'Shamir Security Ltd');

    // URL reflects the selection.
    expect(screen.getByTestId('location')).toHaveTextContent('/cost/2026-08?company=1');

    // Scoped view: only company 1's worker remains, the By company table is hidden, and the
    // roster total reflects just that company.
    expect(screen.getByText('Dana Levi')).toBeInTheDocument();
    expect(screen.queryByText('Omer Cohen')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'By company' })).not.toBeInTheDocument();
    const totalTileAfter = screen.getByText('Roster total (August 2026)').closest<HTMLElement>('.stat-tile');
    expect(totalTileAfter ? within(totalTileAfter).getByText('₪700') : null).toBeInTheDocument();

    // Back to "All companies" restores the full view.
    await user.selectOptions(screen.getByLabelText('Company'), 'All companies');
    expect(screen.getByTestId('location')).toHaveTextContent('/cost/2026-08');
    expect(screen.getByText('Omer Cohen')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'By company' })).toBeInTheDocument();
  });

  describe('worker comparison selection', () => {
    async function renderTwoWorkerPage() {
      installMockFetch([
        { method: 'GET', match: '/api/rosters/2026-08/cost-summary', respond: () => ({ status: 200, body: TWO_COMPANY_SUMMARY }) },
        { method: 'GET', match: /^\/api\/workers$/, respond: () => ({ status: 200, body: TWO_COMPANY_WORKERS }) },
        { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: TWO_COMPANIES }) },
      ]);

      const utils = renderWithProviders(
        <>
          <CostDashboardPage />
          <LocationProbe />
        </>,
        { initialEntries: ['/cost/2026-08'], path: '/cost/:month' },
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
        { method: 'GET', match: '/api/rosters/2026-08/cost-summary', respond: () => ({ status: 200, body: TWO_COMPANY_SUMMARY }) },
        { method: 'GET', match: /^\/api\/workers$/, respond: () => ({ status: 200, body: TWO_COMPANY_WORKERS }) },
        { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: TWO_COMPANIES }) },
      ]);

      // `LocationProbe` is mounted OUTSIDE the `/cost/:month`-scoped `<Routes>` (unlike
      // `renderTwoWorkerPage`'s usage) specifically so it survives navigating to a route this test
      // doesn't otherwise render (`/cost/:month/compare`) — inside the same `<Routes>`, navigating
      // away would unmount it along with `CostDashboardPage`.
      const store = createAppStore();
      render(
        <Provider store={store}>
          <MemoryRouter initialEntries={['/cost/2026-08']}>
            <LocationProbe />
            <Routes>
              <Route path="/cost/:month" element={<CostDashboardPage />} />
              <Route path="*" element={null} />
            </Routes>
          </MemoryRouter>
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

    it('checkbox selection coexists with the company filter and the worker-name link — neither interferes with the other', async () => {
      const user = userEvent.setup();
      await renderTwoWorkerPage();

      // The worker-name link to the single-worker detail page still works alongside the checkbox
      // column.
      const link = screen.getByRole('link', { name: 'Dana Levi' });
      expect(link).toHaveAttribute('href', '/cost/2026-08/worker/1');

      await user.click(screen.getByLabelText('Select Dana Levi for comparison'));
      expect(screen.getByLabelText('Select Dana Levi for comparison')).toBeChecked();

      // The company filter still scopes the table as before, with the checkbox selection intact.
      await user.selectOptions(screen.getByLabelText('Company'), 'Shamir Security Ltd');
      expect(screen.queryByText('Omer Cohen')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Select Dana Levi for comparison')).toBeChecked();
    });
  });
});
