import { describe, expect, it } from 'vitest';

import { maskNationalId, redactNationalIds } from '../src/logger.js';

describe('maskNationalId', () => {
  it('masks all but the last 4 digits', () => {
    expect(maskNationalId('123456782')).toBe('*****6782');
  });

  it('masks a short id entirely', () => {
    expect(maskNationalId('123')).toBe('***');
  });
});

describe('redactNationalIds', () => {
  it('redacts every free-standing 9-digit run in a log line', () => {
    const line = 'Duplicate nationalId 123456782 for worker 987654321 rejected';
    expect(redactNationalIds(line)).toBe('Duplicate nationalId *****6782 for worker *****4321 rejected');
  });

  it('leaves lines with no national-id-shaped numbers untouched', () => {
    const line = 'Company 42 already exists';
    expect(redactNationalIds(line)).toBe(line);
  });
});
