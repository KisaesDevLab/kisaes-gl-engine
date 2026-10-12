// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md "Safe harbor" — the required annual payment (Form 2210 Part I):
//   (a) current-year rule: `safe_harbor.current_pct` × current-year tax;
//   (b) prior-year rule: `safe_harbor.prior_pct` (or `prior_pct_high_agi` when
//       the PRIOR-year AGI exceeds `safe_harbor.high_agi_threshold.{standard|mfs}`)
//       × prior-year tax — unavailable when the prior year was short or unfiled;
//       a zero prior-year tax means NO penalty at all (§6654(e)(2)).
// BOTH are always shown; the recommended rule is the effective rule (year →
// taxpayer → firm default `lesser_of`, D10). The core is parameter-free so the
// state path (rules) and Phase 9's farmer / C corp paths (other keys or explicit
// percentages) reuse it through a SafeHarborPolicy.

import type { FilingStatus } from '../types.js';
import { dCmp, dIsZero, dMin, dMul, dRoundDollars, dSub, dec, type Dec } from '../decimal.js';
import type { EstimateContext, PriorYearInput, SafeHarborOverride, SafeHarborRuleSource } from './estimate-types.js';

const STEP = 'safe_harbor';
/** `safe_harbor.high_agi_threshold` variants (VARIANT_SETS.standard_mfs). */
const HIGH_AGI_VARIANT_STANDARD = 'standard';
const HIGH_AGI_VARIANT_MFS = 'mfs';

// ── Policies (which keys supply the percentages) ─────────────────────

export interface SafeHarborPolicy {
  label: string;
  currentPctKey: string;
  /** null = the regime has no prior-year harbor. */
  priorPctKey: string | null;
  /** null = no high-AGI variant. */
  priorPctHighAgiKey: string | null;
  /** Base of the `{standard|mfs}` threshold keys; null = no high-AGI test. */
  highAgiThresholdBase: string | null;
  /** Key of the "no penalty when the balance after withholding is below" amount; null = none. */
  minBalanceDueKey: string | null;
}

export const INDIVIDUAL_SAFE_HARBOR_POLICY: SafeHarborPolicy = {
  label: 'individual (§6654(d))',
  currentPctKey: 'safe_harbor.current_pct',
  priorPctKey: 'safe_harbor.prior_pct',
  priorPctHighAgiKey: 'safe_harbor.prior_pct_high_agi',
  highAgiThresholdBase: 'safe_harbor.high_agi_threshold',
  minBalanceDueKey: 'safe_harbor.min_balance_due',
};

/** Phase 9: farmers / fishermen (§6654(i)) — 66⅔% current, 100% prior, no high-AGI variant. */
export const FARMER_SAFE_HARBOR_POLICY: SafeHarborPolicy = {
  label: 'farmer / fisherman (§6654(i))',
  currentPctKey: 'farmer.safe_harbor_current_pct',
  priorPctKey: 'farmer.safe_harbor_prior_pct',
  priorPctHighAgiKey: null,
  highAgiThresholdBase: null,
  minBalanceDueKey: 'safe_harbor.min_balance_due',
};

/** Phase 9: C corporations (§6655) — the large-corporation rule is applied by the caller (prior year marked unavailable). */
export const CCORP_SAFE_HARBOR_POLICY: SafeHarborPolicy = {
  label: 'C corporation (§6655)',
  currentPctKey: 'ccorp.safe_harbor_current_pct',
  priorPctKey: 'ccorp.safe_harbor_prior_pct',
  priorPctHighAgiKey: null,
  highAgiThresholdBase: null,
  minBalanceDueKey: null,
};

// ── Core (parameter-free) ────────────────────────────────────────────

/** Resolved percentages, however they were sourced (parameters, state rules, explicit overrides). */
export interface SafeHarborRates {
  currentPct: Dec;
  /** null = no prior-year harbor in this regime. */
  priorPct: Dec | null;
  /** Percentage replacing `priorPct` when the prior-year AGI exceeds `highAgiThreshold`; null = none. */
  priorPctHighAgi: Dec | null;
  highAgiThreshold: Dec | null;
  /** Prior-year harbor unavailable when the CURRENT-year AGI reaches this (CA `no_prior_year_agi`); null = none. */
  priorHarborCurrentAgiCutoff: Dec | null;
  /** Keys the rates were read from (trace). */
  keys: string[];
  /** Caller-supplied reason the prior-year harbor is unavailable (e.g. large corporation), null = decide from the prior-year inputs. */
  priorUnavailableReason: string | null;
}

