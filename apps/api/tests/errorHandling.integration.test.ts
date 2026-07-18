import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from './helpers/testDb.js';
import { buildTestApp } from './helpers/testApp.js';

describe('error handling (integration, real DB)', () => {
  const prisma = getTestPrismaClient();
  const app = buildTestApp();

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  it('rejects an oversized JSON body before it reaches a route handler', async () => {
    const oversizedName = 'x'.repeat(200_000); // well over the 100kb express.json() limit

    const response = await request(app).post('/api/companies').send({ name: oversizedName });

    expect(response.status).toBe(413);
    await expect(prisma.company.count()).resolves.toBe(0);
  });

  it('never leaks raw Prisma/DB error detail to the client on an unexpected failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // A companyId that is valid per the Zod schema (positive int) but out of Postgres's int4
    // range triggers a raw, unhandled Prisma/DB error — never a `ConflictError`/`BadRequestError`
    // this service explicitly translates.
    const response = await request(app).post('/api/workers').send({
      nationalId: '000000018',
      name: 'Overflow Worker',
      role: 'GENERAL_GUARD',
      status: 'ACTIVE',
      companyId: 99_999_999_999,
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Internal server error' });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/prisma/i);
    expect(serialized).not.toMatch(/postgres/i);
    expect(serialized).not.toContain('SELECT');
    expect(serialized).not.toContain('INSERT');

    consoleSpy.mockRestore();
  });
});
