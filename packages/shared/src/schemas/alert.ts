import { z } from 'zod';
import { ROLES, SHIFT_TYPES } from '../constants.js';

const unfillableSlotAlertSchema = z
  .object({
    id: z.number().int(),
    type: z.literal('UNFILLABLE_SLOT'),
    detail: z
      .object({
        date: z.string(),
        shift: z.enum(SHIFT_TYPES),
        role: z.enum(ROLES),
      })
      .strict(),
    acknowledged: z.boolean(),
    acknowledgedAt: z.string().nullable(),
  })
  .strict();

const minHoursShortfallAlertSchema = z
  .object({
    id: z.number().int(),
    type: z.literal('MIN_HOURS_SHORTFALL'),
    detail: z
      .object({
        workerId: z.number().int(),
        deficitHours: z.number(),
      })
      .strict(),
    acknowledged: z.boolean(),
    acknowledgedAt: z.string().nullable(),
  })
  .strict();

export const alertSchema = z.discriminatedUnion('type', [
  unfillableSlotAlertSchema,
  minHoursShortfallAlertSchema,
]);

export type Alert = z.infer<typeof alertSchema>;