export interface SafeHarborCoreInput {
  jurisdiction: string;
  currentYearTax: Dec;
  /** Current-year AGI (only the CA-style current-AGI cutoff reads it). */
  currentYearAgi: Dec | null;
  priorYear: PriorYearInput;
  rule: SafeHarborOverride;
  ruleSource: SafeHarborRuleSource;
  rates: SafeHarborRates;
}

export type SafeHarborPriorYearReason = 'unfiled' | 'short_year' | 'tax_unknown' | 'no_prior_year_rule' | 'current_agi_cutoff' | 'other';

export interface SafeHarborPriorYear {
  available: boolean;
  unavailableReason: SafeHarborPriorYearReason | null;
  unavailableDetail: string | null;
  tax: Dec | null;
  agi: Dec | null;
  pct: Dec | null;
  highAgiApplied: boolean;
  /** Prior-year AGI was needed for the high-AGI test but not supplied (the base pct was used; verify). */
  highAgiUntested: boolean;
  /** pct × prior-year tax (whole dollars); null when unavailable. */
  amount: Dec | null;
}

export interface SafeHarborExact {
  currentYearAmount: Dec;
  priorYearAmount: Dec | null;
  requiredAnnualPayment: Dec;
}

export interface SafeHarborResult {
  jurisdiction: string;
  policy: string;
  rule: SafeHarborOverride;
  ruleSource: SafeHarborRuleSource;
  /** The rule the required amount actually follows (falls back to current_year when the prior year is unavailable). */
  appliedRule: SafeHarborOverride;
  currentYear: { tax: Dec; pct: Dec; amount: Dec };
  priorYear: SafeHarborPriorYear;
  requiredAnnualPayment: Dec;
  /** §6654(e)(2): zero prior-year tax on a filed 12-month return → no underpayment penalty. */
  noPenaltyReason: 'prior_year_zero_tax' | null;
  /** Something the CPA must check (missing prior-year AGI, caller-supplied unavailability …). */
  verify: boolean;
  notes: string[];
  keys: string[];
  exact: SafeHarborExact;
}

const R = dRoundDollars;

function priorYearStatus(input: SafeHarborCoreInput): { available: boolean; reason: SafeHarborPriorYearReason | null; detail: string | null } {
  const { priorYear: py, rates } = input;
  if (rates.priorUnavailableReason) return { available: false, reason: 'other', detail: rates.priorUnavailableReason };
  if (rates.priorPct == null) return { available: false, reason: 'no_prior_year_rule', detail: `${input.jurisdiction} has no prior-year safe harbor.` };
  if (!py.filed) return { available: false, reason: 'unfiled', detail: 'No prior-year return was filed; the prior-year safe harbor is unavailable.' };
  if (!py.twelveMonths) return { available: false, reason: 'short_year', detail: 'The prior year was not a 12-month tax year; the prior-year safe harbor is unavailable.' };
  if (py.tax == null) return { available: false, reason: 'tax_unknown', detail: 'The prior-year tax has not been entered; the prior-year safe harbor cannot be computed.' };
  if (rates.priorHarborCurrentAgiCutoff != null && input.currentYearAgi != null && dCmp(input.currentYearAgi, rates.priorHarborCurrentAgiCutoff) >= 0) {
    return { available: false, reason: 'current_agi_cutoff', detail: `Current-year AGI ${input.currentYearAgi} is at or above ${rates.priorHarborCurrentAgiCutoff}; ${input.jurisdiction} does not allow the prior-year safe harbor.` };
  }
  return { available: true, reason: null, detail: null };
}

/**
 * Parameter-free safe-harbor arithmetic. Writes trace rows when a context is
 * given; never reads parameters itself (the wrappers below do).
 */
