// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// State engine DTOs (MODULE.md "State calculation", Phase 8) plus the two small
// runtime helpers both state.ts and state-gates.ts need: the StateRuleReader
// (the engine's only door to `state_estimate_rules` values — records every key
// read and warns on every non-verified read, D12a) and the StateTraceBuilder.
//
// The state engine is independent of the federal engine's internals: it takes
// the federal figures it needs (AGI, taxable income, total income, wages,
// deduction) as a plain input DTO built by `federalFiguresFromResult`.
// MONEY: decimal strings; result amounts are whole dollars, `exact` unrounded.

import type { FilingStatus, ParameterStatus, TraceRow } from '../types.js';
import type { TaxEstimatorWarning } from '../entities-api.js';
import type { StateBase, StateResidency } from '../years-api.js';
import type { RequirementGateKind, ThresholdComparison } from '../stateRuleKeys.js';
import { dRoundDollars, dec, type Dec } from '../decimal.js';
import type { ParameterMap, ParameterUse, ResolvedParameter } from './types.js';

// ── Rules ────────────────────────────────────────────────────────────

/** Registry key → resolved value WITH status, for one (state, year). Built by `stateRuleMapFromRows`. */
export type StateRuleMap = Readonly<Record<string, ResolvedParameter>>;

/** One jurisdiction's resolved rule set as the engine sees it (built from a StateRulesDTO by jurisdictionFromStateRules — the one resolver, R6-03). */
export interface StateJurisdictionInput {
  state: string;
  rules: StateRuleMap;
  /** No or incomplete rule set: apply the federal pattern and flag "verify" (MODULE.md "States"). */
  usesFederalFallback: boolean;
  verifyBadge: boolean;
  /** false = no quarterly individual estimate regime (estimates_required = false: ID, UT) or no income tax. */
  estimatesRequired: boolean;
}

export interface StateRuleUse {
  state: string;
  key: string;
  status: ParameterStatus;
  value: unknown;
}

// ── Inputs ───────────────────────────────────────────────────────────

/**
 * Figures the income-based requirement gates read (D12b). All optional: a null
 * means "not provided" and the gate says so (verify flag + warning) rather
 * than guessing. Withholding and credits default to zero.
 */
export interface StateGateInputs {
  /** Expected state income tax withholding for the year. */
  withholding: Dec;
  /** Expected state credits other than withholding. */
  credits: Dec;
  /** Prior-year state tax liability (ME two-year test). */
  priorYearLiability: Dec | null;
  /** Current-year state gross income (AZ / GA); null = federal total income. */
  grossIncome: Dec | null;
  /** Prior-year state gross income (AZ two-year test). */
  priorYearGrossIncome: Dec | null;
  /** Income not subject to withholding (PA); null = federal total income − wages. */
  nonWithheldIncome: Dec | null;
  /** State personal exemptions (GA). */
  exemptions: Dec | null;
  /** State deductions (GA); null = the federal deduction taken. */
  deductions: Dec | null;
}

export interface StateEngineRow {
  rowId: string;
  state: string;
  residency: StateResidency;
  /** Fraction 0..1 (effective_rate). */
  effectiveRate: Dec;
  base: StateBase;
  /** Required when base = 'custom'. */
  customBase: Dec | null;
  /** Nonresident rows: manual sourced income (used when sourcedManual). */
  sourcedIncome: Dec | null;
  /** false = derive sourced income from the entities whose state_sourcing is this state. */
  sourcedManual: boolean;
  /** Resident rows: replaces the computed credit for other-state taxes when set. */
  creditOverride: Dec | null;
  gate: StateGateInputs;
}

/** One linked entity's full-year income allocated to this taxpayer, with the entity's sourcing state. */
export interface StateSourcedEntity {
  companyId: string;
  companyName: string;
  /** Entity `state_sourcing`; null = not sourced to any state. */
  state: string | null;
  /** Taxpayer's share of the entity's business income (ordinary + rental + §1231 after loss limits, + guaranteed payments), profit-positive; portfolio income excluded (R2-15). */
  income: Dec;
}

