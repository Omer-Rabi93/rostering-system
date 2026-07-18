import { useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import { FormField, Input, Spinner } from '@rostering/ui';
import type { Role, ShiftType } from '@rostering/shared';

import { useCreateCompanyMutation, useListCompaniesQuery, type CompanyDto } from '../api/companies.api.js';
import { useReplaceStaffingRequirementsMutation } from '../api/staffingRequirements.api.js';
import { classifyMutationError } from '../api/errors.js';
import { ActiveCompanyContext } from '../hooks/useActiveCompanyId.js';
import { CompanyFormModal } from '../pages/Companies/CompanyFormModal.js';
import { StaffingRequirementsMatrixField } from '../pages/Companies/StaffingRequirementsMatrixField.js';
import {
  buildMatrixState,
  computeShiftTotals,
  mapBadRequestErrors,
  setCell,
  validateMatrix,
  type MatrixState,
} from '../pages/Companies/staffingRequirementsMatrix.js';
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
 *         company is how the app is originally onboarded), which also includes the staffing
 *         requirements matrix (`FirstRunCompanyForm` below) — reusing `StaffingRequirementsMatrixField`
 *         + `staffingRequirementsMatrix.ts` directly rather than `CompanyFormModal`, since this
 *         screen's whole point is that it is NOT modal chrome (no dialog role, no close control,
 *         nothing to escape back to).
 *       - One or more companies exist but none is active -> a picker (click a company to activate
 *         it) plus a "+ New company" action, which reuses `CompanyFormModal` since escaping back
 *         to the picker is fine there.
 *
 * Creating a company from either sub-case dispatches `companySelected(id)` only once its
 * staffing-requirements matrix has also saved -- if you just created a company you almost
 * certainly want to work in it next, but not until it's actually usable.
 */