export function resolveSafeHarbor(input: SafeHarborCoreInput, ctx?: EstimateContext): SafeHarborResult {
  const { rates, jurisdiction } = input;
  const tax = dec(input.currentYearTax);
  const notes: string[] = [];
  let verify = false;

  const currentAmount = dMul(rates.currentPct, tax);

  // Prior-year harbor.
  const status = priorYearStatus(input);
  let priorPct: Dec | null = null;
  let priorAmount: Dec | null = null;
  let highAgiApplied = false;
  let highAgiUntested = false;
  let noPenaltyReason: SafeHarborResult['noPenaltyReason'] = null;
  if (status.available) {
    const priorTax = dec(input.priorYear.tax as Dec);
    priorPct = rates.priorPct as Dec;
    if (rates.priorPctHighAgi != null && rates.highAgiThreshold != null) {
      if (input.priorYear.agi == null) {
        highAgiUntested = true;
        verify = true;
        notes.push(`Prior-year AGI not entered: the high-AGI test (prior-year AGI over ${rates.highAgiThreshold}) could not be applied; ${rates.priorPct} of prior-year tax was used. Verify.`);
        ctx?.warn('TE_SAFE_HARBOR_PRIOR_AGI_MISSING', `${jurisdiction}: prior-year AGI is missing; the high-AGI safe-harbor percentage could not be tested.`, { jurisdiction });
      } else if (dCmp(dec(input.priorYear.agi), rates.highAgiThreshold) > 0) {
        highAgiApplied = true;
        priorPct = rates.priorPctHighAgi;
        notes.push(`Prior-year AGI ${input.priorYear.agi} exceeds ${rates.highAgiThreshold}: the prior-year harbor is ${rates.priorPctHighAgi} of prior-year tax.`);
      }
    }
    priorAmount = dMul(priorPct, priorTax);
    if (dIsZero(priorTax)) {
      noPenaltyReason = 'prior_year_zero_tax';
      notes.push('The prior-year tax was zero on a filed 12-month return: no underpayment penalty applies (§6654(e)(2)); estimates are optional.');
    }
  } else {
    notes.push(status.detail as string);
    if (status.reason === 'other' || status.reason === 'current_agi_cutoff') verify = true;
  }

  // Rule → required annual payment.
  let appliedRule: SafeHarborOverride = input.rule;
  let required: Dec;
  switch (input.rule) {
    case 'current_year':
      required = currentAmount;
      break;
    case 'prior_year':
      if (priorAmount == null) { appliedRule = 'current_year'; required = currentAmount; notes.push('The prior-year rule was selected but the prior-year harbor is unavailable; the current-year rule applies.'); }
      else required = priorAmount;
      break;
    case 'lesser_of':
      if (priorAmount == null) { appliedRule = 'current_year'; required = currentAmount; }
      else required = dMin(currentAmount, priorAmount);
      break;
    default: {
      const never: never = input.rule;
      throw new Error(`TE_SAFE_HARBOR_RULE_INVALID: ${String(never)}`);
    }
  }

  if (ctx) {
    ctx.trace.add({ step: STEP, id: `${jurisdiction}.safe_harbor.current`, jurisdiction, label: `${jurisdiction} safe harbor — ${rates.currentPct} of current-year tax`, exact: currentAmount, source: 'parameter', formula: `${rates.currentPct} × ${tax}`, parameterKeys: rates.keys });
    if (priorAmount != null) {
      ctx.trace.add({ step: STEP, id: `${jurisdiction}.safe_harbor.prior`, jurisdiction, label: `${jurisdiction} safe harbor — ${priorPct} of prior-year tax${highAgiApplied ? ' (high AGI)' : ''}`, exact: priorAmount, source: 'parameter', formula: `${priorPct} × ${input.priorYear.tax}`, parameterKeys: rates.keys });
    }
    ctx.trace.add({ step: STEP, id: `${jurisdiction}.safe_harbor.required`, jurisdiction, label: `${jurisdiction} required annual payment (${appliedRule}${appliedRule !== input.rule ? `, requested ${input.rule}` : ''}; rule from ${input.ruleSource})`, exact: required, source: 'input', formula: priorAmount == null ? `current ${currentAmount}` : `${appliedRule === 'lesser_of' ? 'min' : appliedRule}(${currentAmount}, ${priorAmount})` });
  }

  return {
    jurisdiction,
    policy: '',
    rule: input.rule,
    ruleSource: input.ruleSource,
    appliedRule,
    currentYear: { tax: R(tax), pct: rates.currentPct, amount: R(currentAmount) },
    priorYear: {
      available: status.available, unavailableReason: status.reason, unavailableDetail: status.detail,
      tax: input.priorYear.tax == null ? null : R(dec(input.priorYear.tax)), agi: input.priorYear.agi == null ? null : R(dec(input.priorYear.agi)),
      pct: priorPct, highAgiApplied, highAgiUntested, amount: priorAmount == null ? null : R(priorAmount),
    },
    requiredAnnualPayment: R(required),
    noPenaltyReason,
    verify,
    notes,
    keys: rates.keys,
    exact: { currentYearAmount: currentAmount, priorYearAmount: priorAmount, requiredAnnualPayment: required },
  };
}

