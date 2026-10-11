// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Completeness gate for the shipped federal parameter seeds: every year must
// carry every registry key exactly once, with a valid value and a citation.

import { describe, it, expect } from 'vitest';
import { expandParameterKeys, validateParameterValue, getParameterDef } from '@kis-books/shared';
import { FEDERAL_SEEDS } from './index.js';

const YEARS = Object.keys(FEDERAL_SEEDS).map(Number);

describe('federal seeds', () => {
  it('ships at least one year', () => {
    expect(YEARS.length).toBeGreaterThan(0);
  });

  for (const year of YEARS) {
    describe(`tax year ${year}`, () => {
      const rows = FEDERAL_SEEDS[year]!;

      it('has every registry key exactly once', () => {
        const counts = new Map<string, number>();
        for (const r of rows) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
        const missing = expandParameterKeys().map((e) => e.key).filter((k) => !counts.has(k));
        const duplicated = [...counts].filter(([, c]) => c > 1).map(([k]) => k);
        expect({ missing, duplicated }).toEqual({ missing: [], duplicated: [] });
      });

      it('has no unknown keys', () => {
        expect(rows.map((r) => r.key).filter((k) => !getParameterDef(k))).toEqual([]);
      });

      it('has valid values', () => {
        const bad = rows.flatMap((r) => {
          const def = getParameterDef(r.key);
          const err = def ? validateParameterValue(def.def.type, r.value) : 'unknown key';
          return err ? [`${r.key}: ${err}`] : [];
        });
        expect(bad).toEqual([]);
      });

      it('has a citation and a valid status on every row', () => {
        expect(rows.filter((r) => !r.citation || !r.citation.trim()).map((r) => r.key)).toEqual([]);
        expect(rows.filter((r) => !['verified', 'unverified', 'provisional'].includes(r.status)).map((r) => r.key)).toEqual([]);
      });
    });
  }
});
