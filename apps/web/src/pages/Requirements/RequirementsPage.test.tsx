import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../testUtils/mockFetch.js';
import { renderWithProviders } from '../../testUtils/renderWithProviders.js';
import { RequirementsPage } from './RequirementsPage.js';

const INITIAL_ROWS = [
  { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 2 },
  { role: 'SUPERVISOR', shift: 'A', requiredCount: 1 },
];

// Company-scoped rostering: `RequirementsPage` fetches the company list to default `companyId`
// before it can fetch/save a staffing-requirements matrix — every test needs this route mocked.
const COMPANIES_ROUTE = {
  method: 'GET' as const,
  match: '/api/companies',
  respond: () => ({ status: 200, body: [{ id: 1, name: 'Alpha Security Ltd.', createdAt: '2026-01-01T00:00:00.000Z' }] }),
};

describe('RequirementsPage', () => {
  it('loads the matrix (defaulting missing cells to 0) and saves a full-replace PUT', async () => {
    const user = userEvent.setup();
    const { calls } = installMockFetch([
      COMPANIES_ROUTE,
      { method: 'GET', match: '/api/staffing-requirements', respond: () => ({ status: 200, body: INITIAL_ROWS }) },
      {
        method: 'PUT',
        match: '/api/staffing-requirements',
        respond: () => ({ status: 200, body: INITIAL_ROWS }),
      },
    ]);

    renderWithProviders(<RequirementsPage />);

    const guardShiftA = await screen.findByLabelText('General Guard required, Shift A');
    expect(guardShiftA).toHaveValue(2);
    const screenerShiftC = screen.getByLabelText('Screener required, Shift C');
    expect(screenerShiftC).toHaveValue(0);

    await user.clear(screenerShiftC);
    await user.type(screenerShiftC, '3');

    await user.click(screen.getByRole('button', { name: 'Save requirements' }));

    await screen.findByText('Requirements saved.');
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/staffing-requirements?companyId=1')).toBe(true);
  });

  it('blocks save and shows an inline per-cell error for a negative headcount (client-side)', async () => {
    const user = userEvent.setup();
    installMockFetch([
      COMPANIES_ROUTE,
      { method: 'GET', match: '/api/staffing-requirements', respond: () => ({ status: 200, body: [] }) },
    ]);

    renderWithProviders(<RequirementsPage />);
    const guardShiftA = await screen.findByLabelText('General Guard required, Shift A');

    await user.clear(guardShiftA);
    await user.type(guardShiftA, '-1');
    await user.click(screen.getByRole('button', { name: 'Save requirements' }));

    expect(guardShiftA).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Headcount can't be negative/)).toBeInTheDocument();
  });

  it('maps a server 400 (e.g. duplicate-cell) response back onto the general error region', async () => {
    const user = userEvent.setup();
    installMockFetch([
      COMPANIES_ROUTE,
      { method: 'GET', match: '/api/staffing-requirements', respond: () => ({ status: 200, body: [] }) },
      {
        method: 'PUT',
        match: '/api/staffing-requirements',
        respond: () => ({ status: 400, body: { errors: [{ path: '', message: 'Duplicate role+shift cell' }] } }),
      },
    ]);

    renderWithProviders(<RequirementsPage />);
    await screen.findByLabelText('General Guard required, Shift A');

    await user.click(screen.getByRole('button', { name: 'Save requirements' }));

    expect(await screen.findByText('Duplicate role+shift cell')).toBeInTheDocument();
  });
});
