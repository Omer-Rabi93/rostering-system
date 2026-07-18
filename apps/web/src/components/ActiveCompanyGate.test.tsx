import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { useActiveCompanyId } from '../hooks/useActiveCompanyId.js';
import { installMockFetch } from '../testUtils/mockFetch.js';
import { renderWithProviders } from '../testUtils/renderWithProviders.js';
import { ActiveCompanyGate } from './ActiveCompanyGate.js';

const COMPANY_1 = { id: 1, name: 'Shamir Security Ltd', createdAt: '2026-01-01T00:00:00.000Z' };
const COMPANY_2 = { id: 2, name: 'Harel Protective Services', createdAt: '2026-01-02T00:00:00.000Z' };

/** Marker child that reads the guaranteed non-null id off the context the gate is responsible for
 * providing — proves the gate actually passed through to `children`, not just that some content
 * rendered (which the gate's own screens also render). */
function Probe() {
  const companyId = useActiveCompanyId();
  return <div data-testid="probe">active: {companyId}</div>;
}

describe('ActiveCompanyGate', () => {
  it('renders a non-dismissable create-only screen when zero companies exist, and activates the newly created one', async () => {
    const user = userEvent.setup();
    // `createCompany` invalidates the `Company` list tag -- RTK Query refetches `GET
    // /api/companies` right after, and the gate only passes through once the newly-*selected* id
    // is actually present in that refetched list. A real API would include the new row; this mock
    // needs to as well (a fixed, always-empty response would never let the gate pass through).
    const companies: { id: number; name: string; createdAt: string }[] = [];
    installMockFetch([
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: companies }) },
      {
        method: 'POST',
        match: '/api/companies',
        respond: () => {
          const created = { id: 5, name: 'New Co', createdAt: '2026-01-05T00:00:00.000Z' };
          companies.push(created);
          return { status: 201, body: created };
        },
      },
    ]);
    const { store } = renderWithProviders(
      <ActiveCompanyGate>
        <Probe />
      </ActiveCompanyGate>,
    );

    expect(await screen.findByRole('heading', { name: 'Welcome — create your first company' })).toBeInTheDocument();
    // Not a Modal -- no dialog role, no close control, no overlay to escape through.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('×')).not.toBeInTheDocument();
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Company name', { exact: false }), 'New Co');
    await user.click(screen.getByRole('button', { name: 'Create company' }));

    expect(await screen.findByTestId('probe')).toHaveTextContent('active: 5');
    expect(store.getState().activeCompany.activeCompanyId).toBe(5);
  });

  it('renders a picker (plus "+ New company") when companies exist but none is active, and activates the one clicked', async () => {
    const user = userEvent.setup();
    installMockFetch([
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [COMPANY_1, COMPANY_2] }) },
    ]);
    renderWithProviders(
      <ActiveCompanyGate>
        <Probe />
      </ActiveCompanyGate>,
      { preloadedState: { activeCompany: { activeCompanyId: null } } },
    );

    expect(await screen.findByRole('heading', { name: 'Select a company' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shamir Security Ltd' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Harel Protective Services' })).toBeInTheDocument();
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Harel Protective Services' }));

    expect(await screen.findByTestId('probe')).toHaveTextContent('active: 2');
  });

  it('the picker\'s "+ New company" reuses the dismissable CompanyFormModal, and creating from it activates the new company', async () => {
    const user = userEvent.setup();
    // Same "the mock must reflect the invalidation-triggered refetch" reasoning as the
    // zero-companies test above.
    const companies: { id: number; name: string; createdAt: string }[] = [COMPANY_1];
    installMockFetch([
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: companies }) },
      {
        method: 'POST',
        match: '/api/companies',
        respond: () => {
          const created = { id: 9, name: 'Newer Co', createdAt: '2026-01-09T00:00:00.000Z' };
          companies.push(created);
          return { status: 201, body: created };
        },
      },
    ]);
    renderWithProviders(
      <ActiveCompanyGate>
        <Probe />
      </ActiveCompanyGate>,
      { preloadedState: { activeCompany: { activeCompanyId: null } } },
    );

    await screen.findByRole('heading', { name: 'Select a company' });
    await user.click(screen.getByRole('button', { name: '+ New company' }));

    const dialog = await screen.findByRole('dialog', { name: 'New company' });
    // Unlike the zero-companies screen, this sub-action IS dismissable (escaping back to the
    // picker is fine here, since a picker already exists to fall back to).
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Select a company' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '+ New company' }));
    const reopened = await screen.findByRole('dialog', { name: 'New company' });
    await user.type(within(reopened).getByLabelText('Name', { exact: false }), 'Newer Co');
    await user.click(within(reopened).getByRole('button', { name: 'Create' }));

    expect(await screen.findByTestId('probe')).toHaveTextContent('active: 9');
  });

  it('passes through to children (with the context provided) once a valid company is active', async () => {
    installMockFetch([
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [COMPANY_1, COMPANY_2] }) },
    ]);
    renderWithProviders(
      <ActiveCompanyGate>
        <Probe />
      </ActiveCompanyGate>,
      { preloadedState: { activeCompany: { activeCompanyId: 2 } } },
    );

    expect(await screen.findByTestId('probe')).toHaveTextContent('active: 2');
    expect(screen.queryByRole('heading', { name: 'Select a company' })).not.toBeInTheDocument();
  });

  it('re-shows the gate (picker) if the persisted/selected id no longer refers to a real company', async () => {
    installMockFetch([
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [COMPANY_1, COMPANY_2] }) },
    ]);
    renderWithProviders(
      <ActiveCompanyGate>
        <Probe />
      </ActiveCompanyGate>,
      // Simulates a company that was deleted elsewhere (or a stale localStorage value): id 99
      // isn't in the live company list at all.
      { preloadedState: { activeCompany: { activeCompanyId: 99 } } },
    );

    expect(await screen.findByRole('heading', { name: 'Select a company' })).toBeInTheDocument();
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();
  });
});
