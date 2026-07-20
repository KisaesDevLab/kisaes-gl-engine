// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The MICR line is the one part of a check the bank's reader-sorter
// actually consumes — these tests pin the ANSI X9.100-160-1 field
// positions and the E-13B glyph geometry invariants.

import { describe, it, expect } from 'vitest';
import {
  E13B_GLYPHS,
  layoutMicrLine,
  micrPositionRightOffsetInches,
  glyphSvgPath,
  MICR_CHAR_HEIGHT_UNITS,
  MICR_PITCH_UNITS,
} from './check-micr.js';

describe('E-13B glyph geometry', () => {
  it('has all 14 characters', () => {
    expect(Object.keys(E13B_GLYPHS).sort()).toEqual(
      ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'amount', 'dash', 'onus', 'transit'].sort(),
    );
  });

  it('every glyph fits the 0.117" x 0.125" character cell', () => {
    for (const [key, contours] of Object.entries(E13B_GLYPHS)) {
      for (const contour of contours) {
        for (const [x, y] of contour) {
          expect(y, `${key} y`).toBeGreaterThanOrEqual(0);
          expect(y, `${key} y`).toBeLessThanOrEqual(MICR_CHAR_HEIGHT_UNITS);
          expect(x, `${key} x`).toBeGreaterThanOrEqual(0);
          expect(x, `${key} x`).toBeLessThanOrEqual(MICR_PITCH_UNITS);
        }
      }
    }
  });

  it('digits span the full 0.117" character height', () => {
    for (const d of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      const ys = E13B_GLYPHS[d]!.flat().map(([, y]) => y);
      expect(Math.min(...ys), `${d} bottom`).toBe(0);
      expect(Math.max(...ys), `${d} top`).toBe(MICR_CHAR_HEIGHT_UNITS);
    }
  });

  it('renders every glyph to a closed SVG path', () => {
    for (const key of Object.keys(E13B_GLYPHS)) {
      const path = glyphSvgPath(key);
      expect(path).toMatch(/^M /);
      expect(path.endsWith('Z')).toBe(true);
      // one closed subpath per contour
      expect(path.match(/Z/g)!.length).toBe(E13B_GLYPHS[key]!.length);
    }
  });
});

describe('layoutMicrLine — ANSI X9.100-160-1 field positions', () => {
  const base = { routingNumber: '081000032', accountNumber: '1234567890', checkNumber: 1042 };

  function at(placed: ReturnType<typeof layoutMicrLine>, position: number) {
    return placed.find((p) => p.position === position)?.glyph;
  }

  it('brackets the routing number with transit symbols at positions 43 and 33', () => {
    const placed = layoutMicrLine(base);
    expect(at(placed, 43)).toBe('transit');
    expect(at(placed, 33)).toBe('transit');
    // digits 42..34, MSD leftmost
    const digits = Array.from({ length: 9 }, (_, i) => at(placed, 42 - i)).join('');
    expect(digits).toBe('081000032');
  });

  it('left-aligns the account at position 31 and terminates with the on-us symbol', () => {
    const placed = layoutMicrLine(base);
    const acct = Array.from({ length: 10 }, (_, i) => at(placed, 31 - i)).join('');
    expect(acct).toBe('1234567890');
    expect(at(placed, 21)).toBe('onus');
  });

  it('renders dashes in the account as the MICR dash symbol and spaces as gaps', () => {
    const placed = layoutMicrLine({ ...base, accountNumber: '12-34 567' });
    expect(at(placed, 31)).toBe('1');
    expect(at(placed, 30)).toBe('2');
    expect(at(placed, 29)).toBe('dash');
    expect(at(placed, 28)).toBe('3');
    expect(at(placed, 27)).toBe('4');
    expect(at(placed, 26)).toBeUndefined(); // space = empty position
    expect(at(placed, 25)).toBe('5');
    expect(at(placed, 22)).toBe('onus'); // right after last char
  });

  it('puts the zero-padded serial in the auxiliary on-us field ending at position 45', () => {
    const placed = layoutMicrLine(base);
    expect(at(placed, 45)).toBe('onus');
    const serial = Array.from({ length: 6 }, (_, i) => at(placed, 51 - i)).join('');
    expect(serial).toBe('001042');
    expect(at(placed, 52)).toBe('onus');
  });

  it('leaves the amount field (positions 1-12) blank', () => {
    const placed = layoutMicrLine(base);
    for (let p = 1; p <= 12; p++) expect(at(placed, p)).toBeUndefined();
  });

  it('omits the aux field when the check has no number yet', () => {
    const placed = layoutMicrLine({ ...base, checkNumber: null });
    expect(placed.every((p) => p.position < 44)).toBe(true);
  });

  it('prints nothing when the routing number is not 9 digits', () => {
    expect(layoutMicrLine({ ...base, routingNumber: '12345' })).toEqual([]);
    expect(layoutMicrLine({ ...base, routingNumber: '' })).toEqual([]);
  });

  it('positions cells per spec: position 1 ends 5/16" from the right edge, 1/8" pitch', () => {
    expect(micrPositionRightOffsetInches(1)).toBeCloseTo(0.3125, 10);
    expect(micrPositionRightOffsetInches(2)).toBeCloseTo(0.4375, 10);
    expect(micrPositionRightOffsetInches(33)).toBeCloseTo(4.3125, 10);
    expect(micrPositionRightOffsetInches(43)).toBeCloseTo(5.5625, 10);
  });
});
