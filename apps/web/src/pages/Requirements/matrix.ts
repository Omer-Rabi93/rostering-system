import { ROLES, SHIFT_TYPES } from '@rostering/shared';
import type { Role, ShiftType, StaffingRequirement, StaffingRequirementsInput } from '@rostering/shared';

export interface MatrixCellPos {
  readonly role: Role;
  readonly shift: ShiftType;
}

/** Fixed submission order for the 3x3 role×shift matrix — every save PUTs all 9 cells in this
 * exact order, so a `400` response's `errors[].path` (`"<arrayIndex>.requiredCount"`, per
 * `apps/api/src/middleware/errorHandler.ts`'s `issue.path.join('.')`) can be mapped straight back
 * to the (role, shift) cell that produced it. */
export const CELLS: readonly MatrixCellPos[] = ROLES.flatMap((role) =>
  SHIFT_TYPES.map((shift) => ({ role, shift })),
);

export function cellKey(role: Role, shift: ShiftType): string {
  return `${role}:${shift}`;
}

export type MatrixState = Readonly<Record<string, string>>; // cellKey -> raw input string

/** Builds the editable matrix state from the server's (possibly sparse — a role×shift cell with
 * no row yet defaults to 0) list of requirement rows. */
export function buildMatrixState(rows: readonly StaffingRequirement[]): MatrixState {
  const state: Record<string, string> = {};
  for (const cell of CELLS) {
    state[cellKey(cell.role, cell.shift)] = '0';
  }
  for (const row of rows) {
    state[cellKey(row.role, row.shift)] = String(row.requiredCount);
  }
  return state;
}

export function setCell(matrix: MatrixState, role: Role, shift: ShiftType, value: string): MatrixState {
  return { ...matrix, [cellKey(role, shift)]: value };
}

export interface MatrixValidationResult {
  readonly rows?: StaffingRequirementsInput;
  readonly cellErrors: Readonly<Record<string, string>>;
}

/** Client-side validation mirroring the server's `requiredCount >= 0, integer` rule — parses
 * every cell and returns either the ready-to-submit rows (in `CELLS` order) or a map of per-cell
 * error messages, keyed the same way `mapBadRequestErrors` keys its server-side counterpart. */
export function validateMatrix(matrix: MatrixState): MatrixValidationResult {
  const cellErrors: Record<string, string> = {};
  const rows: StaffingRequirement[] = [];

  for (const cell of CELLS) {
    const key = cellKey(cell.role, cell.shift);
    const raw = matrix[key] ?? '';
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isInteger(parsed)) {
      cellErrors[key] = 'Enter a whole number.';
      continue;
    }
    if (parsed < 0) {
      cellErrors[key] = "Headcount can't be negative.";
      continue;
    }
    rows.push({ role: cell.role, shift: cell.shift, requiredCount: parsed });
  }

  if (Object.keys(cellErrors).length > 0) {
    return { cellErrors };
  }
  return { rows, cellErrors };
}

export interface BadRequestFieldError {
  readonly path: string;
  readonly message: string;
}

export interface MappedBadRequestErrors {
  readonly cellErrors: Readonly<Record<string, string>>;
  readonly generalErrors: readonly string[];
}

/** Maps a `400` response's `errors[]` (path `"<index>.requiredCount"` for a per-cell issue, or a
 * path-less entry for the whole-array `refine` — e.g. the duplicate-cell check) back onto the
 * matrix's cells using the fixed `CELLS` submission order, or into a general (non-cell-specific)
 * error list. */
export function mapBadRequestErrors(errors: readonly BadRequestFieldError[]): MappedBadRequestErrors {
  const cellErrors: Record<string, string> = {};
  const generalErrors: string[] = [];

  for (const err of errors) {
    const indexMatch = /^(\d+)\./.exec(err.path);
    const index = indexMatch?.[1] !== undefined ? Number(indexMatch[1]) : NaN;
    const cell = Number.isInteger(index) ? CELLS[index] : undefined;
    if (cell) {
      cellErrors[cellKey(cell.role, cell.shift)] = err.message;
    } else {
      generalErrors.push(err.message);
    }
  }

  return { cellErrors, generalErrors };
}
