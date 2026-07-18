import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, EmptyState, Select, Spinner, Toast, ToastRegion } from '@rostering/ui';
import { ROLES, SHIFT_TYPES } from '@rostering/shared';
import type { Role, ShiftType } from '@rostering/shared';

import {
  useListStaffingRequirementsQuery,
  useReplaceStaffingRequirementsMutation,
} from '../../api/staffingRequirements.api.js';
import { useListCompaniesQuery } from '../../api/companies.api.js';
import { classifyMutationError } from '../../api/errors.js';
import { useToasts } from '../../hooks/useToasts.js';
import {
  buildMatrixState,
  cellKey,
  mapBadRequestErrors,
  setCell,
  validateMatrix,
  type MatrixState,
} from './matrix.js';

const ROLE_LABELS: Record<Role, string> = {
  GENERAL_GUARD: 'General Guard',
  SUPERVISOR: 'Supervisor',
  SCREENER: 'Screener',
};

const SHIFT_HOURS_LABEL: Record<ShiftType, string> = { A: '00–08', B: '08–16', C: '16–24' };

export function RequirementsPage(): ReactElement {
  const navigate = useNavigate();
  // Company-scoped rostering: each company has its own independent role×shift matrix -- see
  // `RosterPage.tsx` for the same default-to-first-company selector pattern.
  const { data: companies, isLoading: companiesLoading } = useListCompaniesQuery();
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | undefined>(undefined);
  const companyId = selectedCompanyId ?? companies?.[0]?.id;

  const { data, isLoading } = useListStaffingRequirementsQuery(companyId ?? -1, { skip: companyId === undefined });
  const [replaceAll, replaceResult] = useReplaceStaffingRequirementsMutation();
  const { toasts, pushToast, dismissToast } = useToasts();

  const [matrix, setMatrix] = useState<MatrixState>(() => buildMatrixState([]));
  const [cellErrors, setCellErrors] = useState<Readonly<Record<string, string>>>({});
  const [generalErrors, setGeneralErrors] = useState<readonly string[]>([]);

  useEffect(() => {
    if (data) setMatrix(buildMatrixState(data));
  }, [data]);

  function resetToLastSaved() {
    setMatrix(buildMatrixState(data ?? []));
    setCellErrors({});
    setGeneralErrors([]);
  }

  async function handleSave() {
    if (companyId === undefined) return;
    const validation = validateMatrix(matrix);
    if (!validation.rows) {
      setCellErrors(validation.cellErrors);
      setGeneralErrors([]);
      return;
    }
    setCellErrors({});
    setGeneralErrors([]);
    try {
      await replaceAll({ companyId, rows: validation.rows }).unwrap();
      pushToast('success', 'Requirements saved.');
    } catch (err) {
      const classified = classifyMutationError(err);
      if (classified.kind === 'badRequest') {
        const mapped = mapBadRequestErrors(classified.body.errors);
        setCellErrors(mapped.cellErrors);
        setGeneralErrors(mapped.generalErrors);
      }
      pushToast('error', 'Save failed (400) — one or more cells are invalid.');
    }
  }

  const totalsByShift: Record<ShiftType, number> = { A: 0, B: 0, C: 0 };
  for (const role of ROLES) {
    for (const shift of SHIFT_TYPES) {
      const raw = matrix[cellKey(role, shift)];
      const n = Number(raw);
      if (Number.isInteger(n)) totalsByShift[shift] += n;
    }
  }

  return (
    <div className="page page--narrow">
      <div className="page-header">
        <div>
          <h1>Staffing Requirements</h1>
          <p>
            Required headcount per role × shift. The scheduling engine treats every cell as a hard
            coverage target; shortfalls become <code>unfillable_slot</code> alerts on the roster.
          </p>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field__label visually-hidden" htmlFor="requirements-company">
            Company
          </label>
          <Select
            id="requirements-company"
            value={companyId !== undefined ? String(companyId) : ''}
            options={(companies ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
            onChange={(e) => setSelectedCompanyId(Number(e.target.value))}
          />
        </div>
      </div>

      {companiesLoading ? (
        <Spinner label="Loading companies" />
      ) : companies && companies.length === 0 ? (
        <EmptyState
          icon={<span aria-hidden="true">🏢</span>}
          title="No companies yet"
          body="Staffing requirements are per-company — add at least one company first."
          action={{ label: 'Go to Companies', onClick: () => void navigate('/companies') }}
        />
      ) : isLoading ? (
        <Spinner label="Loading staffing requirements" />
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          {generalErrors.length > 0 ? (
            <p className="field__error" role="alert">
              {generalErrors.join(' ')}
            </p>
          ) : null}
          <table className="req-matrix">
            <caption className="visually-hidden">Required headcount per role and shift</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Role</span>
                </th>
                {SHIFT_TYPES.map((shift) => (
                  <th scope="col" key={shift}>
                    <Badge kind="shift" value={shift} />
                    <br />
                    <span className="field__hint">{SHIFT_HOURS_LABEL[shift]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROLES.map((role) => (
                <tr key={role}>
                  <th scope="row">
                    <Badge kind="role" value={role} />
                  </th>
                  {SHIFT_TYPES.map((shift) => {
                    const key = cellKey(role, shift);
                    const inputId = `rq-${key}`;
                    const errorId = `${inputId}-error`;
                    const error = cellErrors[key];
                    return (
                      <td key={shift} className={`col-${shift.toLowerCase()}`}>
                        <label className="visually-hidden" htmlFor={inputId}>
                          {ROLE_LABELS[role]} required, Shift {shift}
                        </label>
                        <input
                          id={inputId}
                          type="number"
                          min={0}
                          value={matrix[key] ?? '0'}
                          onChange={(event) => setMatrix((prev) => setCell(prev, role, shift, event.target.value))}
                          {...(error ? { 'aria-invalid': true, 'aria-describedby': errorId } : {})}
                        />
                        {error ? (
                          <p className="field__error" id={errorId} role="alert">
                            {ROLE_LABELS[role]} / Shift {shift}: {error}
                          </p>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="field__hint" style={{ marginTop: 'var(--space-3)' }}>
            Total required per shift: A = {totalsByShift.A} · B = {totalsByShift.B} · C ={' '}
            {totalsByShift.C} workers.
          </p>
          <div className="toolbar" style={{ marginTop: 'var(--space-4)' }}>
            <button className="btn btn--primary" type="submit" disabled={replaceResult.isLoading}>
              Save requirements
            </button>
            <button className="btn btn--secondary" type="button" onClick={resetToLastSaved}>
              Reset to last saved
            </button>
          </div>
        </form>
      )}

      <ToastRegion>
        {toasts.map((toast) => (
          <Toast
            key={toast.id}
            variant={toast.variant}
            message={toast.message}
            onDismiss={() => dismissToast(toast.id)}
          />
        ))}
      </ToastRegion>
    </div>
  );
}
