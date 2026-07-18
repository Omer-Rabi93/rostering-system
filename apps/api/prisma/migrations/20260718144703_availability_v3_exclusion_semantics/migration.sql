-- Availability v3: rename `worker_availability.shifts` -> `excludedShifts`. Rename-only, no data
-- backfill -- confirmed no production data exists anywhere in this repo's history (a from-scratch
-- dev project), so any existing dev/seed rows are simply re-authored (see `db/seedData.ts`) to
-- express the same real-world intent under the new "stores EXCLUDED shifts" meaning rather than
-- migrated in place. A plain `RENAME COLUMN` (not drop-and-recreate) so the column's underlying
-- data type/constraints (`VARCHAR(3) NOT NULL`) and any existing rows survive unchanged --
-- deliberately not "rename-in-place-then-let-callers-be-wrong-until-fixed": every reader/writer of
-- this column is updated in this same change (see the design doc, Part F).
ALTER TABLE "worker_availability" RENAME COLUMN "shifts" TO "excludedShifts";
