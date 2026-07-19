import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { PgBoss } from 'pg-boss';

import type { PrismaClient } from './db/client.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createAvailabilityRouter } from './routes/availability.js';
import { createCompaniesRouter } from './routes/companies.js';
import { createWorkersRouter } from './routes/workers.js';
import { createStaffingRequirementsRouter } from './routes/staffingRequirements.js';
import { createRostersRouter } from './routes/rosters.js';
import { createShiftWorkersRouter } from './routes/shiftWorkers.js';
import { createPublicScheduleRouter } from './routes/publicSchedule.js';
import { createWorkforceRouter } from './routes/workforce.js';
import { createImportTasksRouter } from './routes/importTasks.js';
import { createJobsRouter } from './routes/jobs.js';

/**
 * Assembles the Express application: middleware, routes, error handling.
 * Does NOT call `.listen()` — that is the responsibility of `src/index.ts`
 * (the HTTP entrypoint), so the app instance can be imported directly by
 * tests (via Supertest) without binding a port.
 *
 * `prisma` is constructor-injected (well, factory-function-injected) rather
 * than constructed internally, so every route wires through a single shared
 * client and tests can pass the process-wide test client from
 * `tests/helpers/testDb.ts`.
 */
export function createApp(prisma: PrismaClient, boss: PgBoss): Express {
  const app = express();

  // Trust exactly one hop: nginx is the sole reverse proxy in front of this
  // app (docker-compose.yml publishes only nginx's :80; api/worker have no
  // host port). This makes express-rate-limit and req.ip resolve the real
  // client IP from X-Forwarded-For instead of nginx's container IP, without
  // trusting arbitrary spoofed hops if this ever sits behind more proxies.
  app.set('trust proxy', 1);

  // Mounted under `/api` (never at root, so nginx's `location /api` proxying/security headers
  // cover it) and BEFORE the app-wide 100kb JSON body limit below: its own `PUT
  // /api/availability/:month` route applies a wider, route-scoped 2mb `express.json()` limit
  // first (Availability v2 plan's body-size decision — a dense month payload can exceed 100kb
  // well within this app's stated 50-150-worker org size). A request that does not match one of
  // this router's own routes (e.g. `/api/companies`) falls through unchanged to the app-wide
  // parser and the routers mounted below, so every other route keeps the 100kb cap untouched.
  app.use('/api', createAvailabilityRouter(prisma));

  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/api/companies', createCompaniesRouter(prisma));
  app.use('/api/workers', createWorkersRouter(prisma));
  app.use('/api/staffing-requirements', createStaffingRequirementsRouter(prisma));
  app.use('/api/rosters', createRostersRouter(prisma, boss));
  app.use('/api/shifts', createShiftWorkersRouter(prisma));
  // The router itself defines the full `/import/workforce/:month` + `/export/workforce/:month`
  // paths (they don't share a common resource prefix the way `/api/companies` etc. do).
  app.use('/api', createWorkforceRouter(prisma, boss));
  app.use('/api/import-tasks', createImportTasksRouter(prisma));
  app.use('/api/jobs', createJobsRouter(boss));

  // Public, unauthenticated worker-schedule route — per-IP rate limited since there is no auth
  // boundary protecting it. Mounted at `/api/schedule` (NOT the bare `/schedule` the design doc
  // originally sketched): the SPA's own client-side route (React Router, `apps/web/src/routes.tsx`)
  // owns the literal path `/schedule/:token` too, and nginx has no way to tell a browser's
  // top-level document navigation for that page apart from this endpoint's own data fetch when
  // both share one path — it always forwarded to this API, so opening a worker's bookmarked link
  // returned raw JSON instead of the SPA shell. Living under `/api` removes the collision entirely
  // (and matches every other API route) while leaving `/schedule/:token` as a pure frontend route.
  const publicScheduleLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/schedule', publicScheduleLimiter, createPublicScheduleRouter(prisma));

  // Must be mounted after every route — see `errorHandler`'s doc comment.
  app.use(errorHandler);

  return app;
}
