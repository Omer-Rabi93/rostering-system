import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../testUtils/mockFetch.js';
import { renderWithProviders } from '../../testUtils/renderWithProviders.js';
import { AvailabilityGrid } from './AvailabilityGrid.js';

function makeWorker(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    nationalId: '123456782',
    name: 'Dana Levi',
    role: 'GENERAL_GUARD',
    status: 'ACTIVE',
    companyId: 1,
    shareToken: 'tok-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    contract: {
      workerId: 1,
      hourlyCostIls: 50,
      minMonthlyHours: 100,
      maxMonthlyHours: 186,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

const WORKERS_ROUTE = (workers: unknown[]) => ({
  method: 'GET' as const,
  match: /^\/api\/workers/,
  respond: () => ({ status: 200, body: workers }),
});

function availabilityRoute(month: string, body: unknown) {
  return { method: 'GET' as const, match: `/api/availability/${month}`, respond: () => ({ status: 200, body }) };
}

describe('AvailabilityGrid', () => {
  it.each([
    ['2026-02', 28],
    ['2028-02', 29], // leap year
    ['2026-04', 30],
    ['2026-08', 31],
  ])('renders exactly %s date columns for %s', async (month, dayCount) => {
    installMockFetch([WORKERS_ROUTE([makeWorker()]), availabilityRoute(month, {})]);

    renderWithProviders(<AvailabilityGrid month={month} companyId={1} />);

    const table = await screen.findByRole('table');
    // +1 for the leading "Worker" header column.
    expect(within(table).getAllByRole('columnheader')).toHaveLength(dayCount + 1);
    expect(within(table).getAllByRole('gridcell')).toHaveLength(dayCount);
  });

  it('renders a worker with zero rows in the month as all-unavailable, without crashing', async () => {
    installMockFetch([WORKERS_ROUTE([makeWorker()]), availabilityRoute('2026-08', {})]);

    renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);

    const cell = await screen.findByTestId('avail-cell-1-2026-08-01');
    expect(cell.getAttribute('aria-label')).toContain('unavailable');
  });

  it('has exactly one roving tab stop, and arrow keys move it between cells', async () => {
    const user = userEvent.setup();
    installMockFetch([
      WORKERS_ROUTE([makeWorker(), makeWorker({ id: 2, name: 'Omer Cohen', nationalId: '111223344' })]),
      availabilityRoute('2026-08', {}),
    ]);

    renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);
    await screen.findByRole('table');

    const cells = screen.getAllByRole('gridcell');
    expect(cells.filter((c) => c.tabIndex === 0)).toHaveLength(1);
    expect(cells.filter((c) => c.tabIndex === -1)).toHaveLength(cells.length - 1);

    const first = screen.getByTestId('avail-cell-1-2026-08-01');
    first.focus();
    await user.keyboard('{ArrowRight}');

    const second = screen.getByTestId('avail-cell-1-2026-08-02');
    expect(document.activeElement).toBe(second);
    expect(second.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);
  });

  it('pressing A/B/C on a focused cell toggles that shift and updates its aria-label, without any mouse interaction', async () => {
    const user = userEvent.setup();
    installMockFetch([WORKERS_ROUTE([makeWorker()]), availabilityRoute('2026-08', {})]);

    renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);
    const cell = await screen.findByTestId('avail-cell-1-2026-08-03');
    expect(cell.getAttribute('aria-label')).toContain('unavailable');

    cell.focus();
    await user.keyboard('a');
    expect(cell.getAttribute('aria-label')).toContain('available shift A');

    await user.keyboard('c');
    expect(cell.getAttribute('aria-label')).toContain('available shift A, C');

    // Toggling the same letter again removes it.
    await user.keyboard('a');
    expect(cell.getAttribute('aria-label')).toContain('available shift C');
    expect(cell.getAttribute('aria-label')).not.toContain('A, C');
  });

  it('Save sends a PUT with only the toggled-on cell present — an untouched/cleared cell is never sent as an empty entry', async () => {
    const user = userEvent.setup();
    const { fetchMock, calls } = installMockFetch([
      WORKERS_ROUTE([makeWorker()]),
      availabilityRoute('2026-08', {}),
      { method: 'PUT', match: '/api/availability/2026-08', respond: () => ({ status: 200, body: { month: '2026-08' } }) },
    ]);

    renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);
    const cell = await screen.findByTestId('avail-cell-1-2026-08-03');
    cell.focus();
    await user.keyboard('b');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByText(/Availability saved/)).toBeInTheDocument());

    const putIndex = calls.findIndex((c) => c.method === 'PUT' && c.path === '/api/availability/2026-08?companyId=1');
    expect(putIndex).toBeGreaterThanOrEqual(0);
    const putRequest = fetchMock.mock.calls[putIndex]?.[0] as { body?: string };
    const payload = JSON.parse(String(putRequest.body)) as unknown;
    expect(payload).toEqual({ '1': { '2026-08-03': ['B'] } });
  });

  it('scopes both read queries (worker list and availability GET) to the active company — the topbar company switcher bug fix', async () => {
    const { calls } = installMockFetch([WORKERS_ROUTE([makeWorker()]), availabilityRoute('2026-08', {})]);

    renderWithProviders(<AvailabilityGrid month="2026-08" companyId={7} />);
    await screen.findByRole('table');

    const workersCall = calls.find((c) => c.method === 'GET' && c.path.startsWith('/api/workers'));
    expect(workersCall?.path).toContain('companyId=7');

    const availabilityCall = calls.find((c) => c.method === 'GET' && c.path.startsWith('/api/availability/2026-08'));
    expect(availabilityCall?.path).toBe('/api/availability/2026-08?companyId=7');
  });

  it('a different active company sees only that company\'s workers and availability, never the other company\'s cached data', async () => {
    const companyAWorker = makeWorker({ id: 1, name: 'Dana Levi (Company A)' });
    const companyBWorker = makeWorker({ id: 2, name: 'Omer Cohen (Company B)', companyId: 2 });

    installMockFetch([
      {
        method: 'GET',
        match: /^\/api\/workers/,
        respond: (url) => ({
          status: 200,
          body: url.searchParams.get('companyId') === '2' ? [companyBWorker] : [companyAWorker],
        }),
      },
      {
        method: 'GET',
        match: /^\/api\/availability\/2026-08/,
        respond: (url) => ({
          status: 200,
          body:
            url.searchParams.get('companyId') === '2'
              ? { '2': { '2026-08-02': ['B'] } }
              : { '1': { '2026-08-01': ['A'] } },
        }),
      },
    ]);

    // Two separate mounts (each gets its own fresh store/cache via `renderWithProviders`) rather
    // than RTL's `rerender` — `rerender` re-renders at the root, which would strip the
    // Redux `Provider`/`MemoryRouter` `renderWithProviders` wraps `AvailabilityGrid` in.
    const companyA = renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);
    expect(await screen.findByText('Dana Levi (Company A)')).toBeInTheDocument();
    expect(screen.queryByText('Omer Cohen (Company B)')).not.toBeInTheDocument();
    const cellA = await screen.findByTestId('avail-cell-1-2026-08-01');
    expect(cellA.getAttribute('aria-label')).toContain('available shift A');
    companyA.unmount();

    renderWithProviders(<AvailabilityGrid month="2026-08" companyId={2} />);
    expect(await screen.findByText('Omer Cohen (Company B)')).toBeInTheDocument();
    expect(screen.queryByText('Dana Levi (Company A)')).not.toBeInTheDocument();
    const cellB = await screen.findByTestId('avail-cell-2-2026-08-02');
    expect(cellB.getAttribute('aria-label')).toContain('available shift B');
  });

  it('starts from the server-loaded availability, and "None" clears a worker entirely', async () => {
    const user = userEvent.setup();
    const { fetchMock, calls } = installMockFetch([
      WORKERS_ROUTE([makeWorker()]),
      availabilityRoute('2026-08', { '1': { '2026-08-01': ['A', 'B'] } }),
      { method: 'PUT', match: '/api/availability/2026-08', respond: () => ({ status: 200, body: { month: '2026-08' } }) },
    ]);

    renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);
    const cell = await screen.findByTestId('avail-cell-1-2026-08-01');
    expect(cell.getAttribute('aria-label')).toContain('available shift A, B');

    await user.click(screen.getByRole('button', { name: 'None' }));
    expect(cell.getAttribute('aria-label')).toContain('unavailable');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText(/Availability saved/)).toBeInTheDocument());

    const putIndex = calls.findIndex((c) => c.method === 'PUT' && c.path === '/api/availability/2026-08?companyId=1');
    const putRequest = fetchMock.mock.calls[putIndex]?.[0] as { body?: string };
    expect(JSON.parse(String(putRequest.body))).toEqual({});
  });

  it('surfaces the server-provided 400 detail instead of a generic message', async () => {
    const user = userEvent.setup();
    installMockFetch([
      WORKERS_ROUTE([makeWorker()]),
      availabilityRoute('2026-08', {}),
      {
        method: 'PUT',
        match: '/api/availability/2026-08',
        respond: () => ({ status: 400, body: { errors: [{ path: 'entries', message: 'Bad payload' }] } }),
      },
    ]);

    renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/entries: Bad payload/)).toBeInTheDocument();
  });

  it('falls back to a generic message for a non-badRequest save failure', async () => {
    const user = userEvent.setup();
    installMockFetch([
      WORKERS_ROUTE([makeWorker()]),
      availabilityRoute('2026-08', {}),
      { method: 'PUT', match: '/api/availability/2026-08', respond: () => ({ status: 500, body: { message: 'boom' } }) },
    ]);

    renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/Could not save availability/)).toBeInTheDocument();
  });
});
