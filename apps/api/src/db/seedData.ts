import { isValidIsraeliId, ROLES, SHIFT_TYPES, type Role, type ShiftType, type WorkerStatus } from '@rostering/shared';
import type { Month } from '@rostering/shared';
import { monthDays, weekdayIndex } from '../engine/calendar.js';

/**
 * Deterministically derives a checksum-valid 9-digit Israeli national ID from
 * an 8-digit prefix, using the real `isValidIsraeliId` validator (rather than
 * hand-computing/transcribing check digits) so seed data can never drift out
 * of sync with the checksum algorithm.
 */
function deriveValidIsraeliId(prefix: number): string {
  const base = String(prefix).padStart(8, '0');
  if (base.length !== 8) {
    throw new Error(`prefix must fit in 8 digits, got ${base}`);
  }
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${base}${checkDigit}`;
    if (isValidIsraeliId(candidate)) {
      return candidate;
    }
  }
  throw new Error(`no valid check digit found for prefix ${base}`);
}

/** One row per role × shift — the default staffing requirement, per the design doc. */
export const SEED_STAFFING_REQUIREMENTS: ReadonlyArray<{
  role: Role;
  shift: ShiftType;
  requiredCount: number;
}> = ROLES.flatMap((role) =>
  SHIFT_TYPES.map((shift) => ({
    role,
    shift,
    requiredCount: role === 'GENERAL_GUARD' ? 3 : role === 'SUPERVISOR' ? 1 : 2,
  })),
);

export const SEED_COMPANY_NAMES = ['Alpha Security Ltd.', 'Beta Guarding Co.', 'Gamma Protective Services'] as const;

/**
 * Which days of the week the worker is available at all, Sunday-first (index 0 = Sunday … index 6
 * = Saturday), matching the `avail_sun … avail_sat` CSV column order the Phase 6 sample file uses.
 * Matches `contractSchema`'s `availableDays` shape from `@rostering/shared`.
 */
export type AvailableDays = readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
/** Which of the three daily shifts the worker can ever be assigned to, in shift order A, B, C,
 * matching the `avail_shift_a … avail_shift_c` CSV column order. Matches `contractSchema`'s
 * `availableShifts` shape. */
export type AvailableShifts = readonly [boolean, boolean, boolean];

const ALL_DAYS: AvailableDays = [true, true, true, true, true, true, true];
const ALL_SHIFTS: AvailableShifts = [true, true, true];
/** Every shift except C (e.g. a worker who can't do nights). */
const NO_NIGHT_SHIFT: AvailableShifts = [true, true, false];
/** Sun–Thu only (Fri–Sat excluded). */
const WEEKDAYS: AvailableDays = [true, true, true, true, true, false, false];

export interface SeedWorkerInput {
  nationalId: string;
  name: string;
  companyName: (typeof SEED_COMPANY_NAMES)[number];
  role: Role;
  status: WorkerStatus;
  hourlyCostIls: number;
  minMonthlyHours: number;
  maxMonthlyHours: number;
  availableDays: AvailableDays;
  availableShifts: AvailableShifts;
}

/**
 * ≥10 workers with contracts, matching flat CSV-row structure (national ID,
 * name, company name, role, status, contract fields, availability) so this
 * fixture can double as the basis for the Phase 6 sample CSV file.
 */
export const SEED_WORKERS: readonly SeedWorkerInput[] = [
  {
    nationalId: deriveValidIsraeliId(1),
    name: 'Noa Levi',
    companyName: 'Alpha Security Ltd.',
    role: 'GENERAL_GUARD',
    status: 'ACTIVE',
    hourlyCostIls: 45,
    minMonthlyHours: 120,
    maxMonthlyHours: 200,
    availableDays: ALL_DAYS,
    availableShifts: ALL_SHIFTS,
  },
  {
    nationalId: deriveValidIsraeliId(2),
    name: 'Avi Cohen',
    companyName: 'Alpha Security Ltd.',
    role: 'GENERAL_GUARD',
    status: 'ACTIVE',
    hourlyCostIls: 45,
    minMonthlyHours: 100,
    maxMonthlyHours: 180,
    availableDays: ALL_DAYS,
    availableShifts: NO_NIGHT_SHIFT,
  },
  {
    nationalId: deriveValidIsraeliId(3),
    name: 'Dana Mizrahi',
    companyName: 'Alpha Security Ltd.',
    role: 'SUPERVISOR',
    status: 'ACTIVE',
    hourlyCostIls: 65,
    minMonthlyHours: 140,
    maxMonthlyHours: 200,
    availableDays: ALL_DAYS,
    availableShifts: ALL_SHIFTS,
  },
  {
    nationalId: deriveValidIsraeliId(4),
    name: 'Yossi Peretz',
    companyName: 'Alpha Security Ltd.',
    role: 'SCREENER',
    status: 'ACTIVE',
    hourlyCostIls: 50,
    minMonthlyHours: 120,
    maxMonthlyHours: 180,
    availableDays: WEEKDAYS,
    availableShifts: ALL_SHIFTS,
  },
  {
    nationalId: deriveValidIsraeliId(5),
    name: 'Michal Katz',
    companyName: 'Beta Guarding Co.',
    role: 'GENERAL_GUARD',
    status: 'ACTIVE',
    hourlyCostIls: 47,
    minMonthlyHours: 120,
    maxMonthlyHours: 200,
    availableDays: ALL_DAYS,
    availableShifts: ALL_SHIFTS,
  },
  {
    nationalId: deriveValidIsraeliId(6),
    name: 'Eitan Shapira',
    companyName: 'Beta Guarding Co.',
    role: 'GENERAL_GUARD',
    status: 'INACTIVE',
    hourlyCostIls: 47,
    minMonthlyHours: 100,
    maxMonthlyHours: 160,
    availableDays: ALL_DAYS,
    availableShifts: ALL_SHIFTS,
  },
  {
    nationalId: deriveValidIsraeliId(7),
    name: 'Tamar Golan',
    companyName: 'Beta Guarding Co.',
    role: 'SUPERVISOR',
    status: 'ACTIVE',
    hourlyCostIls: 68,
    minMonthlyHours: 140,
    maxMonthlyHours: 200,
    availableDays: ALL_DAYS,
    availableShifts: NO_NIGHT_SHIFT,
  },
  {
    nationalId: deriveValidIsraeliId(8),
    name: 'Roi Ben-David',
    companyName: 'Beta Guarding Co.',
    role: 'SCREENER',
    status: 'ACTIVE',
    hourlyCostIls: 52,
    minMonthlyHours: 120,
    maxMonthlyHours: 190,
    availableDays: ALL_DAYS,
    availableShifts: ALL_SHIFTS,
  },
  {
    nationalId: deriveValidIsraeliId(9),
    name: 'Shira Azulay',
    companyName: 'Gamma Protective Services',
    role: 'GENERAL_GUARD',
    status: 'ACTIVE',
    hourlyCostIls: 46,
    minMonthlyHours: 120,
    maxMonthlyHours: 200,
    availableDays: ALL_DAYS,
    availableShifts: ALL_SHIFTS,
  },
  {
    nationalId: deriveValidIsraeliId(10),
    name: 'Omer Biton',
    companyName: 'Gamma Protective Services',
    role: 'GENERAL_GUARD',
    status: 'ACTIVE',
    hourlyCostIls: 46,
    minMonthlyHours: 100,
    maxMonthlyHours: 180,
    availableDays: WEEKDAYS,
    availableShifts: ALL_SHIFTS,
  },
  {
    nationalId: deriveValidIsraeliId(11),
    name: 'Liora Sharabi',
    companyName: 'Gamma Protective Services',
    role: 'SUPERVISOR',
    status: 'ACTIVE',
    hourlyCostIls: 66,
    minMonthlyHours: 140,
    maxMonthlyHours: 200,
    availableDays: ALL_DAYS,
    availableShifts: ALL_SHIFTS,
  },
  {
    nationalId: deriveValidIsraeliId(12),
    name: 'Guy Amrani',
    companyName: 'Gamma Protective Services',
    role: 'SCREENER',
    status: 'INACTIVE',
    hourlyCostIls: 51,
    minMonthlyHours: 110,
    maxMonthlyHours: 180,
    availableDays: ALL_DAYS,
    availableShifts: NO_NIGHT_SHIFT,
  },
];

/**
 * The `YYYY-MM` month immediately after `now`'s calendar month — Availability v2 rows are seeded
 * for this month (the month a planner would next be entering availability for), computed at seed
 * time rather than hardcoded so the fixture never silently drifts into the past.
 */
export function nextCalendarMonth(now: Date = new Date()): Month {
  const year = now.getUTCFullYear();
  const month0 = now.getUTCMonth(); // 0-11
  const nextMonth0 = (month0 + 1) % 12;
  const nextYear = month0 === 11 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth0 + 1).padStart(2, '0')}`;
}

