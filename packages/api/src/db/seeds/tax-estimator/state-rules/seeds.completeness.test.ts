// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Completeness gate for the shipped state-rule seeds: every jurisdiction must
// carry `has_income_tax` for each shipped year, and every income-tax state the
// full key set, each exactly once, with a valid value and a citation. Expected
// to fail until the per-state researchers have filled their seed files. The R5
// keys (estimates_required, threshold_comparison, penalty.* additions, dates) are
// required for every taxed state: a value, or an explicit cited null.

import { describe, it, expect } from 'vitest';
import { STATE_CODES, getStateRuleDef, requiredStateRuleKeys, validateStateRuleValue, rollStateRuleDates } from '@kis-books/shared';
import { STATE_RULE_SEEDS } from './index.js';

const YEARS = [2025, 2026];
/** Keys added by the R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md, "Key-set decisions"). */
const R5_KEYS = [
  'estimates_required', 'threshold_comparison', 'installments.q4_file_and_pay_date', 'return_due_date',
  'penalty.rate_schedule', 'penalty.method', 'penalty.min_balance_due',
];

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

  // R6-01: the state roll infers each statutory day from the stored observed date and regenerates the
  // holiday list from the rules it follows; rolling the owner states' 2025 rows must give the 2026 rows.
  const DATE_KEYS = ['installments.due_dates', 'installments.q4_file_and_pay_date', 'return_due_date', 'farmer.rule', 'holidays'];
  const valuesOf = (state: string, year: number) => new Map(STATE_RULE_SEEDS.filter((r) => r.state === state && r.year === year).map((r) => [r.key, r.value]));

  it('rolling the MO 2025 rows to 2026 reproduces every shipped MO 2026 date rule and the holiday list', () => {
    const rolled = rollStateRuleDates(valuesOf('MO', 2025), 2025, 2026);
    const shipped = valuesOf('MO', 2026);
    for (const key of DATE_KEYS) expect(rolled.get(key), `MO ${key}`).toEqual(shipped.get(key));
  });

  it('rolling the AR 2025 rows to 2026 reproduces the shipped AR 2026 dates (farmer Feb 15 → Tue Feb 16, 2027 after Presidents\' Day)', () => {
    const rolled = rollStateRuleDates(valuesOf('AR', 2025), 2025, 2026);
    const shipped = valuesOf('AR', 2026);
    for (const key of DATE_KEYS.filter((k) => k !== 'holidays')) expect(rolled.get(key), `AR ${key}`).toEqual(shipped.get(key));
    // AR Policy 52 item 6 observes a Saturday holiday on the preceding Friday: New Year's Day 2028 (Saturday) is
    // Fri Dec 31, 2027. The shipped list is framed by holiday year and leaves that one entry out; nothing is due that day.
    expect(rolled.get('holidays')).toEqual([...(shipped.get('holidays') as string[]), '2027-12-31']);
  });

  it('the R5 keys are part of the required key set for taxed states', () => {
    expect(requiredStateRuleKeys(true)).toEqual(expect.arrayContaining(R5_KEYS));
    expect(requiredStateRuleKeys(false)).toEqual(['has_income_tax']);
  });

  it('only Idaho and Utah have no quarterly estimate regime', () => {
    const off = STATE_RULE_SEEDS.filter((r) => r.key === 'estimates_required' && r.value === false).map((r) => `${r.state} ${r.year}`);
    expect(off.sort()).toEqual(['ID 2025', 'ID 2026', 'UT 2025', 'UT 2026']);
  });

  it('Missouri and Arkansas carry every R5 key verified (owner states)', () => {
    for (const state of ['MO', 'AR'] as const) {
      for (const year of YEARS) {
        const rows = STATE_RULE_SEEDS.filter((r) => r.state === state && r.year === year && R5_KEYS.includes(r.key));
        expect(rows.map((r) => r.key).sort(), `${state} ${year}`).toEqual([...R5_KEYS].sort());
        expect(rows.filter((r) => r.status !== 'verified').map((r) => r.key), `${state} ${year}`).toEqual([]);
      }
    }
    const mo = (year: number, key: string) => STATE_RULE_SEEDS.find((r) => r.state === 'MO' && r.year === year && r.key === key)?.value;
    expect(mo(2025, 'penalty.min_balance_due')).toBe(500);
    expect(mo(2025, 'required_threshold')).toBe(100);
    expect(mo(2025, 'penalty.rate_schedule')).toEqual([
      { from: '2025-01-01', to: '2025-12-31', rate: 0.08 },
      { from: '2026-01-01', to: '2026-12-31', rate: 0.07 },
    ]);
    expect(STATE_RULE_SEEDS.find((r) => r.state === 'AR' && r.year === 2025 && r.key === 'threshold_comparison')?.value).toBe('more_than');
  });

  it('Q53: every income-tax state + DC carries starting_point, brackets, standard_deduction and capital_gains (value or cited null) for 2025 and 2026, all unverified', () => {
    const KEYS = ['starting_point', 'brackets', 'standard_deduction', 'capital_gains'];
    const missing: string[] = [];
    for (const state of STATE_CODES) {
      for (const year of YEARS) {
        const hasTax = STATE_RULE_SEEDS.find((r) => r.state === state && r.year === year && r.key === 'has_income_tax')?.value === true;
        for (const key of KEYS) {
          const rows = STATE_RULE_SEEDS.filter((r) => r.state === state && r.year === year && r.key === key);
          if (hasTax && rows.length !== 1) missing.push(`${state} ${year} ${key} (${rows.length})`);
          if (!hasTax && rows.length > 0) missing.push(`${state} ${year} ${key}: no-income-tax state`);
          for (const r of rows) {
            if (r.status !== 'unverified') missing.push(`${state} ${year} ${key}: ${r.status}`);
            if (r.value === null && !/null|not (yet )?(published|sourced)|unsourceable/i.test(r.citation)) missing.push(`${state} ${year} ${key}: null without an explanation`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
    const ftd = STATE_RULE_SEEDS.filter((r) => r.key === 'federal_tax_deduction').map((r) => `${r.state} ${r.year}`).sort();
    expect(ftd).toEqual(['AL 2025', 'AL 2026', 'MO 2025', 'MO 2026', 'OR 2025', 'OR 2026']);
    expect(STATE_RULE_SEEDS.filter((r) => r.key === 'capital_gains_excise').map((r) => `${r.state} ${r.year}`).sort()).toEqual(['WA 2025', 'WA 2026']);
  });

  it('Q53: Missouri and Arkansas schedules (owner states)', () => {
    const v = (state: string, year: number, key: string) => STATE_RULE_SEEDS.find((r) => r.state === state && r.year === year && r.key === key)?.value as Record<string, unknown>;
    const mo = v('MO', 2025, 'brackets') as { single: Array<{ over: number; rate: number }> };
    expect(mo.single[mo.single.length - 1]).toEqual({ over: 9191, rate: 0.047 });
    expect(v('MO', 2025, 'standard_deduction')).toMatchObject({ single: 15750, mfj: 31500 });
    expect(v('MO', 2025, 'capital_gains')).toMatchObject({ treatment: 'exclusion', applies_to: 'net_capital_gain', exclusion_tiers: [{ over: 0, pct: 1 }] });
    expect(v('AR', 2025, 'capital_gains')).toMatchObject({ treatment: 'exclusion', applies_to: 'net_ltcg', exclusion_tiers: [{ over: 0, pct: 0.5 }, { over: 10000000, pct: 1 }] });
    expect(STATE_RULE_SEEDS.find((r) => r.state === 'AR' && r.year === 2025 && r.key === 'starting_point')?.value).toBe('state_specific');
  });

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
