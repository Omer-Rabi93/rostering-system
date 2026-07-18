import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../testUtils/mockFetch.js';
import { renderWithProviders } from '../../testUtils/renderWithProviders.js';
import { WorkerCostComparePage } from './WorkerCostComparePage.js';

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

const DANA = { workerId: 1, name: 'Dana Levi', role: 'SUPERVISOR' as const };
const OMER = { workerId: 2, name: 'Omer Cohen', role: 'GENERAL_GUARD' as const };

const ROSTER = {
  id: 1,
  month: '2026-08',
  status: 'DRAFT',
  generatedAt: '2026-08-01T00:00:00.000Z',
  publishedAt: null,
  shifts: [
    { id: 10, date: '2026-08-03', shiftType: 'A', assignments: [DANA] },
    { id: 11, date: '2026-08-05', shiftType: 'B', assignments: [OMER] },
    { id: 12, date: '2026-08-07', shiftType: 'C', assignments: [DANA] },
  ],
  alerts: [],
};

const WORKERS = [worker(1, 'Dana Levi', 1, 'SUPERVISOR'), worker(2, 'Omer Cohen', 2, 'GENERAL_GUARD')];
const COMPANIES = [company(1, 'Shamir Security Ltd'), company(2, 'Magen Guard Co.')];
const DANA_CONTRACT = { workerId: 1, hourlyCostIls: 65, minMonthlyHours: 0, maxMonthlyHours: 200, updatedAt: '2026-01-01T00:00:00.000Z' };
const OMER_CONTRACT = { workerId: 2, hourlyCostIls: 45, minMonthlyHours: 0, maxMonthlyHours: 200, updatedAt: '2026-01-01T00:00:00.000Z' };

function installBaseRoutes(overrides: Partial<{ rosterStatus: number; workers: typeof WORKERS }> = {}) {
  installMockFetch([
    {
      method: 'GET',
      match: '/api/rosters/2026-08',
      respond: () => (overrides.rosterStatus === 404 ? { status: 404, body: { message: 'not found' } } : { status: 200, body: ROSTER }),
    },
    { method: 'GET', match: /^\/api\/workers$/, respond: () => ({ status: 200, body: overrides.workers ?? WORKERS }) },
    { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: COMPANIES }) },
    {
      method: 'GET',
      match: /^\/api\/workers\/\d+\/contract$/,
      respond: (url) => {
        const workerId = Number(url.pathname.split('/')[3]);
        if (workerId === 1) return { status: 200, body: DANA_CONTRACT };
        if (workerId === 2) return { status: 200, body: OMER_CONTRACT };
        return { status: 404, body: { message: 'no contract' } };
      },
    },
  ]);
}