/** `availableShifts` -> the canonical EXCLUDED shift-subset string (`SHIFT_TYPES` order, e.g.
 * `"C"`, `""`) `WorkerAvailability.excludedShifts` stores for a date the worker IS available at
 * all (Availability v3: the row lists what the worker CANNOT work, the complement of
 * `availableShifts`). Can be empty (fully available that date, e.g. `ALL_SHIFTS`) -- callers must
 * treat an empty result as "no row needed", never store it (the schema's non-empty-or-absent
 * invariant). */
function excludedShiftSubsetForFixture(availableShifts: AvailableShifts): string {
  return SHIFT_TYPES.filter((_, i) => !availableShifts[i]).join('');
}

/**
 * Derives this fixture worker's Availability v3 rows for `month`, preserving its old weekly-matrix
 * intent under the new "row stores EXCLUDED shifts, absence = available for everything" meaning:
 *
 * - A date whose weekday is NOT in `availableDays` (e.g. a weekend for the "weekdays only"
 *   fixture) is fully unavailable that date -- expressed as an explicit `excludedShifts: "ABC"`
 *   row (the new way to represent what row-absence used to mean), not by omitting the row (that
 *   would now mean the opposite: available for everything).
 * - A date whose weekday IS in `availableDays` gets a row carrying the complement of
 *   `availableShifts` (e.g. `NO_NIGHT_SHIFT`'s `[true, true, false]` -> excluded `"C"`) -- UNLESS
 *   the worker is available for every shift that date (`ALL_SHIFTS`), in which case the complement
 *   is empty and NO row is seeded at all (an empty `excludedShifts` is never stored; row-absence
 *   already means "available everything," so it needs no row to say so).
 */
export function buildSeedAvailabilityRows(
  seedWorker: SeedWorkerInput,
  month: Month,
): ReadonlyArray<{ date: string; excludedShifts: string }> {
  const excludedWhenAvailable = excludedShiftSubsetForFixture(seedWorker.availableShifts);
  return monthDays(month)
    .map((date) => ({
      date,
      excludedShifts: seedWorker.availableDays[weekdayIndex(date)] ? excludedWhenAvailable : 'ABC',
    }))
    .filter((row) => row.excludedShifts.length > 0);
}
