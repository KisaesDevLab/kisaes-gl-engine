// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md step 11 — regular tax. Default rate_mode 'brackets': ordinary
// brackets (`brackets.{fs}`) plus the Schedule D Tax Worksheet for qualified
// dividends and net long-term gains (0 / 15 / 20 breakpoints from
// `ltcg.breakpoints.{fs}` and `ltcg.rates`, the 25% unrecaptured §1250 and 28%
// collectibles buckets from `unrecaptured_1250_rate` / `collectibles_rate`),
// never more than the all-ordinary tax. rate_mode 'effective' multiplies
// taxable income by the override and is labelled everywhere.

import type { RateMode } from '../years-api.js';
import {
  ZERO, dAdd, dCmp, dDiv, dFloorZero, dIsPos, dIsZero, dMax, dMin, dMul, dRoundRate, dSub, dSum, dec, type Dec,
} from '../decimal.js';
import type { EngineContext } from './context.js';
import type { BracketRow } from './parameters.js';

const STEP_REGULAR_TAX = 'regular_tax';

/** Ordinary bracket tax on `income` (≤ 0 → 0). The upper bound belongs to its bracket. */
export function bracketTax(income: Dec, brackets: ReadonlyArray<BracketRow>): Dec {
  if (!dIsPos(income)) return ZERO;
  let tax: Dec = ZERO;
  let lower: Dec = ZERO;
  for (const b of brackets) {
    const upper = b.upper == null ? income : dMin(b.upper, income);
    if (dCmp(income, lower) <= 0) break;
    tax = dAdd(tax, dMul(dSub(upper, lower), b.rate));
    if (b.upper == null || dCmp(income, b.upper) <= 0) break;
    lower = b.upper;
  }
  return tax;
}

/** Rate of the bracket the last dollar of `income` falls in (bottom rate for ≤ 0). */
export function marginalBracketRate(income: Dec, brackets: ReadonlyArray<BracketRow>): Dec {
  for (const b of brackets) {
    if (b.upper == null || dCmp(income, b.upper) <= 0) return b.rate;
  }
  return brackets[brackets.length - 1]!.rate;
}

export interface RegularTaxInput {
  taxableIncome: Dec;
  qualifiedDividends: Dec;
  /** Schedule D line 15 equivalent: net long-term gain limited by the overall net gain, ≥ 0. */
  netLongTermGain: Dec;
  unrecaptured1250: Dec;
  collectibles: Dec;
  rateMode: RateMode;
  effectiveRateOverride: Dec | null;
}

export interface WorksheetExact {
  qualifiedDividends: Dec;
  netLongTermGain: Dec;
  preferentialIncome: Dec;
  unrecaptured1250: Dec;
  collectibles: Dec;
  taxedAtZero: Dec;
  taxedAtFifteen: Dec;
  taxedAtTwenty: Dec;
  taxedAtTwentyFive: Dec;
  taxedAtTwentyEight: Dec;
  ordinaryPortion: Dec;
  ordinaryTax: Dec;
  preferentialTax: Dec;
  worksheetTax: Dec;
  allOrdinaryTax: Dec;
}

export interface RegularTaxExact {
  method: RateMode;
  taxableIncome: Dec;
  tax: Dec;
  marginalOrdinaryRate: Dec;
  marginalCapitalGainRate: Dec;
  effectiveRate: Dec;
  worksheet: WorksheetExact | null;
}

