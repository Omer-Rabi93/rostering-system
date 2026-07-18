/**
 * Validates an Israeli national ID (Teudat Zehut) using the standard
 * checksum algorithm: alternating 1/2 digit weights, digit-sum reduction
 * for two-digit products, and a mod-10 check.
 */
export function isValidIsraeliId(raw: string): boolean {
  if (!/^\d{1,9}$/.test(raw)) return false;
  const id = raw.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const digit = Number(id[i]);
    const product = digit * (i % 2 === 0 ? 1 : 2);
    sum += product > 9 ? product - 9 : product;
  }
  return sum % 10 === 0;
}
