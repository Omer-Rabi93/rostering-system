import { createApp } from './app.js';
import { createPrismaClient } from './db/client.js';
import { createBoss } from './jobs/queue.js';

/**
 * HTTP entrypoint: imports the assembled app and starts listening.
 * Kept separate from `app.ts` so the app instance can be imported by tests
 * without binding a port.
 */
const port = process.env['PORT'] ?? 3000;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env at the repo root and point it at a running Postgres.',
  );
}

const prisma = createPrismaClient(databaseUrl);
// The API process only ever *sends*/reads jobs (never `.work()`s a queue -- that's `worker.ts`'s
// job); the boss instance is created here but its `start()` + schema migration is lazy, run on
// first job send/read (`jobs/queue.ts`'s `ensureBossStarted`).
const boss = createBoss(databaseUrl);
const app = createApp(prisma, boss);

app.listen(port, () => {
  console.log(`api listening on port ${port}`);
});
