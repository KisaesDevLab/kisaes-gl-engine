// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md "State calculation" — the pure state orchestrator (Phase 8).
//   nonresident tax = sourced income × effective rate (flat-rate simplification,
//     labelled NONRESIDENT_FLAT_RATE_LABEL; the state's real method is recorded
//     from `nonresident_method`), sourced income manual or derived from the
//     entities whose state_sourcing is that state;
//   resident tax = base × rate − credit for other-state taxes, credit =
//     Σ min(other-state tax, resident rate × income sourced there);
//   C corp = apportionment % × taxable income × rate (computeCcorpStateTax, Phase 9).
// Every jurisdiction's estimate-requirement gate is evaluated (state-gates.ts).
// Takes the federal figures as a plain DTO so it is independent of federal.ts.

import type { FederalResult } from './types.js';
import type { StateRulesDTO, StateRuleRowDTO } from '../state-rules-api.js';
import type { StateRowDTO } from '../years-api.js';
import {
  ZERO, dAdd, dCmp, dFloorZero, dIsPos, dMin, dMul, dRoundDollars, dSub, dSum, dec, type Dec,
} from '../decimal.js';
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

const STEP_SOURCING = 'state_sourcing';
const STEP_TAX = 'state_tax';
const STEP_CREDIT = 'state_credit';
const STEP_TOTAL = 'state_total';
const KEY_HAS_INCOME_TAX = 'has_income_tax';
const KEY_CREDIT_FOR_OTHER_STATE = 'credit_for_other_state';
const KEY_NONRESIDENT_METHOD = 'nonresident_method';
const KEY_ESTIMATES_REQUIRED = 'estimates_required';
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

interface NonresidentExact {
  sourced: Dec; derived: boolean; tax: Dec; method: NonresidentMethod | null;
}

function nonresidentTax(row: StateEngineRow, res: Resolved, input: StateEngineInput, ctx: StateContext): NonresidentExact {
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
  if (!res.hasIncomeTax) {
    ctx.info('TE_STATE_NO_INCOME_TAX', `${row.state} has no broad-based personal income tax; the row computes 0.`, { state: row.state });
    ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.tax`, state: row.state, label: `${row.state} nonresident tax (no income tax)`, exact: ZERO, source: 'state_rule', ruleKeys: [KEY_HAS_INCOME_TAX] });
    return { sourced, derived, tax: ZERO, method };
  }
  const tax = dMul(dFloorZero(sourced), rate);
  ctx.info('TE_STATE_NONRESIDENT_FLAT_RATE', `${row.state} nonresident tax is an ${NONRESIDENT_FLAT_RATE_LABEL}${method ? ` (${row.state} method: ${method})` : ''}.`, { state: row.state, nonresidentMethod: method });
  ctx.trace.add({
    step: STEP_TAX, id: `state.${row.state}.tax`, state: row.state,
    label: `${row.state} nonresident tax — ${NONRESIDENT_FLAT_RATE_LABEL}${method ? `; ${row.state} nonresident_method = ${method}` : ''}`,
    exact: tax, source: 'input', formula: `sourced ${dFloorZero(sourced)} × rate ${rate}`, ruleKeys,
  });
  return { sourced, derived, tax, method };
}

interface NonresidentDone { row: StateEngineRow; exact: NonresidentExact }

interface ResidentExact { base: Dec; gross: Dec; credit: Dec; details: StateCreditDetail[]; net: Dec }

function residentTax(row: StateEngineRow, res: Resolved, others: NonresidentDone[], input: StateEngineInput, ctx: StateContext): ResidentExact {
  const rate = dec(row.effectiveRate);
  const base = baseAmount(row, input.federal, ctx);
  ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.base`, state: row.state, label: `${row.state} base (${row.base})`, exact: base, source: row.base === 'custom' ? 'input' : 'gl_map' });
  if (!res.hasIncomeTax) {
    ctx.info('TE_STATE_NO_INCOME_TAX', `${row.state} has no broad-based personal income tax; the row computes 0.`, { state: row.state });
    ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.gross`, state: row.state, label: `${row.state} resident tax (no income tax)`, exact: ZERO, source: 'state_rule', ruleKeys: [KEY_HAS_INCOME_TAX] });
    return { base, gross: ZERO, credit: ZERO, details: [], net: ZERO };
  }
  const gross = dMul(dFloorZero(base), rate);
  ctx.trace.add({ step: STEP_TAX, id: `state.${row.state}.gross`, state: row.state, label: `${row.state} resident tax before credits`, exact: gross, source: 'input', formula: `base ${dFloorZero(base)} × rate ${rate}` });

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
  return { base, gross, credit, details, net };
}

function gateFor(row: StateEngineRow, res: Resolved, netTax: Dec, input: StateEngineInput, ctx: StateContext): StateEstimateGate {
  return evaluateEstimateGate({ state: row.state, filingStatus: input.filingStatus, jurisdiction: res.jurisdiction, rules: res.rules, stateTax: netTax, gate: row.gate, federal: input.federal }, ctx);
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

  // Nonresident rows first; the resident credit depends on them.
  const nonresidents: NonresidentDone[] = input.rows.filter((r) => r.residency === 'nonresident').map((row) => ({ row, exact: nonresidentTax(row, resolved.get(row.state)!, input, ctx) }));
  const resident = input.rows.find((r) => r.residency === 'resident') ?? null;
  const residentExact = resident ? residentTax(resident, resolved.get(resident.state)!, nonresidents, input, ctx) : null;

  const results: StateRowResult[] = [];
  for (const row of input.rows) {
    const res = resolved.get(row.state)!;
    if (row.residency === 'resident') {
      const e = residentExact!;
      const gate = gateFor(row, res, e.net, input, ctx);
      results.push({
        rowId: row.rowId, state: row.state, residency: row.residency, method: 'resident', nonresidentMethod: null, base: row.base,
        baseAmount: R(e.base), effectiveRate: dec(row.effectiveRate), sourcedIncome: ZERO, sourcedDerived: false,
        grossTax: R(e.gross), creditForOtherStates: R(e.credit),
        creditDetails: e.details.map((d) => ({ state: d.state, otherStateTax: R(d.otherStateTax), residentRateOnSourced: R(d.residentRateOnSourced), allowed: R(d.allowed) })),
        netTax: R(e.net), gate, hasIncomeTax: res.hasIncomeTax, usesFederalFallback: res.usesFederalFallback, verify: res.verify || gate.verify,
        exact: { baseAmount: e.base, sourcedIncome: ZERO, grossTax: e.gross, credit: e.credit, netTax: e.net },
      });
    } else {
      const e = nonresidents.find((n) => n.row === row)!.exact;
      const gate = gateFor(row, res, e.tax, input, ctx);
      results.push({
        rowId: row.rowId, state: row.state, residency: row.residency, method: 'nonresident_flat', nonresidentMethod: e.method, base: row.base,
        baseAmount: R(e.sourced), effectiveRate: dec(row.effectiveRate), sourcedIncome: R(e.sourced), sourcedDerived: e.derived,
        grossTax: R(e.tax), creditForOtherStates: ZERO, creditDetails: [], netTax: R(e.tax), gate,
        hasIncomeTax: res.hasIncomeTax, usesFederalFallback: res.usesFederalFallback, verify: res.verify || gate.verify,
        exact: { baseAmount: e.sourced, sourcedIncome: e.sourced, grossTax: e.tax, credit: ZERO, netTax: e.tax },
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
  return { agi: r.exact.agi, taxableIncome: r.exact.taxableIncome, totalIncome: r.exact.totalIncome, wages: r.income.wages, deduction: r.exact.deduction };
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
