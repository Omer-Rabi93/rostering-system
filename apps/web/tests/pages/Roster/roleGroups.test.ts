import { describe, expect, it } from 'vitest';
import type { ShiftAssignment, StaffingRequirement } from '@rostering/shared';

import { buildRoleGroups } from '../../../src/pages/Roster/roleGroups.js';

function assignment(overrides: Partial<ShiftAssignment> = {}): ShiftAssignment {
  return { workerId: 1, name: 'Dana Levi', role: 'GENERAL_GUARD', ...overrides };
}

function requirement(overrides: Partial<StaffingRequirement> = {}): StaffingRequirement {
  return { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 2, ...overrides };
}

describe('buildRoleGroups', () => {
  it('counts a single assigned worker against that role\'s requirement for the given shift', () => {
    const assignments = [assignment({ workerId: 1, name: 'Dana Levi', role: 'GENERAL_GUARD' })];
    const requirements = [requirement({ role: 'GENERAL_GUARD', shift: 'A', requiredCount: 2 })];

    const groups = buildRoleGroups(assignments, requirements, 'A');
    const guardGroup = groups.find((g) => g.role === 'GENERAL_GUARD');

    expect(guardGroup?.assignedCount).toBe(1);
    expect(guardGroup?.requiredCount).toBe(2);
    expect(guardGroup?.assignedWorkers).toEqual([assignments[0]]);
  });

  it('returns all three roles in General Guard / Supervisor / Screener order, even with no assignments or requirements at all', () => {
    const groups = buildRoleGroups([], [], 'B');

    expect(groups.map((g) => g.role)).toEqual(['GENERAL_GUARD', 'SUPERVISOR', 'SCREENER']);
    expect(groups.every((g) => g.assignedCount === 0 && g.requiredCount === 0)).toBe(true);
  });

  it('only counts a requirement cell that matches both the role and the given shift, not a same-role cell for a different shift', () => {
    const requirements = [
      requirement({ role: 'SUPERVISOR', shift: 'A', requiredCount: 5 }),
      requirement({ role: 'SUPERVISOR', shift: 'C', requiredCount: 1 }),
    ];

    const groups = buildRoleGroups([], requirements, 'C');
    const supervisorGroup = groups.find((g) => g.role === 'SUPERVISOR');

    expect(supervisorGroup?.requiredCount).toBe(1);
  });

  it('excludes other roles\' assigned workers from a role\'s own group', () => {
    const assignments = [
      assignment({ workerId: 1, name: 'Dana Levi', role: 'GENERAL_GUARD' }),
      assignment({ workerId: 2, name: 'Omer Cohen', role: 'SUPERVISOR' }),
    ];

    const groups = buildRoleGroups(assignments, [], 'A');
    const guardGroup = groups.find((g) => g.role === 'GENERAL_GUARD');

    expect(guardGroup?.assignedWorkers).toEqual([assignments[0]]);
    expect(guardGroup?.assignedCount).toBe(1);
  });
});
