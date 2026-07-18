import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidIsraeliId } from '@rostering/shared';

import { CSV_COLUMNS } from '../../src/csv/index.js';
import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';
import { buildTestApp } from '../helpers/testApp.js';

function validNationalId(prefix: number): string {
  const base = String(prefix).padStart(8, '0');
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${base}${checkDigit}`;
    if (isValidIsraeliId(candidate)) return candidate;
  }
  throw new Error('no valid check digit found');
}

const ID_A = validNationalId(501);
const HEADER = CSV_COLUMNS.join(',');
const SAMPLE_ROW = `${ID_A},Dana Levi,Shamir Security Ltd,Supervisor,Active,62.50,120,182`;

describe('/api/import/workers and /api/export/workers', () => {
  const prisma = getTestPrismaClient();
  let app: Express;

  beforeAll(() => {
    app = buildTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  describe('POST /api/import/workers', () => {
    it('accepts a well-formed CSV upload and returns 202 with a jobId', async () => {
      const response = await request(app)
        .post('/api/import/workers')
        .attach('file', Buffer.from(`${HEADER}\n${SAMPLE_ROW}\n`), { filename: 'workers.csv', contentType: 'text/csv' });

      expect(response.status).toBe(202);
      expect(typeof response.body.jobId).toBe('string');
    });

    it('returns 400 when no file is attached', async () => {
      const response = await request(app).post('/api/import/workers');
      expect(response.status).toBe(400);
    });

    it('returns 400 for a non-CSV file extension/mimetype', async () => {
      const response = await request(app)
        .post('/api/import/workers')
        .attach('file', Buffer.from('not a csv'), { filename: 'workers.txt', contentType: 'text/plain' });

      expect(response.status).toBe(400);
    });

    it('returns 400 for a CSV with a missing/wrong header', async () => {
      const response = await request(app)
        .post('/api/import/workers')
        .attach('file', Buffer.from('a,b,c\n1,2,3\n'), { filename: 'workers.csv', contentType: 'text/csv' });

      expect(response.status).toBe(400);
    });

    it('returns 400 when the file exceeds the size cap', async () => {
      // Comfortably over the 2 MB cap.
      const oversized = Buffer.alloc(3 * 1024 * 1024, 'a');
      const response = await request(app)
        .post('/api/import/workers')
        .attach('file', oversized, { filename: 'workers.csv', contentType: 'text/csv' });

      expect(response.status).toBe(400);
    });

    it('returns 400 when the row count exceeds the max-row cap', async () => {
      const tooManyRows = Array.from({ length: 10_001 }, () => SAMPLE_ROW).join('\n');
      const response = await request(app)
        .post('/api/import/workers')
        .attach('file', Buffer.from(`${HEADER}\n${tooManyRows}\n`), { filename: 'workers.csv', contentType: 'text/csv' });

      expect(response.status).toBe(400);
    }, 15_000);
  });

  describe('GET /api/export/workers', () => {
    it('returns text/csv with the security headers and a re-importable body', async () => {
      const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
      const worker = await prisma.worker.create({
        data: { nationalId: ID_A, name: 'Dana Levi', role: 'SUPERVISOR', status: 'ACTIVE', companyId: company.id },
      });
      await prisma.contract.create({
        data: {
          workerId: worker.id,
          hourlyCostIls: 62.5,
          minMonthlyHours: 120,
          maxMonthlyHours: 182,
        },
      });

      const response = await request(app).get('/api/export/workers');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/csv/);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-disposition']).toMatch(/attachment/);
      expect(response.text.split('\n')[0]).toBe(HEADER);
      expect(response.text).toContain(ID_A);
    });
  });
});
