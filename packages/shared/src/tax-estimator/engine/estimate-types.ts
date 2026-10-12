// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 10 shared vocabulary (MODULE.md "Safe harbor, Schedule AI, vouchers,
// penalties"): the estimate trace, the per-calculation context and the small
// DTOs the safe-harbor / Schedule AI / payments / penalty / voucher modules
// exchange. Pure. MONEY: decimal strings; result amounts whole dollars with the
// unrounded value in `exact` / on the trace.

import type { FilingStatus, TraceRow } from '../types.js';
import type { TaxEstimatorWarning, PaymentJurisdiction } from '../entities-api.js';
import type { SafeHarborOverride } from '../taxpayers-api.js';
import { dRoundDollars, type Dec } from '../decimal.js';
import { EngineContext } from './context.js';
import type { ParameterMap, ParameterUse } from './types.js';
import { StateRuleReader, type StateRuleMap, type StateRuleUse } from './state-types.js';

// ── Trace ────────────────────────────────────────────────────────────

export const ESTIMATE_STEPS = [
  'safe_harbor',   // required annual payment (both rules)
  'schedule_ai',   // annualized income installments (Form 2210 Schedule AI)
  'installments',  // regular installments, lesser-of selection, withholding shares
  'payments',      // payment application (earliest unpaid installment)
  'penalty',       // §6654 / state underpayment accrual
  'vouchers',      // voucher amounts and holiday-adjusted due dates
] as const;
export type EstimateStep = typeof ESTIMATE_STEPS[number];

export interface EstimateTraceRow extends TraceRow {
  step: EstimateStep;
  /** Stable id for drill-down (e.g. 'federal.safe_harbor.current', 'MO.installment.2.required'). */
  id: string;
  exact: Dec;
  jurisdiction: PaymentJurisdiction;
  parameterKeys?: string[];
  ruleKeys?: string[];
}

export type EstimateTraceInput = Omit<EstimateTraceRow, 'amount'>;

export class EstimateTraceBuilder {
  private readonly items: EstimateTraceRow[] = [];

  add(row: EstimateTraceInput): EstimateTraceRow {
    const full: EstimateTraceRow = { ...row, amount: dRoundDollars(row.exact) };
    this.items.push(full);
    return full;
  }

  rows(): EstimateTraceRow[] {
    return [...this.items];
  }
}

// ── Context ──────────────────────────────────────────────────────────

/** Parameters + warnings (EngineContext), an estimate trace and one rule reader per state. */
export class EstimateContext {
  readonly base: EngineContext;
  readonly trace = new EstimateTraceBuilder();
  private readonly readers = new Map<string, StateRuleReader>();

  constructor(parameters: ParameterMap, readonly taxYear: number, readonly filingStatus: FilingStatus) {
    this.base = new EngineContext(parameters, taxYear, filingStatus);
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

  parametersUsed(): ParameterUse[] {
    return this.params.used();
  }

  /** Step warnings, then the D12a parameter and rule warnings. */
  allWarnings(): TaxEstimatorWarning[] {
    return [...this.base.allWarnings(), ...[...this.readers.values()].flatMap((r) => r.warnings())];
  }
}

// ── Shared DTOs ──────────────────────────────────────────────────────

/** Where the effective safe-harbor rule came from (precedence year → taxpayer → firm default). */
export type SafeHarborRuleSource = 'year' | 'taxpayer' | 'firm_default';

export interface PriorYearInput {
  /** Prior-year tax shown on the return; null = unknown / unfiled. */
  tax: Dec | null;
  /** Prior-year AGI (high-AGI test); null = unknown. */
  agi: Dec | null;
  /** The prior year covered 12 months (§6654(d)(1)(B)(ii)). */
  twelveMonths: boolean;
  /** A prior-year return was (or will be) filed. */
  filed: boolean;
}

export const NO_PRIOR_YEAR: PriorYearInput = { tax: null, agi: null, twelveMonths: false, filed: false };

export type { SafeHarborOverride };

/** One installment the payment ledger must cover. */
export interface InstallmentDue {
  /** 0-based position in the schedule. */
  index: number;
  /** Statutory due date (already business-day adjusted when it comes from a seed). */
  dueDate: string;
  /** Required installment before withholding (lesser of regular / annualized). */
  required: Dec;
}
