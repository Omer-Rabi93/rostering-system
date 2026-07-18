import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from './routes.js';
import { createAppStore } from './store/index.js';
import { installMockFetch } from './testUtils/mockFetch.js';

const EMPTY_LISTS = [
  { method: 'GET' as const, match: '/api/workers', respond: () => ({ status: 200, body: [] }) },
  { method: 'GET' as const, match: '/api/companies', respond: () => ({ status: 200, body: [] }) },
  { method: 'GET' as const, match: '/api/staffing-requirements', respond: () => ({ status: 200, body: [] }) },
  {
    method: 'GET' as const,
    match: /^\/api\/rosters\/2026-08$/,
    respond: () => ({ status: 404, body: { message: 'not found' } }),
  },
  {
    method: 'GET' as const,
    match: '/api/rosters/2026-08/cost-summary',
    respond: () => ({ status: 404, body: { message: 'not found' } }),
  },
];

function renderAt(path: string) {
  installMockFetch(EMPTY_LISTS);
  return render(
    <Provider store={createAppStore()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </Provider>,
  );
}

describe('AppRoutes', () => {
  it('redirects / to /workers', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Workers' })).toBeInTheDocument();
  });

  it.each([
    ['/workers', 'Workers'],
    ['/companies', 'Companies'],
    ['/requirements', 'Staffing Requirements'],
    ['/cost/2026-08', 'Cost Dashboard — August 2026'],
  ])('renders %s inside the authenticated Layout shell (topbar present)', async (path, expectedHeading) => {
    renderAt(path);
    expect(screen.getByText('ICTS Rostering')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: expectedHeading })).toBeInTheDocument();
  });

  it('renders the Roster page for /roster/:month inside the authenticated Layout shell', async () => {
    renderAt('/roster/2026-08');
    expect(screen.getByText('ICTS Rostering')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Roster — August 2026' })).toBeInTheDocument();
  });

  it('renders the public schedule page for /schedule/:token WITHOUT the authenticated topbar', async () => {
    installMockFetch([
      {
        method: 'GET',
        match: /^\/api\/schedule\/some-token/,
        respond: () => ({ status: 200, body: { name: 'Dana Levi', month: '2026-08', shifts: [] } }),
      },
    ]);
    render(
      <Provider store={createAppStore()}>
        <MemoryRouter initialEntries={['/schedule/some-token']}>
          <AppRoutes />
        </MemoryRouter>
      </Provider>,
    );
    expect(screen.queryByText('ICTS Rostering')).not.toBeInTheDocument();
    expect(await screen.findByText(/read-only worker schedule/)).toBeInTheDocument();
  });

  it('renders a not-found placeholder (inside Layout) for unknown paths', async () => {
    renderAt('/nope');
    expect(screen.getByText('ICTS Rostering')).toBeInTheDocument();
    expect(await screen.findByText('Not found')).toBeInTheDocument();
  });
});
