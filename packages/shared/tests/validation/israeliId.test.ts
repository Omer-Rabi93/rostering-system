import { describe, expect, it } from 'vitest';
import { isValidIsraeliId } from '../../src/index.js';

describe('isValidIsraeliId', () => {
  it('accepts a valid 9-digit Israeli ID with a correct checksum', () => {
    expect(isValidIsraeliId('111111118')).toBe(true);
  });

  it('rejects a 9-digit ID with an incorrect checksum', () => {
    expect(isValidIsraeliId('111111111')).toBe(false);
  });

  it('accepts a short ID as if zero-padded on the left to 9 digits', () => {
    // '18' zero-pads to '000000018', a valid checksum per the same algorithm.
    expect(isValidIsraeliId('18')).toBe(true);
  });

  it('rejects a value containing non-digit characters', () => {
    expect(isValidIsraeliId('12345678a')).toBe(false);
  });

  it('rejects a value longer than 9 digits', () => {
    expect(isValidIsraeliId('1234567890')).toBe(false);
  });
});
