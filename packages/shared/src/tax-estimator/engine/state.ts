// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md "State calculation" — the pure state orchestrator (Phase 8; Q53 rate schedules).
//   rate_mode 'brackets' (default; state-schedule.ts): the state's starting point − capital gain
//     exclusion − federal tax deduction − standard deduction − exemptions → the state's rate
//     schedule (with its capital-gain rates); a missing / null schedule falls back to the
//     effective rate with TE_STATE_BRACKETS_UNAVAILABLE. rate_mode 'effective' = the v1 formulas
//     below, labelled "effective-rate override".
//   nonresident (brackets, nonresident_mode 'ratio'): the state's method — 'ratio' = as-if-resident
//     schedule tax × sourced income ÷ federal AGI; 'sourced_flat' / 'other' = schedule on sourced
//     income less deductions and exemptions × that ratio. nonresident_mode 'sourced_rate' or
//     effective = sourced income × effective rate (NONRESIDENT_FLAT_RATE_LABEL);
//   resident credit for other-state taxes (brackets) = Σ min(other-state tax, resident tax ×
//     sourced income ÷ resident state AGI); effective = Σ min(other-state tax, rate × sourced);
//   sourced income manual or derived from the entities whose state_sourcing is that state;
//   C corp = apportionment % × taxable income × rate (computeCcorpStateTax, Phase 9).
// Every jurisdiction's estimate-requirement gate is evaluated (state-gates.ts).
// Takes the federal figures as a plain DTO so it is independent of federal.ts.

import type { FederalResult } from './types.js';
import type { StateRulesDTO, StateRuleRowDTO } from '../state-rules-api.js';
import type { StateRowDTO } from '../years-api.js';
import {
  ZERO, dAdd, dCmp, dFloorZero, dIsPos, dMin, dMul, dRoundRate, dRoundDollars, dSub, dSum, dec, type Dec,
} from '../decimal.js';
import { bracketSlices as bracketSlicesFor } from './bracket-tax.js';
import { EngineContext } from './context.js';
import type { IncomeCharacter } from '../entities-api.js';
import { evaluateEstimateGate, type GateContext } from './state-gates.js';
import {
  StateRuleReader, StateTraceBuilder, NONRESIDENT_FLAT_RATE_LABEL,
  type CcorpApportionmentExact, type CcorpApportionmentInput, type FederalFiguresForState, type NonresidentMethod, type StateCreditDetail,
  type StateEngineInput, type StateEstimateGate, type StateGateInputs, type StateJurisdictionInput, type StateResult, type StateEngineRow, type StateRowResult,
  type StateRuleMap, type StateRuleUse, type StateSourcedEntity,
} from './state-types.js';
import { TAX_ENGINE_VERSION } from './version.js';
import {
  KEY_CAPITAL_GAINS_EXCISE, capitalGainsExcise, computeScheduleTax, gainsFromFederal, incomeRatio, scheduleAvailable, type ScheduleCalc,
} from './state-schedule.js';
import type { StateCapitalGainsExciseRule } from '../stateRuleKeys.js';
import type { StateNonresidentMode, StateRateMode, StateScheduleSummary } from './state-types.js';

const STEP_SOURCING = 'state_sourcing';
const STEP_TAX = 'state_tax';
const STEP_CREDIT = 'state_credit';
const STEP_TOTAL = 'state_total';
const KEY_HAS_INCOME_TAX = 'has_income_tax';
const KEY_CREDIT_FOR_OTHER_STATE = 'credit_for_other_state';
const KEY_NONRESIDENT_METHOD = 'nonresident_method';
const KEY_ESTIMATES_REQUIRED = 'estimates_required';
const KEY_EXEMPTIONS = 'exemptions';
const NONRESIDENT_METHODS: readonly NonresidentMethod[] = ['ratio', 'sourced_flat', 'other'];

const R = dRoundDollars;

/** Per-calculation context: federal parameters + warnings via EngineContext, a state trace, one rule reader per state. */
export class StateContext implements GateContext {
  readonly base: EngineContext;
  readonly trace = new StateTraceBuilder();
  private readonly readers = new Map<string, StateRuleReader>();

  constructor(input: Pick<StateEngineInput, 'parameters' | 'taxYear' | 'filingStatus'>) {
    this.base = new EngineContext(input.parameters, input.taxYear, input.filingStatus);
  }

  get params() { return this.base.params; }
  warn: EngineContext['warn'] = (code, message, details, severity) => this.base.warn(code, message, details, severity);
  info: EngineContext['info'] = (code, message, details) => this.base.info(code, message, details);

  reader(state: string, rules: StateRuleMap): StateRuleReader {
    let r = this.readers.get(state);
    if (!r) { r = new StateRuleReader(state, rules); this.readers.set(state, r); }
    return r;
  }

  rulesUsed(): StateRuleUse[] {
    return [...this.readers.values()].flatMap((r) => r.used());
  }

  /** Step warnings, then the D12a parameter and rule warnings. */
  allWarnings() {
    return [...this.base.allWarnings(), ...[...this.readers.values()].flatMap((r) => r.warnings())];
  }
}

interface Resolved {
  jurisdiction: StateJurisdictionInput | null;
  rules: StateRuleReader | null;
  hasIncomeTax: boolean;
  usesFederalFallback: boolean;
  verify: boolean;
}

function resolveJurisdiction(state: string, input: StateEngineInput, ctx: StateContext): Resolved {
  const j = input.jurisdictions.find((x) => x.state === state) ?? null;
  if (!j) {
    ctx.warn('TE_STATE_RULES_MISSING', `No rule set was supplied for ${state}; the federal pattern applies and the state is flagged "verify".`, { state });
    return { jurisdiction: null, rules: null, hasIncomeTax: true, usesFederalFallback: true, verify: true };
  }
  const rules = ctx.reader(state, j.rules);
  const hasIncomeTax = rules.bool(KEY_HAS_INCOME_TAX) !== false;
  if (!hasIncomeTax) return { jurisdiction: j, rules, hasIncomeTax: false, usesFederalFallback: false, verify: j.verifyBadge };
  if (j.usesFederalFallback) return { jurisdiction: j, rules, hasIncomeTax: true, usesFederalFallback: true, verify: true };
  return { jurisdiction: j, rules, hasIncomeTax: true, usesFederalFallback: false, verify: j.verifyBadge };
}

