import { Prisma } from '../generated/prisma/client.js';

/** Postgres unique-violation surfaced through Prisma, e.g. duplicate company name or nationalId. */
export function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Postgres FK-violation surfaced through Prisma — covers both "you referenced a row that doesn't
 * exist" (P2003, e.g. an unknown companyId) and "you tried to delete a row something else still
 * references" under `onDelete: Restrict` (P2003 on delete, P2014 for the required-relation case).
 */
export function isForeignKeyConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2003' || err.code === 'P2014')
  );
}
