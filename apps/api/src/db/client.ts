import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client.js';

export type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Builds a `PrismaClient` wired to a real `pg` driver adapter.
 *
 * Prisma 7 removed the built-in query engine's ability to connect from a
 * `url` declared in `schema.prisma`; the client now always takes an explicit
 * driver adapter (or an Accelerate URL). `@prisma/adapter-pg` is the direct
 * Postgres adapter, so this is the one seam every consumer (seed script,
 * services in later phases, the integration-test harness) goes through
 * rather than each constructing `new PrismaClient(...)` independently.
 */
export function createPrismaClient(databaseUrl: string | undefined = process.env.DATABASE_URL): PrismaClient {
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env at the repo root ' +
        '(and/or apps/api/.env) and point it at a running Postgres — see docker-compose.dev.yml.',
    );
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}
