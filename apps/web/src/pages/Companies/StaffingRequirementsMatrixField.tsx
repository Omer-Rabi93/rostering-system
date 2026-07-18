import type { ReactElement } from 'react';
import { Badge } from '@rostering/ui';
import { ROLES, SHIFT_TYPES } from '@rostering/shared';
import type { Role, ShiftType } from '@rostering/shared';

import { cellKey, type MatrixState } from './staffingRequirementsMatrix.js';

const ROLE_LABELS: Record<Role, string> = {
  GENERAL_GUARD: 'General Guard',
  SUPERVISOR: 'Supervisor',
  SCREENER: 'Screener',
};

const SHIFT_HOURS_LABEL: Record<ShiftType, string> = { A: '00–08', B: '08–16', C: '16–24' };

export interface StaffingRequirementsMatrixFieldProps {
  readonly matrix: MatrixState;
  readonly cellErrors: Readonly<Record<string, string>>;
  readonly onCellChange: (role: Role, shift: ShiftType, value: string) => void;
}

/**
 * Presentational role×shift required-headcount matrix — purely the accessible `<table>`
 * (visually-hidden per-cell `<label>`s, `aria-invalid`/`aria-describedby` + inline error text on
 * any cell the caller flags via `cellErrors`). No data-fetching or submit logic lives here; the
 * caller owns the `MatrixState` (see `staffingRequirementsMatrix.ts`) and passes it in as a plain
 * controlled prop. Shared by `CompanyFormModal` (create/edit) and `ActiveCompanyGate`'s
 * zero-companies first-run bootstrap form — every "add/edit a company" entry point in the app.
 */
export function StaffingRequirementsMatrixField(props: StaffingRequirementsMatrixFieldProps): ReactElement {
  const { matrix, cellErrors, onCellChange } = props;

  return (
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
                    onChange={(event) => onCellChange(role, shift, event.target.value)}
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
  );
}
