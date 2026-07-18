import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';
import { buildTestApp } from '../helpers/testApp.js';

describe('/api/companies', () => {
  const prisma = getTestPrismaClient();
  const app = buildTestApp();

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  describe('GET /api/companies', () => {
    it('lists companies', async () => {
      await prisma.company.create({ data: { name: 'Alpha Security Ltd.' } });
      await prisma.company.create({ data: { name: 'Beta Guarding Co.' } });

      const response = await request(app).get('/api/companies');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(response.body.map((c: { name: string }) => c.name).sort()).toEqual([
        'Alpha Security Ltd.',
        'Beta Guarding Co.',
      ]);
    });

    it('returns an empty array when there are no companies', async () => {
      const response = await request(app).get('/api/companies');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });
  });

  describe('POST /api/companies', () => {
    it('creates a company', async () => {
      const response = await request(app).post('/api/companies').send({ name: 'Alpha Security Ltd.' });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ name: 'Alpha Security Ltd.' });
      expect(response.body.id).toEqual(expect.any(Number));

      await expect(prisma.company.count()).resolves.toBe(1);
    });

    it('rejects an empty name with 400', async () => {
      const response = await request(app).post('/api/companies').send({ name: '' });

      expect(response.status).toBe(400);
      expect(response.body.errors).toBeInstanceOf(Array);
    });

    it('returns 409 on an exact duplicate name', async () => {
      await request(app).post('/api/companies').send({ name: 'Alpha Security Ltd.' });

      const response = await request(app).post('/api/companies').send({ name: 'Alpha Security Ltd.' });

      expect(response.status).toBe(409);
      expect(response.body).toHaveProperty('message');
    });

    it('returns 409 on a case-insensitive duplicate name', async () => {
      await request(app).post('/api/companies').send({ name: 'Alpha Security Ltd.' });

      const response = await request(app).post('/api/companies').send({ name: 'alpha security ltd.' });

      expect(response.status).toBe(409);
    });
  });

  describe('PATCH /api/companies/:id', () => {
    it('renames a company', async () => {
      const company = await prisma.company.create({ data: { name: 'Old Name Ltd.' } });

      const response = await request(app)
        .patch(`/api/companies/${company.id}`)
        .send({ name: 'New Name Ltd.' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: company.id, name: 'New Name Ltd.' });
    });

    it('returns 404 for an unknown company id', async () => {
      const response = await request(app).patch('/api/companies/999999').send({ name: 'Whatever' });

      expect(response.status).toBe(404);
    });

    it('returns 409 when renaming to an existing name (case-insensitive)', async () => {
      await prisma.company.create({ data: { name: 'Alpha Security Ltd.' } });
      const company = await prisma.company.create({ data: { name: 'Beta Guarding Co.' } });

      const response = await request(app)
        .patch(`/api/companies/${company.id}`)
        .send({ name: 'alpha security ltd.' });

      expect(response.status).toBe(409);
    });
  });

  describe('DELETE /api/companies/:id', () => {
    it('deletes an empty company', async () => {
      const company = await prisma.company.create({ data: { name: 'Alpha Security Ltd.' } });

      const response = await request(app).delete(`/api/companies/${company.id}`);

      expect(response.status).toBe(204);
      await expect(prisma.company.count()).resolves.toBe(0);
    });

    it('returns 404 for an unknown company id', async () => {
      const response = await request(app).delete('/api/companies/999999');

      expect(response.status).toBe(404);
    });

    it('returns 409 when the company still has workers', async () => {
      const company = await prisma.company.create({ data: { name: 'Alpha Security Ltd.' } });
      await prisma.worker.create({
        data: {
          nationalId: '000000018',
          name: 'Test Worker',
          companyId: company.id,
          role: 'GENERAL_GUARD',
        },
      });

      const response = await request(app).delete(`/api/companies/${company.id}`);

      expect(response.status).toBe(409);
      await expect(prisma.company.count()).resolves.toBe(1);
    });
  });
});
