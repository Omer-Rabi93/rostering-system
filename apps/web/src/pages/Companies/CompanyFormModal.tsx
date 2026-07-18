import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { FormField, Input, Modal, Spinner } from '@rostering/ui';

import { useCreateCompanyMutation, useRenameCompanyMutation, type CompanyDto } from '../../api/companies.api.js';
import {
  useListStaffingRequirementsQuery,
  useReplaceStaffingRequirementsMutation,
} from '../../api/staffingRequirements.api.js';
import { classifyMutationError } from '../../api/errors.js';
import { StaffingRequirementsMatrixField } from './StaffingRequirementsMatrixField.js';
import {
  buildMatrixState,
  computeShiftTotals,
  mapBadRequestErrors,
  setCell,
  validateMatrix,
  type MatrixState,
} from './staffingRequirementsMatrix.js';

export interface CompanyFormModalProps {
  readonly isOpen: boolean;
  /** `null` => create mode (the matrix starts all-zero, since there's no company id yet to fetch
   * requirements for). Otherwise the company being edited — its name and existing
   * staffing-requirements matrix are prefilled from it. */
  readonly company: CompanyDto | null;
  /** Called exactly once, when both the company and its staffing-requirements matrix have been
   * saved successfully. The caller owns toasting, setting the active company (on create), and
   * closing the modal (`isOpen={false}`) — this component does not close itself. */
  readonly onSaved: (company: CompanyDto) => void;
  readonly onCancel: () => void;
}

/**
 * One form for both "new company" and "rename company", folding what used to be a separate
 * `/requirements` page's role×shift matrix into the same modal — company scoping and its staffing
 * requirements are edited together instead of as two disconnected steps.
 *
 * Submit sequencing:
 *  - Create: `POST /companies` first; only once that succeeds does the new id get used for
 *    `PUT /staffing-requirements`. If the requirements save then fails, the modal stays open with
 *    the error surfaced inline (general + per-cell) and the already-created company's id pinned in
 *    `createdCompany` — a retry re-submits ONLY the requirements PUT, never a second `POST
 *    /companies` (the company is not, and must not be, created twice).
 *  - Edit: `PATCH /companies/:id` (only if the name actually changed — a no-op rename is never
 *    fired) and `PUT /staffing-requirements` run together; a full-matrix replace is idempotent, so
 *    firing it regardless of whether cells changed is safe. Either half failing keeps the modal
 *    open with that half's error shown; the other half's success still lands (rename and replace
 *    are independent of one another once the company id is stable).
 */
