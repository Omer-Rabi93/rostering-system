import { z } from 'zod';

export const costSummarySchema = z
  .object({
    totalIls: z.number().nonnegative(),
    perCompany: z.array(
      z
        .object({
          companyId: z.number().int(),
          name: z.string().max(120),
          costIls: z.number().nonnegative(),
        })
        .strict(),
    ),
    perWorker: z.array(
      z
        .object({
          workerId: z.number().int(),
          shifts: z.number().int().nonnegative(),
          hours: z.number().nonnegative(),
          costIls: z.number().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export type CostSummary = z.infer<typeof costSummarySchema>;