/** Schedule D Tax Worksheet (Form 1040 instructions) with the worksheet's line numbers in comments. */
function capitalGainWorksheet(ti: Dec, qd: Dec, netLtcg: Dec, unrecap: Dec, coll: Dec, brackets: ReadonlyArray<BracketRow>, breakpoints: ReadonlyArray<Dec>, rates: ReadonlyArray<Dec>, rate25: Dec, rate28: Dec): WorksheetExact {
  const zeroBreak = breakpoints[0]!;
  const fifteenBreak = breakpoints[1]!;
  const rateZero = rates[0]!;
  const rateFifteen = rates[1]!;
  const rateTwenty = rates[rates.length - 1]!;

  const line9 = dFloorZero(netLtcg);                    // net LTCG limited by net gain
  const line10 = dAdd(dFloorZero(qd), line9);           // QD + net LTCG
  const line11 = dAdd(dFloorZero(unrecap), dFloorZero(coll));
  const line12 = dMin(line9, line11);                   // 25% / 28% gains, limited to net LTCG
  const line13 = dSub(line10, line12);                  // adjusted net capital gain (0 / 15 / 20)
  const line14 = dFloorZero(dSub(ti, line13));         // if zero or less, enter -0-
  const line16 = dMin(ti, zeroBreak);
  const line17 = dMin(line14, line16);
  const line18 = dFloorZero(dSub(ti, line10));          // income taxed only at ordinary rates
  const line19 = dMax(line17, line18);
  const line20 = dSub(line16, line17);                  // taxed at 0%
  const line21 = dMin(ti, line13);
  const line23 = dSub(line21, line20);
  const line25 = dMin(ti, fifteenBreak);
  const line26 = dAdd(line19, line20);
  const line27 = dFloorZero(dSub(line25, line26));
  const line28 = dMin(line23, line27);                  // taxed at 15%
  const line30 = dAdd(line20, line28);
  const line31 = dFloorZero(dSub(line21, line30));      // taxed at 20%
  const line33 = dMin(line9, dFloorZero(unrecap));
  const line34 = dAdd(line10, line19);
  const line36 = dFloorZero(dSub(line34, ti));
  const line37 = dFloorZero(dSub(line33, line36));      // taxed at 25%
  const line39 = dSum([line19, line20, line28, line31, line37]);
  const line40 = dIsPos(coll) ? dFloorZero(dSub(ti, line39)) : ZERO; // taxed at 28%
  const ordinaryTax = bracketTax(line19, brackets);
  const preferentialTax = dSum([dMul(line20, rateZero), dMul(line28, rateFifteen), dMul(line31, rateTwenty), dMul(line37, rate25), dMul(line40, rate28)]);
  const worksheetTax = dAdd(ordinaryTax, preferentialTax);
  const allOrdinaryTax = bracketTax(ti, brackets);
  return {
    qualifiedDividends: dec(qd), netLongTermGain: line9, preferentialIncome: line10, unrecaptured1250: dec(unrecap), collectibles: dec(coll),
    taxedAtZero: line20, taxedAtFifteen: line28, taxedAtTwenty: line31, taxedAtTwentyFive: line37, taxedAtTwentyEight: line40,
    ordinaryPortion: line19, ordinaryTax, preferentialTax, worksheetTax, allOrdinaryTax,
  };
}

