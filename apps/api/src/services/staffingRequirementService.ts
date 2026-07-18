import type { StaffingRequirementsInput } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import type { StaffingRequirement as StaffingRequirementRecord } from '../generated/prisma/client.js';

/**
 * Staffing-requirements matrix business logic. `PUT` is a full-matrix replace — the whole role ×
 * shift set is swapped in one transaction, so a cell the caller omits (or zeroes out) does not
 * silently survive from the previous version.
 */
export class StaffingRequirementService {
  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<StaffingRequirementRecord[]> {
    return this.prisma.staffingRequirement.findMany({ orderBy: [{ role: 'asc' }, { shift: 'asc' }] });
  }

  async replaceAll(rows: StaffingRequirementsInput): Promise<StaffingRequirementRecord[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.staffingRequirement.deleteMany({});
      if (rows.length > 0) {
        await tx.staffingRequirement.createMany({ data: rows });
      }
      return tx.staffingRequirement.findMany({ orderBy: [{ role: 'asc' }, { shift: 'asc' }] });
    });
  }
}