describe('WorkerCostComparePage', () => {
  it('renders one section per selected worker plus a combined summary table sorted by cost descending', async () => {
    installBaseRoutes();

    renderWithProviders(<WorkerCostComparePage />, {
      initialEntries: ['/cost/2026-08/compare?workers=1,2'],
      path: '/cost/:month/compare',
    });

    expect(await screen.findByRole('heading', { name: /Compare Workers/ })).toHaveTextContent('August 2026');

    // Dana: 2 shifts x 8h x 65 = 1040. Omer: 1 shift x 8h x 45 = 360. The summary table starts
    // empty and fills in once each card's contract query settles and reports up (see
    // `WorkerCompareCard`'s doc comment) — wait for that before inspecting rows.
    const summaryTable = screen.getByRole('table', { name: 'Worker comparison summary, sorted by cost descending' });
    await within(summaryTable).findByText('₪1,040');
    const [summaryFirstRow, summarySecondRow] = within(summaryTable).getAllByRole('row').slice(1); // drop header row
    if (!summaryFirstRow || !summarySecondRow) throw new Error('expected two summary rows');
    expect(within(summaryFirstRow).getByText('Dana Levi')).toBeInTheDocument();
    expect(within(summaryFirstRow).getByText('₪1,040')).toBeInTheDocument();
    expect(within(summarySecondRow).getByText('Omer Cohen')).toBeInTheDocument();
    expect(within(summarySecondRow).getByText('₪360')).toBeInTheDocument();

    // Per-worker cards: name (as a link back to the single-worker detail page), role badge,
    // company, and their own stat tiles, matching the combined table's numbers exactly.
    const danaHeading = await screen.findByRole('heading', { name: 'Dana Levi' });
    const danaCard = danaHeading.closest<HTMLElement>('.card');
    if (!danaCard) throw new Error('expected a .card ancestor for Dana Levi');
    expect(within(danaCard).getByRole('link', { name: 'Dana Levi' })).toHaveAttribute(
      'href',
      '/cost/2026-08/worker/1',
    );
    expect(within(danaCard).getByText('Supervisor')).toBeInTheDocument();
    expect(within(danaCard).getByText('Shamir Security Ltd')).toBeInTheDocument();
    const danaCostTile = within(danaCard).getByText('Cost', { selector: '.stat-tile__label' }).closest<HTMLElement>('.stat-tile');
    expect(danaCostTile ? within(danaCostTile).getByText('₪1,040') : null).toBeInTheDocument();

    const omerHeading = await screen.findByRole('heading', { name: 'Omer Cohen' });
    const omerCard = omerHeading.closest<HTMLElement>('.card');
    if (!omerCard) throw new Error('expected a .card ancestor for Omer Cohen');
    const omerCostTile = within(omerCard).getByText('Cost', { selector: '.stat-tile__label' }).closest<HTMLElement>('.stat-tile');
    expect(omerCostTile ? within(omerCostTile).getByText('₪360') : null).toBeInTheDocument();
  });

  it('skips a worker id that does not resolve to a real worker, with a visible "not found" note, rather than crashing', async () => {
    installBaseRoutes();

    renderWithProviders(<WorkerCostComparePage />, {
      initialEntries: ['/cost/2026-08/compare?workers=1,999,2'],
      path: '/cost/:month/compare',
    });

    expect(await screen.findByRole('heading', { name: /Compare Workers/ })).toBeInTheDocument();
    expect(await screen.findByText(/Worker #999 not found/)).toBeInTheDocument();

    // Both real workers still render normally.
    expect(await screen.findByRole('heading', { name: 'Dana Levi' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Omer Cohen' })).toBeInTheDocument();
  });

  it('shows a clear message (not a broken/empty comparison) when fewer than 2 worker ids are in the URL', async () => {
    installBaseRoutes();

    renderWithProviders(<WorkerCostComparePage />, {
      initialEntries: ['/cost/2026-08/compare?workers=1'],
      path: '/cost/:month/compare',
    });

    expect(await screen.findByText('Select at least 2 workers to compare')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Compare Workers/ })).not.toBeInTheDocument();
  });

  it('shows the same clear message when the workers param is entirely missing', async () => {
    installBaseRoutes();

    renderWithProviders(<WorkerCostComparePage />, {
      initialEntries: ['/cost/2026-08/compare'],
      path: '/cost/:month/compare',
    });

    expect(await screen.findByText('Select at least 2 workers to compare')).toBeInTheDocument();
  });

  it('shows a "not enough workers" message when 2+ ids are given but fewer than 2 resolve to real workers', async () => {
    installBaseRoutes();

    renderWithProviders(<WorkerCostComparePage />, {
      initialEntries: ['/cost/2026-08/compare?workers=1,888,999'],
      path: '/cost/:month/compare',
    });

    expect(await screen.findByText(/Worker #888 not found/)).toBeInTheDocument();
    expect(screen.getByText(/Worker #999 not found/)).toBeInTheDocument();
    expect(await screen.findByText('Not enough workers to compare')).toBeInTheDocument();
  });

  it('the back link returns to the Cost Dashboard for the current month', async () => {
    installBaseRoutes();

    renderWithProviders(<WorkerCostComparePage />, {
      initialEntries: ['/cost/2026-08/compare?workers=1,2'],
      path: '/cost/:month/compare',
    });

    const backLink = await screen.findByRole('link', { name: /back to cost dashboard/i });
    expect(backLink).toHaveAttribute('href', '/cost/2026-08');
  });

  it('shows a "no cost data" empty state when the roster has not been generated for the month', async () => {
    const user = userEvent.setup();
    installBaseRoutes({ rosterStatus: 404 });

    renderWithProviders(<WorkerCostComparePage />, {
      initialEntries: ['/cost/2026-08/compare?workers=1,2'],
      path: '/cost/:month/compare',
    });

    expect(await screen.findByText('No cost data for August 2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go to Roster' }));
  });
});
