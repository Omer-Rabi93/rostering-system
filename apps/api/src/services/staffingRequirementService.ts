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

  list(companyId: number): Promise<StaffingRequirementRecord[]> {
    return this.prisma.staffingRequirement.findMany({
      where: { companyId },
      orderBy: [{ role: 'asc' }, { shift: 'asc' }],
    });
  }

  async replaceAll(companyId: number, rows: StaffingRequirementsInput): Promise<StaffingRequirementRecord[]> {
    return this.prisma.$transaction(async (tx) => {
      // Full-matrix replace is scoped to THIS company only -- every other company's matrix is
      // left completely untouched by a `PUT` for a different `companyId`.
      await tx.staffingRequirement.deleteMany({ where: { companyId } });
      if (rows.length > 0) {
        await tx.staffingRequirement.createMany({ data: rows.map((row) => ({ ...row, companyId })) });
      }
      return tx.staffingRequirement.findMany({ where: { companyId }, orderBy: [{ role: 'asc' }, { shift: 'asc' }] });
    });
  }
}
