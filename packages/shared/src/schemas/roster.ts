import { z } from 'zod';
import { ROLES, ROSTER_STATUSES, SHIFT_TYPES } from '../constants.js';
import { alertSchema } from './alert.js';
import { monthSchema } from './month.js';

export const shiftAssignmentSchema = z
  .object({
    workerId: z.number().int(),
    name: z.string().max(120),
    role: z.enum(ROLES),
  })
  .strict();

export const shiftSchema = z
  .object({
    id: z.number().int(),
    date: z.string(),
    shiftType: z.enum(SHIFT_TYPES),
    assignments: z.array(shiftAssignmentSchema),
  })
  .strict();

export const rosterSchema = z
  .object({
    id: z.number().int(),
    month: monthSchema,
    status: z.enum(ROSTER_STATUSES),
    generatedAt: z.string().nullable(),
    publishedAt: z.string().nullable(),
    shifts: z.array(shiftSchema),
    alerts: z.array(alertSchema),
  })
  .strict();

export type ShiftAssignment = z.infer<typeof shiftAssignmentSchema>;
export type Shift = z.infer<typeof shiftSchema>;
export type Roster = z.infer<typeof rosterSchema>;