function baseAmount(row: StateEngineRow, federal: FederalFiguresForState, ctx: StateContext): Dec {
  switch (row.base) {
    case 'federal_agi': return federal.agi;
    case 'federal_taxable': return federal.taxableIncome;
    case 'custom': {
      if (row.customBase == null) {
        ctx.warn('TE_STATE_CUSTOM_BASE_MISSING', `${row.state}: base is 'custom' but no custom base amount was entered; federal AGI was used.`, { state: row.state, rowId: row.rowId });
        return federal.agi;
      }
      return dec(row.customBase);
    }
    default: {
      const never: never = row.base;
      throw new Error(`TE_STATE_BASE_INVALID: ${String(never)}`);
    }
  }
}

// ── Q44: personal / dependent exemptions and exemption credits ─────────

interface ExemptionsExact {
  /** Total exemptions for the household (null = the rule is missing / unsourced). */
  exemption: Dec | null;
  credit: Dec | null;
  keys: string[];
}

type ExemptionStatusMap = Partial<Record<string, number>>;

/**
 * The household's exemption and exemption-credit totals under the state's `exemptions` rule.
 * Pure arithmetic; WHERE they apply is the caller's (resident rows only, exemptions only on a
 * computed base). Warnings: rule missing (info), rule a cited null (warning), a component
 * the household needs that is null (warning), simplified (info with the note).
 */
function stateExemptions(row: StateEngineRow, res: Resolved, input: StateEngineInput, ctx: StateContext): ExemptionsExact {
  if (!res.rules || !res.hasIncomeTax || res.usesFederalFallback) return { exemption: null, credit: null, keys: [] };
  if (!res.rules.has(KEY_EXEMPTIONS)) {
    ctx.info('TE_STATE_EXEMPTIONS_MISSING', `${row.state}: no personal / dependent exemption rule is on file for the year; none was applied.`, { state: row.state });
    return { exemption: null, credit: null, keys: [] };
  }
  const v = res.rules.object(KEY_EXEMPTIONS);
  if (!v) {
    ctx.warn('TE_STATE_EXEMPTIONS_UNSOURCED', `${row.state}: the personal / dependent exemption amounts could not be sourced for the year (stored as an explicit null); none were applied. Verify.`, { state: row.state });
    return { exemption: null, credit: null, keys: [KEY_EXEMPTIONS] };
  }
  const filers = input.household?.filers ?? 1;
  const dependents = input.household?.dependents ?? 0;
  const fs = input.filingStatus;
  const num = (x: unknown): Dec | null => (typeof x === 'number' && Number.isFinite(x) ? dec(x) : null);
  const missing: string[] = [];
  const perFiler = (byStatusKey: string, perKey: string): Dec => {
    const byStatus = v[byStatusKey] as ExemptionStatusMap | undefined;
    const whole = byStatus ? num(byStatus[fs]) : null;
    if (whole != null) return whole;
    const per = num(v[perKey]);
    if (per == null) { missing.push(perKey); return ZERO; }
    return dMul(per, String(filers));
  };
  const perDependent = (key: string): Dec => {
    if (dependents === 0) return ZERO;
    const per = num(v[key]);
    if (per == null) { missing.push(key); return ZERO; }
    return dMul(per, String(dependents));
  };
  const personalEx = perFiler('personal_exemption_by_status', 'personal_exemption');
  const dependentEx = perDependent('dependent_exemption');
  const personalCr = perFiler('personal_credit_by_status', 'personal_credit');
  const dependentCr = perDependent('dependent_credit');
  if (missing.length > 0) {
    ctx.warn('TE_STATE_EXEMPTIONS_COMPONENT_UNSOURCED', `${row.state}: ${missing.join(', ')} could not be sourced for the year (null); treated as 0. Verify.`, { state: row.state, missing });
  }
  if (v['simplified'] === true) {
    ctx.info('TE_STATE_EXEMPTIONS_SIMPLIFIED', `${row.state}: exemptions / exemption credits use the base or maximum amount; income phase-outs, tiers or age-based amounts are not modelled${typeof v['note'] === 'string' && v['note'] ? ` (${v['note']})` : ''}. The estimate may differ.`, { state: row.state });
  }
  const exemption = dAdd(personalEx, dependentEx);
  const credit = dAdd(personalCr, dependentCr);
  ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.exemption_amounts`, state: row.state, label: `${row.state} personal + dependent exemptions (${filers} filer${filers === 1 ? '' : 's'}, ${dependents} dependent${dependents === 1 ? '' : 's'})`, exact: exemption, source: 'state_rule', ruleKeys: [KEY_EXEMPTIONS], formula: `personal ${personalEx} + dependents ${dependentEx}` });
  return { exemption, credit, keys: [KEY_EXEMPTIONS] };
}

// ── Q53: which rate mode applies ─────────────────────────────────────

interface Modes {
  requested: StateRateMode;
  applied: StateRateMode;
  nonresidentMode: StateNonresidentMode;
}

/** Requested vs applied rate mode; warns once when brackets were asked for but no schedule exists. */
function modesFor(row: StateEngineRow, res: Resolved, input: StateEngineInput, ctx: StateContext): Modes {
  const requested: StateRateMode = row.rateMode ?? 'brackets';
  const nonresidentMode: StateNonresidentMode = row.nonresidentMode ?? 'ratio';
  if (requested === 'effective' || !res.hasIncomeTax) return { requested, applied: 'effective', nonresidentMode };
  if (row.residency === 'nonresident' && nonresidentMode === 'sourced_rate') return { requested, applied: 'effective', nonresidentMode };
  if (res.usesFederalFallback || !scheduleAvailable(res.rules, input.filingStatus)) {
    ctx.warn('TE_STATE_BRACKETS_UNAVAILABLE', `${row.state}: no rate schedule is on file for ${input.taxYear} (${input.filingStatus}); the row's effective rate ${row.effectiveRate} was used instead. Verify.`, { state: row.state, rowId: row.rowId });
    return { requested, applied: 'effective', nonresidentMode };
  }
  return { requested, applied: 'brackets', nonresidentMode };
}

