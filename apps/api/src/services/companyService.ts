import type { Company as CompanyInput } from '@rostering/shared';

import type { PrismaClient } from '../db/client.js';
import type { Company as CompanyRecord } from '../generated/prisma/client.js';
import { isForeignKeyConstraintViolation, isUniqueConstraintViolation } from '../db/prismaErrors.js';
import { ConflictError, NotFoundError } from '../errors.js';

/** Narrow structural type covering both `PrismaClient` and `Prisma.TransactionClient` -- just
 * enough of the `company` delegate for `resolveOrCreate` to run against either, so a caller (e.g.
 * the CSV import job) can resolve-or-create a company inside its own per-row transaction. */
interface CompanyClient {
  company: {
    findFirst: PrismaClient['company']['findFirst'];
    create: PrismaClient['company']['create'];
  };
}

/**
 * Company CRUD business logic. Takes a `PrismaClient` via constructor injection (not a global
 * singleton) so it stays unit-testable with a different client if ever needed, and contains no
 * Express-specific code — no `req`/`res`, only plain arguments and typed errors that
 * `src/middleware/errorHandler.ts` translates to the right HTTP envelope.
 */
export class CompanyService {
  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<CompanyRecord[]> {
    return this.prisma.company.findMany({ orderBy: { id: 'asc' } });
  }

  async create(input: CompanyInput): Promise<CompanyRecord> {
    try {
      return await this.prisma.company.create({ data: { name: input.name } });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw new ConflictError(`Company name "${input.name}" already exists`);
      }
      throw err;
    }
  }

  async rename(id: number, input: CompanyInput): Promise<CompanyRecord> {
    await this.getOrThrow(id);
    try {
      return await this.prisma.company.update({ where: { id }, data: { name: input.name } });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw new ConflictError(`Company name "${input.name}" already exists`);
      }
      throw err;
    }
  }

  async remove(id: number): Promise<void> {
    await this.getOrThrow(id);
    try {
      await this.prisma.company.delete({ where: { id } });
    } catch (err) {
      if (isForeignKeyConstraintViolation(err)) {
        throw new ConflictError(`Company ${id} still has workers assigned to it`);
      }
      throw err;
    }
  }

  /**
   * Resolve-or-create by case-insensitive name -- the CSV import job's company-resolution step
   * reuses this (rather than re-implementing the matching), passing its own `tx` client so
   * company creation participates in the same one-transaction-per-row unit of work. Defaults to
   * `this.prisma` for the plain (non-transactional) case.
   *
   * The lookup relies on the same case-insensitive uniqueness the DB enforces (the
   * `companies_lower_name_key` functional unique index from the Phase 3 migration), so a race
   * between the initial `findFirst` and `create` still can't produce two companies whose names
   * differ only by case -- it surfaces as a unique-constraint violation, which is treated the same
   * as "someone else already resolved this name" and re-fetched.
   */
  async resolveOrCreate(name: string, client: CompanyClient = this.prisma): Promise<CompanyRecord> {
    const existing = await client.company.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) {
      return existing;
    }
    try {
      return await client.company.create({ data: { name } });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        const found = await client.company.findFirst({
          where: { name: { equals: name, mode: 'insensitive' } },
        });
        if (found) {
          return found;
        }
      }
      throw err;
    }
  }

  private async getOrThrow(id: number): Promise<CompanyRecord> {
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) {
      throw new NotFoundError(`Company ${id} not found`);
    }
    return company;
  }
}
