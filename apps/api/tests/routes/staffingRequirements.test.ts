import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';
import { buildTestApp } from '../helpers/testApp.js';

describe('/api/staffing-requirements', () => {
  const prisma = getTestPrismaClient();
  const app = buildTestApp();

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  describe('GET /api/staffing-requirements', () => {
    it('returns an empty array when nothing is configured', async () => {
      const response = await request(app).get('/api/staffing-requirements');
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it('returns the configured rows', async () => {
      await prisma.staffingRequirement.create({ data: { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 3 } });

      const response = await request(app).get('/api/staffing-requirements');
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        expect.objectContaining({ role: 'GENERAL_GUARD', shift: 'A', requiredCount: 3 }),
      ]);
    });
  });

  describe('PUT /api/staffing-requirements', () => {
    it('replaces the full matrix', async () => {
      await prisma.staffingRequirement.create({ data: { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 3 } });

      const response = await request(app)
        .put('/api/staffing-requirements')
        .send([
          { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 2 },
          { role: 'SUPERVISOR', shift: 'B', requiredCount: 1 },
        ]);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);

      const rows = await prisma.staffingRequirement.findMany();
      expect(rows).toHaveLength(2);
      const guardRow = rows.find((r) => r.role === 'GENERAL_GUARD');
      expect(guardRow?.requiredCount).toBe(2);
    });

    it('a cell zeroed out stays zero after replace (full-matrix replace, not merge)', async () => {
      await request(app)
        .put('/api/staffing-requirements')
        .send([{ role: 'GENERAL_GUARD', shift: 'A', requiredCount: 5 }]);

      const response = await request(app)
        .put('/api/staffing-requirements')
        .send([{ role: 'GENERAL_GUARD', shift: 'A', requiredCount: 0 }]);

      expect(response.status).toBe(200);
      const rows = await prisma.staffingRequirement.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.requiredCount).toBe(0);
    });

    it('returns 400 for a duplicate role+shift cell', async () => {
      const response = await request(app)
        .put('/api/staffing-requirements')
        .send([
          { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 2 },
          { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 3 },
        ]);

      expect(response.status).toBe(400);
    });

    it('returns 400 for a negative count', async () => {
      const response = await request(app)
        .put('/api/staffing-requirements')
        .send([{ role: 'GENERAL_GUARD', shift: 'A', requiredCount: -1 }]);

      expect(response.status).toBe(400);
    });
  });
});
