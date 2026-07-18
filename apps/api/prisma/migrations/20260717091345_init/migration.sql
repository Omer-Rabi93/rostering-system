-- CreateEnum
CREATE TYPE "Role" AS ENUM ('GENERAL_GUARD', 'SUPERVISOR', 'SCREENER');

-- CreateEnum
CREATE TYPE "ShiftType" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "RosterStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('UNFILLABLE_SLOT', 'MIN_HOURS_SHORTFALL');

-- CreateTable
CREATE TABLE "companies" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workers" (
    "id" SERIAL NOT NULL,
    "nationalId" CHAR(9) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "companyId" INTEGER NOT NULL,
    "role" "Role" NOT NULL,
    "status" "WorkerStatus" NOT NULL DEFAULT 'ACTIVE',
    "shareToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" SERIAL NOT NULL,
    "workerId" INTEGER NOT NULL,
    "hourlyCostIls" DECIMAL(8,2) NOT NULL,
    "minMonthlyHours" INTEGER NOT NULL,
    "maxMonthlyHours" INTEGER NOT NULL,
    "availability" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staffing_requirements" (
    "id" SERIAL NOT NULL,
    "role" "Role" NOT NULL,
    "shift" "ShiftType" NOT NULL,
    "requiredCount" INTEGER NOT NULL,

    CONSTRAINT "staffing_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rosters" (
    "id" SERIAL NOT NULL,
    "month" CHAR(7) NOT NULL,
    "status" "RosterStatus" NOT NULL DEFAULT 'DRAFT',
    "generatedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "rosters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" SERIAL NOT NULL,
    "rosterId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "shiftType" "ShiftType" NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_workers" (
    "shiftId" INTEGER NOT NULL,
    "workerId" INTEGER NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "shift_workers_pkey" PRIMARY KEY ("shiftId","workerId")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" SERIAL NOT NULL,
    "rosterId" INTEGER NOT NULL,
    "type" "AlertType" NOT NULL,
    "detail" JSONB NOT NULL,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workers_nationalId_key" ON "workers"("nationalId");

-- CreateIndex
CREATE UNIQUE INDEX "workers_shareToken_key" ON "workers"("shareToken");

-- CreateIndex
CREATE INDEX "workers_companyId_idx" ON "workers"("companyId");

-- CreateIndex
CREATE INDEX "workers_status_idx" ON "workers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_workerId_key" ON "contracts"("workerId");

-- CreateIndex
CREATE UNIQUE INDEX "staffing_requirements_role_shift_key" ON "staffing_requirements"("role", "shift");

-- CreateIndex
CREATE UNIQUE INDEX "rosters_month_key" ON "rosters"("month");

-- CreateIndex
CREATE INDEX "shifts_rosterId_date_idx" ON "shifts"("rosterId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_rosterId_date_shiftType_key" ON "shifts"("rosterId", "date", "shiftType");

-- CreateIndex
CREATE INDEX "shift_workers_workerId_idx" ON "shift_workers"("workerId");

-- CreateIndex
CREATE INDEX "alerts_rosterId_idx" ON "alerts"("rosterId");

-- AddForeignKey
ALTER TABLE "workers" ADD CONSTRAINT "workers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "rosters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_workers" ADD CONSTRAINT "shift_workers_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_workers" ADD CONSTRAINT "shift_workers_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "rosters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Case-insensitive uniqueness on company name (not expressible in schema.prisma;
-- Prisma has no functional/expression-index syntax for lower(name)).
CREATE UNIQUE INDEX "companies_lower_name_key" ON "companies" (lower("name"));

-- Partial index: every engine/candidate query filters on active workers only.
CREATE INDEX "workers_id_active_idx" ON "workers" ("id") WHERE "status" = 'ACTIVE';
