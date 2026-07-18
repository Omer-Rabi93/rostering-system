import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { CompanyService } from '../../src/services/companyService.js';
import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';

describe('CompanyService.resolveOrCreate', () => {
  const prisma = getTestPrismaClient();
  const companyService = new CompanyService(prisma);

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  it('creates a new company when no case-insensitive match exists', async () => {
    const company = await companyService.resolveOrCreate('Shamir Security Ltd');
    expect(company.id).toEqual(expect.any(Number));
    expect(company.name).toBe('Shamir Security Ltd');
  });

  it('resolves to the existing company by case-insensitive name instead of creating a duplicate', async () => {
    const created = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });

    const resolved = await companyService.resolveOrCreate('SHAMIR security LTD');

    expect(resolved.id).toBe(created.id);
    const all = await prisma.company.findMany();
    expect(all).toHaveLength(1);
  });

  it('accepts an explicit transaction client so callers can resolve-or-create inside a larger transaction', async () => {
    const company = await prisma.$transaction(async (tx) => companyService.resolveOrCreate('Beta Guarding Co.', tx));
    expect(company.name).toBe('Beta Guarding Co.');
  });
});