function summary(c: ScheduleCalc, ratio: Dec | null, fullYearTax: Dec | null): StateScheduleSummary {
  return {
    startingPoint: c.startingPoint, start: R(c.start), capitalGainExclusion: R(c.capitalGainExclusion), federalTaxDeduction: R(c.federalTaxDeduction),
    standardDeduction: R(c.standardDeduction), exemptions: R(c.exemptions), taxableIncome: R(c.taxableIncome), scheduleTax: R(c.tax), scheduleLabel: c.scheduleLabel,
    capitalGainsTreatment: c.capitalGainsTreatment, ratio: ratio == null ? null : dRoundRate(ratio), fullYearTax: fullYearTax == null ? null : R(fullYearTax),
  };
}

/**
 * Nonresident rows: the effective-rate × sourced-income simplification takes no exemptions
 * (most states prorate them by the income ratio — part of the "effective-rate estimate"
 * label). The amounts are still read when the row has an income-based gate (GA).
 */
function nonresidentExemptions(row: StateEngineRow, res: Resolved, input: StateEngineInput, ctx: StateContext): ExemptionsExact {
  if (!res.rules || !res.rules.has('requirement_gate') || res.rules.value('requirement_gate') == null) return { exemption: null, credit: null, keys: [] };
  return stateExemptions(row, res, input, ctx);
}

interface NonresidentExact {
  sourced: Dec; derived: boolean; tax: Dec; method: NonresidentMethod | null;
  rowMethod: StateRowResult['method']; modes: Modes; schedule: StateScheduleSummary | null; exemptions: Dec; exemptionCredits: Dec;
}

