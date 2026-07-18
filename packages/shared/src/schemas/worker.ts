import { z } from 'zod';
import { ROLES, WORKER_STATUSES } from '../constants.js';
import { isValidIsraeliId } from '../validation/israeliId.js';

export const workerSchema = z
  .object({
    nationalId: z.string().refine(isValidIsraeliId, 'Invalid Israeli ID checksum'),
    name: z.string().min(1).max(120),
    role: z.enum(ROLES),
    status: z.enum(WORKER_STATUSES),
    companyId: z.number().int().positive(),
  })
  .strict();

export type Worker = z.infer<typeof workerSchema>;
