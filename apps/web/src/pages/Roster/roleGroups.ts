import { ROLES } from '@rostering/shared';
import type { Role, ShiftAssignment, ShiftType, StaffingRequirement } from '@rostering/shared';

export interface RoleGroup {
  readonly role: Role;
  readonly assignedCount: number;
  readonly requiredCount: number;
  readonly assignedWorkers: readonly ShiftAssignment[];
}

/**
 * Groups a shift's assignments by role and pairs each group with its staffing requirement (the
 * "Y" in "assigned X of Y required") for that exact shift type — `StaffingRequirement` is a
 * role × shift matrix cell, so the same role can require a different headcount on shift A vs B/C.
 * Always returns one group per `ROLES` entry, in `ROLES`' declared order (General Guard,
 * Supervisor, Screener), even when a role has zero assignments and/or a zero requirement — a
 * role group is never hidden just because nothing is required or assigned for it.
 */
export function buildRoleGroups(
  assignments: readonly ShiftAssignment[],
  staffingRequirements: readonly StaffingRequirement[],
  shift: ShiftType,
): RoleGroup[] {
  return ROLES.map((role) => {
    const assignedWorkers = assignments.filter((a) => a.role === role);
    const requiredCount =
      staffingRequirements.find((r) => r.role === role && r.shift === shift)?.requiredCount ?? 0;
    return { role, assignedCount: assignedWorkers.length, requiredCount, assignedWorkers };
  });
}
