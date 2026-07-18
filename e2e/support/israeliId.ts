import { isValidIsraeliId } from '../../packages/shared/src/validation/israeliId.js';

/**
 * Deterministically derives a checksum-valid 9-digit Israeli national ID from a small integer
 * prefix, mirroring `apps/api/src/db/seedData.ts#deriveValidIsraeliId` (duplicated rather than
 * imported since that one is private to the seed module) — used by tests that need a *fresh* valid
 * ID guaranteed not to collide with the seeded fixture workers (prefixes 1-12; tests here start
 * from 9000 to stay well clear).
 */
export function deriveValidIsraeliId(prefix: number): string {
  const base = String(prefix).padStart(8, '0');
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${base}${checkDigit}`;
    if (isValidIsraeliId(candidate)) return candidate;
  }
  throw new Error(`no valid check digit found for prefix ${base}`);
}

export { isValidIsraeliId };
