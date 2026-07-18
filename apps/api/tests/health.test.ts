import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildTestApp } from './helpers/testApp.js';

describe('GET /api/health', () => {
  it('returns 200 ok', async () => {
    const app = buildTestApp();

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
