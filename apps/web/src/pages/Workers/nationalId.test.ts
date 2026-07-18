import { describe, expect, it } from 'vitest';

import { validateNationalId } from './nationalId.js';

describe('validateNationalId', () => {
  it('accepts a checksum-valid Israeli ID', () => {
    expect(validateNationalId('123456782')).toBeNull();
  });

  it('rejects an empty value', () => {
    expect(validateNationalId('')).toBe('National ID is required.');
  });

  it('rejects non-digit characters', () => {
    expect(validateNationalId('12345678A')).toBe('National ID must be 1-9 digits.');
  });

  it('rejects a checksum failure', () => {
    expect(validateNationalId('987654321')).toBe('Invalid Israeli ID — checksum failed.');
  });

  it('rejects more than 9 digits', () => {
    expect(validateNationalId('1234567890')).toBe('National ID must be 1-9 digits.');
  });
});