export interface FederalFiguresForState {
  agi: Dec;
  taxableIncome: Dec;
  totalIncome: Dec;
  wages: Dec;
  /** Deduction actually taken (standard or itemized). */
  deduction: Dec;
}

export interface StateEngineInput {
  taxYear: number;
  filingStatus: FilingStatus;
  /** Federal parameter set (the federal fallback pattern reads `safe_harbor.min_balance_due`). */
  parameters: ParameterMap;
  federal: FederalFiguresForState;
  rows: StateEngineRow[];
  /** One per distinct state in `rows`; a missing jurisdiction is treated as the federal fallback. */
  jurisdictions: StateJurisdictionInput[];
  entities: StateSourcedEntity[];
}

// ── Trace ────────────────────────────────────────────────────────────

export const STATE_STEPS = [
  'state_sourcing',  // derived sourced income per entity
  'state_tax',       // base × rate (resident), sourced × rate (nonresident), C corp apportionment
  'state_credit',    // credit for taxes paid to other states
  'state_gate',      // estimate-requirement gate (D12b)
  'state_total',     // Σ state tax
] as const;
export type StateStep = typeof STATE_STEPS[number];

export interface StateTraceRow extends TraceRow {
  step: StateStep;
  /** Stable id for drill-down (e.g. 'state.MO.gross', 'state.AR.sourced.<companyId>'). */
  id: string;
  /** Unrounded amount. */
  exact: Dec;
  state: string;
  entityId?: string | null;
  /** State rule keys the row read. */
  ruleKeys?: string[];
  /** Federal parameter keys the row read. */
  parameterKeys?: string[];
}

export type StateTraceInput = Omit<StateTraceRow, 'amount'>;

export class StateTraceBuilder {
  private readonly items: StateTraceRow[] = [];

  add(row: StateTraceInput): StateTraceRow {
    const full: StateTraceRow = { ...row, amount: dRoundDollars(row.exact) };
    this.items.push(full);
    return full;
  }

  rows(): StateTraceRow[] {
    return [...this.items];
  }
}

// ── Results ──────────────────────────────────────────────────────────

/** Trace / assumptions label for the v1 nonresident simplification (OPEN-QUESTIONS Q17). */
export const NONRESIDENT_FLAT_RATE_LABEL = 'effective-rate estimate; most states compute nonresident tax by ratio of the full return';

export type NonresidentMethod = 'ratio' | 'sourced_flat' | 'other';

export type StateGateMethod = 'no_income_tax' | 'no_estimate_regime' | 'threshold' | 'federal_fallback' | RequirementGateKind;

export interface StateEstimateGate {
  state: string;
  method: StateGateMethod;
  /** true = estimates required; false = not required; null = cannot be determined from the inputs given (see notes). */
  required: boolean | null;
  /** Tax-due threshold applied (null when the state has no regime / no income tax). */
  threshold: Dec | null;
  comparison: ThresholdComparison;
  /** The amount measured against `threshold` (tax less withholding and credits, or per the gate kind). */
  measured: Dec | null;
  /** Income-based gate kind applied, if any. */
  gateKind: RequirementGateKind | null;
  /** Result of the income-based gate alone (null = no gate or inputs missing). */
  gateSatisfied: boolean | null;
  /** Rules unverified / federal fallback / inputs missing: show the verify badge. */
  verify: boolean;
  notes: string[];
  ruleKeys: string[];
}

export interface StateCreditDetail {
  state: string;
  otherStateTax: Dec;
  /** Resident rate × income sourced to that state. */
  residentRateOnSourced: Dec;
  allowed: Dec;
}

export interface StateRowExact {
  baseAmount: Dec;
  sourcedIncome: Dec;
  grossTax: Dec;
  credit: Dec;
  netTax: Dec;
}

export interface StateRowResult {
  rowId: string;
  state: string;
  residency: StateResidency;
  /** 'resident' = base × rate − credit; 'nonresident_flat' = sourced × rate (NONRESIDENT_FLAT_RATE_LABEL). */
  method: 'resident' | 'nonresident_flat';
  /** The state's actual nonresident method per its rules (informational, nonresident rows). */
  nonresidentMethod: NonresidentMethod | null;
  base: StateBase;
  baseAmount: Dec;
  effectiveRate: Dec;
  /** Nonresident rows: income sourced to the state; resident rows: 0. */
  sourcedIncome: Dec;
  sourcedDerived: boolean;
  grossTax: Dec;
  creditForOtherStates: Dec;
  creditDetails: StateCreditDetail[];
  netTax: Dec;
  gate: StateEstimateGate;
  hasIncomeTax: boolean;
  usesFederalFallback: boolean;
  verify: boolean;
  exact: StateRowExact;
}

