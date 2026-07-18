import { Router } from 'express';
import { companySchema } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { CompanyService } from '../services/companyService.js';
import { parseIdParam } from './params.js';

/** Thin HTTP layer for `/api/companies`: parse (Zod) -> service -> respond. */
export function createCompaniesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const companyService = new CompanyService(prisma);

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const companies = await companyService.list();
      res.status(200).json(companies);
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = companySchema.parse(req.body);
      const company = await companyService.create(input);
      res.status(201).json(company);
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseIdParam(req.params.id, 'Company');
      const input = companySchema.parse(req.body);
      const company = await companyService.rename(id, input);
      res.status(200).json(company);
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseIdParam(req.params.id, 'Company');
      await companyService.remove(id);
      res.status(204).send();
    }),
  );

  return router;
}