function nonresidentTax(row: StateEngineRow, res: Resolved, input: StateEngineInput, ctx: StateContext, modes: Modes, ex: ExemptionsExact): NonresidentExact {
  const rate = dec(row.effectiveRate);
  let sourced: Dec;
  let derived = false;
  if (row.sourcedManual) {
    sourced = dec(row.sourcedIncome ?? ZERO);
    if (row.sourcedIncome == null) ctx.warn('TE_STATE_SOURCED_MISSING', `${row.state}: sourced income is manual but blank; 0 was used.`, { state: row.state, rowId: row.rowId });
    ctx.trace.add({ step: STEP_SOURCING, id: `state.${row.state}.sourced`, state: row.state, label: `${row.state} income sourced to the state (manual)`, exact: sourced, source: 'input' });
  } else {
    derived = true;
    const parts = input.entities.filter((e) => e.state === row.state);
    for (const e of parts) {
      ctx.trace.add({ step: STEP_SOURCING, id: `state.${row.state}.sourced.${e.companyId}`, state: row.state, entityId: e.companyId, label: `${e.companyName} share sourced to ${row.state} (entity state_sourcing)`, exact: dec(e.income), source: 'gl_map' });
    }
    sourced = dSum(parts.map((e) => e.income));
    if (parts.length === 0) ctx.warn('TE_STATE_SOURCED_NONE', `${row.state}: no linked entity is sourced to the state, so derived sourced income is 0. Enter it manually or set the entity's state sourcing.`, { state: row.state, rowId: row.rowId });
    ctx.trace.add({ step: STEP_SOURCING, id: `state.${row.state}.sourced`, state: row.state, label: `${row.state} income sourced to the state (derived from ${parts.length} entit${parts.length === 1 ? 'y' : 'ies'})`, exact: sourced, source: 'gl_map' });
  }
  let method: NonresidentMethod | null = null;
  const ruleKeys: string[] = [];
  if (res.rules && res.hasIncomeTax) {
    const m = res.rules.text(KEY_NONRESIDENT_METHOD);
    ruleKeys.push(KEY_NONRESIDENT_METHOD);
    method = m && (NONRESIDENT_METHODS as readonly string[]).includes(m) ? (m as NonresidentMethod) : null;
  }
  const base = { sourced, derived, method, modes, exemptions: ZERO, exemptionCredits: ZERO };
  if (!res.hasIncomeTax) {
    ctx.info('TE_STATE_NO_INCOME_TAX', `${row.state} has no broad-based personal income tax; the row computes 0.`, { state: row.state });
    if (res.rules?.has(KEY_CAPITAL_GAINS_EXCISE) && res.rules.value(KEY_CAPITAL_GAINS_EXCISE) != null) {
      ctx.info('TE_STATE_CG_EXCISE_RESIDENT_ONLY', `${row.state}: the capital gains excise tax applies to residents (intangible gains); a nonresident row computes 0.`, { state: row.state });
    }
    ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.tax`, state: row.state, label: `${row.state} nonresident tax (no income tax)`, exact: ZERO, source: 'state_rule', ruleKeys: [KEY_HAS_INCOME_TAX] });
    return { ...base, tax: ZERO, rowMethod: 'nonresident_flat', schedule: null };
  }
  if (modes.applied === 'brackets' && res.rules) {
    const agi = dec(input.federal.agi);
    const ratio = incomeRatio(dFloorZero(sourced), agi);
    const prorated = method === 'sourced_flat' || method === 'other';
    if (method == null) ctx.info('TE_STATE_NONRESIDENT_METHOD_ASSUMED', `${row.state}: no nonresident method is on file; the ratio method was used.`, { state: row.state });
    if (!dIsPos(agi) && dIsPos(sourced)) ctx.warn('TE_STATE_RATIO_NO_AGI', `${row.state}: federal AGI is not positive, so the nonresident income ratio is 0 and the tax computes 0. Verify.`, { state: row.state, rowId: row.rowId });
    ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.ratio`, state: row.state, label: `${row.state} income ratio (sourced income ÷ federal AGI, 0 to 1)`, exact: ratio, source: 'input', formula: `${dFloorZero(sourced)} ÷ ${agi}` });
    const credit = ex.credit != null && dIsPos(ex.credit) ? ex.credit : ZERO;
    if (!prorated) {
      const calc = computeScheduleTax({
        state: row.state, filingStatus: input.filingStatus, rules: res.rules, federal: input.federal, rowBase: row.base, customBase: row.customBase,
        exemption: ex.exemption, exemptionKeys: ex.keys, idPrefix: `state.${row.state}.full`, labelPrefix: `${row.state} (as if resident)`,
      }, ctx)!;
      const exCr = dMin(credit, calc.tax);
      const fullYearTax = dSub(calc.tax, exCr);
      if (dIsPos(exCr)) ctx.trace.add({ step: STEP_CREDIT, id: `state.${row.state}.full.exemption_credits`, state: row.state, label: `${row.state} (as if resident) exemption credits`, exact: exCr, source: 'state_rule', ruleKeys: ex.keys, formula: `min(${credit}, ${calc.tax})` });
      const tax = dMul(fullYearTax, ratio);
      ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.tax`, state: row.state, label: `${row.state} nonresident tax — ratio method (as-if-resident tax × income ratio)`, exact: tax, source: 'state_rule', formula: `${fullYearTax} × ${ratio}`, ruleKeys: [...ruleKeys, ...calc.ruleKeys] });
      return { ...base, tax, rowMethod: 'nonresident_ratio', schedule: summary(calc, ratio, fullYearTax), exemptions: calc.exemptions, exemptionCredits: exCr };
    }
    if (method === 'other') ctx.info('TE_STATE_NONRESIDENT_OTHER_APPROX', `${row.state}: the state's nonresident computation is its own ('other'); it was approximated by the schedule on sourced income less deductions and exemptions prorated by the income ratio. The estimate may differ.`, { state: row.state });
    const calc = computeScheduleTax({
      state: row.state, filingStatus: input.filingStatus, rules: res.rules, federal: input.federal, rowBase: row.base, customBase: null,
      exemption: ex.exemption, exemptionKeys: ex.keys, prorated: { sourced, ratio }, idPrefix: `state.${row.state}`, labelPrefix: `${row.state} (sourced)`,
    }, ctx)!;
    const exCr = dMin(dMul(credit, ratio), calc.tax);
    if (dIsPos(exCr)) ctx.trace.add({ step: STEP_CREDIT, id: `state.${row.state}.exemption_credits`, state: row.state, label: `${row.state} exemption credits × income ratio`, exact: exCr, source: 'state_rule', ruleKeys: ex.keys, formula: `min(${credit} × ${ratio}, ${calc.tax})` });
    const tax = dSub(calc.tax, exCr);
    ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.tax`, state: row.state, label: `${row.state} nonresident tax — schedule on sourced income (${method} method; deductions prorated)`, exact: tax, source: 'state_rule', formula: `${calc.tax} − ${exCr}`, ruleKeys: [...ruleKeys, ...calc.ruleKeys] });
    return { ...base, tax, rowMethod: 'nonresident_prorated', schedule: summary(calc, ratio, null), exemptions: calc.exemptions, exemptionCredits: exCr };
  }
  const tax = dMul(dFloorZero(sourced), rate);
  const why = modes.requested === 'effective' ? 'effective-rate override' : modes.nonresidentMode === 'sourced_rate' ? 'sourced income × rate chosen on the row' : 'no rate schedule on file';
  ctx.info('TE_STATE_NONRESIDENT_FLAT_RATE', `${row.state} nonresident tax is an ${NONRESIDENT_FLAT_RATE_LABEL} (${why})${method ? ` (${row.state} method: ${method})` : ''}.`, { state: row.state, nonresidentMethod: method });
  ctx.trace.add({
    step: STEP_TAX, id: `state.${row.state}.tax`, state: row.state,
    label: `${row.state} nonresident tax — ${NONRESIDENT_FLAT_RATE_LABEL} (${why})${method ? `; ${row.state} nonresident_method = ${method}` : ''}`,
    exact: tax, source: 'input', formula: `sourced ${dFloorZero(sourced)} × rate ${rate}`, ruleKeys,
  });
  return { ...base, tax, rowMethod: 'nonresident_flat', schedule: null };
}

interface NonresidentDone { row: StateEngineRow; exact: NonresidentExact }

interface ResidentExact { base: Dec; gross: Dec; credit: Dec; details: StateCreditDetail[]; net: Dec; exemptions: Dec; exemptionCredits: Dec; schedule: StateScheduleSummary | null }

function residentTax(row: StateEngineRow, res: Resolved, others: NonresidentDone[], input: StateEngineInput, ctx: StateContext, ex: ExemptionsExact, modes: Modes): ResidentExact {
  const rate = dec(row.effectiveRate);
  if (!res.hasIncomeTax) {
    const rawBase = baseAmount(row, input.federal, ctx);
    const excise = res.rules?.has(KEY_CAPITAL_GAINS_EXCISE) ? (res.rules.object(KEY_CAPITAL_GAINS_EXCISE) as unknown as StateCapitalGainsExciseRule | null) : null;
    if (excise) {
      // Q53 (Kurt): WA capital gains excise tax — residents, net long-term gain over the standard deduction.
      const gains = gainsFromFederal(input.federal);
      const x = capitalGainsExcise(excise, gains);
      ctx.info('TE_STATE_CG_EXCISE', `${row.state} has no broad-based personal income tax; its capital gains excise tax on net long-term gains over ${excise.standard_deduction} was computed${excise.estimates_required === false ? ' (no estimated payments; due with the return)' : ''}. Federal net long-term gain approximates the state's gain (real estate, retirement accounts, livestock / timber and other exempt assets are not separated).`, { state: row.state });
      ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.excise.taxable`, state: row.state, label: `${row.state} capital gains excise: net long-term gain less the standard deduction`, exact: x.taxableGain, source: 'state_rule', ruleKeys: [KEY_CAPITAL_GAINS_EXCISE], formula: `max(0, ${gains.ltcg} − ${excise.standard_deduction})` });
      for (const sl of bracketSlicesFor(x.taxableGain, x.rows)) {
        ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.excise.bracket.${sl.index}`, state: row.state, label: `${row.state} capital gains excise bracket ${sl.index}: ${sl.lower} to ${sl.upper ?? 'no limit'} at ${sl.rate}`, exact: sl.tax, source: 'state_rule', ruleKeys: [KEY_CAPITAL_GAINS_EXCISE], formula: `${sl.taxable} × ${sl.rate}` });
      }
      ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.tax`, state: row.state, label: `${row.state} capital gains excise tax`, exact: x.tax, source: 'state_rule', ruleKeys: [KEY_CAPITAL_GAINS_EXCISE] });
      const sched: StateScheduleSummary = { startingPoint: 'net_long_term_gain', start: R(gains.ltcg), capitalGainExclusion: ZERO, federalTaxDeduction: ZERO, standardDeduction: R(dMin(dec(excise.standard_deduction), gains.ltcg)), exemptions: ZERO, taxableIncome: R(x.taxableGain), scheduleTax: R(x.tax), scheduleLabel: 'capital gains excise', capitalGainsTreatment: 'excise', ratio: null, fullYearTax: null, exciseTaxableGain: R(x.taxableGain) };
      return { base: x.taxableGain, gross: x.tax, credit: ZERO, details: [], net: x.tax, exemptions: ZERO, exemptionCredits: ZERO, schedule: sched };
    }
    ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.base`, state: row.state, label: `${row.state} base (${row.base})`, exact: rawBase, source: row.base === 'custom' ? 'input' : 'gl_map' });
    ctx.info('TE_STATE_NO_INCOME_TAX', `${row.state} has no broad-based personal income tax; the row computes 0.`, { state: row.state });
    ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.gross`, state: row.state, label: `${row.state} resident tax (no income tax)`, exact: ZERO, source: 'state_rule', ruleKeys: [KEY_HAS_INCOME_TAX] });
    return { base: rawBase, gross: ZERO, credit: ZERO, details: [], net: ZERO, exemptions: ZERO, exemptionCredits: ZERO, schedule: null };
  }
  if (modes.applied === 'brackets' && res.rules) return residentScheduleTax(row, res, others, input, ctx, ex);
  const rawBase = baseAmount(row, input.federal, ctx);
  ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.base`, state: row.state, label: `${row.state} base (${row.base})${modes.requested === 'effective' ? ' — effective-rate override' : ''}`, exact: rawBase, source: row.base === 'custom' ? 'input' : 'gl_map' });
  // Q44: exemptions reduce a COMPUTED base (federal AGI / federal taxable income); a custom base is
  // the user's own state base and is taken as entered. Exemption credits reduce the tax in every mode.
  let base = rawBase;
  let exemptions: Dec = ZERO;
  if (ex.exemption != null && dIsPos(ex.exemption)) {
    if (row.base === 'custom') {
      ctx.info('TE_STATE_EXEMPTIONS_CUSTOM_BASE', `${row.state}: the base is a custom amount, so the personal / dependent exemptions (${R(ex.exemption)}) were not subtracted; enter the base after exemptions.`, { state: row.state });
    } else {
      exemptions = dMin(ex.exemption, dFloorZero(rawBase));
      base = dSub(rawBase, exemptions);
      ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.exemptions`, state: row.state, label: `${row.state} base after personal / dependent exemptions`, exact: base, source: 'state_rule', ruleKeys: ex.keys, formula: `${rawBase} − exemptions ${ex.exemption}, not below 0` });
    }
  }
  const beforeCredits = dMul(dFloorZero(base), rate);
  ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.gross`, state: row.state, label: `${row.state} resident tax before credits`, exact: beforeCredits, source: 'input', formula: `base ${dFloorZero(base)} × rate ${rate}` });
  let exemptionCredits: Dec = ZERO;
  if (ex.credit != null && dIsPos(ex.credit)) {
    exemptionCredits = dMin(ex.credit, beforeCredits);
    ctx.trace.add({ step: STEP_CREDIT, id: `state.${row.state}.exemption_credits`, state: row.state, label: `${row.state} personal / dependent exemption credits (nonrefundable)`, exact: exemptionCredits, source: 'state_rule', ruleKeys: ex.keys, formula: `min(${ex.credit}, ${beforeCredits})` });
  }
  const gross = dSub(beforeCredits, exemptionCredits);

  // Credit for taxes paid to other states.
  let creditAllowed = true;
  const creditKeys: string[] = [];
  if (res.rules && !res.usesFederalFallback) {
    const c = res.rules.bool(KEY_CREDIT_FOR_OTHER_STATE);
    creditKeys.push(KEY_CREDIT_FOR_OTHER_STATE);
    creditAllowed = c !== false;
    if (!creditAllowed) ctx.info('TE_STATE_NO_OTHER_STATE_CREDIT', `${row.state} allows no credit for taxes paid to other states.`, { state: row.state });
  } else {
    ctx.warn('TE_STATE_CREDIT_ASSUMED', `${row.state}: no verified rule on the credit for other-state taxes; the credit was assumed allowed. Verify.`, { state: row.state });
  }
  const details: StateCreditDetail[] = [];
  let credit: Dec = ZERO;
  if (creditAllowed) {
    for (const o of others) {
      if (!dIsPos(o.exact.tax)) continue;
      const onSourced = dMul(dFloorZero(o.exact.sourced), rate);
      const allowed = dMin(o.exact.tax, onSourced);
      details.push({ state: o.row.state, otherStateTax: o.exact.tax, residentRateOnSourced: onSourced, allowed });
      ctx.trace.add({ step: STEP_CREDIT, id: `state.${row.state}.credit.${o.row.state}`, state: row.state, label: `${row.state} credit for tax paid to ${o.row.state}`, exact: allowed, source: 'input', formula: `min(${o.row.state} tax ${o.exact.tax}, ${row.state} rate ${rate} × sourced ${dFloorZero(o.exact.sourced)} = ${onSourced})`, ruleKeys: creditKeys });
      credit = dAdd(credit, allowed);
    }
    if (row.creditOverride != null) {
      const override = dFloorZero(dec(row.creditOverride));
      ctx.info('TE_STATE_CREDIT_OVERRIDE', `${row.state}: the computed credit ${R(credit)} was replaced by the entered ${R(override)}.`, { state: row.state, computed: credit, override });
      credit = override;
      ctx.trace.add({ step: STEP_CREDIT, id: `state.${row.state}.credit.override`, state: row.state, label: `${row.state} credit for other-state taxes (entered)`, exact: credit, source: 'input' });
    }
    if (dCmp(credit, gross) > 0) {
      ctx.warn('TE_STATE_CREDIT_CAPPED', `${row.state}: credit for other-state taxes ${R(credit)} exceeds the resident tax ${R(gross)}; only ${R(gross)} is used.`, { state: row.state, credit, gross });
      credit = gross;
    }
  }
  if (details.length > 0) {
    ctx.info('TE_STATE_CREDIT_RESIDENT_SIDE', `${row.state}: the credit for taxes paid to other states is taken on the resident return. Reverse-credit pairs (AZ, CA, OR, VA, IN and DC with each other) grant it on the NONRESIDENT return instead — not modelled; the estimate may differ.`, { state: row.state });
  }
  ctx.trace.add({ step: STEP_CREDIT, id: `state.${row.state}.credit`, state: row.state, label: `${row.state} credit for taxes paid to other states`, exact: credit, source: creditKeys.length > 0 ? 'state_rule' : 'input', ruleKeys: creditKeys, formula: details.map((d) => `${d.state} ${d.allowed}`).join(' + ') || undefined });
  const net = dSub(gross, credit);
  ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.tax`, state: row.state, label: `${row.state} resident tax after credit`, exact: net, source: 'input', formula: `${gross} − ${credit}` });
  return { base, gross, credit, details, net, exemptions, exemptionCredits, schedule: null };
}

/** Credit-for-other-state rule read shared by both rate modes; false = the state allows none. */
function creditAllowedFor(row: StateEngineRow, res: Resolved, ctx: StateContext): { allowed: boolean; keys: string[] } {
  const keys: string[] = [];
  if (res.rules && !res.usesFederalFallback) {
    const c = res.rules.bool(KEY_CREDIT_FOR_OTHER_STATE);
    keys.push(KEY_CREDIT_FOR_OTHER_STATE);
    if (c === false) ctx.info('TE_STATE_NO_OTHER_STATE_CREDIT', `${row.state} allows no credit for taxes paid to other states.`, { state: row.state });
    return { allowed: c !== false, keys };
  }
  ctx.warn('TE_STATE_CREDIT_ASSUMED', `${row.state}: no verified rule on the credit for other-state taxes; the credit was assumed allowed. Verify.`, { state: row.state });
  return { allowed: true, keys };
}

/**
 * Q53 resident row, rate_mode 'brackets': schedule tax − exemption credits − credit for other-state
 * taxes, credit = Σ min(other-state tax, resident tax × sourced income ÷ resident state AGI) — the
 * standard limitation (the share of the resident tax attributable to the income taxed elsewhere).
 */
function residentScheduleTax(row: StateEngineRow, res: Resolved, others: NonresidentDone[], input: StateEngineInput, ctx: StateContext, ex: ExemptionsExact): ResidentExact {
  const calc = computeScheduleTax({
    state: row.state, filingStatus: input.filingStatus, rules: res.rules!, federal: input.federal, rowBase: row.base, customBase: row.customBase,
    exemption: ex.exemption, exemptionKeys: ex.keys, idPrefix: `state.${row.state}`, labelPrefix: row.state,
  }, ctx)!;
  const beforeCredits = calc.tax;
  ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.gross`, state: row.state, label: `${row.state} resident tax before credits (rate schedule)`, exact: beforeCredits, source: 'state_rule', ruleKeys: calc.ruleKeys });
  let exemptionCredits: Dec = ZERO;
  if (ex.credit != null && dIsPos(ex.credit)) {
    exemptionCredits = dMin(ex.credit, beforeCredits);
    ctx.trace.add({ step: STEP_CREDIT, id: `state.${row.state}.exemption_credits`, state: row.state, label: `${row.state} personal / dependent exemption credits (nonrefundable)`, exact: exemptionCredits, source: 'state_rule', ruleKeys: ex.keys, formula: `min(${ex.credit}, ${beforeCredits})` });
  }
  const gross = dSub(beforeCredits, exemptionCredits);
  const { allowed: creditAllowed, keys: creditKeys } = creditAllowedFor(row, res, ctx);
  const details: StateCreditDetail[] = [];
  let credit: Dec = ZERO;
  const residentBase = calc.stateAgi;
  if (creditAllowed) {
    for (const o of others) {
      if (!dIsPos(o.exact.tax)) continue;
      const ratio = incomeRatio(dFloorZero(o.exact.sourced), residentBase);
      const limit = dMul(gross, ratio);
      const allowed = dMin(o.exact.tax, limit);
      details.push({ state: o.row.state, otherStateTax: o.exact.tax, residentRateOnSourced: limit, allowed });
      ctx.trace.add({ step: STEP_CREDIT, id: `state.${row.state}.credit.${o.row.state}`, state: row.state, label: `${row.state} credit for tax paid to ${o.row.state}`, exact: allowed, source: 'input', formula: `min(${o.row.state} tax ${o.exact.tax}, ${row.state} tax ${gross} × sourced ${dFloorZero(o.exact.sourced)} ÷ ${row.state} AGI ${residentBase} = ${limit})`, ruleKeys: creditKeys });
      credit = dAdd(credit, allowed);
    }
    if (row.creditOverride != null) {
      const override = dFloorZero(dec(row.creditOverride));
      ctx.info('TE_STATE_CREDIT_OVERRIDE', `${row.state}: the computed credit ${R(credit)} was replaced by the entered ${R(override)}.`, { state: row.state, computed: credit, override });
      credit = override;
      ctx.trace.add({ step: STEP_CREDIT, id: `state.${row.state}.credit.override`, state: row.state, label: `${row.state} credit for other-state taxes (entered)`, exact: credit, source: 'input' });
    }
    if (dCmp(credit, gross) > 0) {
      ctx.warn('TE_STATE_CREDIT_CAPPED', `${row.state}: credit for other-state taxes ${R(credit)} exceeds the resident tax ${R(gross)}; only ${R(gross)} is used.`, { state: row.state, credit, gross });
      credit = gross;
    }
  }
  if (details.length > 0) {
    ctx.info('TE_STATE_CREDIT_RESIDENT_SIDE', `${row.state}: the credit for taxes paid to other states is taken on the resident return. Reverse-credit pairs (AZ, CA, OR, VA, IN and DC with each other) grant it on the NONRESIDENT return instead — not modelled; the estimate may differ.`, { state: row.state });
  }
  ctx.trace.add({ step: STEP_CREDIT, id: `state.${row.state}.credit`, state: row.state, label: `${row.state} credit for taxes paid to other states`, exact: credit, source: creditKeys.length > 0 ? 'state_rule' : 'input', ruleKeys: creditKeys, formula: details.map((d) => `${d.state} ${d.allowed}`).join(' + ') || undefined });
  const net = dSub(gross, credit);
  ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.tax`, state: row.state, label: `${row.state} resident tax after credit`, exact: net, source: 'state_rule', formula: `${gross} − ${credit}` });
  return { base: calc.taxableIncome, gross, credit, details, net, exemptions: calc.exemptions, exemptionCredits, schedule: summary(calc, null, null) };
}

function gateFor(row: StateEngineRow, res: Resolved, netTax: Dec, input: StateEngineInput, ctx: StateContext, ex: ExemptionsExact): StateEstimateGate {
  // Q44: the GA gross-over-exemptions gate reads the computed exemptions when none were entered.
  let gate = row.gate;
  if (gate.exemptions == null && ex.exemption != null) {
    gate = { ...gate, exemptions: ex.exemption };
    ctx.info('TE_STATE_GATE_EXEMPTIONS_COMPUTED', `${row.state}: the estimate-requirement gate used the computed personal / dependent exemptions ${R(ex.exemption)} (none were entered).`, { state: row.state });
  }
  return evaluateEstimateGate({ state: row.state, filingStatus: input.filingStatus, jurisdiction: res.jurisdiction, rules: res.rules, stateTax: netTax, gate, federal: input.federal }, ctx);
}

function validateRows(rows: StateEngineRow[]): void {
  const seen = new Set<string>();
  let residents = 0;
  for (const r of rows) {
    if (seen.has(r.state)) throw new Error(`TE_STATE_DUPLICATE_ROW: ${r.state} appears more than once`);
    seen.add(r.state);
    if (r.residency === 'resident') residents++;
  }
  if (residents > 1) throw new Error('TE_STATE_MULTIPLE_RESIDENT: a scenario has at most one resident state');
}

export function computeState(input: StateEngineInput): StateResult {
  validateRows(input.rows);
  const ctx = new StateContext(input);
  const resolved = new Map(input.rows.map((r) => [r.state, resolveJurisdiction(r.state, input, ctx)]));

  const modes = new Map(input.rows.map((r) => [r.state, modesFor(r, resolved.get(r.state)!, input, ctx)]));
  // Q44: exemptions are read for every row (the GA gate needs them); the resident row applies them, and
  // (Q53) a nonresident row on the rate schedule applies them inside its ratio / prorated computation.
  const exemptionsByState = new Map(input.rows.map((r) => [r.state, r.residency === 'resident' || modes.get(r.state)!.applied === 'brackets' ? stateExemptions(r, resolved.get(r.state)!, input, ctx) : nonresidentExemptions(r, resolved.get(r.state)!, input, ctx)]));
  // Nonresident rows first; the resident credit depends on them.
  const nonresidents: NonresidentDone[] = input.rows.filter((r) => r.residency === 'nonresident').map((row) => ({ row, exact: nonresidentTax(row, resolved.get(row.state)!, input, ctx, modes.get(row.state)!, exemptionsByState.get(row.state)!) }));
  const resident = input.rows.find((r) => r.residency === 'resident') ?? null;
  const residentExact = resident ? residentTax(resident, resolved.get(resident.state)!, nonresidents, input, ctx, exemptionsByState.get(resident.state)!, modes.get(resident.state)!) : null;

  const results: StateRowResult[] = [];
  for (const row of input.rows) {
    const res = resolved.get(row.state)!;
    if (row.residency === 'resident') {
      const e = residentExact!;
      const gate = gateFor(row, res, e.net, input, ctx, exemptionsByState.get(row.state)!);
      results.push({
        rowId: row.rowId, state: row.state, residency: row.residency, method: 'resident', nonresidentMethod: null, base: row.base,
        rateMode: modes.get(row.state)!.applied, rateModeRequested: modes.get(row.state)!.requested, nonresidentMode: modes.get(row.state)!.nonresidentMode,
        ...(e.schedule ? { schedule: e.schedule } : {}),
        baseAmount: R(e.base), effectiveRate: dec(row.effectiveRate), sourcedIncome: ZERO, sourcedDerived: false,
        exemptions: R(e.exemptions), exemptionCredits: R(e.exemptionCredits),
        grossTax: R(e.gross), creditForOtherStates: R(e.credit),
        creditDetails: e.details.map((d) => ({ state: d.state, otherStateTax: R(d.otherStateTax), residentRateOnSourced: R(d.residentRateOnSourced), allowed: R(d.allowed) })),
        netTax: R(e.net), gate, hasIncomeTax: res.hasIncomeTax, usesFederalFallback: res.usesFederalFallback, verify: res.verify || gate.verify,
        exact: { baseAmount: e.base, sourcedIncome: ZERO, grossTax: e.gross, credit: e.credit, netTax: e.net, exemptions: e.exemptions, exemptionCredits: e.exemptionCredits },
      });
    } else {
      const e = nonresidents.find((n) => n.row === row)!.exact;
      const gate = gateFor(row, res, e.tax, input, ctx, exemptionsByState.get(row.state)!);
      results.push({
        rowId: row.rowId, state: row.state, residency: row.residency, method: e.rowMethod, nonresidentMethod: e.method, base: row.base,
        rateMode: e.modes.applied, rateModeRequested: e.modes.requested, nonresidentMode: e.modes.nonresidentMode,
        ...(e.schedule ? { schedule: e.schedule, exemptions: R(e.exemptions), exemptionCredits: R(e.exemptionCredits) } : {}),
        baseAmount: R(e.sourced), effectiveRate: dec(row.effectiveRate), sourcedIncome: R(e.sourced), sourcedDerived: e.derived,
        grossTax: R(e.tax), creditForOtherStates: ZERO, creditDetails: [], netTax: R(e.tax), gate,
        hasIncomeTax: res.hasIncomeTax, usesFederalFallback: res.usesFederalFallback, verify: res.verify || gate.verify,
        exact: { baseAmount: e.sourced, sourcedIncome: e.sourced, grossTax: e.tax, credit: ZERO, netTax: e.tax, ...(e.schedule ? { exemptions: e.exemptions, exemptionCredits: e.exemptionCredits } : {}) },
      });
    }
  }

  const stateTotal = dSum(results.map((r) => r.exact.netTax));
  ctx.trace.add({ step: STEP_TOTAL, id: 'state_total', state: '', label: 'State tax (all jurisdictions)', exact: stateTotal, source: 'input', formula: results.map((r) => `${r.state} ${r.exact.netTax}`).join(' + ') || undefined });

  return {
    engineVersion: TAX_ENGINE_VERSION,
    taxYear: input.taxYear,
    filingStatus: input.filingStatus,
    rows: results,
    stateTotal: R(stateTotal),
    exact: { stateTotal },
    trace: ctx.trace.rows(),
    warnings: ctx.allWarnings(),
    parametersUsed: ctx.params.used(),
    rulesUsed: ctx.rulesUsed(),
  };
}

// ── C corp apportionment (Phase 9 uses it) ───────────────────────────

/** apportionment % × taxable income × rate. Pure; trace rows are written when a context is given. */
export function computeCcorpStateTax(input: CcorpApportionmentInput, ctx?: StateContext): CcorpApportionmentExact {
  const taxable = dFloorZero(dec(input.taxableIncome));
  const pct = dec(input.apportionmentPct);
  const rate = dec(input.effectiveRate);
  const apportioned = dMul(taxable, pct);
  const tax = dMul(apportioned, rate);
  if (ctx) {
    ctx.trace.add({ step: STEP_TAX, id: `state.${input.state}.apportioned`, state: input.state, label: `${input.state} apportioned taxable income`, exact: apportioned, source: 'input', formula: `taxable ${taxable} × apportionment ${pct}` });
    ctx.trace.add({ step: STEP_TAX, id: `state.${input.state}.tax`, state: input.state, label: `${input.state} C corp tax (apportioned × rate)`, exact: tax, source: 'input', formula: `${apportioned} × ${rate}` });
  }
  return { apportioned, tax };
}

// ── DTO bridges ──────────────────────────────────────────────────────

/** getStateRules rows (which carry statuses) → engine rule map. */
export function stateRuleMapFromRows(rows: ReadonlyArray<Pick<StateRuleRowDTO, 'key' | 'value' | 'status'> & Partial<Pick<StateRuleRowDTO, 'source' | 'citation'>>>): StateRuleMap {
  const out: Record<string, StateRuleMap[string]> = {};
  for (const r of rows) out[r.key] = { key: r.key, value: r.value, status: r.status, source: r.source, citation: r.citation };
  return out;
}

/**
 * StateRulesDTO (getStateRules) → jurisdiction input. THE resolver for a state-year (R6-03): the
 * estimate and the admin States screen both go through it, so a state with no rows for the year
 * is served its latest earlier year's rules (dto.isFallback) in both places. A complete set is
 * required for the state's own rules; "verify" when any row is non-verified, the set is a
 * fallback, or (no-income-tax state) the has_income_tax row itself is missing.
 */
export function jurisdictionFromStateRules(dto: StateRulesDTO): StateJurisdictionInput {
  const rules = stateRuleMapFromRows(dto.rules);
  const allVerified = dto.rules.every((r) => r.status === 'verified');
  if (!dto.hasIncomeTax) return { state: dto.state, rules, usesFederalFallback: false, verifyBadge: !allVerified || dto.isFallback || !dto.complete, estimatesRequired: false };
  const usesFederalFallback = !dto.complete;
  const estimatesRequired = rules[KEY_ESTIMATES_REQUIRED]?.value !== false;
  return { state: dto.state, rules, usesFederalFallback, verifyBadge: usesFederalFallback || !allVerified || dto.isFallback, estimatesRequired };
}

export function federalFiguresFromResult(r: FederalResult): FederalFiguresForState {
  return {
    agi: r.exact.agi, taxableIncome: r.exact.taxableIncome, totalIncome: r.exact.totalIncome, wages: r.income.wages, deduction: r.exact.deduction,
    // Q53: capital-gain characters for the state treatment; federal income tax for the AL / MO / OR deduction.
    netLongTermGain: r.exact.netLongTermGain ?? r.regularTax?.worksheet?.netLongTermGain ?? ZERO,
    capitalGainNet: r.exact.capitalGainNet ?? r.income?.capitalGainNet ?? ZERO,
    qualifiedDividends: r.exact.qualifiedDividends ?? r.income?.qualifiedDividends ?? ZERO,
    qbiDeduction: r.exact.qbi ?? ZERO,
    federalIncomeTax: dFloorZero(dSub(r.exact.regularTax ?? ZERO, r.exact.nonrefundableCredits ?? ZERO)),
  };
}

export const EMPTY_GATE_INPUTS: StateGateInputs = {
  withholding: ZERO, credits: ZERO, priorYearLiability: null, grossIncome: null, priorYearGrossIncome: null, nonWithheldIncome: null, exemptions: null, deductions: null,
};

/** Scenario state row → engine row. Gate figures are not on StateRowDTO yet (Phase 10/11); pass them when known. */
export function stateRowFromDto(dto: StateRowDTO, gate: Partial<StateGateInputs> = {}): StateEngineRow {
  return {
    rowId: dto.id, state: dto.state, residency: dto.residency, effectiveRate: dec(dto.effectiveRate), base: dto.base,
    customBase: dto.customBase == null ? null : dec(dto.customBase),
    sourcedIncome: dto.sourcedIncome == null ? null : dec(dto.sourcedIncome), sourcedManual: dto.sourcedManual,
    creditOverride: dto.creditOverride == null ? null : dec(dto.creditOverride),
    gate: { ...EMPTY_GATE_INPUTS, ...gate },
    rateMode: dto.rateMode ?? 'brackets', nonresidentMode: dto.nonresidentMode ?? 'ratio',
  };
}

const SOURCED_CHARACTERS: readonly IncomeCharacter[] = ['ordinary', 'rental', 'section_1231'];

/**
 * Entity income sourced by state, from the federal result (R2-15): the taxpayer's
 * BUSINESS characters (ordinary + rental + §1231) of each share AFTER the step-3
 * loss limitations, plus guaranteed payments, whole dollars, with the entity's
 * `state_sourcing` from the estimator settings. Portfolio income (interest,
 * dividends, capital gains) is left to the residence state. A derived figure is
 * an estimate; the row's manual `sourced_income` wins when set (Q11).
 */
export function sourcedEntitiesFromFederal(federal: FederalResult, sourcing: ReadonlyArray<{ companyId: string; stateSourcing: string | null }>): StateSourcedEntity[] {
  const byCompany = new Map(sourcing.map((s) => [s.companyId, s.stateSourcing]));
  return federal.entities.map((e) => ({
    companyId: e.companyId,
    companyName: e.companyName,
    state: byCompany.get(e.companyId) ?? null,
    income: dSum(e.shares.map((s) => dAdd(dSum(SOURCED_CHARACTERS.map((k) => s.shareAfterLossLimits[k])), s.guaranteedPayment))),
  }));
}