export interface StateResult {
  engineVersion: string;
  taxYear: number;
  filingStatus: FilingStatus;
  rows: StateRowResult[];
  /** Σ net state tax over all rows. */
  stateTotal: Dec;
  exact: { stateTotal: Dec };
  trace: StateTraceRow[];
  warnings: TaxEstimatorWarning[];
  parametersUsed: ParameterUse[];
  /** Every state rule the calculation read, with its status (D12a). */
  rulesUsed: StateRuleUse[];
}

/** C corp state path (Phase 9): apportionment % × taxable income × rate. */
export interface CcorpApportionmentInput {
  state: string;
  taxableIncome: Dec;
  /** Fraction 0..1. */
  apportionmentPct: Dec;
  /** Fraction 0..1. */
  effectiveRate: Dec;
}

export interface CcorpApportionmentExact {
  apportioned: Dec;
  tax: Dec;
}

// ── Rule reader ──────────────────────────────────────────────────────

const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function stateRuleUnverifiedWarning(state: string, key: string, status: ParameterStatus, value: unknown): TaxEstimatorWarning {
  return {
    code: 'TE_STATE_RULE_UNVERIFIED',
    severity: 'warning',
    message: `${state} rule '${key}' is ${status} (not CPA-verified); the estimate uses its current value ${JSON.stringify(value)}.`,
    details: { state, key, status, value },
  };
}

/**
 * Typed reads of one jurisdiction's rules. A missing key reads as null (the
 * caller decides the default); a present key with the wrong shape throws
 * TE_STATE_RULE_INVALID. Every read is recorded for the assumptions page.
 */
export class StateRuleReader {
  private readonly usedKeys = new Map<string, StateRuleUse>();

  constructor(readonly state: string, private readonly map: StateRuleMap) {}

  has(key: string): boolean {
    return this.map[key] !== undefined;
  }

  private raw(key: string): ResolvedParameter | undefined {
    const r = this.map[key];
    if (r && !this.usedKeys.has(key)) this.usedKeys.set(key, { state: this.state, key, status: r.status, value: r.value });
    return r;
  }

  private invalid(key: string, expected: string): never {
    throw new Error(`TE_STATE_RULE_INVALID: ${this.state} rule '${key}' is not ${expected}`);
  }

  /** Raw JSON value; undefined when the key is absent. */
  value(key: string): unknown {
    return this.raw(key)?.value;
  }

  bool(key: string): boolean | null {
    const r = this.raw(key);
    if (!r || r.value === null) return null;
    if (typeof r.value !== 'boolean') this.invalid(key, 'true/false');
    return r.value as boolean;
  }

  money(key: string): Dec | null {
    const r = this.raw(key);
    if (!r || r.value === null) return null;
    if (!isFiniteNumber(r.value)) this.invalid(key, 'a number');
    return dec(r.value as number);
  }

  text(key: string): string | null {
    const r = this.raw(key);
    if (!r || r.value === null) return null;
    if (typeof r.value !== 'string') this.invalid(key, 'a string');
    return r.value as string;
  }

  object(key: string): Record<string, unknown> | null {
    const r = this.raw(key);
    if (!r || r.value === null) return null;
    if (!isObj(r.value)) this.invalid(key, 'an object');
    return r.value as Record<string, unknown>;
  }

  used(): StateRuleUse[] {
    return [...this.usedKeys.values()];
  }

  /** One warning per non-verified rule read (D12a). */
  warnings(): TaxEstimatorWarning[] {
    const out: TaxEstimatorWarning[] = [];
    for (const u of this.usedKeys.values()) {
      if (u.status === 'verified') continue;
      out.push(stateRuleUnverifiedWarning(u.state, u.key, u.status, u.value));
    }
    return out;
  }
}
