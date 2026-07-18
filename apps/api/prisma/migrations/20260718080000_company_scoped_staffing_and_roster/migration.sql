-- Per-company rostering: `StaffingRequirement` and `Roster` move from global (one matrix / one
-- roster per calendar month, shared across every company) to company-scoped (each company gets
-- its own independent staffing-requirements matrix and its own roster per month).
--
-- Backfill strategy (dev/seed-only database, not production data -- see the report for the
-- decision): any pre-existing `staffing_requirements` / `rosters` rows have no company today, so
-- there is no principled way to attribute them to one company over another. They are backfilled
-- onto the single, lowest-`id` (i.e. first-created) `Company` row -- matching the seed data's
-- "Alpha Security Ltd." as the first of the three seeded companies. Re-running `db:seed` after
-- this migration seeds the same default staffing-requirements matrix independently for every
-- company (see `src/db/seed.ts`), so the other seeded companies (Beta, Gamma) end up with their
-- own rows rather than silently starting empty. If the target database has zero companies AND
-- zero staffing_requirements/rosters rows (a genuinely fresh database), the backfill UPDATE is a
-- no-op and the subsequent NOT NULL is trivially satisfied.

-- DropIndex
DROP INDEX "rosters_month_key";

-- DropIndex
DROP INDEX "staffing_requirements_role_shift_key";

-- AlterTable: add companyId nullable first so existing rows can be backfilled before the NOT NULL
-- constraint is applied.
ALTER TABLE "rosters" ADD COLUMN "companyId" INTEGER;
ALTER TABLE "staffing_requirements" ADD COLUMN "companyId" INTEGER;

-- Backfill existing rows onto the first (lowest-id) company, per the decision above.
UPDATE "rosters" SET "companyId" = (SELECT "id" FROM "companies" ORDER BY "id" ASC LIMIT 1)
WHERE "companyId" IS NULL;

UPDATE "staffing_requirements" SET "companyId" = (SELECT "id" FROM "companies" ORDER BY "id" ASC LIMIT 1)
WHERE "companyId" IS NULL;

-- AlterTable: now safe to enforce NOT NULL.
ALTER TABLE "rosters" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "staffing_requirements" ALTER COLUMN "companyId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "rosters_companyId_idx" ON "rosters"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "rosters_companyId_month_key" ON "rosters"("companyId", "month");

-- CreateIndex
CREATE INDEX "staffing_requirements_companyId_idx" ON "staffing_requirements"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "staffing_requirements_companyId_role_shift_key" ON "staffing_requirements"("companyId", "role", "shift");

-- AddForeignKey
ALTER TABLE "staffing_requirements" ADD CONSTRAINT "staffing_requirements_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
