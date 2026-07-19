// Barrel export for `@rostering/shared`.
//
// Holds Zod schemas, inferred TypeScript types, and shared constants (e.g.
// `SHIFT_TYPES`, `ROLES`, `SHIFT_HOURS`) consumed by both `apps/api` and
// `apps/web`.

export { isValidIsraeliId } from './validation/israeliId.js';

export {
  SHIFT_HOURS,
  SHIFT_TYPES,
  type ShiftType,
  computeAvailableShifts,
  shiftSubsetFromString,
  ROLES,
  type Role,
  WORKER_STATUSES,
  type WorkerStatus,
  ROSTER_STATUSES,
  type RosterStatus,
  ALERT_TYPES,
  type AlertType,
} from './constants.js';

export { companySchema, type Company } from './schemas/company.js';

export { monthSchema, type Month } from './schemas/month.js';

export { workerSchema, type Worker } from './schemas/worker.js';

export { contractSchema, type Contract } from './schemas/contract.js';

export {
  shiftSubsetSchema,
  type ShiftSubset,
  dateInMonthSchema,
  availabilityEntrySchema,
  type AvailabilityEntry,
  monthAvailabilitySchema,
  type MonthAvailability,
} from './schemas/availability.js';

export {
  staffingRequirementSchema,
  type StaffingRequirement,
  staffingRequirementsInputSchema,
  type StaffingRequirementsInput,
} from './schemas/staffingRequirement.js';

export { alertSchema, type Alert } from './schemas/alert.js';

export {
  shiftAssignmentSchema,
  type ShiftAssignment,
  shiftSchema,
  type Shift,
  rosterSchema,
  type Roster,
} from './schemas/roster.js';

export { costSummarySchema, type CostSummary } from './schemas/costSummary.js';

export {
  jobSchema,
  type Job,
  JOB_NAMES,
  JOB_STATES,
  importResultSchema,
  type ImportResult,
  rosterGenerationResultSchema,
  type RosterGenerationResult,
  jobErrorResultSchema,
  type JobErrorResult,
} from './schemas/job.js';

export {
  badRequestErrorSchema,
  type BadRequestError,
  notFoundErrorSchema,
  type NotFoundError,
  unprocessableErrorSchema,
  type UnprocessableError,
  conflictWarningErrorSchema,
  type ConflictWarningError,
  conflictMessageErrorSchema,
  type ConflictMessageError,
  publishConflictErrorSchema,
  type PublishConflictError,
} from './schemas/errors.js';
