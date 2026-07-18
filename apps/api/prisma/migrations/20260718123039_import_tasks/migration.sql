-- CreateEnum
CREATE TYPE "ImportTaskKind" AS ENUM ('WORKER_SYNC', 'AVAILABILITY_SYNC');

-- CreateEnum
CREATE TYPE "ImportTaskStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "workers" ADD COLUMN     "lastImportTaskId" INTEGER;

-- CreateTable
CREATE TABLE "import_tasks" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "kind" "ImportTaskKind" NOT NULL,
    "status" "ImportTaskStatus" NOT NULL DEFAULT 'PENDING',
    "pgBossJobId" TEXT,
    "month" CHAR(7),
    "totalRows" INTEGER,
    "processedRows" INTEGER,
    "insertedCount" INTEGER,
    "updatedCount" INTEGER,
    "failedCount" INTEGER,
    "errors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "import_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_tasks_companyId_kind_status_idx" ON "import_tasks"("companyId", "kind", "status");

-- CreateIndex
CREATE INDEX "import_tasks_companyId_kind_finishedAt_idx" ON "import_tasks"("companyId", "kind", "finishedAt");

-- AddForeignKey
ALTER TABLE "import_tasks" ADD CONSTRAINT "import_tasks_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workers" ADD CONSTRAINT "workers_lastImportTaskId_fkey" FOREIGN KEY ("lastImportTaskId") REFERENCES "import_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
