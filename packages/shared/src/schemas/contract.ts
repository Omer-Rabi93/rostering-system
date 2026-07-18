import { z } from 'zod';

/**
 * A worker's contract terms: hourly rate and the monthly hours band. Availability is NOT a
 * contract field (Availability v2): it is date-specific, one `WorkerAvailability` entry per
 * `(worker, calendar date)` — see `schemas/availability.ts` (`shiftSubsetSchema`,
 * `availabilityEntrySchema`, `monthAvailabilitySchema`).
 */
export const contractSchema = z
  .object({
    hourlyCostIls: z.number().nonnegative(),
    minMonthlyHours: z.number().int().nonnegative(),
    maxMonthlyHours: z.number().int().nonnegative(),
  })
  .strict()
  .refine((c) => c.minMonthlyHours <= c.maxMonthlyHours, {
    message: 'minMonthlyHours must be <= maxMonthlyHours',
    path: ['minMonthlyHours'],
  });

export type Contract = z.infer<typeof contractSchema>;
