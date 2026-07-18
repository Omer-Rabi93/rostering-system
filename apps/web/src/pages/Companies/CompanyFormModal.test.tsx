import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { installMockFetch } from '../../testUtils/mockFetch.js';
import { renderWithProviders } from '../../testUtils/renderWithProviders.js';
import { CompanyFormModal } from './CompanyFormModal.js';

const COMPANY = { id: 7, name: 'Shamir Security Ltd', createdAt: '2026-01-01T00:00:00.000Z' };

const INITIAL_ROWS = [
  { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 2 },
  { role: 'SUPERVISOR', shift: 'A', requiredCount: 1 },
];

describe('CompanyFormModal', () => {
  describe('create mode', () => {
    it('creates the company first, then saves its (possibly edited) requirements against the new id, in order', async () => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      const { calls } = installMockFetch([
        {
          method: 'POST',
          match: '/api/companies',
          respond: () => ({ status: 201, body: { id: 9, name: 'New Co', createdAt: '2026-02-01T00:00:00.000Z' } }),
        },
        { method: 'PUT', match: '/api/staffing-requirements', respond: () => ({ status: 200, body: [] }) },
      ]);

      renderWithProviders(<CompanyFormModal isOpen company={null} onSaved={onSaved} onCancel={() => {}} />);

      const dialog = await screen.findByRole('dialog', { name: 'New company' });
      await user.type(within(dialog).getByLabelText('Name', { exact: false }), 'New Co');
      await user.clear(within(dialog).getByLabelText('General Guard required, Shift A'));
      await user.type(within(dialog).getByLabelText('General Guard required, Shift A'), '4');
      await user.click(within(dialog).getByRole('button', { name: 'Create' }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 9, name: 'New Co', createdAt: '2026-02-01T00:00:00.000Z' }));

      const postIndex = calls.findIndex((c) => c.method === 'POST' && c.path === '/api/companies');
      const putIndex = calls.findIndex((c) => c.method === 'PUT' && c.path === '/api/staffing-requirements?companyId=9');
      expect(postIndex).toBeGreaterThanOrEqual(0);
      expect(putIndex).toBeGreaterThan(postIndex);
    });

    it('blocks submit and shows an inline per-cell error for a negative headcount before creating anything', async () => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      const { calls } = installMockFetch([
        {
          method: 'POST',
          match: '/api/companies',
          respond: () => ({ status: 201, body: { id: 9, name: 'New Co', createdAt: '2026-02-01T00:00:00.000Z' } }),
        },
      ]);

      renderWithProviders(<CompanyFormModal isOpen company={null} onSaved={onSaved} onCancel={() => {}} />);
      const dialog = await screen.findByRole('dialog', { name: 'New company' });
      await user.type(within(dialog).getByLabelText('Name', { exact: false }), 'New Co');
      const guardShiftA = within(dialog).getByLabelText('General Guard required, Shift A');
      await user.clear(guardShiftA);
      await user.type(guardShiftA, '-1');
      await user.click(within(dialog).getByRole('button', { name: 'Create' }));

      expect(guardShiftA).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText(/Headcount can't be negative/)).toBeInTheDocument();
      expect(calls.some((c) => c.method === 'POST')).toBe(false);
      expect(onSaved).not.toHaveBeenCalled();
    });

    it('a requirements-save failure after successful company creation keeps the modal open and retries without re-creating the company', async () => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      let postCount = 0;
      let putCount = 0;
      const { calls } = installMockFetch([
        {
          method: 'POST',
          match: '/api/companies',
          respond: () => {
            postCount += 1;
            return { status: 201, body: { id: 9, name: 'New Co', createdAt: '2026-02-01T00:00:00.000Z' } };
          },
        },
        {
          method: 'PUT',
          match: '/api/staffing-requirements',
          respond: () => {
            putCount += 1;
            if (putCount === 1) {
              return { status: 400, body: { errors: [{ path: '', message: 'Duplicate role+shift cell' }] } };
            }
            return { status: 200, body: [] };
          },
        },
      ]);

      renderWithProviders(<CompanyFormModal isOpen company={null} onSaved={onSaved} onCancel={() => {}} />);
      const dialog = await screen.findByRole('dialog', { name: 'New company' });
      await user.type(within(dialog).getByLabelText('Name', { exact: false }), 'New Co');
      await user.click(within(dialog).getByRole('button', { name: 'Create' }));

      // First attempt: company created, requirements save failed -- error surfaced, modal stays open.
      expect(await screen.findByText('Duplicate role+shift cell')).toBeInTheDocument();
      expect(dialog).toBeVisible();
      expect(onSaved).not.toHaveBeenCalled();
      expect(postCount).toBe(1);

      // Retry button no longer says "Create" -- resubmitting only replays the requirements PUT.
      const retryButton = within(dialog).getByRole('button', { name: 'Retry saving requirements' });
      await user.click(retryButton);

      await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 9, name: 'New Co', createdAt: '2026-02-01T00:00:00.000Z' }));
      expect(postCount).toBe(1); // still exactly one POST /companies -- never created twice
      expect(putCount).toBe(2);
      expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/companies')).toHaveLength(1);
    });

    it('shows an inline duplicate-name error (409) on create without firing any requirements request', async () => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      const { calls } = installMockFetch([
        {
          method: 'POST',
          match: '/api/companies',
          respond: () => ({ status: 409, body: { message: 'Company name "Shamir Security Ltd" already exists' } }),
        },
      ]);

      renderWithProviders(<CompanyFormModal isOpen company={null} onSaved={onSaved} onCancel={() => {}} />);
      const dialog = await screen.findByRole('dialog', { name: 'New company' });
      await user.type(within(dialog).getByLabelText('Name', { exact: false }), 'Shamir Security Ltd');
      await user.click(within(dialog).getByRole('button', { name: 'Create' }));

      expect(
        await within(dialog).findByText('A company with this name already exists (names are case-insensitive).'),
      ).toBeInTheDocument();
      expect(within(dialog).getByLabelText('Name', { exact: false })).toHaveAttribute('aria-invalid', 'true');
      expect(calls.some((c) => c.method === 'PUT')).toBe(false);
      expect(onSaved).not.toHaveBeenCalled();
    });
  });

  describe('edit mode', () => {
    it('prefills the existing matrix, and on save renames + replaces requirements together', async () => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      const { calls } = installMockFetch([
        {
          method: 'GET',
          match: '/api/staffing-requirements',
          respond: () => ({ status: 200, body: INITIAL_ROWS }),
        },
        {
          method: 'PATCH',
          match: '/api/companies/7',
          respond: () => ({ status: 200, body: { ...COMPANY, name: 'Shamir Security Group' } }),
        },
        { method: 'PUT', match: '/api/staffing-requirements', respond: () => ({ status: 200, body: [] }) },
      ]);

      renderWithProviders(<CompanyFormModal isOpen company={COMPANY} onSaved={onSaved} onCancel={() => {}} />);
      const dialog = await screen.findByRole('dialog', { name: 'Rename company' });

      const guardA = await within(dialog).findByLabelText('General Guard required, Shift A');
      expect(guardA).toHaveValue(2);
      const screenerC = within(dialog).getByLabelText('Screener required, Shift C');
      expect(screenerC).toHaveValue(0);

      await user.clear(screenerC);
      await user.type(screenerC, '3');

      const nameInput = within(dialog).getByLabelText('Name', { exact: false });
      await user.clear(nameInput);
      await user.type(nameInput, 'Shamir Security Group');

      await user.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...COMPANY, name: 'Shamir Security Group' }));
      expect(calls.some((c) => c.method === 'PATCH' && c.path === '/api/companies/7')).toBe(true);
      expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/staffing-requirements?companyId=7')).toBe(true);
    });

    it('does not fire a rename request when the name is unchanged, but still replaces requirements', async () => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      const { calls } = installMockFetch([
        { method: 'GET', match: '/api/staffing-requirements', respond: () => ({ status: 200, body: [] }) },
        { method: 'PUT', match: '/api/staffing-requirements', respond: () => ({ status: 200, body: [] }) },
      ]);

      renderWithProviders(<CompanyFormModal isOpen company={COMPANY} onSaved={onSaved} onCancel={() => {}} />);
      const dialog = await screen.findByRole('dialog', { name: 'Rename company' });
      await within(dialog).findByLabelText('General Guard required, Shift A');

      await user.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(COMPANY));
      expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
      expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/staffing-requirements?companyId=7')).toBe(true);
    });

    it('blocks save and shows an inline per-cell error for a negative headcount (client-side)', async () => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      installMockFetch([{ method: 'GET', match: '/api/staffing-requirements', respond: () => ({ status: 200, body: [] }) }]);

      renderWithProviders(<CompanyFormModal isOpen company={COMPANY} onSaved={onSaved} onCancel={() => {}} />);
      const dialog = await screen.findByRole('dialog', { name: 'Rename company' });
      const guardShiftA = await within(dialog).findByLabelText('General Guard required, Shift A');

      await user.clear(guardShiftA);
      await user.type(guardShiftA, '-1');
      await user.click(within(dialog).getByRole('button', { name: 'Save' }));

      expect(guardShiftA).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText(/Headcount can't be negative/)).toBeInTheDocument();
      expect(onSaved).not.toHaveBeenCalled();
    });
  });
});
