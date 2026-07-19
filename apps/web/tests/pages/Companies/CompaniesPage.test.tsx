import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../../src/testUtils/mockFetch.js';
import { renderWithProviders } from '../../../src/testUtils/renderWithProviders.js';
import { CompaniesPage } from '../../../src/pages/Companies/CompaniesPage.js';

const COMPANY_1 = { id: 1, name: 'Shamir Security Ltd', createdAt: '2026-01-01T00:00:00.000Z' };
const COMPANY_2 = { id: 2, name: 'Harel Protective Services', createdAt: '2026-01-02T00:00:00.000Z' };

function worker(id: number, companyId: number) {
  return {
    id,
    nationalId: '123456782',
    name: `Worker ${id}`,
    role: 'GENERAL_GUARD',
    status: 'ACTIVE',
    companyId,
    shareToken: `tok-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    contract: null,
  };
}

describe('CompaniesPage', () => {
  it('opens the edit form (with its staffing-requirements matrix) by clicking the company name directly, not just an action button', async () => {
    const user = userEvent.setup();
    installMockFetch([
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [COMPANY_1, COMPANY_2] }) },
      { method: 'GET', match: '/api/workers', respond: () => ({ status: 200, body: [] }) },
      { method: 'GET', match: '/api/staffing-requirements', respond: () => ({ status: 200, body: [] }) },
    ]);
    renderWithProviders(<CompaniesPage />, { preloadedState: { activeCompany: { activeCompanyId: null } } });

    await screen.findByText('Shamir Security Ltd');
    await user.click(screen.getByRole('button', { name: 'Shamir Security Ltd' }));

    const dialog = await screen.findByRole('dialog', { name: 'Rename company' });
    expect(within(dialog).getByText('Staffing requirements')).toBeInTheDocument();
  });

  it('lists companies with a derived worker count, and creates a new one (setting it as the active company)', async () => {
    const user = userEvent.setup();
    installMockFetch([
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [COMPANY_1, COMPANY_2] }) },
      { method: 'GET', match: '/api/workers', respond: () => ({ status: 200, body: [worker(1, 1), worker(2, 1)] }) },
      {
        method: 'POST',
        match: '/api/companies',
        respond: () => ({ status: 201, body: { id: 3, name: 'New Co', createdAt: '2026-01-03T00:00:00.000Z' } }),
      },
      { method: 'PUT', match: '/api/staffing-requirements', respond: () => ({ status: 200, body: [] }) },
    ]);
    const { store } = renderWithProviders(<CompaniesPage />, {
      preloadedState: { activeCompany: { activeCompanyId: null } },
    });

    expect(await screen.findByText('Shamir Security Ltd')).toBeInTheDocument();
    const row1 = screen.getByText('Shamir Security Ltd').closest('tr');
    expect(row1 ? within(row1).getByText('2') : null).toBeInTheDocument();
    const row2 = screen.getByText('Harel Protective Services').closest('tr');
    expect(row2 ? within(row2).getByText('0') : null).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '+ New company' }));
    const dialog = await screen.findByRole('dialog', { name: 'New company' });
    await user.type(within(dialog).getByLabelText('Name', { exact: false }), 'New Co');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('"New Co" created. Staffing requirements saved.')).toBeInTheDocument();
    // Creating a company from any entry point sets it active -- if you just created it you almost
    // certainly want to work in it next.
    expect(store.getState().activeCompany.activeCompanyId).toBe(3);
  });

  it('shows an inline duplicate-name error (409) on create without closing the modal', async () => {
    const user = userEvent.setup();
    installMockFetch([
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [COMPANY_1] }) },
      { method: 'GET', match: '/api/workers', respond: () => ({ status: 200, body: [] }) },
      {
        method: 'POST',
        match: '/api/companies',
        respond: () => ({ status: 409, body: { message: 'Company name "Shamir Security Ltd" already exists' } }),
      },
    ]);

    renderWithProviders(<CompaniesPage />);
    await screen.findByText('Shamir Security Ltd');

    await user.click(screen.getByRole('button', { name: '+ New company' }));
    const dialog = await screen.findByRole('dialog', { name: 'New company' });
    await user.type(within(dialog).getByLabelText('Name', { exact: false }), 'Shamir Security Ltd');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(
      await within(dialog).findByText('A company with this name already exists (names are case-insensitive).'),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Name', { exact: false })).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the delete-blocked notice (informational, single OK) for a company with workers', async () => {
    const user = userEvent.setup();
    installMockFetch([
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [COMPANY_1] }) },
      { method: 'GET', match: '/api/workers', respond: () => ({ status: 200, body: [worker(1, 1)] }) },
    ]);

    renderWithProviders(<CompaniesPage />);
    await screen.findByText('Shamir Security Ltd');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog', { name: "Can't delete this company" });
    expect(within(dialog).getByText(/still has 1 worker\(s\) assigned/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('deleting the active company clears it (the gate reappears on next render)', async () => {
    const user = userEvent.setup();
    installMockFetch([
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [COMPANY_1, COMPANY_2] }) },
      { method: 'GET', match: '/api/workers', respond: () => ({ status: 200, body: [] }) },
      { method: 'DELETE', match: '/api/companies/1', respond: () => ({ status: 204 }) },
    ]);
    const { store } = renderWithProviders(<CompaniesPage />, {
      preloadedState: { activeCompany: { activeCompanyId: 1 } },
    });

    await screen.findByText('Shamir Security Ltd');
    const row1 = screen.getByText('Shamir Security Ltd').closest('tr');
    await user.click(within(row1 as HTMLElement).getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete "Shamir Security Ltd"?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(store.getState().activeCompany.activeCompanyId).toBeNull();
  });
});
