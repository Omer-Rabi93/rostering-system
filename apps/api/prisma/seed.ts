import 'dotenv/config';

import { createPrismaClient } from '../src/db/client.js';
import { seedDatabase } from '../src/db/seed.js';

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  try {
    const result = await seedDatabase(prisma);
    console.log('Seed complete:', result);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
});
