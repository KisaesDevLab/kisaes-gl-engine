// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md step 5 — self-employment tax per person (Schedule SE):
//   NESE     = SE income × se.nese_factor (zero when below se.min_nese or ≤ 0)
//   SS       = se.ss_rate × max(0, min(NESE, se.ss_wage_base − the person's W-2 Social Security wages))
//   Medicare = se.medicare_rate × NESE
//   ½ SE tax = SE tax × se.deduction_factor (the §164(f) deduction)

import { ZERO, dAdd, dCmp, dFloorZero, dIsPos, dMin, dMul, dSub, type Dec } from '../decimal.js';
import type { EngineContext } from './context.js';

const STEP_SE_TAX = 'se_tax';

export interface SeTaxInput {
  personId: string;
  label: string;
  /** Step 4 SE income (may be ≤ 0). */
  seIncome: Dec;
  /** Full-year W-2 Social Security wages of the same person. */
  socialSecurityWages: Dec;
}

export interface SeTaxExact {
  personId: string;
  seIncome: Dec;
  nese: Dec;
  socialSecurity: Dec;
  medicare: Dec;
  seTax: Dec;
  halfSeTax: Dec;
}

export function computeSeTax(input: SeTaxInput, ctx: EngineContext): SeTaxExact {
  const { params, trace } = ctx;
  const factor = params.rate('se.nese_factor');
  const minNese = params.money('se.min_nese');
  const ssRate = params.rate('se.ss_rate');
  const medicareRate = params.rate('se.medicare_rate');
  const wageBase = params.money('se.ss_wage_base');
  const deductionFactor = params.rate('se.deduction_factor');

  const grossNese = dIsPos(input.seIncome) ? dMul(input.seIncome, factor) : ZERO;
  const subject = dIsPos(grossNese) && dCmp(grossNese, minNese) >= 0;
  const nese = subject ? grossNese : ZERO;
  if (dIsPos(grossNese) && !subject) {
    ctx.info('TE_SE_BELOW_MINIMUM', `${input.label}: net earnings from self-employment ${grossNese} are below ${minNese}; no SE tax.`, { personId: input.personId });
  }
  const remainingBase = dFloorZero(dSub(wageBase, input.socialSecurityWages));
  const socialSecurity = dMul(ssRate, dMin(nese, remainingBase));
  const medicare = dMul(medicareRate, nese);
  const seTax = dAdd(socialSecurity, medicare);
  const halfSeTax = dMul(seTax, deductionFactor);

  trace.add({ step: STEP_SE_TAX, id: `nese.${input.personId}`, label: `${input.label} — net earnings from self-employment`, exact: nese, source: 'parameter', formula: `${input.seIncome} × ${factor}${subject ? '' : ` (below minimum ${minNese} → 0)`}`, personId: input.personId, parameterKeys: ['se.nese_factor', 'se.min_nese'] });
  trace.add({ step: STEP_SE_TAX, id: `se_ss.${input.personId}`, label: `${input.label} — SE Social Security`, exact: socialSecurity, source: 'parameter', formula: `${ssRate} × min(${nese}, ${wageBase} − W-2 SS wages ${input.socialSecurityWages})`, personId: input.personId, parameterKeys: ['se.ss_rate', 'se.ss_wage_base'], marginalRate: dIsPos(dMin(nese, remainingBase)) && dCmp(nese, remainingBase) < 0 ? ssRate : ZERO });
  trace.add({ step: STEP_SE_TAX, id: `se_medicare.${input.personId}`, label: `${input.label} — SE Medicare`, exact: medicare, source: 'parameter', formula: `${medicareRate} × ${nese}`, personId: input.personId, parameterKeys: ['se.medicare_rate'], marginalRate: dIsPos(nese) ? medicareRate : ZERO });
  trace.add({ step: STEP_SE_TAX, id: `se_tax.${input.personId}`, label: `${input.label} — self-employment tax`, exact: seTax, source: 'parameter', formula: 'Social Security + Medicare', personId: input.personId });
  trace.add({ step: STEP_SE_TAX, id: `half_se_tax.${input.personId}`, label: `${input.label} — deductible part of SE tax`, exact: halfSeTax, source: 'parameter', formula: `${seTax} × ${deductionFactor}`, personId: input.personId, parameterKeys: ['se.deduction_factor'] });

  return { personId: input.personId, seIncome: input.seIncome, nese, socialSecurity, medicare, seTax, halfSeTax };
}
