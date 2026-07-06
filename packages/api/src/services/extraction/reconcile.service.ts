// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// The Golden Rule of bank-statement reconciliation (ported from
// Vibe-Transaction-Convertor's reconciler/golden-rule.ts):
//   opening_balance + sum(transactions) = closing_balance
// Cents-exact comparison on bigint. A non-zero delta is a discrepancy; the
// statement-import pipeline treats it softly — it lowers confidence and routes
// the import to review rather than blocking it (see ai-statement-parser).

export interface ReconcileTxn {
  amountCents: bigint;
  runningBalanceCents?: bigint | null;
}

export interface ReconcileInput {
  openingBalanceCents: bigint;
  closingBalanceCents: bigint;
  transactions: ReconcileTxn[];
  // Optional period bounds for defense-in-depth.
  periodStart?: string | null | undefined; // YYYY-MM-DD
  periodEnd?: string | null | undefined; // YYYY-MM-DD
  transactionDates?: string[] | undefined; // posted_date for each row, in order
}

// A row is "suspect" when its printed running balance disagrees with the prior
// row's running balance + this row's amount. Useful for the review UI (per-row
// "off by $X" badge) and as a precise repair hint.
export interface SuspectRow {
  index: number;
  expectedRunningCents: bigint;
  actualRunningCents: bigint;
  deltaCents: bigint;
}

export const findSuspectRows = (
  openingBalanceCents: bigint,
  txs: ReconcileTxn[],
): SuspectRow[] => {
  const out: SuspectRow[] = [];
  let priorRunning = openingBalanceCents;
  for (let i = 0; i < txs.length; i += 1) {
    const tx = txs[i]!;
    const expected = priorRunning + tx.amountCents;
    if (tx.runningBalanceCents !== null && tx.runningBalanceCents !== undefined) {
      const delta = tx.runningBalanceCents - expected;
      if (delta !== 0n) {
        out.push({
          index: i,
          expectedRunningCents: expected,
          actualRunningCents: tx.runningBalanceCents,
          deltaCents: delta,
        });
      }
      priorRunning = tx.runningBalanceCents;
    } else {
      priorRunning = expected;
    }
  }
  return out;
};

export type ReconciliationStatus = 'verified' | 'discrepancy' | 'failed';

export interface ReconcileResult {
  status: ReconciliationStatus;
  expectedClosingCents: bigint;
  actualClosingCents: bigint;
  deltaCents: bigint;
  periodBoundsViolations: number;
  message?: string;
}

export const reconcileGoldenRule = (input: ReconcileInput): ReconcileResult => {
  let sum = 0n;
  for (const tx of input.transactions) sum += tx.amountCents;
  const expected = input.openingBalanceCents + sum;
  const delta = input.closingBalanceCents - expected;

  let violations = 0;
  if (input.periodStart && input.periodEnd && input.transactionDates) {
    for (const d of input.transactionDates) {
      if (d < input.periodStart || d > input.periodEnd) violations += 1;
    }
  }

  if (delta === 0n) {
    return {
      status: 'verified',
      expectedClosingCents: expected,
      actualClosingCents: input.closingBalanceCents,
      deltaCents: 0n,
      periodBoundsViolations: violations,
    };
  }
  return {
    status: 'discrepancy',
    expectedClosingCents: expected,
    actualClosingCents: input.closingBalanceCents,
    deltaCents: delta,
    periodBoundsViolations: violations,
    message: `discrepancy of ${delta} cents (expected ${expected}, actual ${input.closingBalanceCents})`,
  };
};

// Repair pass — try a small set of corrections that often resolve a single
// sign-flip or duplicate-row discrepancy. Returns the modified transaction list
// AND a description of the fix; null when no safe fix is found.
//
// Repair rules (in order):
//   1. If flipping exactly one transaction's sign closes delta exactly, flip it.
//   2. If delta == amount of exactly one transaction AND that row is
//      independently implicated — flagged suspect by the running-balance check,
//      extracted with low row confidence, or an exact duplicate (same
//      date + amount + description) of another row — drop it. A row that
//      merely happens to match the delta arithmetically is NOT dropped;
//      silently discarding clean data to force reconciliation is worse than
//      reporting the discrepancy for human review.
export interface RepairCandidate<T extends { amountCents: bigint }> {
  transactions: T[];
  fixDescription: string;
}

// Row-confidence bar for the drop rule: a row the extractor itself scored
// below this is a plausible OCR phantom and may be dropped when it closes the
// Golden-Rule delta exactly. Rows at/above the bar need independent evidence
// (suspect flag or duplicate) before they can be dropped.
export const REPAIR_DROP_CONFIDENCE_BAR = 0.7;

export interface RepairOptions {
  /** Pre-repair indexes flagged by findSuspectRows (running-balance breaks). */
  suspectIndexes?: Set<number>;
  /** Override for REPAIR_DROP_CONFIDENCE_BAR. */
  dropConfidenceBar?: number;
}

export const repairPass = <
  T extends {
    amountCents: bigint;
    description?: string;
    /** ISO posted date — used for the duplicate-row drop guard. */
    postedDate?: string;
    /** Extractor's per-row confidence (0-1) — used for the drop guard. */
    rowConfidence?: number | null;
  },
>(
  txs: T[],
  delta: bigint,
  opts: RepairOptions = {},
): RepairCandidate<T> | null => {
  if (delta === 0n) return null;

  // delta = actual - (opening + sum). After flipping txs[i] from a to -a:
  //   new_sum = sum - 2a  →  new_delta = delta + 2a
  for (let i = 0; i < txs.length; i += 1) {
    const tx = txs[i]!;
    if (delta + 2n * tx.amountCents === 0n) {
      const next = txs.map((t, j) => (j === i ? { ...t, amountCents: -tx.amountCents } : t));
      return {
        transactions: next,
        fixDescription: `flipped sign on row ${i} (${tx.description ?? 'n/a'})`,
      };
    }
  }

  const dropBar = opts.dropConfidenceBar ?? REPAIR_DROP_CONFIDENCE_BAR;
  const isDuplicateOfAnother = (tx: T, i: number): boolean =>
    txs.some(
      (o, j) =>
        j !== i &&
        o.amountCents === tx.amountCents &&
        (o.description ?? '') === (tx.description ?? '') &&
        (o.postedDate ?? '') === (tx.postedDate ?? ''),
    );
  const dropReason = (tx: T, i: number): string | null => {
    if (opts.suspectIndexes?.has(i)) return 'suspect running balance';
    if (tx.rowConfidence != null && tx.rowConfidence < dropBar) {
      return `row confidence ${tx.rowConfidence} < ${dropBar}`;
    }
    if (isDuplicateOfAnother(tx, i)) return 'duplicate of another row';
    return null;
  };

  // After dropping txs[i] with amount a:  new_delta = delta + a
  for (let i = 0; i < txs.length; i += 1) {
    const tx = txs[i]!;
    if (delta + tx.amountCents === 0n) {
      const reason = dropReason(tx, i);
      if (!reason) continue; // arithmetic match alone is not enough to discard data
      const next = txs.filter((_, j) => j !== i);
      return {
        transactions: next,
        fixDescription: `dropped row ${i} (${tx.description ?? 'n/a'}; ${reason})`,
      };
    }
  }

  return null;
};
