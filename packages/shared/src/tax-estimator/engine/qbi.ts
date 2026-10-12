// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md step 9 — §199A qualified business income deduction.
// PHASE 6 STUB: the deduction is an overridable input (`qbi.manualDeduction`,
// fixture-supplied in the golden tests). Phase 7 replaces the body of
// computeQbi() with the full computation (per-link QBI after attributable
// ½ SE / SEHI / retirement, W-2 wage and UBIA limits (D8), threshold phase-in,
// SSTB rules, loss netting, REIT / PTP, overall taxable-income limit, minimum
// deduction) and keeps `manualDeduction` as the CPA override. The signature
// below is the contract federal.ts relies on.

import { ZERO, dFloorZero, dec, type Dec } from '../decimal.js';
import type { EngineContext } from './context.js';
import type { AggregatedIncome } from './income.js';
import type { QbiInput, QbiResult } from './types.js';

const STEP_QBI = 'qbi';

export interface QbiContext {
  /** AGI − deduction − Schedule 1-A (taxable income before the QBI deduction). */
  taxableIncomeBeforeQbi: Dec;
  /** Net capital gain including qualified dividends (overall-limit subtraction). */
  netCapitalGainWithQd: Dec;
  income: AggregatedIncome;
}

export interface QbiExact extends QbiResult {
  deduction: Dec;
}

export function computeQbi(input: QbiInput, _qbiCtx: QbiContext, ctx: EngineContext): QbiExact {
  if (input.manualDeduction != null) {
    const deduction = dFloorZero(dec(input.manualDeduction));
    ctx.info('TE_QBI_STUB', 'The §199A deduction is a manual input (the full computation arrives in Phase 7).', { deduction });
    ctx.trace.add({ step: STEP_QBI, id: 'qbi', label: 'Qualified business income deduction (manual input — §199A computation pending Phase 7)', exact: deduction, source: 'input' });
    return { method: 'manual', deduction };
  }
  ctx.info('TE_QBI_STUB', 'No §199A deduction was entered; none is taken (the full computation arrives in Phase 7).');
  ctx.trace.add({ step: STEP_QBI, id: 'qbi', label: 'Qualified business income deduction (none entered — §199A computation pending Phase 7)', exact: ZERO, source: 'input' });
  return { method: 'none', deduction: ZERO };
}
