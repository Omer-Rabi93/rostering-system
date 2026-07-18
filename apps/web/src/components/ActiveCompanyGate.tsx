import { useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import { FormField, Input, Spinner } from '@rostering/ui';

import { useCreateCompanyMutation, useListCompaniesQuery } from '../api/companies.api.js';
import { classifyMutationError } from '../api/errors.js';
import { ActiveCompanyContext } from '../hooks/useActiveCompanyId.js';
import { CompanyFormModal } from '../pages/Companies/CompanyFormModal.js';
import { companySelected, selectActiveCompanyId } from '../store/activeCompany.slice.js';
import { useAppDispatch, useAppSelector } from '../store/hooks.js';

/**
 * Gates every authenticated route behind having a valid "active company" selected — rendered by
 * `components/Layout.tsx` around `{children}`, so every route mounted inside `<Layout>` (i.e.
 * every route except the public `/schedule/:token`) gets this for free.
 *
 * Three states, driven by the live `useListCompaniesQuery()` result (never just the
 * `activeCompany` Redux slice alone, since the persisted/selected id can point at a company that
 * no longer exists — deleted elsewhere, or a stale/corrupt `localStorage` value):
 *   - Loading the company list -> a spinner (same pattern each page's own `companiesLoading`
 *     branch used before this gate existed).
 *   - The selected id is set AND present in the fetched list -> render `children`, wrapped in
 *     `ActiveCompanyContext.Provider` supplying that id (the only place this context is ever
 *     provided).
 *   - Otherwise (nothing selected, or the selected id isn't a real company anymore) -> a
 *     create-or-pick screen:
 *       - Zero companies exist -> a create-only, non-closeable full-page form (NOT a `Modal` —
 *         `packages/ui`'s `Modal` has no non-dismissable mode, and this step can't be skipped:
 *         company is how the app is originally onboarded).
 *       - One or more companies exist but none is active -> a picker (click a company to activate
 *         it) plus a "+ New company" action, which reuses `CompanyFormModal` since escaping back
 *         to the picker is fine there.
 *
 * Creating a company from either sub-case dispatches `companySelected(id)` on success — if you
 * just created a company you almost certainly want to work in it next.
 */
export function ActiveCompanyGate({ children }: { children: ReactNode }): ReactElement {
  const { data: companies, isLoading } = useListCompaniesQuery();
  const activeCompanyId = useAppSelector(selectActiveCompanyId);
  const dispatch = useAppDispatch();
  const [createCompany, createResult] = useCreateCompanyMutation();
  const [isCreateModalOpen, setCreateModalOpen] = useState(false);

  if (isLoading || !companies) {
    return (
      <div className="page">
        <Spinner label="Loading companies" />
      </div>
    );
  }

  const activeCompany = companies.find((c) => c.id === activeCompanyId);
  if (activeCompany) {
    return <ActiveCompanyContext.Provider value={activeCompany.id}>{children}</ActiveCompanyContext.Provider>;
  }

  async function handleCreate(name: string): Promise<void> {
    try {
      const created = await createCompany({ name }).unwrap();
      dispatch(companySelected(created.id));
      setCreateModalOpen(false);
    } catch {
      // Error is surfaced inline via createResult.error below; nothing else to do.
    }
  }

  const createError =
    classifyMutationError(createResult.error).kind === 'conflictMessage'
      ? 'A company with this name already exists (names are case-insensitive).'
      : undefined;

  if (companies.length === 0) {
    return (
      <div className="page page--narrow">
        <div className="page-header">
          <div>
            <h1>Welcome — create your first company</h1>
            <p>
              Rostering in this app is per-company: workers, staffing requirements, and rosters
              all belong to one company. Create the first one to get started — you can add more
              later, and switch between them at any time.
            </p>
          </div>
        </div>
        <FirstRunCompanyForm
          error={createError}
          submitting={createResult.isLoading}
          onSubmit={(name) => void handleCreate(name)}
        />
      </div>
    );
  }

  return (
    <div className="page page--narrow">
      <div className="page-header">
        <div>
          <h1>Select a company</h1>
          <p>Pick which company to work in. You can switch at any time from the top bar.</p>
        </div>
        <button className="btn btn--primary" type="button" onClick={() => setCreateModalOpen(true)}>
          + New company
        </button>
      </div>

      <ul className="company-picker" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {companies.map((company) => (
          <li key={company.id} style={{ marginBottom: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn btn--secondary"
              style={{ width: '100%', justifyContent: 'flex-start' }}
              onClick={() => dispatch(companySelected(company.id))}
            >
              {company.name}
            </button>
          </li>
        ))}
      </ul>

      <CompanyFormModal
        isOpen={isCreateModalOpen}
        mode="create"
        initialName=""
        error={createError}
        submitting={createResult.isLoading}
        onSubmit={(name) => void handleCreate(name)}
        onCancel={() => setCreateModalOpen(false)}
      />
    </div>
  );
}

interface FirstRunCompanyFormProps {
  readonly error: string | undefined;
  readonly submitting: boolean;
  readonly onSubmit: (name: string) => void;
}

/**
 * The zero-companies first-run form: deliberately plain page content, not a `Modal` — there is
 * nothing to escape back to (no company exists yet to pass through to), so this step can't be
 * skipped/dismissed, which `packages/ui`'s `Modal` (always closeable via Escape/overlay
 * click/its own close button) can't express.
 */
function FirstRunCompanyForm(props: FirstRunCompanyFormProps): ReactElement {
  const { error, submitting, onSubmit } = props;
  const [name, setName] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit(name.trim());
  }

  return (
    <form onSubmit={handleSubmit}>
      <FormField id="first-run-company-name" label="Company name" required {...(error ? { error } : {})}>
        {(inputProps) => (
          <Input {...inputProps} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        )}
      </FormField>
      <button className="btn btn--primary" type="submit" disabled={submitting || name.trim() === ''}>
        Create company
      </button>
    </form>
  );
}