export function CompanyFormModal(props: CompanyFormModalProps): ReactElement {
  const { isOpen, company, onSaved, onCancel } = props;
  const mode: 'create' | 'edit' = company === null ? 'create' : 'edit';

  const [name, setName] = useState(company?.name ?? '');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [matrix, setMatrix] = useState<MatrixState>(() => buildMatrixState([]));
  const [cellErrors, setCellErrors] = useState<Readonly<Record<string, string>>>({});
  const [generalErrors, setGeneralErrors] = useState<readonly string[]>([]);
  // Create-mode only: once the company itself is created, it's pinned here so a subsequent
  // requirements-save retry never re-creates it (see the doc comment above).
  const [createdCompany, setCreatedCompany] = useState<CompanyDto | null>(null);

  const [createCompanyMutation, createResult] = useCreateCompanyMutation();
  const [renameCompanyMutation, renameResult] = useRenameCompanyMutation();
  const [replaceRequirementsMutation, replaceResult] = useReplaceStaffingRequirementsMutation();

  const { data: existingRequirements, isLoading: loadingRequirements } = useListStaffingRequirementsQuery(
    company?.id ?? -1,
    { skip: !isOpen || company === null },
  );

  // Reset every field whenever the modal (re)opens, or a *different* company opens it for edit.
  useEffect(() => {
    if (!isOpen) return;
    setName(company?.name ?? '');
    setNameError(undefined);
    setCellErrors({});
    setGeneralErrors([]);
    setCreatedCompany(null);
    if (company === null) setMatrix(buildMatrixState([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, company?.id]);

  // Edit mode: once the existing matrix loads, seed local state from it. Create mode is zeroed by
  // the effect above instead (there's no company id yet to fetch requirements against).
  useEffect(() => {
    if (isOpen && company !== null && existingRequirements) {
      setMatrix(buildMatrixState(existingRequirements));
    }
  }, [isOpen, company, existingRequirements]);

  const submitting = createResult.isLoading || renameResult.isLoading || replaceResult.isLoading;
  const totals = computeShiftTotals(matrix);

  async function handleSubmit(): Promise<void> {
    const trimmedName = name.trim();
    const validation = validateMatrix(matrix);
    if (!validation.rows) {
      setCellErrors(validation.cellErrors);
      setGeneralErrors([]);
      return;
    }
    setCellErrors({});
    setGeneralErrors([]);

    if (mode === 'create') {
      let target = createdCompany;
      if (!target) {
        try {
          target = await createCompanyMutation({ name: trimmedName }).unwrap();
          setCreatedCompany(target);
          setNameError(undefined);
        } catch (err) {
          const classified = classifyMutationError(err);
          if (classified.kind === 'conflictMessage') {
            setNameError('A company with this name already exists (names are case-insensitive).');
          } else {
            setGeneralErrors(['Could not create the company. Please try again.']);
          }
          return;
        }
      }
      try {
        await replaceRequirementsMutation({ companyId: target.id, rows: validation.rows }).unwrap();
        onSaved(target);
      } catch (err) {
        const classified = classifyMutationError(err);
        if (classified.kind === 'badRequest') {
          const mapped = mapBadRequestErrors(classified.body.errors);
          setCellErrors(mapped.cellErrors);
          setGeneralErrors(mapped.generalErrors);
        } else {
          setGeneralErrors([
            `"${target.name}" was created, but staffing requirements failed to save. Fix the matrix below and ` +
              'retry — the company will not be created again.',
          ]);
        }
        // Stays open; `createdCompany` is already set, so the retry above skips straight to the
        // requirements PUT.
      }
      return;
    }

    // Edit mode: rename (only if changed) and the full-matrix replace run together — a replace is
    // idempotent, so firing it regardless of whether cells actually changed is safe, and it isn't
    // gated on the rename succeeding since the company id itself never changes.
    const activeCompany = company as CompanyDto;
    const nameChanged = trimmedName !== activeCompany.name;
    const [renameOutcome, replaceOutcome] = await Promise.allSettled([
      nameChanged
        ? renameCompanyMutation({ id: activeCompany.id, body: { name: trimmedName } }).unwrap()
        : Promise.resolve(activeCompany),
      replaceRequirementsMutation({ companyId: activeCompany.id, rows: validation.rows }).unwrap(),
    ]);

    let hasError = false;
    let savedCompany = activeCompany;
    if (renameOutcome.status === 'fulfilled') {
      savedCompany = renameOutcome.value;
    } else {
      hasError = true;
      const classified = classifyMutationError(renameOutcome.reason);
      setNameError(
        classified.kind === 'conflictMessage'
          ? `A company named "${trimmedName}" already exists.`
          : 'Could not rename this company. Please try again.',
      );
    }
    if (replaceOutcome.status === 'rejected') {
      hasError = true;
      const classified = classifyMutationError(replaceOutcome.reason);
      if (classified.kind === 'badRequest') {
        const mapped = mapBadRequestErrors(classified.body.errors);
        setCellErrors(mapped.cellErrors);
        setGeneralErrors(mapped.generalErrors);
      }
    }
    if (!hasError) {
      onSaved(savedCompany);
    }
  }

  const submitLabel = submitting
    ? 'Saving…'
    : mode === 'create'
      ? createdCompany
        ? 'Retry saving requirements'
        : 'Create'
      : 'Save';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      titleId="company-form-title"
      title={mode === 'create' ? 'New company' : 'Rename company'}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={submitting || name.trim() === '' || (mode === 'edit' && loadingRequirements)}
            onClick={() => void handleSubmit()}
          >
            {submitLabel}
          </button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <FormField id="company-name" label="Name" required {...(nameError ? { error: nameError } : {})}>
          {(inputProps) => (
            <Input {...inputProps} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          )}
        </FormField>

        <h3>Staffing requirements</h3>
        <p className="field__hint">
          Required headcount per role × shift. The scheduling engine treats every cell as a hard
          coverage target; shortfalls become <code>unfillable_slot</code> alerts on the roster.
        </p>

        {mode === 'edit' && loadingRequirements ? (
          <Spinner label="Loading staffing requirements" />
        ) : (
          <>
            {generalErrors.length > 0 ? (
              <p className="field__error" role="alert">
                {generalErrors.join(' ')}
              </p>
            ) : null}
            <StaffingRequirementsMatrixField
              matrix={matrix}
              cellErrors={cellErrors}
              onCellChange={(role, shift, value) => setMatrix((prev) => setCell(prev, role, shift, value))}
            />
            <p className="field__hint" style={{ marginTop: 'var(--space-3)' }}>
              Total required per shift: A = {totals.A} · B = {totals.B} · C = {totals.C} workers.
            </p>
          </>
        )}
      </form>
    </Modal>
  );
}
