import { z } from 'zod';

export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected format YYYY-MM');

export type Month = z.infer<typeof monthSchema>;
