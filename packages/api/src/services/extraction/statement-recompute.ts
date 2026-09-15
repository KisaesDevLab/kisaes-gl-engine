// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Pure re-reconciliation of a persisted statement parse after the operator
// corrects a misread row (amount and/or type) in the review table. Re-runs
// the Golden Rule and the per-row running-balance check over the corrected
// rows so the "off by $X" badges and the reconcile banner reflect what will
// actually be imported. No repair pass here — a human edit is authoritative
// and must never be second-guessed by the auto-repair heuristics.

import { reconcileGoldenRule, findSuspectRows } from './reconcile.service.js';
import { isCreditCardType } from './statement-map.js';

export interface RecomputableTransaction {
  amount: string; // positive magnitude
  type: 'debit' | 'credit';
  balance?: string;
}

export interface RecomputeInput {
  transactions: RecomputableTransaction[];
  openingBalance: string | null;
  closingBalance: string | null;
  accountTypeHint: string | null;
}

export interface RecomputeOutput {
  reconciliation: {
    status: 'verified' | 'discrepancy' | 'skipped';
    deltaCents: number;
    expectedClosingCents: number | null;
    actualClosingCents: number | null;
  };
  suspectRows: Array<{ index: number; deltaCents: number }>;
}

// "$1,234.56" / "1234.56" / "-12.5" → integer cents (null when unparseable).
export function amountToCents(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = parseFloat(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// Inverse of mapSignedCentsToFeed: a positive magnitude + debit/credit back
// to the extraction sign convention (bank: out negative; card: charge positive).
export function feedToSignedCents(amount: string, type: 'debit' | 'credit', isCreditCard: boolean): number | null {
  const mag = amountToCents(amount);
  if (mag == null) return null;
  const abs = Math.abs(mag);
  const isSpend = type === 'debit';
  if (isCreditCard) return isSpend ? abs : -abs;
  return isSpend ? -abs : abs;
}

export function recomputeStatementReconciliation(input: RecomputeInput): RecomputeOutput {
  const isCard = isCreditCardType(input.accountTypeHint);
  const recTxns = input.transactions.map((t) => {
    const cents = feedToSignedCents(t.amount, t.type, isCard) ?? 0;
    const bal = amountToCents(t.balance);
    return {
      amountCents: BigInt(cents),
      runningBalanceCents: bal == null ? null : BigInt(bal),
    };
  });
  const opening = amountToCents(input.openingBalance);
  const closing = amountToCents(input.closingBalance);

  const suspectRows = findSuspectRows(BigInt(opening ?? 0), recTxns)
    .map((s) => ({ index: s.index, deltaCents: Number(s.deltaCents) }));

  if (opening == null || closing == null) {
    return {
      reconciliation: { status: 'skipped', deltaCents: 0, expectedClosingCents: null, actualClosingCents: null },
      suspectRows,
    };
  }
  const rec = reconcileGoldenRule({
    openingBalanceCents: BigInt(opening),
    closingBalanceCents: BigInt(closing),
    transactions: recTxns,
  });
  return {
    reconciliation: {
      status: rec.status === 'verified' ? 'verified' : 'discrepancy',
      deltaCents: Number(rec.deltaCents),
      expectedClosingCents: Number(rec.expectedClosingCents),
      actualClosingCents: Number(rec.actualClosingCents),
    },
    suspectRows,
  };
}
