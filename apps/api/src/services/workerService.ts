import { randomUUID } from 'node:crypto';

import type { Contract as ContractInput, Role, Worker as WorkerInput, WorkerStatus } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import type {
  Contract as ContractRecord,
  Prisma,
  Worker as WorkerRecord,
} from '../generated/prisma/client.js';
import { isForeignKeyConstraintViolation, isUniqueConstraintViolation } from '../db/prismaErrors.js';
import { BadRequestError, ConflictError, NotFoundError } from '../errors.js';

export interface WorkerFilters {
  readonly status?: WorkerStatus | undefined;
  readonly role?: Role | undefined;
  readonly companyId?: number | undefined;
  readonly q?: string | undefined;
}

// Availability v2: `Contract` carries only rate/min/max hours. Date-specific availability lives
// in the separate `WorkerAvailability` table (see `prisma/schema.prisma`), surfaced by its own
// service/route in Phase V4 — it is intentionally absent from `ContractResponse`.
export interface ContractResponse {
  readonly workerId: number;
  readonly hourlyCostIls: number;
  readonly minMonthlyHours: number;
  readonly maxMonthlyHours: number;
  readonly updatedAt: Date;
}

export interface WorkerResponse extends WorkerRecord {
  readonly contract: ContractResponse | null;
}

function toContractResponse(contract: ContractRecord): ContractResponse {
  return {
    workerId: contract.workerId,
    hourlyCostIls: Number(contract.hourlyCostIls),
    minMonthlyHours: contract.minMonthlyHours,
    maxMonthlyHours: contract.maxMonthlyHours,
    updatedAt: contract.updatedAt,
  };
}

/**
 * Worker + Contract business logic, `PrismaClient` constructor-injected. No Express types leak in
 * here — plain arguments, plain return values, typed errors for the route layer to translate.
 */
export class WorkerService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(filters: WorkerFilters): Promise<WorkerResponse[]> {
    const where: Prisma.WorkerWhereInput = {};
    if (filters.status) where.status = filters.status;
    if (filters.role) where.role = filters.role;
    if (filters.companyId !== undefined) where.companyId = filters.companyId;
    if (filters.q) {
      where.OR = [
        { name: { contains: filters.q, mode: 'insensitive' } },
        { nationalId: { contains: filters.q } },
      ];
    }

    const workers = await this.prisma.worker.findMany({
      where,
      include: { contract: true },
      orderBy: { id: 'asc' },
    });
    return workers.map((w) => ({ ...w, contract: w.contract ? toContractResponse(w.contract) : null }));
  }

  async getById(id: number): Promise<WorkerResponse> {
    const worker = await this.prisma.worker.findUnique({ where: { id }, include: { contract: true } });
    if (!worker) {
      throw new NotFoundError(`Worker ${id} not found`);
    }
    return { ...worker, contract: worker.contract ? toContractResponse(worker.contract) : null };
  }

  async create(input: WorkerInput): Promise<WorkerRecord> {
    try {
      return await this.prisma.worker.create({
        data: {
          nationalId: input.nationalId,
          name: input.name,
          role: input.role,
          status: input.status,
          companyId: input.companyId,
        },
      });
    } catch (err) {
      throw this.translateWriteError(err, input);
    }
  }

  async update(id: number, input: WorkerInput): Promise<WorkerRecord> {
    await this.getOrThrow(id);
    try {
      return await this.prisma.worker.update({
        where: { id },
        data: {
          nationalId: input.nationalId,
          name: input.name,
          role: input.role,
          status: input.status,
          companyId: input.companyId,
        },
      });
    } catch (err) {
      throw this.translateWriteError(err, input);
    }
  }

  async remove(id: number): Promise<void> {
    await this.getOrThrow(id);
    try {
      await this.prisma.worker.delete({ where: { id } });
    } catch (err) {
      if (isForeignKeyConstraintViolation(err)) {
        throw new ConflictError(
          `Worker ${id} has shift history and cannot be deleted; set status to INACTIVE instead`,
        );
      }
      throw err;
    }
  }

  async getContract(workerId: number): Promise<ContractResponse> {
    await this.getOrThrow(workerId);
    const contract = await this.prisma.contract.findUnique({ where: { workerId } });
    if (!contract) {
      throw new NotFoundError(`Worker ${workerId} has no contract yet`);
    }
    return toContractResponse(contract);
  }

  async upsertContract(workerId: number, input: ContractInput): Promise<ContractResponse> {
    await this.getOrThrow(workerId);
    const contract = await this.prisma.contract.upsert({
      where: { workerId },
      create: {
        workerId,
        hourlyCostIls: input.hourlyCostIls,
        minMonthlyHours: input.minMonthlyHours,
        maxMonthlyHours: input.maxMonthlyHours,
      },
      update: {
        hourlyCostIls: input.hourlyCostIls,
        minMonthlyHours: input.minMonthlyHours,
        maxMonthlyHours: input.maxMonthlyHours,
      },
    });
    return toContractResponse(contract);
  }

  async getShareLink(id: number): Promise<{ url: string }> {
    const worker = await this.getOrThrow(id);
    return { url: `/schedule/${worker.shareToken}` };
  }

  /** Issues a fresh `crypto.randomUUID()` token — the old one 404s immediately afterwards (the
   * unique `shareToken` column no longer holds it, so a public-schedule lookup by the old value
   * simply finds no worker). */
  async rotateShareLink(id: number): Promise<{ url: string }> {
    await this.getOrThrow(id);
    const worker = await this.prisma.worker.update({
      where: { id },
      data: { shareToken: randomUUID() },
    });
    return { url: `/schedule/${worker.shareToken}` };
  }

  private async getOrThrow(id: number): Promise<WorkerRecord> {
    const worker = await this.prisma.worker.findUnique({ where: { id } });
    if (!worker) {
      throw new NotFoundError(`Worker ${id} not found`);
    }
    return worker;
  }

  private translateWriteError(err: unknown, input: WorkerInput): Error {
    if (isUniqueConstraintViolation(err)) {
      return new ConflictError(`A worker with nationalId "${input.nationalId}" already exists`);
    }
    if (isForeignKeyConstraintViolation(err)) {
      return new BadRequestError([{ path: 'companyId', message: `Company ${input.companyId} does not exist` }]);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