export function ActiveCompanyGate({ children }: { children: ReactNode }): ReactElement {
  const { data: companies, isLoading } = useListCompaniesQuery();
  const activeCompanyId = useAppSelector(selectActiveCompanyId);
  const dispatch = useAppDispatch();
  const [isCreateModalOpen, setCreateModalOpen] = useState(false);

  // First-run bootstrap form's own local state (only rendered/used when zero companies exist —
  // see the `companies.length === 0` branch below).
  const [createCompany, createResult] = useCreateCompanyMutation();
  const [replaceRequirements, replaceResult] = useReplaceStaffingRequirementsMutation();
  const [firstRunName, setFirstRunName] = useState('');
  const [firstRunNameError, setFirstRunNameError] = useState<string | undefined>(undefined);
  const [firstRunMatrix, setFirstRunMatrix] = useState<MatrixState>(() => buildMatrixState([]));
  const [firstRunCellErrors, setFirstRunCellErrors] = useState<Readonly<Record<string, string>>>({});
  const [firstRunGeneralErrors, setFirstRunGeneralErrors] = useState<readonly string[]>([]);
  // Once the company itself is created, it's pinned here so a requirements-save retry never
  // re-creates it -- same reasoning as `CompanyFormModal`'s own `createdCompany` state.
  const [firstRunCreatedCompany, setFirstRunCreatedCompany] = useState<CompanyDto | null>(null);

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

  async function handleFirstRunSubmit(): Promise<void> {
    const trimmedName = firstRunName.trim();
    const validation = validateMatrix(firstRunMatrix);
    if (!validation.rows) {
      setFirstRunCellErrors(validation.cellErrors);
      setFirstRunGeneralErrors([]);
      return;
    }
    setFirstRunCellErrors({});
    setFirstRunGeneralErrors([]);

    let target = firstRunCreatedCompany;
    if (!target) {
      try {
        target = await createCompany({ name: trimmedName }).unwrap();
        setFirstRunCreatedCompany(target);
        setFirstRunNameError(undefined);
      } catch (err) {
        const classified = classifyMutationError(err);
        if (classified.kind === 'conflictMessage') {
          setFirstRunNameError('A company with this name already exists (names are case-insensitive).');
        } else {
          setFirstRunGeneralErrors(['Could not create the company. Please try again.']);
        }
        return;
      }
    }
    try {
      await replaceRequirements({ companyId: target.id, rows: validation.rows }).unwrap();
      dispatch(companySelected(target.id));
    } catch (err) {
      const classified = classifyMutationError(err);
      if (classified.kind === 'badRequest') {
        const mapped = mapBadRequestErrors(classified.body.errors);
        setFirstRunCellErrors(mapped.cellErrors);
        setFirstRunGeneralErrors(mapped.generalErrors);
      } else {
        setFirstRunGeneralErrors([
          `"${target.name}" was created, but staffing requirements failed to save. Fix the matrix below and ` +
            'retry — the company will not be created again.',
        ]);
      }
      // `firstRunCreatedCompany` stays set, so retrying skips straight to the requirements PUT.
    }
  }

  const firstRunSubmitting = createResult.isLoading || replaceResult.isLoading;
  const firstRunSubmitLabel = firstRunSubmitting
    ? 'Saving…'
    : firstRunCreatedCompany
      ? 'Retry saving requirements'
      : 'Create company';

  // Stay on the bootstrap screen once its own company-creation step has succeeded, even if the
  // (now non-empty) company list has already refetched -- otherwise a requirements-save failure
  // after a successful `POST /companies` would flip this straight to the picker branch below
  // (companies.length is no longer 0) mid-flow, stranding the error/retry state nothing would
  // ever render.
  if (companies.length === 0 || firstRunCreatedCompany) {
    return (
      <div className="page page--narrow">
        <div className="page-header">
          <div>
            <h1>Welcome — create your first company</h1>
            <p>
              Rostering in this app is per-company: workers, staffing requirements, and rosters
              all belong to one company. Create the first one to get started, including its
              required headcount per role × shift — you can add more companies later, and switch
              between them at any time.
            </p>
          </div>
        </div>
        <FirstRunCompanyForm
          name={firstRunName}
          onNameChange={setFirstRunName}
          nameError={firstRunNameError}
          matrix={firstRunMatrix}
          cellErrors={firstRunCellErrors}
          generalErrors={firstRunGeneralErrors}
          totals={computeShiftTotals(firstRunMatrix)}
          submitting={firstRunSubmitting}
          submitLabel={firstRunSubmitLabel}
          onCellChange={(role, shift, value) => setFirstRunMatrix((prev) => setCell(prev, role, shift, value))}
          onSubmit={() => void handleFirstRunSubmit()}
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
        company={null}
        onSaved={(created) => {
          dispatch(companySelected(created.id));
          setCreateModalOpen(false);
        }}
        onCancel={() => setCreateModalOpen(false)}
      />
    </div>
  );
}

interface FirstRunCompanyFormProps {
  readonly name: string;
  readonly onNameChange: (name: string) => void;
  readonly nameError: string | undefined;
  readonly matrix: MatrixState;
  readonly cellErrors: Readonly<Record<string, string>>;
  readonly generalErrors: readonly string[];
  readonly totals: Record<ShiftType, number>;
  readonly submitting: boolean;
  readonly submitLabel: string;
  readonly onCellChange: (role: Role, shift: ShiftType, value: string) => void;
  readonly onSubmit: () => void;
}

/**
 * The zero-companies first-run form: deliberately plain page content, not a `Modal` — there is
 * nothing to escape back to (no company exists yet to pass through to), so this step can't be
 * skipped/dismissed, which `packages/ui`'s `Modal` (always closeable via Escape/overlay
 * click/its own close button) can't express. Includes the staffing-requirements matrix inline
 * (via `StaffingRequirementsMatrixField`) so the very first company is fully usable —
 * name + requirements together — the moment it's created, with no separate page/step needed
 * afterward.
 */
function FirstRunCompanyForm(props: FirstRunCompanyFormProps): ReactElement {
  const {
    name,
    onNameChange,
    nameError,
    matrix,
    cellErrors,
    generalErrors,
    totals,
    submitting,
    submitLabel,
    onCellChange,
    onSubmit,
  } = props;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit();
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <FormField id="first-run-company-name" label="Company name" required {...(nameError ? { error: nameError } : {})}>
        {(inputProps) => (
          <Input {...inputProps} value={name} onChange={(e) => onNameChange(e.target.value)} maxLength={120} />
        )}
      </FormField>

      <h2>Staffing requirements</h2>
      <p className="field__hint">
        Required headcount per role × shift. You can fine-tune this later from the Companies page.
      </p>
      {generalErrors.length > 0 ? (
        <p className="field__error" role="alert">
          {generalErrors.join(' ')}
        </p>
      ) : null}
      <StaffingRequirementsMatrixField matrix={matrix} cellErrors={cellErrors} onCellChange={onCellChange} />
      <p className="field__hint" style={{ marginTop: 'var(--space-3)' }}>
        Total required per shift: A = {totals.A} · B = {totals.B} · C = {totals.C} workers.
      </p>

      <button
        className="btn btn--primary"
        type="submit"
        disabled={submitting || name.trim() === ''}
        style={{ marginTop: 'var(--space-4)' }}
      >
        {submitLabel}
      </button>
    </form>
  );
}
