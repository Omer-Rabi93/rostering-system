import path from 'node:path';

import { config } from 'dotenv';

// Loads DATABASE_URL (and friends) from the repo-root `.env` so integration
// tests can reach the docker-compose.dev.yml Postgres without every test
// invocation needing the shell env pre-populated. `dotenv` never overwrites
// variables already set in `process.env` (e.g. in CI), so this is purely a
// local-dev convenience.
config({ path: path.resolve(import.meta.dirname, '../../../.env') });
