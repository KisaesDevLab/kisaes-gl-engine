// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md step 13 — Additional Medicare tax (Form 8959) and net investment
// income tax (Form 8960):
//   Additional Medicare = rate × [max(0, Medicare wages − threshold)
//                               + max(0, NESE − max(0, threshold − Medicare wages))]
//     i.e. wages + NESE above the threshold, the threshold used by wages first.
//     Medicare wages = outside W-2 wages (the higher of box 1 and Social Security
//     wages, since box 5 is uncapped) + officer wages, all persons on the return.
//   NIIT = rate × max(0, min(NII, MAGI − threshold)), MAGI = AGI;
//     NII = interest + dividends + net capital gain (or the limited loss) + rental
//     (after §469) + ordinary income of passive / investment interests (after §469)
//     − allocable deductions entered by the user (Form 8960 Part II).
// A non-null input amount is a CPA override and replaces the computed figure.

import { ZERO, dAdd, dFloorZero, dIsPos, dIsZero, dMin, dMul, dSub, dSum, dec, type Dec } from '../decimal.js';
import type { EngineContext } from './context.js';
import type { OtherTaxesInput, OtherTaxesResult } from './types.js';

const STEP = 'other_taxes';

export interface OtherTaxesPerson {
  personId: string;
  label: string;
  medicareWages: Dec;
  /** Step 5 NESE (≥ 0). */
  nese: Dec;
}

export interface OtherTaxesContext {
  persons: ReadonlyArray<OtherTaxesPerson>;
  interest: Dec;
  /** Ordinary dividends including qualified. */
  dividends: Dec;
  /** Net capital gain after the §1211 limit (may be a limited loss). */
  capitalGains: Dec;
  /** Rental income after loss limitations. */
  rental: Dec;
  /** Ordinary income of passive / investment interests after loss limitations. */
  passiveOrdinary: Dec;
  agi: Dec;
}

export type OtherTaxesExact = OtherTaxesResult;

export function computeOtherTaxes(input: OtherTaxesInput, c: OtherTaxesContext, ctx: EngineContext): OtherTaxesExact {
  const { params, filingStatus: fs } = ctx;

  // ── Additional Medicare (Form 8959) ──
  const medRate = params.rate('addl_medicare.rate');
  const medThreshold = params.moneyFs('addl_medicare.threshold', fs);
  const medicareWages = dSum(c.persons.map((p) => dFloorZero(p.medicareWages)));
  const nese = dSum(c.persons.map((p) => dFloorZero(p.nese)));
  const wagesAbove = dFloorZero(dSub(medicareWages, medThreshold));
  const neseAbove = dFloorZero(dSub(nese, dFloorZero(dSub(medThreshold, medicareWages))));
  const medComputed = dMul(medRate, dAdd(wagesAbove, neseAbove));
  let medTax = medComputed;
  let medMethod: OtherTaxesResult['additionalMedicare']['method'] = 'computed';
  if (input.additionalMedicareTax != null) {
    medTax = dFloorZero(dec(input.additionalMedicareTax));
    medMethod = 'manual';
    ctx.warn('TE_ADDL_MEDICARE_MANUAL_OVERRIDE', `Additional Medicare tax is overridden to ${medTax} (engine computed ${medComputed}).`, { manual: medTax, computed: medComputed });
  }
  const medKeys = ['addl_medicare.rate', `addl_medicare.threshold.${fs}`];
  if (dIsPos(wagesAbove)) ctx.trace.add({ step: STEP, id: 'additional_medicare.wages', label: 'Additional Medicare tax on wages above the threshold', exact: dMul(medRate, wagesAbove), source: 'parameter', formula: `${medRate} × (${medicareWages} − ${medThreshold})`, parameterKeys: medKeys });
  if (dIsPos(neseAbove)) ctx.trace.add({ step: STEP, id: 'additional_medicare.se', label: 'Additional Medicare tax on self-employment income (threshold reduced by wages)', exact: dMul(medRate, neseAbove), source: 'parameter', formula: `${medRate} × (${nese} − max(0, ${medThreshold} − ${medicareWages}))`, parameterKeys: medKeys });
  ctx.trace.add({ step: STEP, id: 'additional_medicare', label: `Additional Medicare tax${medMethod === 'manual' ? ' (MANUAL OVERRIDE)' : ''}`, exact: medTax, source: medMethod === 'manual' ? 'input' : 'parameter', formula: medMethod === 'manual' ? `override; computed ${medComputed}` : `${medRate} × (${wagesAbove} + ${neseAbove})`, parameterKeys: medKeys });

  // ── NIIT (Form 8960) ──
  const niitRate = params.rate('niit.rate');
  const niitThreshold = params.moneyFs('niit.threshold', fs);
  const allocable = input.niiAllocableDeductions == null ? ZERO : dFloorZero(dec(input.niiAllocableDeductions));
  const items = dSum([c.interest, c.dividends, c.capitalGains, c.rental, c.passiveOrdinary]);
  const nii = dFloorZero(dSub(items, allocable));
  const base = dFloorZero(dMin(nii, dSub(c.agi, niitThreshold)));
  const niitComputed = dMul(niitRate, base);
  let niitTax = niitComputed;
  let niitMethod: OtherTaxesResult['niit']['method'] = 'computed';
  if (input.niit != null) {
    niitTax = dFloorZero(dec(input.niit));
    niitMethod = 'manual';
    ctx.warn('TE_NIIT_MANUAL_OVERRIDE', `Net investment income tax is overridden to ${niitTax} (engine computed ${niitComputed}).`, { manual: niitTax, computed: niitComputed });
  }
  const niitKeys = ['niit.rate', `niit.threshold.${fs}`];
  if (!dIsZero(items)) ctx.trace.add({ step: STEP, id: 'niit.nii', label: 'Net investment income', exact: nii, source: 'gl_map', formula: `interest ${c.interest} + dividends ${c.dividends} + capital gains ${c.capitalGains} + rental ${c.rental} + passive K-1 ${c.passiveOrdinary} − allocable deductions ${allocable}, not below 0` });
  ctx.trace.add({ step: STEP, id: 'niit', label: `Net investment income tax${niitMethod === 'manual' ? ' (MANUAL OVERRIDE)' : ''}`, exact: niitTax, source: niitMethod === 'manual' ? 'input' : 'parameter', formula: niitMethod === 'manual' ? `override; computed ${niitComputed}` : `${niitRate} × min(NII ${nii}, MAGI ${c.agi} − ${niitThreshold}), not below 0`, parameterKeys: niitKeys });

  return {
    additionalMedicare: { method: medMethod, medicareWages, nese, threshold: medThreshold, wagesAboveThreshold: wagesAbove, neseAboveThreshold: neseAbove, tax: medTax },
    niit: { method: niitMethod, interest: c.interest, dividends: c.dividends, capitalGains: c.capitalGains, rental: c.rental, passiveOrdinary: c.passiveOrdinary, allocableDeductions: allocable, netInvestmentIncome: nii, magi: c.agi, threshold: niitThreshold, base, tax: niitTax },
  };
}
