// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  BOX_THRESHOLDS,
  FORM_1099_BOXES,
  FORM_BOX_LABELS,
  formOf,
  isValidFormBox,
} from './portal-1099.boxes.js';

describe('FORM_1099_BOXES catalog', () => {
  it('contains the six common boxes — NEC-1 plus MISC 1, 2, 3, 6, 10', () => {
    const values = FORM_1099_BOXES.map((b) => b.value).sort();
    expect(values).toEqual(['MISC-1', 'MISC-10', 'MISC-2', 'MISC-3', 'MISC-6', 'NEC-1']);
  });

  it('every entry exposes value / form / box / label', () => {
    for (const b of FORM_1099_BOXES) {
      expect(b.value).toMatch(/^(NEC|MISC|K)-\w+$/);
      expect(b.form).toMatch(/^1099-(NEC|MISC|K)$/);
      expect(b.box).toBeTruthy();
      expect(b.label.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate values', () => {
    const values = FORM_1099_BOXES.map((b) => b.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('builds a label dictionary covering every catalog entry', () => {
    for (const b of FORM_1099_BOXES) {
      expect(FORM_BOX_LABELS[b.value]).toContain(b.label);
      expect(FORM_BOX_LABELS[b.value]).toContain(b.form);
    }
  });
});

describe('BOX_THRESHOLDS', () => {
  it('defines a numeric threshold for every catalog entry', () => {
    for (const b of FORM_1099_BOXES) {
      expect(typeof BOX_THRESHOLDS[b.value]).toBe('number');
      expect(BOX_THRESHOLDS[b.value]).toBeGreaterThan(0);
    }
  });

  it('uses $10 for royalties (MISC-2) and $600 for everything else', () => {
    expect(BOX_THRESHOLDS['MISC-2']).toBe(10);
    expect(BOX_THRESHOLDS['NEC-1']).toBe(600);
    expect(BOX_THRESHOLDS['MISC-1']).toBe(600);
    expect(BOX_THRESHOLDS['MISC-3']).toBe(600);
    expect(BOX_THRESHOLDS['MISC-6']).toBe(600);
    expect(BOX_THRESHOLDS['MISC-10']).toBe(600);
  });
});

describe('formOf', () => {
  it('NEC-1 → 1099-NEC; every MISC-x → 1099-MISC', () => {
    expect(formOf('NEC-1')).toBe('1099-NEC');
    expect(formOf('MISC-1')).toBe('1099-MISC');
    expect(formOf('MISC-2')).toBe('1099-MISC');
    expect(formOf('MISC-10')).toBe('1099-MISC');
  });
});

describe('isValidFormBox', () => {
  it('accepts every catalog value', () => {
    for (const b of FORM_1099_BOXES) {
      expect(isValidFormBox(b.value)).toBe(true);
    }
  });

  it('rejects empty / unknown / non-string values', () => {
    expect(isValidFormBox('')).toBe(false);
    expect(isValidFormBox('NEC-99')).toBe(false);
    expect(isValidFormBox('MISC-7')).toBe(false); // not in our common-six set
    expect(isValidFormBox('K-1a')).toBe(false); // 1099-K is intentionally out of scope
    expect(isValidFormBox(null)).toBe(false);
    expect(isValidFormBox(undefined)).toBe(false);
    expect(isValidFormBox(0)).toBe(false);
    expect(isValidFormBox({ value: 'NEC-1' })).toBe(false);
  });
});
