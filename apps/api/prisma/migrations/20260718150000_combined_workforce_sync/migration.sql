-- Combine the two CSV import pipelines into one: collapse ImportTaskKind's two values
-- (WORKER_SYNC, AVAILABILITY_SYNC) into a single WORKFORCE_SYNC value, and make `month` required
-- (every ImportTask is now always month-scoped, since the combined workforce CSV always targets
-- one month). No production data exists anywhere in this repo's history (confirmed in CLAUDE.md
-- and the original v4/Part-G design docs' own research) -- existing dev/seed import_tasks rows
-- carry the dead two-kind split and have zero downstream value, so this truncates rather than
-- backfilling a month for old worker-only rows that never had one.

UPDATE "workers" SET "lastImportTaskId" = NULL;
DELETE FROM "import_tasks";

ALTER TYPE "ImportTaskKind" RENAME TO "ImportTaskKind_old";
CREATE TYPE "ImportTaskKind" AS ENUM ('WORKFORCE_SYNC');
ALTER TABLE "import_tasks" ALTER COLUMN "kind" TYPE "ImportTaskKind" USING ("kind"::text::"ImportTaskKind");
DROP TYPE "ImportTaskKind_old";

ALTER TABLE "import_tasks" ALTER COLUMN "month" SET NOT NULL;
