import { z } from 'zod';

export const companySchema = z
  .object({
    name: z.string().min(1).max(120),
  })
  .strict();

export type Company = z.infer<typeof companySchema>;
