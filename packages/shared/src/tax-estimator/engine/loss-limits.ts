// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md step 3 — loss limitations (allowed_loss_override, passive netting,
// §469(i) rental allowance with the MAGI phase-out (D10), §461(l) excess
// business loss). PHASE 6 EXTENSION POINT: shares pass through unchanged; a
// warning says so whenever a limitation could have applied. Phase 7 implements
// the body of applyLossLimitations() against this signature (it may rewrite
// `share` amounts on the AggregatedIncome persons and must fill the result).

import { ZERO, dIsNeg, dAdd, type Dec } from '../decimal.js';
import { sumCharacters, type AggregatedIncome } from './income.js';
import type { EngineContext } from './context.js';
import type { LossLimitationResult } from './types.js';

export interface LossLimitationExact extends LossLimitationResult {
  suspendedPassiveLoss: Dec;
  excessBusinessLoss: Dec;
}

export function applyLossLimitations(income: AggregatedIncome, ctx: EngineContext): LossLimitationExact {
  let passiveLoss: Dec = ZERO;
  let anyLoss = false;
  let anyOverride = false;
  for (const p of income.byPerson.values()) {
    for (const s of p.shares) {
      const total = sumCharacters(s.share);
      if (dIsNeg(total)) {
        anyLoss = true;
        if (s.activityType === 'passive' || s.activityType === 'rental') passiveLoss = dAdd(passiveLoss, total);
      }
      if (s.allowedLossOverride != null) anyOverride = true;
    }
  }
  if (anyLoss || anyOverride) {
    ctx.warn('TE_LOSS_LIMITS_NOT_APPLIED', 'Loss limitations (basis / at-risk override, passive activity rules incl. §469(i), §461(l) excess business loss) are not yet applied; losses are deducted in full. Phase 7 adds them.', { passiveLoss });
  }
  return { applied: false, suspendedPassiveLoss: ZERO, excessBusinessLoss: ZERO, notes: anyLoss ? ['Losses deducted without limitation (Phase 7 pending).'] : [] };
}
