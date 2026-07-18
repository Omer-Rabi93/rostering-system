/**
 * pg-boss worker entrypoint (separate process from the HTTP API). Starts a `PgBoss` instance,
 * registers the `csv-import` and `roster-generation` job handlers (each `localConcurrency: 1`,
 * matching the design doc's `teamSize: 1` intent -- see `jobs/queue.ts`'s doc comment), and
 * schedules the next-month generation cron. Never publishes a roster on its own.
 */
import { createPrismaClient } from './db/client.js';
import { createAvailabilityImportHandler } from './jobs/availabilityImport.job.js';
import { createCsvImportHandler } from './jobs/csvImport.job.js';
import {
  createBoss,
  ensureQueues,
  registerAvailabilityImportWorker,
  registerCsvImportWorker,
  registerRosterGenerationWorker,
  scheduleNextMonthGeneration,
} from './jobs/queue.js';
import { createRosterGenerationHandler } from './jobs/rosterGeneration.job.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env at the repo root and point it at a running Postgres.',
    );
  }

  const prisma = createPrismaClient(databaseUrl);
  const boss = createBoss(databaseUrl);
  boss.on('error', (err: unknown) => {
    console.error('pg-boss error', err);
  });

  await boss.start();
  await ensureQueues(boss);

  await registerCsvImportWorker(boss, createCsvImportHandler(prisma));
  await registerAvailabilityImportWorker(boss, createAvailabilityImportHandler(prisma));
  await registerRosterGenerationWorker(boss, createRosterGenerationHandler(prisma));
  await scheduleNextMonthGeneration(boss);

  console.log(
    'worker: csv-import + availability-import + roster-generation handlers registered; next-month cron scheduled',
  );
}

main().catch((error: unknown) => {
  console.error('worker failed to start', error);
  process.exitCode = 1;
});