// ── Federal wrapper (reads the parameters through the policy) ────────

export interface FederalSafeHarborInput {
  currentYearTax: Dec;
  currentYearAgi: Dec | null;
  priorYear: PriorYearInput;
  rule: SafeHarborOverride;
  ruleSource: SafeHarborRuleSource;
  policy?: SafeHarborPolicy;
  /** Phase 9: explicit percentages winning over the policy keys (e.g. a large corporation's rule). */
  pctOverrides?: { currentPct?: Dec; priorPct?: Dec | null; priorUnavailableReason?: string };
}

export function federalSafeHarborRates(filingStatus: FilingStatus, ctx: EstimateContext, policy: SafeHarborPolicy = INDIVIDUAL_SAFE_HARBOR_POLICY, over: FederalSafeHarborInput['pctOverrides'] = {}): SafeHarborRates {
  const keys: string[] = [policy.currentPctKey];
  const currentPct = over.currentPct ?? ctx.params.rate(policy.currentPctKey);
  let priorPct: Dec | null = null;
  if (over.priorPct !== undefined) priorPct = over.priorPct;
  else if (policy.priorPctKey) { priorPct = ctx.params.rate(policy.priorPctKey); keys.push(policy.priorPctKey); }
  let priorPctHighAgi: Dec | null = null;
  let highAgiThreshold: Dec | null = null;
  if (policy.priorPctHighAgiKey && policy.highAgiThresholdBase && priorPct != null) {
    priorPctHighAgi = ctx.params.rate(policy.priorPctHighAgiKey);
    const thresholdKey = `${policy.highAgiThresholdBase}.${filingStatus === 'mfs' ? HIGH_AGI_VARIANT_MFS : HIGH_AGI_VARIANT_STANDARD}`;
    highAgiThreshold = ctx.params.money(thresholdKey);
    keys.push(policy.priorPctHighAgiKey, thresholdKey);
  }
  return { currentPct, priorPct, priorPctHighAgi, highAgiThreshold, priorHarborCurrentAgiCutoff: null, keys, priorUnavailableReason: over.priorUnavailableReason ?? null };
}

export function computeFederalSafeHarbor(input: FederalSafeHarborInput, ctx: EstimateContext): SafeHarborResult {
  const policy = input.policy ?? INDIVIDUAL_SAFE_HARBOR_POLICY;
  const rates = federalSafeHarborRates(ctx.filingStatus, ctx, policy, input.pctOverrides);
  const res = resolveSafeHarbor({ jurisdiction: 'federal', currentYearTax: input.currentYearTax, currentYearAgi: input.currentYearAgi, priorYear: input.priorYear, rule: input.rule, ruleSource: input.ruleSource, rates }, ctx);
  return { ...res, policy: policy.label };
}

/** §6654(e)(1): no penalty (and no estimates needed) when tax less withholding is below the minimum. */
export function balanceAfterWithholding(currentYearTax: Dec, withholding: Dec): Dec {
  return dSub(dec(currentYearTax), dec(withholding));
}
