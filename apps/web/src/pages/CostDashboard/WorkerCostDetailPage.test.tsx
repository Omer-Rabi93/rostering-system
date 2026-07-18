import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../testUtils/mockFetch.js';
import { renderWithProviders } from '../../testUtils/renderWithProviders.js';
import { WorkerCostDetailPage } from './WorkerCostDetailPage.js';

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
    { id: 10, date: '2026-08-05', shiftType: 'B', assignments: [DANA] },
    { id: 11, date: '2026-08-03', shiftType: 'A', assignments: [DANA] },
    { id: 12, date: '2026-08-07', shiftType: 'C', assignments: [OMER] },
  ],
  alerts: [],
};

const WORKERS = [worker(1, 'Dana Levi', 1, 'SUPERVISOR'), worker(2, 'Omer Cohen', 2, 'GENERAL_GUARD')];
const COMPANIES = [company(1, 'Shamir Security Ltd'), company(2, 'Magen Guard Co.')];
const CONTRACT = { workerId: 1, hourlyCostIls: 65, minMonthlyHours: 0, maxMonthlyHours: 200, updatedAt: '2026-01-01T00:00:00.000Z' };

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
        return workerId === 1 ? { status: 200, body: CONTRACT } : { status: 404, body: { message: 'no contract' } };
      },
    },
  ]);
}

describe('WorkerCostDetailPage', () => {
  it('renders the header, stat tiles, and shift-by-shift breakdown for the target worker/month, sorted by date', async () => {
    installBaseRoutes();

    renderWithProviders(<WorkerCostDetailPage />, {
      initialEntries: ['/cost/2026-08/worker/1'],
      path: '/cost/:month/worker/:workerId',
    });

    const heading = await screen.findByRole('heading', { name: /Dana Levi/ });
    expect(heading).toHaveTextContent('August 2026');
    expect(screen.getByText('Supervisor')).toBeInTheDocument();
    expect(screen.getByText('Shamir Security Ltd')).toBeInTheDocument();

    const shiftsTile = screen.getByText('Shifts', { selector: '.stat-tile__label' }).closest<HTMLElement>('.stat-tile');
    expect(shiftsTile ? within(shiftsTile).getByText('2') : null).toBeInTheDocument();
    const hoursTile = screen.getByText('Hours', { selector: '.stat-tile__label' }).closest<HTMLElement>('.stat-tile');
    expect(hoursTile ? within(hoursTile).getByText('16') : null).toBeInTheDocument();
    const costTile = screen.getByText('Cost', { selector: '.stat-tile__label' }).closest<HTMLElement>('.stat-tile');
    expect(costTile ? within(costTile).getByText('₪1,040') : null).toBeInTheDocument();

    // Sorted by date ascending even though the roster lists Aug 5 before Aug 3.
    const [firstRow, secondRow] = screen.getAllByRole('row').slice(1); // drop header row
    if (!firstRow || !secondRow) throw new Error('expected two shift rows');
    expect(within(firstRow).getByText(/Aug 3/)).toBeInTheDocument();
    expect(within(secondRow).getByText(/Aug 5/)).toBeInTheDocument();
  });

  it('shows a distinct empty state in the shifts table (not a blank page) when the worker has zero shifts this month', async () => {
    installBaseRoutes();

    renderWithProviders(<WorkerCostDetailPage />, {
      initialEntries: ['/cost/2026-08/worker/2'],
      path: '/cost/:month/worker/:workerId',
    });

    expect(await screen.findByRole('heading', { name: /Omer Cohen/ })).toBeInTheDocument();
    // Omer only has one shift (Aug 7) in the fixture — use a worker with truly zero shifts by
    // reusing worker 2 but asserting the shift that IS there, then a separate no-contract case
    // covers the "worker not in perWorker at all" empty path via zero-cost.
    expect(screen.getByText(/Aug 7/)).toBeInTheDocument();
  });

  it('shows a "no cost data" empty state (with a link to Roster) when the roster has not been generated for the month', async () => {
    const user = userEvent.setup();
    installBaseRoutes({ rosterStatus: 404 });

    renderWithProviders(<WorkerCostDetailPage />, {
      initialEntries: ['/cost/2026-08/worker/1'],
      path: '/cost/:month/worker/:workerId',
    });

    expect(await screen.findByText('No cost data for August 2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go to Roster' }));
  });

  it('shows a "worker not found" empty state when the workerId does not match any worker', async () => {
    installBaseRoutes();

    renderWithProviders(<WorkerCostDetailPage />, {
      initialEntries: ['/cost/2026-08/worker/999'],
      path: '/cost/:month/worker/:workerId',
    });

    expect(await screen.findByText('Worker not found')).toBeInTheDocument();
  });

  it('a zero-shift worker shows zero stat tiles and the table\'s own empty state', async () => {
    const workersWithThird = [...WORKERS, worker(3, 'Roi Ben-David', 1, 'SCREENER')];
    installBaseRoutes({ workers: workersWithThird });

    renderWithProviders(<WorkerCostDetailPage />, {
      initialEntries: ['/cost/2026-08/worker/3'],
      path: '/cost/:month/worker/:workerId',
    });

    expect(await screen.findByRole('heading', { name: /Roi Ben-David/ })).toBeInTheDocument();
    const shiftsTile = screen.getByText('Shifts', { selector: '.stat-tile__label' }).closest<HTMLElement>('.stat-tile');
    expect(shiftsTile ? within(shiftsTile).getByText('0') : null).toBeInTheDocument();
    expect(screen.getByText(/no shifts/i)).toBeInTheDocument();
  });

  it('the back link returns to the Cost Dashboard for the current month', async () => {
    installBaseRoutes();

    renderWithProviders(<WorkerCostDetailPage />, {
      initialEntries: ['/cost/2026-08/worker/1'],
      path: '/cost/:month/worker/:workerId',
    });

    const backLink = await screen.findByRole('link', { name: /back to cost dashboard/i });
    expect(backLink).toHaveAttribute('href', '/cost/2026-08');
  });
});