export function computeRegularTax(input: RegularTaxInput, ctx: EngineContext): RegularTaxExact {
  const { params, filingStatus: fs } = ctx;
  const ti = dec(input.taxableIncome);
  const positiveTi = dFloorZero(ti);

  if (input.rateMode === 'effective' && input.effectiveRateOverride == null) {
    ctx.warn('TE_EFFECTIVE_RATE_MISSING', 'Rate mode is "effective" but no effective rate is set; the brackets were used.');
  }
  if (input.rateMode === 'effective' && input.effectiveRateOverride != null) {
    const rate = dec(input.effectiveRateOverride);
    const tax = dMul(positiveTi, rate);
    ctx.warn('TE_EFFECTIVE_RATE_OVERRIDE', `Regular tax uses an effective-rate override of ${rate} instead of the brackets (labelled on every surface).`, { rate });
    ctx.trace.add({ step: STEP_REGULAR_TAX, id: 'regular_tax', label: 'Regular tax — EFFECTIVE-RATE OVERRIDE (not brackets)', exact: tax, source: 'input', formula: `${positiveTi} × ${rate}`, marginalRate: rate });
    return { method: 'effective', taxableIncome: ti, tax, marginalOrdinaryRate: rate, marginalCapitalGainRate: ZERO, effectiveRate: dIsPos(positiveTi) ? dRoundRate(dDiv(tax, positiveTi)) : ZERO, worksheet: null };
  }

  const bracketsKey = `brackets.${fs}`;
  const brackets = params.bracketsFs('brackets', fs);
  const qd = dFloorZero(input.qualifiedDividends);
  const ltcg = dFloorZero(input.netLongTermGain);
  const hasPreferential = dIsPos(positiveTi) && (dIsPos(qd) || dIsPos(ltcg));

  if (!hasPreferential) {
    const tax = bracketTax(positiveTi, brackets);
    const marginal = marginalBracketRate(positiveTi, brackets);
    ctx.trace.add({ step: STEP_REGULAR_TAX, id: 'regular_tax', label: 'Regular tax (ordinary brackets)', exact: tax, source: 'parameter', formula: `bracket tax on ${positiveTi}`, parameterKeys: [bracketsKey], marginalRate: marginal });
    return { method: 'brackets', taxableIncome: ti, tax, marginalOrdinaryRate: marginal, marginalCapitalGainRate: ZERO, effectiveRate: dIsPos(positiveTi) ? dRoundRate(dDiv(tax, positiveTi)) : ZERO, worksheet: null };
  }

  const breakpointsKey = `ltcg.breakpoints.${fs}`;
  const breakpoints = params.moneyListFs('ltcg.breakpoints', fs);
  const rates = params.rateList('ltcg.rates');
  const rate25 = params.rate('unrecaptured_1250_rate');
  const rate28 = params.rate('collectibles_rate');
  const w = capitalGainWorksheet(positiveTi, qd, ltcg, dFloorZero(input.unrecaptured1250), dFloorZero(input.collectibles), brackets, breakpoints, rates, rate25, rate28);
  const tax = dMin(w.worksheetTax, w.allOrdinaryTax);
  const marginalOrdinaryRate = marginalBracketRate(w.ordinaryPortion, brackets);
  const marginalCapitalGainRate = dIsPos(w.taxedAtTwenty) ? rates[rates.length - 1]! : dIsPos(w.taxedAtFifteen) ? rates[1]! : rates[0]!;
  const keys = [bracketsKey, breakpointsKey, 'ltcg.rates', 'unrecaptured_1250_rate', 'collectibles_rate'];
  ctx.trace.add({ step: STEP_REGULAR_TAX, id: 'regular_tax.ordinary', label: 'Tax on ordinary income (worksheet)', exact: w.ordinaryTax, source: 'parameter', formula: `bracket tax on ${w.ordinaryPortion}`, parameterKeys: [bracketsKey], marginalRate: marginalOrdinaryRate });
  ctx.trace.add({ step: STEP_REGULAR_TAX, id: 'regular_tax.preferential', label: 'Tax on qualified dividends and long-term gains (0 / 15 / 20 / 25 / 28)', exact: w.preferentialTax, source: 'parameter', formula: `${w.taxedAtZero} @ ${rates[0]} + ${w.taxedAtFifteen} @ ${rates[1]} + ${w.taxedAtTwenty} @ ${rates[rates.length - 1]} + ${w.taxedAtTwentyFive} @ ${rate25} + ${w.taxedAtTwentyEight} @ ${rate28}`, parameterKeys: keys, marginalRate: marginalCapitalGainRate });
  ctx.trace.add({ step: STEP_REGULAR_TAX, id: 'regular_tax', label: dIsZero(dSub(tax, w.worksheetTax)) ? 'Regular tax (QD / LTCG worksheet)' : 'Regular tax (all-ordinary, lower than the worksheet)', exact: tax, source: 'parameter', formula: `min(worksheet ${w.worksheetTax}, all ordinary ${w.allOrdinaryTax})`, parameterKeys: keys, marginalRate: marginalOrdinaryRate });
  return { method: 'brackets', taxableIncome: ti, tax, marginalOrdinaryRate, marginalCapitalGainRate, effectiveRate: dRoundRate(dDiv(tax, positiveTi)), worksheet: w };
}
