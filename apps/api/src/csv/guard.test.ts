import { describe, expect, it } from 'vitest';
import { guardCell, unguardCell } from './guard.js';

describe('CSV formula-injection guard', () => {
  it.each(['=SUM(A1)', '+1+1', '-2+3', '@cmd', '\ttabbed', '\rcr'])(
    'prefixes a cell starting with a formula-trigger character on export: %j',
    (value) => {
      expect(guardCell(value)).toBe(`'${value}`);
    },
  );

  it.each(['Dana Levi', '123456782', '', 'Alpha Security Ltd.'])(
    'leaves an ordinary cell untouched: %j',
    (value) => {
      expect(guardCell(value)).toBe(value);
    },
  );

  it('strips the guard prefix back off on import', () => {
    expect(unguardCell("'=SUM(A1)")).toBe('=SUM(A1)');
    expect(unguardCell("'+1+1")).toBe('+1+1');
  });

  it('leaves an unguarded cell untouched on import', () => {
    expect(unguardCell('Dana Levi')).toBe('Dana Levi');
  });

  it('does not strip a leading apostrophe that is not a guard (round-trip safety)', () => {
    // "'Twas" was never guarded (its own first char, "'", is not a trigger char), so unguard
    // must be a no-op here -- otherwise a legitimate name starting with an apostrophe would be
    // corrupted on import.
    expect(unguardCell("'Twas the night")).toBe("'Twas the night");
  });

  it('round-trips every formula-trigger case through guard then unguard', () => {
    for (const value of ['=SUM(A1)', '+1+1', '-2+3', '@cmd', '\ttabbed', '\rcr', 'Dana Levi', '']) {
      expect(unguardCell(guardCell(value))).toBe(value);
    }
  });
});
