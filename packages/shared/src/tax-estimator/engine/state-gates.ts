// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// State estimate-requirement gates (D12b, OPEN-QUESTIONS Q26). Decides whether
// a jurisdiction requires quarterly estimates from this taxpayer:
//   - no income tax → no;  estimates_required = false (ID, UT) → no;
//   - no / incomplete rule set → federal pattern (tax after withholding and
//     credits vs `safe_harbor.min_balance_due`) flagged "verify";
//   - plain test: tax after withholding and credits vs `required_threshold`
//     with the `threshold_comparison` boundary;
//   - `requirement_gate` (optional key) replaces / qualifies the plain test:
//     AZ gross income > $75k/$150k in both years, GA gross > exemptions +
//     deductions + $1,000, PA non-withheld income > $11k/$14k, ME prior-year
//     liability also at least $1,000, NM threshold nets withholding only.
// Penalty add-ons and caps (MI/VT/IN/UT/ID/DC/CT/DE) are NOT modelled: every
// gate with a regime carries an "estimate may differ" note.
// Every constant comes from a rule or parameter key; nothing is hard-coded.

import type { FilingStatus } from '../types.js';
import type { RequirementGateKind, RequirementGateRule, ThresholdComparison } from '../stateRuleKeys.js';
import { ZERO, dCmp, dSub, dSum, dec, type Dec } from '../decimal.js';
import type { EngineContext } from './context.js';
import type { ParameterReader } from './parameters.js';
import type {
  FederalFiguresForState, StateEstimateGate, StateGateInputs, StateGateMethod, StateJurisdictionInput, StateRuleReader, StateTraceBuilder,
} from './state-types.js';

const STEP = 'state_gate';
const KEY_HAS_INCOME_TAX = 'has_income_tax';
const KEY_ESTIMATES_REQUIRED = 'estimates_required';
const KEY_REQUIRED_THRESHOLD = 'required_threshold';
const KEY_THRESHOLD_COMPARISON = 'threshold_comparison';
const KEY_REQUIREMENT_GATE = 'requirement_gate';
const KEY_PENALTY_METHOD = 'penalty.method';
/** Federal pattern: estimates required when the balance after withholding and credits reaches this. */
const FEDERAL_MIN_BALANCE_KEY = 'safe_harbor.min_balance_due';

const PENALTY_ADDON_NOTE = 'Underpayment penalty add-ons and caps (where the state has them) are not modelled; the penalty estimate may differ.';
const GATE_DEFAULT_COMPARISON: ThresholdComparison = 'at_least';

export interface GateEvaluationInput {
  state: string;
  filingStatus: FilingStatus;
  /** null = no jurisdiction supplied (federal fallback). */
  jurisdiction: StateJurisdictionInput | null;
  /** Reader over the jurisdiction's rules; null when falling back. */
  rules: StateRuleReader | null;
  /** This state's tax for the year after the credit for other-state taxes (before withholding). */
  stateTax: Dec;
  gate: StateGateInputs;
  federal: FederalFiguresForState;
}

export interface GateContext {
  params: ParameterReader;
  trace: StateTraceBuilder;
  warn: EngineContext['warn'];
  info: EngineContext['info'];
}

/** `measured` meets `threshold` under the boundary rule. */
export function meetsThreshold(measured: Dec, threshold: Dec, comparison: ThresholdComparison): boolean {
  const c = dCmp(measured, threshold);
  return comparison === 'more_than' ? c > 0 : c >= 0;
}

function thresholdComparison(rules: StateRuleReader): ThresholdComparison {
  const v = rules.text(KEY_THRESHOLD_COMPARISON);
  return v === 'more_than' ? 'more_than' : GATE_DEFAULT_COMPARISON;
}

function gateRule(rules: StateRuleReader): RequirementGateRule | null {
  const o = rules.object(KEY_REQUIREMENT_GATE);
  if (!o) return null;
  return o as unknown as RequirementGateRule;
}

function numField(rule: RequirementGateRule, field: 'threshold' | 'threshold_mfj' | 'non_withheld_floor', state: string): Dec {
  const v = rule[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`TE_STATE_RULE_INVALID: ${state} requirement_gate.${field} is not a number`);
  return dec(v);
}

