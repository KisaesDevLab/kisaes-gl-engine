// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Completeness gate for the shipped state-rule seeds: every jurisdiction must
// carry `has_income_tax` for each shipped year, and every income-tax state the
// full key set, each exactly once, with a valid value and a citation. Expected
// to fail until the per-state researchers have filled their seed files.

import { describe, it, expect } from 'vitest';
import { STATE_CODES, getStateRuleDef, requiredStateRuleKeys, validateStateRuleValue } from '@kis-books/shared';
import { STATE_RULE_SEEDS } from './index.js';

const YEARS = [2025, 2026];

describe('state rule seeds', () => {
  for (const state of STATE_CODES) {
    for (const year of YEARS) {
      describe(`${state} ${year}`, () => {
        const rows = STATE_RULE_SEEDS.filter((r) => r.state === state && r.year === year);

        it('declares has_income_tax and carries every required key exactly once', () => {
          const counts = new Map<string, number>();
          for (const r of rows) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
          const flag = rows.find((r) => r.key === 'has_income_tax');
          expect(flag, `${state} ${year}: has_income_tax row`).toBeDefined();
          const hasTax = flag?.value === true;
          const missing = requiredStateRuleKeys(hasTax).filter((k) => !counts.has(k));
          const duplicated = [...counts].filter(([, c]) => c > 1).map(([k]) => k);
          expect({ missing, duplicated }).toEqual({ missing: [], duplicated: [] });
        });

        it('has only known keys with valid values', () => {
          const bad = rows.flatMap((r) => {
            const def = getStateRuleDef(r.key);
            if (!def) return [`${r.key}: unknown key`];
            const err = validateStateRuleValue(def, r.value);
            return err ? [`${r.key}: ${err}`] : [];
          });
          expect(bad).toEqual([]);
        });

        it('cites every row and has a valid status', () => {
          expect(rows.filter((r) => !r.citation || !r.citation.trim()).map((r) => r.key)).toEqual([]);
          expect(rows.filter((r) => !['verified', 'unverified', 'provisional'].includes(r.status)).map((r) => r.key)).toEqual([]);
        });
      });
    }
  }

  it('every row sits in its own file: state and year match', async () => {
    const wrong: string[] = [];
    for (const code of STATE_CODES) {
      const mod = (await import(`./${code}.js`)) as Record<string, readonly { state: string; year: number; key: string }[] | undefined>;
      const rows = mod[`${code}_RULES`];
      expect(rows, `${code}.ts exports ${code}_RULES`).toBeDefined();
      for (const r of rows ?? []) {
        if (r.state !== code || !YEARS.includes(r.year)) wrong.push(`${code}.ts: ${r.state} ${r.year} ${r.key}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
