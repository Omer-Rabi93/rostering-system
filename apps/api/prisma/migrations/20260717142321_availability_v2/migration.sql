/*
  Warnings:

  - You are about to drop the column `availability` on the `contracts` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "contracts" DROP COLUMN "availability";

-- CreateTable
CREATE TABLE "worker_availability" (
    "id" SERIAL NOT NULL,
    "workerId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "shifts" VARCHAR(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_availability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worker_availability_date_idx" ON "worker_availability"("date");

-- CreateIndex
CREATE UNIQUE INDEX "worker_availability_workerId_date_key" ON "worker_availability"("workerId", "date");

-- AddForeignKey
ALTER TABLE "worker_availability" ADD CONSTRAINT "worker_availability_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