interface GateDecision { satisfied: boolean | null; measured: Dec | null; threshold: Dec | null; notes: string[]; missing: string[] }

/** The income-based part of the gate (null satisfied = an input it needs was not provided). */
function evaluateIncomeGate(kind: RequirementGateKind, rule: RequirementGateRule, input: GateEvaluationInput, base: { measured: Dec; threshold: Dec | null; comparison: ThresholdComparison }): GateDecision {
  const { state, gate, federal } = input;
  const notes: string[] = [];
  const missing: string[] = [];
  switch (kind) {
    case 'gross_income_both_years': {
      const single = numField(rule, 'threshold', state);
      const t = input.filingStatus === 'mfj' && rule.threshold_mfj !== undefined ? numField(rule, 'threshold_mfj', state) : single;
      const gross = gate.grossIncome ?? federal.totalIncome;
      if (gate.grossIncome == null) notes.push('Current-year state gross income not provided; federal total income used.');
      if (gate.priorYearGrossIncome == null) {
        missing.push('priorYearGrossIncome');
        notes.push(`Prior-year gross income not provided; the two-year gross-income gate (more than ${t} in both years) could not be applied.`);
        return { satisfied: null, measured: gross, threshold: t, notes, missing };
      }
      const satisfied = dCmp(gross, t) > 0 && dCmp(gate.priorYearGrossIncome, t) > 0;
      notes.push(`Gross income must exceed ${t} in both the current year (${gross}) and the prior year (${gate.priorYearGrossIncome}).`);
      return { satisfied, measured: gross, threshold: t, notes, missing };
    }
    case 'gross_over_exemptions_deductions': {
      const floor = numField(rule, 'non_withheld_floor', state);
      const gross = gate.grossIncome ?? federal.totalIncome;
      if (gate.grossIncome == null) notes.push('Current-year state gross income not provided; federal total income used.');
      if (gate.exemptions == null) { missing.push('exemptions'); notes.push('State exemptions not provided; the gross-income gate could not be applied.'); return { satisfied: null, measured: gross, threshold: null, notes, missing }; }
      const deductions = gate.deductions ?? federal.deduction;
      if (gate.deductions == null) notes.push('State deductions not provided; the federal deduction taken was used.');
      const t = dSum([gate.exemptions, deductions, floor]);
      notes.push(`Gross income ${gross} must exceed exemptions ${gate.exemptions} + deductions ${deductions} + ${floor} = ${t}.`);
      return { satisfied: dCmp(gross, t) > 0, measured: gross, threshold: t, notes, missing };
    }
    case 'non_withheld_income': {
      const t = numField(rule, 'threshold', state);
      const nonWithheld = gate.nonWithheldIncome ?? dSub(federal.totalIncome, federal.wages);
      if (gate.nonWithheldIncome == null) notes.push('Income not subject to withholding not provided; federal total income less wages used.');
      notes.push(`Income not subject to withholding ${nonWithheld} must exceed ${t}.`);
      return { satisfied: dCmp(nonWithheld, t) > 0, measured: nonWithheld, threshold: t, notes, missing };
    }
    case 'prior_year_liability_also': {
      const t = numField(rule, 'threshold', state);
      if (gate.priorYearLiability == null) {
        missing.push('priorYearLiability');
        notes.push(`Prior-year state liability not provided; the two-year test (prior-year liability also ${base.comparison === 'more_than' ? 'more than' : 'at least'} ${t}) could not be applied.`);
        return { satisfied: null, measured: base.measured, threshold: t, notes, missing };
      }
      const satisfied = meetsThreshold(gate.priorYearLiability, t, base.comparison);
      notes.push(`Prior-year liability ${gate.priorYearLiability} must also ${base.comparison === 'more_than' ? 'exceed' : 'reach'} ${t}.`);
      return { satisfied, measured: base.measured, threshold: t, notes, missing };
    }
    case 'nets_withholding_only': {
      const measured = dSub(input.stateTax, gate.withholding);
      notes.push(`Threshold measured on tax less withholding only (${input.stateTax} − ${gate.withholding}); credits are not subtracted.`);
      return { satisfied: base.threshold == null ? null : meetsThreshold(measured, base.threshold, base.comparison), measured, threshold: base.threshold, notes, missing };
    }
    default: {
      const never: never = kind;
      throw new Error(`TE_STATE_RULE_INVALID: unknown requirement_gate kind ${String(never)}`);
    }
  }
}

