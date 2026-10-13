// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Owner splits on person-target treatments (OPEN-QUESTIONS Q50, MODULE.md "Tax-treatment map").
//
// An account treated as an owner item (W-2 wages, owner / officer SEHI, owner / officer
// retirement, guaranteed payment) or as estimated-tax payments may be shared between
// several owners linked to the business:
//
//   pct    — rows (person [payments: taxpayer + optional person], pct); the pcts total
//            exactly 100. Every month's amount (every payment line) is shared by pct.
//   amount — rows (person, fixed ANNUAL $, tax year). The year-to-date books amount is
//            shared IN PROPORTION to the year's fixed amounts; when the tax year is
//            complete each owner but the LAST gets exactly the fixed amount and the last
//            takes the remainder (books total − Σ the others' fixed amounts), warned
//            TE_SPLIT_REMAINDER whenever the (projected) books total differs from Σ fixed.
//
// Rounding: every portion is rounded half-up to 4 places and the LAST row takes the
// residual, so the portions always add back to the amount exactly. A single row always
// gets the whole amount (no rounding), which keeps single-owner results byte-identical.
//
// Pure (no IO); the API provider, the payment ledger and the web editor share it.

import { dAdd, dCmp, dDiv, dIsPos, dIsZero, dMul, dRound, dSub, dSum, type Dec } from './decimal.js';

export const SPLIT_MODES = ['pct', 'amount'] as const;
export type SplitMode = typeof SPLIT_MODES[number];

/** Money / pct places used by the split helpers. */
const MONEY_PLACES = 4;
const PCT_PLACES = 4;
const HUNDRED: Dec = '100';

/**
 * Share `total` by `weights` (pct values or fixed amounts; only their ratios matter).
 * Portions are rounded half-up to 4 places; the last takes the residual so Σ portions = total.
 * One weight → [total]. All-zero (or empty) weights → everything to the last row.
 */
export function allocateByWeights(total: Dec, weights: ReadonlyArray<Dec>): Dec[] {
  if (weights.length === 0) return [];
  if (weights.length === 1) return [total];
  const sumW = dSum(weights);
  const out: Dec[] = [];
  let used: Dec = '0';
  for (let i = 0; i < weights.length - 1; i++) {
    const p = dIsZero(sumW) ? '0' : dRound(dDiv(dMul(total, weights[i]!), sumW), MONEY_PLACES);
    out.push(p);
    used = dAdd(used, p);
  }
  out.push(dSub(total, used));
  return out;
}

/** True when the pcts total exactly 100 (decimal, no float tolerance). */
export function pctTotalIs100(pcts: ReadonlyArray<Dec>): boolean {
  return dCmp(dSum(pcts), HUNDRED) === 0;
}

/** Σ pcts as a decimal string (for the live total in the editor and the 400 message). */
export function pctTotal(pcts: ReadonlyArray<Dec | null | undefined>): Dec {
  return dSum(pcts.map((p) => (p == null || p === '' ? '0' : p)));
}

/**
 * Default pct split from the owners' profit % on the business links (Kurt, Q50 (3)):
 * normalized to total exactly 100 across the listed owners, 4 places, residual on the last.
 * A single owner → ['100']. Blank / zero profit % everywhere → equal shares.
 */
export function defaultOwnerPcts(profitPcts: ReadonlyArray<Dec | null | undefined>): Dec[] {
  const n = profitPcts.length;
  if (n === 0) return [];
  if (n === 1) return [HUNDRED];
  const vals = profitPcts.map((p) => (p == null || p === '' || !dIsPos(p) ? '0' : p));
  const sum = dSum(vals);
  const weights = dIsZero(sum) ? vals.map(() => '1') : vals;
  const sumW = dSum(weights);
  const out: Dec[] = [];
  let used: Dec = '0';
  for (let i = 0; i < n - 1; i++) {
    const p = dRound(dDiv(dMul(HUNDRED, weights[i]!), sumW), PCT_PLACES);
    out.push(p);
    used = dAdd(used, p);
  }
  out.push(dSub(HUNDRED, used));
  return out;
}

/**
 * Complete-year amount-mode targets (Kurt, Q50 (3)): every row but the last gets its fixed
 * amount; the last gets `total − Σ others`. Returns null when that remainder would be
 * NEGATIVE (books total below the others' fixed amounts) — the caller then keeps the
 * proportional allocation and warns.
 */
export function fixedAmountTargets(total: Dec, amounts: ReadonlyArray<Dec>): Dec[] | null {
  if (amounts.length === 0) return [];
  if (amounts.length === 1) return [total];
  const others = amounts.slice(0, -1);
  const last = dSub(total, dSum(others));
  if (dCmp(last, '0') < 0) return null;
  return [...others, last];
}
