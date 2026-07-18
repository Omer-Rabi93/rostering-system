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

  async function makeCompany(name: string) {
    return prisma.company.create({ data: { name } });
  }

  describe('GET /api/staffing-requirements', () => {
    it('returns 400 when companyId is missing', async () => {
      const response = await request(app).get('/api/staffing-requirements');
      expect(response.status).toBe(400);
    });

    it('returns an empty array when nothing is configured', async () => {
      const company = await makeCompany('Req Co 1');
      const response = await request(app).get(`/api/staffing-requirements?companyId=${company.id}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it('returns the configured rows', async () => {
      const company = await makeCompany('Req Co 2');
      await prisma.staffingRequirement.create({ data: { companyId: company.id, role: 'GENERAL_GUARD', shift: 'A', requiredCount: 3 } });

      const response = await request(app).get(`/api/staffing-requirements?companyId=${company.id}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        expect.objectContaining({ role: 'GENERAL_GUARD', shift: 'A', requiredCount: 3 }),
      ]);
    });

    it("never returns another company's rows", async () => {
      const companyA = await makeCompany('Req Co 3A');
      const companyB = await makeCompany('Req Co 3B');
      await prisma.staffingRequirement.create({ data: { companyId: companyA.id, role: 'GENERAL_GUARD', shift: 'A', requiredCount: 3 } });
      await prisma.staffingRequirement.create({ data: { companyId: companyB.id, role: 'GENERAL_GUARD', shift: 'A', requiredCount: 7 } });

      const response = await request(app).get(`/api/staffing-requirements?companyId=${companyA.id}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        expect.objectContaining({ role: 'GENERAL_GUARD', shift: 'A', requiredCount: 3 }),
      ]);
    });
  });

  describe('PUT /api/staffing-requirements', () => {
    it('returns 400 when companyId is missing', async () => {
      const response = await request(app).put('/api/staffing-requirements').send([]);
      expect(response.status).toBe(400);
    });

    it('replaces the full matrix', async () => {
      const company = await makeCompany('Req Co 4');
      await prisma.staffingRequirement.create({ data: { companyId: company.id, role: 'GENERAL_GUARD', shift: 'A', requiredCount: 3 } });

      const response = await request(app)
        .put(`/api/staffing-requirements?companyId=${company.id}`)
        .send([
          { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 2 },
          { role: 'SUPERVISOR', shift: 'B', requiredCount: 1 },
        ]);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);

      const rows = await prisma.staffingRequirement.findMany({ where: { companyId: company.id } });
      expect(rows).toHaveLength(2);
      const guardRow = rows.find((r) => r.role === 'GENERAL_GUARD');
      expect(guardRow?.requiredCount).toBe(2);
    });

    it('a cell zeroed out stays zero after replace (full-matrix replace, not merge)', async () => {
      const company = await makeCompany('Req Co 5');
      await request(app)
        .put(`/api/staffing-requirements?companyId=${company.id}`)
        .send([{ role: 'GENERAL_GUARD', shift: 'A', requiredCount: 5 }]);

      const response = await request(app)
        .put(`/api/staffing-requirements?companyId=${company.id}`)
        .send([{ role: 'GENERAL_GUARD', shift: 'A', requiredCount: 0 }]);

      expect(response.status).toBe(200);
      const rows = await prisma.staffingRequirement.findMany({ where: { companyId: company.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.requiredCount).toBe(0);
    });

    it("replacing one company's matrix leaves every other company's matrix untouched", async () => {
      const companyA = await makeCompany('Req Co 6A');
      const companyB = await makeCompany('Req Co 6B');
      await prisma.staffingRequirement.create({ data: { companyId: companyA.id, role: 'GENERAL_GUARD', shift: 'A', requiredCount: 3 } });
      await prisma.staffingRequirement.create({ data: { companyId: companyB.id, role: 'GENERAL_GUARD', shift: 'A', requiredCount: 9 } });

      const response = await request(app)
        .put(`/api/staffing-requirements?companyId=${companyA.id}`)
        .send([{ role: 'GENERAL_GUARD', shift: 'A', requiredCount: 1 }]);

      expect(response.status).toBe(200);
      const companyBRows = await prisma.staffingRequirement.findMany({ where: { companyId: companyB.id } });
      expect(companyBRows).toHaveLength(1);
      expect(companyBRows[0]?.requiredCount).toBe(9); // untouched by company A's replace
    });

    it('does not error on a duplicate role+shift cell across DIFFERENT companies (only within one company)', async () => {
      const companyA = await makeCompany('Req Co 7A');
      const companyB = await makeCompany('Req Co 7B');
      await prisma.staffingRequirement.create({ data: { companyId: companyA.id, role: 'GENERAL_GUARD', shift: 'A', requiredCount: 3 } });

      const response = await request(app)
        .put(`/api/staffing-requirements?companyId=${companyB.id}`)
        .send([{ role: 'GENERAL_GUARD', shift: 'A', requiredCount: 3 }]);

      expect(response.status).toBe(200); // same role+shift cell as company A, but a different company -> no conflict
    });

    it('returns 400 for a duplicate role+shift cell within the SAME company', async () => {
      const company = await makeCompany('Req Co 8');
      const response = await request(app)
        .put(`/api/staffing-requirements?companyId=${company.id}`)
        .send([
          { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 2 },
          { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 3 },
        ]);

      expect(response.status).toBe(400);
    });

    it('returns 400 for a negative count', async () => {
      const company = await makeCompany('Req Co 9');
      const response = await request(app)
        .put(`/api/staffing-requirements?companyId=${company.id}`)
        .send([{ role: 'GENERAL_GUARD', shift: 'A', requiredCount: -1 }]);

      expect(response.status).toBe(400);
    });
  });
});
