import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../../src/testUtils/mockFetch.js';
import { renderWithProviders } from '../../../src/testUtils/renderWithProviders.js';
import { AvailabilityGrid } from '../../../src/pages/Roster/AvailabilityGrid.js';

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

  it('renders a worker with zero rows in the month as available for all shifts, without crashing', async () => {
    installMockFetch([WORKERS_ROUTE([makeWorker()]), availabilityRoute('2026-08', {})]);

    renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);

    const cell = await screen.findByTestId('avail-cell-1-2026-08-01');
    expect(cell.getAttribute('aria-label')).toContain('available for all shifts');
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
    expect(cell.getAttribute('aria-label')).toContain('available for all shifts');

    cell.focus();
    await user.keyboard('a');
    expect(cell.getAttribute('aria-label')).toContain('unavailable for shift A');

    await user.keyboard('c');
    expect(cell.getAttribute('aria-label')).toContain('unavailable for shift A, C');

    // Toggling the same letter again removes it.
    await user.keyboard('a');
    expect(cell.getAttribute('aria-label')).toContain('unavailable for shift C');
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
    // v3 exclusion semantics: a row of ['A'] now means "excluded from A" (unavailable for A),
    // not "available for A" -- the mock payload shape is unchanged, only its meaning inverted.
    expect(cellA.getAttribute('aria-label')).toContain('unavailable for shift A');
    companyA.unmount();

    renderWithProviders(<AvailabilityGrid month="2026-08" companyId={2} />);
    expect(await screen.findByText('Omer Cohen (Company B)')).toBeInTheDocument();
    expect(screen.queryByText('Dana Levi (Company A)')).not.toBeInTheDocument();
    const cellB = await screen.findByTestId('avail-cell-2-2026-08-02');
    expect(cellB.getAttribute('aria-label')).toContain('unavailable for shift B');
  });

  it('starts from the server-loaded availability, and "All" clears a worker\'s exclusions entirely (fully available)', async () => {
    const user = userEvent.setup();
    const { fetchMock, calls } = installMockFetch([
      WORKERS_ROUTE([makeWorker()]),
      availabilityRoute('2026-08', { '1': { '2026-08-01': ['A', 'B'] } }),
      { method: 'PUT', match: '/api/availability/2026-08', respond: () => ({ status: 200, body: { month: '2026-08' } }) },
    ]);

    renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);
    const cell = await screen.findByTestId('avail-cell-1-2026-08-01');
    expect(cell.getAttribute('aria-label')).toContain('unavailable for shift A, B');

    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(cell.getAttribute('aria-label')).toContain('available for all shifts');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText(/Availability saved/)).toBeInTheDocument());

    const putIndex = calls.findIndex((c) => c.method === 'PUT' && c.path === '/api/availability/2026-08?companyId=1');
    const putRequest = fetchMock.mock.calls[putIndex]?.[0] as { body?: string };
    expect(JSON.parse(String(putRequest.body))).toEqual({});
  });

  it('"None" marks a worker excluded from every shift, every date this month (fully blocked)', async () => {
    const user = userEvent.setup();
    const { fetchMock, calls } = installMockFetch([
      WORKERS_ROUTE([makeWorker()]),
      availabilityRoute('2026-08', {}),
      { method: 'PUT', match: '/api/availability/2026-08', respond: () => ({ status: 200, body: { month: '2026-08' } }) },
    ]);

    renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);
    const cell = await screen.findByTestId('avail-cell-1-2026-08-01');
    expect(cell.getAttribute('aria-label')).toContain('available for all shifts');

    await user.click(screen.getByRole('button', { name: 'None' }));
    expect(cell.getAttribute('aria-label')).toContain('unavailable');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText(/Availability saved/)).toBeInTheDocument());

    const putIndex = calls.findIndex((c) => c.method === 'PUT' && c.path === '/api/availability/2026-08?companyId=1');
    const putRequest = fetchMock.mock.calls[putIndex]?.[0] as { body?: string };
    const payload = JSON.parse(String(putRequest.body)) as Record<string, Record<string, string[]>>;
    // Every date in the rendered month is set to the full 3-letter excluded subset.
    expect(Object.keys(payload['1'] ?? {}).length).toBeGreaterThan(25);
    expect(payload['1']?.['2026-08-01']).toEqual(['A', 'B', 'C']);
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

  describe('row virtualization (large worker lists)', () => {
    // The backend now allows up to 1,000-10,000 workers/company; well past a few hundred, mounting
    // one <tr> per worker (the pre-virtualization behavior) would make every interaction on this
    // page sluggish. 2,000 is comfortably inside that range and large enough that "renders every
    // row" vs. "renders a small window" are trivially distinguishable by mounted node count.
    const WORKER_COUNT = 2000;

    function makeManyWorkers() {
      return Array.from({ length: WORKER_COUNT }, (_, i) => makeWorker({ id: i + 1, name: `Worker ${i + 1}` }));
    }

    it('mounts only a small, bounded number of worker rows regardless of total worker count', async () => {
      installMockFetch([WORKERS_ROUTE(makeManyWorkers()), availabilityRoute('2026-08', {})]);

      renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);
      const table = await screen.findByRole('table');

      // Every *rendered* data row carries `data-index` (see AvailabilityGrid.tsx's virtualized
      // `<tbody>`); the two spacer `<tr>`s that stand in for the un-rendered rows above/below do
      // not, so this only counts real, interactive worker rows.
      const renderedRows = within(table).getAllByRole('row').filter((row) => row.hasAttribute('data-index'));
      expect(renderedRows.length).toBeGreaterThan(0);
      // Generous bound: comfortably covers the visible window + overscan on both sides, but is
      // nowhere near WORKER_COUNT — the actual proof that windowing, not "render everything", is
      // happening.
      expect(renderedRows.length).toBeLessThan(50);

      // The DOM-level proof mirrors the row proof: with a fixed 31-day month, an unvirtualized grid
      // of WORKER_COUNT workers would mount WORKER_COUNT * 31 gridcells; a windowed one mounts a
      // small, count-independent number.
      const gridcells = within(table).getAllByRole('gridcell');
      expect(gridcells.length).toBeLessThan(50 * 31);
    });

    it('keyboard nav (repeated ArrowDown) scrolls a not-yet-rendered row into view and lands real DOM focus on it, every time, past the initial window', async () => {
      // 60 sequential real keypresses (each triggering a scroll-then-focus round trip) is
      // comfortably under 5s in isolation, but can exceed vitest's default per-test timeout when
      // this suite runs alongside every other package's tests under load (`turbo run ... test`) --
      // an explicit, generous timeout avoids that flaking without changing what's being asserted.
      const user = userEvent.setup();
      installMockFetch([WORKERS_ROUTE(makeManyWorkers()), availabilityRoute('2026-08', {})]);

      renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);
      const table = await screen.findByRole('table');

      const initialRenderedRows = within(table).getAllByRole('row').filter((row) => row.hasAttribute('data-index'));
      // Sanity check on the premise: the initial window must be small enough that 60 ArrowDown
      // presses genuinely walks focus past it (otherwise this test wouldn't be exercising the
      // scroll-then-focus path at all).
      expect(initialRenderedRows.length).toBeLessThan(60);

      const first = screen.getByTestId('avail-cell-1-2026-08-01');
      first.focus();
      expect(document.activeElement).toBe(first);

      const PRESSES = 60;
      for (let i = 0; i < PRESSES; i++) {
        await user.keyboard('{ArrowDown}');
      }

      // Row PRESSES (0-indexed workers, so worker id PRESSES+1) is now the focused cell — the same
      // column (first day of the month) the whole way down, since ArrowDown never changes column.
      const target = screen.getByTestId(`avail-cell-${PRESSES + 1}-2026-08-01`);
      expect(document.activeElement).toBe(target);
      expect(target.tabIndex).toBe(0);

      // Exactly one roving tab stop still holds after walking focus across the virtualization
      // boundary many times — the invariant `useRovingTabindex`/CalendarGrid also rely on.
      const allCells = within(table).getAllByRole('gridcell');
      expect(allCells.filter((c) => c.tabIndex === 0)).toHaveLength(1);

      // The mounted-row-count bound still holds after scrolling deep into a 2,000-row list — the
      // window moved, but it never grew unbounded.
      const renderedRowsAfter = within(table).getAllByRole('row').filter((row) => row.hasAttribute('data-index'));
      expect(renderedRowsAfter.length).toBeLessThan(50);
    }, 20_000);

    it('ArrowUp back toward the top after a long ArrowDown walk also re-scrolls and refocuses correctly', async () => {
      // See the previous test's comment: 155 sequential keypresses need a longer-than-default
      // timeout to avoid flaking under concurrent system load.
      const user = userEvent.setup();
      installMockFetch([WORKERS_ROUTE(makeManyWorkers()), availabilityRoute('2026-08', {})]);

      renderWithProviders(<AvailabilityGrid month="2026-08" companyId={1} />);
      await screen.findByRole('table');

      const first = screen.getByTestId('avail-cell-1-2026-08-01');
      first.focus();

      for (let i = 0; i < 80; i++) {
        await user.keyboard('{ArrowDown}');
      }
      for (let i = 0; i < 75; i++) {
        await user.keyboard('{ArrowUp}');
      }

      // Net: 80 down, 75 up = row 5 (worker id 6).
      const target = screen.getByTestId('avail-cell-6-2026-08-01');
      expect(document.activeElement).toBe(target);
      expect(target.tabIndex).toBe(0);
    }, 20_000);
  });
});
