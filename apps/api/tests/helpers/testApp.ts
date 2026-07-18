import type { Express } from 'express';
import type { PgBoss } from 'pg-boss';

import { createApp } from '../../src/app.js';
import { createBoss } from '../../src/jobs/queue.js';
import { getTestPrismaClient } from './testDb.js';

let cachedBoss: PgBoss | undefined;

/** A `PgBoss` instance is cheap to *construct* -- connecting/migrating only happens lazily, the
 * first time a route actually sends/reads a job (`jobs/queue.ts`'s `ensureBossStarted`) -- so
 * `buildTestApp` stays synchronous and every existing route-test suite (most of which never touch
 * job routes) needs no changes. */
function getTestBoss(): PgBoss {
  if (!cachedBoss) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is not set for the test pg-boss instance (see tests/setupEnv.ts)');
    }
    cachedBoss = createBoss(databaseUrl);
  }
  return cachedBoss;
}

/** Builds a `createApp` instance wired to the shared process-wide test Prisma client. */
export function buildTestApp(): Express {
  return createApp(getTestPrismaClient(), getTestBoss());
}
