import { z } from 'zod';
import { ROLES, SHIFT_TYPES } from '../constants.js';

export const staffingRequirementSchema = z
  .object({
    role: z.enum(ROLES),
    shift: z.enum(SHIFT_TYPES),
    requiredCount: z.number().int().nonnegative(),
  })
  .strict();

export type StaffingRequirement = z.infer<typeof staffingRequirementSchema>;

export const staffingRequirementsInputSchema = z
  .array(staffingRequirementSchema)
  .refine(
    (rows) => {
      const cells = rows.map((r) => `${r.role}:${r.shift}`);
      return new Set(cells).size === cells.length;
    },
    { message: 'Duplicate role+shift cell' },
  );

export type StaffingRequirementsInput = z.infer<typeof staffingRequirementsInputSchema>;