function finish(ctx: GateContext, gate: StateEstimateGate, keys: string[]): StateEstimateGate {
  ctx.trace.add({
    step: STEP, id: `state.${gate.state}.gate`, state: gate.state,
    label: `${gate.state} estimates ${gate.required === null ? 'undetermined' : gate.required ? 'required' : 'not required'} (${gate.method})`,
    exact: gate.measured ?? ZERO, source: 'state_rule', ruleKeys: keys,
    formula: gate.threshold == null ? undefined : `${gate.measured ?? ZERO} vs ${gate.threshold} (${gate.comparison})`,
  });
  return gate;
}

/** Decide whether `input.state` requires quarterly estimates (D12b). Pure; reads rules and the federal fallback parameter only. */
export function evaluateEstimateGate(input: GateEvaluationInput, ctx: GateContext): StateEstimateGate {
  const { state, jurisdiction, rules, gate } = input;
  const afterWithholdingAndCredits = dSub(dSub(input.stateTax, gate.withholding), gate.credits);
  const common = { state, gateKind: null, gateSatisfied: null, comparison: GATE_DEFAULT_COMPARISON } as const;

  // No income tax.
  const hasIncomeTax = rules ? rules.bool(KEY_HAS_INCOME_TAX) : null;
  if (jurisdiction && hasIncomeTax === false) {
    return finish(ctx, { ...common, method: 'no_income_tax', required: false, threshold: null, measured: null, verify: jurisdiction.verifyBadge, notes: [`${state} has no broad-based personal income tax.`], ruleKeys: [KEY_HAS_INCOME_TAX] }, [KEY_HAS_INCOME_TAX]);
  }

  // Federal fallback (no jurisdiction, or no / incomplete rules).
  if (!jurisdiction || !rules || jurisdiction.usesFederalFallback) {
    const threshold = ctx.params.money(FEDERAL_MIN_BALANCE_KEY);
    ctx.warn('TE_STATE_RULES_FALLBACK', `${state} has no verified estimated-tax rule set; the federal pattern (estimates required at ${threshold} after withholding and credits) was applied. Verify.`, { state });
    const required = meetsThreshold(afterWithholdingAndCredits, threshold, GATE_DEFAULT_COMPARISON);
    const g: StateEstimateGate = { ...common, method: 'federal_fallback', required, threshold, measured: afterWithholdingAndCredits, verify: true, notes: ['Federal pattern applied (no verified state rules). Verify.', PENALTY_ADDON_NOTE], ruleKeys: [] };
    ctx.trace.add({ step: STEP, id: `state.${state}.gate.threshold`, state, label: `${state} federal-pattern threshold (verify)`, exact: threshold, source: 'parameter', parameterKeys: [FEDERAL_MIN_BALANCE_KEY] });
    return finish(ctx, g, []);
  }

  // No quarterly regime (ID, UT).
  const estimatesRequired = rules.bool(KEY_ESTIMATES_REQUIRED);
  if (estimatesRequired === false || !jurisdiction.estimatesRequired) {
    return finish(ctx, { ...common, method: 'no_estimate_regime', required: false, threshold: null, measured: afterWithholdingAndCredits, verify: jurisdiction.verifyBadge, notes: [`${state} has no quarterly individual estimated-tax requirement: no estimates required, no vouchers, no underpayment penalty.`], ruleKeys: [KEY_ESTIMATES_REQUIRED] }, [KEY_ESTIMATES_REQUIRED]);
  }

  const threshold = rules.money(KEY_REQUIRED_THRESHOLD);
  const comparison = thresholdComparison(rules);
  const keys = [KEY_ESTIMATES_REQUIRED, KEY_REQUIRED_THRESHOLD, KEY_THRESHOLD_COMPARISON];
  const notes: string[] = [];
  let verify = jurisdiction.verifyBadge;
  if (threshold == null) {
    verify = true;
    ctx.warn('TE_STATE_THRESHOLD_MISSING', `${state} has no required_threshold; the estimate requirement could not be tested.`, { state });
  }
  const baseRequired = threshold == null ? null : meetsThreshold(afterWithholdingAndCredits, threshold, comparison);

  const rule = gateRule(rules);
  if (rule) keys.push(KEY_REQUIREMENT_GATE);
  let method: StateGateMethod = 'threshold';
  let required: boolean | null = baseRequired;
  let measured: Dec | null = afterWithholdingAndCredits;
  let effectiveThreshold: Dec | null = threshold;
  let gateSatisfied: boolean | null = null;
  if (rule) {
    method = rule.kind;
    const d = evaluateIncomeGate(rule.kind, rule, input, { measured: afterWithholdingAndCredits, threshold, comparison });
    notes.push(...d.notes);
    gateSatisfied = d.satisfied;
    if (d.missing.length > 0) {
      verify = true;
      ctx.warn('TE_STATE_GATE_INPUT_MISSING', `${state} estimate-requirement gate (${rule.kind}) needs ${d.missing.join(', ')}; the plain threshold test was shown instead. Verify.`, { state, kind: rule.kind, missing: d.missing });
      required = baseRequired;
    } else {
      switch (rule.kind) {
        case 'gross_income_both_years':
        case 'prior_year_liability_also':
          // Additional AND condition on top of the threshold test.
          required = baseRequired === null ? null : baseRequired && d.satisfied === true;
          break;
        case 'gross_over_exemptions_deductions':
        case 'non_withheld_income':
          // Income test replaces the tax-due test.
          required = d.satisfied;
          measured = d.measured;
          effectiveThreshold = d.threshold;
          break;
        case 'nets_withholding_only':
          required = d.satisfied;
          measured = d.measured;
          break;
        default: {
          const never: never = rule.kind;
          throw new Error(`TE_STATE_RULE_INVALID: unknown requirement_gate kind ${String(never)}`);
        }
      }
    }
  }
  if (threshold != null && method !== 'nets_withholding_only') notes.push(`Tax ${input.stateTax} less withholding ${gate.withholding} and credits ${gate.credits} = ${afterWithholdingAndCredits}; threshold ${threshold} (${comparison}).`);

  // Penalty add-ons stay a note (D12b).
  const penaltyMethod = rules.text(KEY_PENALTY_METHOD);
  keys.push(KEY_PENALTY_METHOD);
  notes.push(penaltyMethod && penaltyMethod !== 'daily_simple' ? `${PENALTY_ADDON_NOTE} (${state} accrues its penalty as ${penaltyMethod}.)` : PENALTY_ADDON_NOTE);
  ctx.info('TE_STATE_PENALTY_ADDONS_NOT_MODELLED', `${state}: ${PENALTY_ADDON_NOTE}`, { state });

  if (effectiveThreshold != null) {
    ctx.trace.add({ step: STEP, id: `state.${state}.gate.threshold`, state, label: `${state} estimate-requirement threshold (${method}, ${comparison})`, exact: effectiveThreshold, source: 'state_rule', ruleKeys: keys });
  }
  return finish(ctx, { state, method, required, threshold: effectiveThreshold, comparison, measured, gateKind: rule ? rule.kind : null, gateSatisfied, verify, notes, ruleKeys: keys }, keys);
}

/** The amount a state's threshold test measures by default (exported for Phase 10's voucher math). */
export function balanceAfterWithholdingAndCredits(stateTax: Dec, gate: StateGateInputs): Dec {
  return dSub(dSub(stateTax, gate.withholding), gate.credits);
}

export const STATE_GATE_RULE_KEYS = [KEY_HAS_INCOME_TAX, KEY_ESTIMATES_REQUIRED, KEY_REQUIRED_THRESHOLD, KEY_THRESHOLD_COMPARISON, KEY_REQUIREMENT_GATE, KEY_PENALTY_METHOD] as const;
export const STATE_GATE_FEDERAL_FALLBACK_KEY = FEDERAL_MIN_BALANCE_KEY;
