// Domain <-> raw-CSV-row mapping: display strings for role/status and decimal/integer parsing for
// the contract fields. Availability v2 moved worker availability out of this CSV entirely (it is
// date-specific, handled by the separate `csv/availability.ts` month-scoped CSV) — this module no
// longer flattens/unflattens any `avail_*` columns. Pure string<->domain conversion only -- the
// formula-injection guard (`guard.ts`) and the CSV file framing (`parse.ts`/`serialize.ts`) are
// separate concerns layered on top of this module.

import type { Role, WorkerStatus } from '@rostering/shared';
import type { CsvRawRow } from './columns.js';

export interface CsvWorkerRecord {
  readonly nationalId: string;
  readonly name: string;
  readonly companyName: string;
  readonly role: Role;
  readonly status: WorkerStatus;
  readonly hourlyCostIls: number;
  readonly minMonthlyHours: number;
  readonly maxMonthlyHours: number;
}

/** Thrown when a single CSV cell cannot be coerced to its expected type/shape. Carries the
 * offending column name so callers (the import job) can report `{row, field, message}` without
 * re-deriving which field failed. */
export class CsvFieldError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'CsvFieldError';
    this.field = field;
  }
}

const ROLE_DISPLAY: Record<Role, string> = {
  GENERAL_GUARD: 'General Guard',
  SUPERVISOR: 'Supervisor',
  SCREENER: 'Screener',
};
const ROLE_FROM_DISPLAY: Record<string, Role> = Object.fromEntries(
  Object.entries(ROLE_DISPLAY).map(([role, display]) => [display, role as Role]),
);

const STATUS_DISPLAY: Record<WorkerStatus, string> = { ACTIVE: 'Active', INACTIVE: 'Inactive' };
const STATUS_FROM_DISPLAY: Record<string, WorkerStatus> = Object.fromEntries(
  Object.entries(STATUS_DISPLAY).map(([status, display]) => [display, status as WorkerStatus]),
);

function parseDecimal(raw: string, field: string): number {
  const value = Number(raw);
  if (raw.trim() === '' || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new CsvFieldError(field, `Expected a decimal number for ${field}, got "${raw}"`);
  }
  return value;
}

function parseInteger(raw: string, field: string): number {
  const value = parseDecimal(raw, field);
  if (!Number.isInteger(value)) {
    throw new CsvFieldError(field, `Expected an integer for ${field}, got "${raw}"`);
  }
  return value;
}

/** Raw (already formula-guard-stripped) CSV row -> typed domain record. Throws `CsvFieldError`
 * (never a generic Error) so the import job can attribute the failure to one column; does NOT
 * apply business rules like the Israeli ID checksum or min <= max hours -- that is
 * `@rostering/shared`'s `workerSchema`/`contractSchema`'s job, run by the caller on the result. */
export function toWorkerRecord(raw: CsvRawRow): CsvWorkerRecord {
  const role = ROLE_FROM_DISPLAY[raw.role];
  if (!role) {
    throw new CsvFieldError('role', `Unknown role "${raw.role}"; expected one of ${Object.keys(ROLE_FROM_DISPLAY).join(', ')}`);
  }
  const status = STATUS_FROM_DISPLAY[raw.status];
  if (!status) {
    throw new CsvFieldError(
      'status',
      `Unknown status "${raw.status}"; expected one of ${Object.keys(STATUS_FROM_DISPLAY).join(', ')}`,
    );
  }

  return {
    nationalId: raw.national_id,
    name: raw.name,
    companyName: raw.company_name,
    role,
    status,
    hourlyCostIls: parseDecimal(raw.hourly_cost_ils, 'hourly_cost_ils'),
    minMonthlyHours: parseInteger(raw.min_monthly_hours, 'min_monthly_hours'),
    maxMonthlyHours: parseInteger(raw.max_monthly_hours, 'max_monthly_hours'),
  };
}

/** Typed domain record -> raw (not yet formula-guarded) CSV row, exactly the 8 documented
 * columns. */
export function fromWorkerRecord(record: CsvWorkerRecord): CsvRawRow {
  return {
    national_id: record.nationalId,
    name: record.name,
    company_name: record.companyName,
    role: ROLE_DISPLAY[record.role],
    status: STATUS_DISPLAY[record.status],
    hourly_cost_ils: record.hourlyCostIls.toFixed(2),
    min_monthly_hours: String(record.minMonthlyHours),
    max_monthly_hours: String(record.maxMonthlyHours),
  };
}
