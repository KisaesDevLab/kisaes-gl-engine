// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Bank reconciliation "proof of cash to the GL" — the standard professional
// bank-to-books reconciliation shared by the Reconcile screen, the
// Reconciliation Detail / Summary reports (screen, PDF, CSV) and the Report
// Pack's Bank Reconciliations section.
//
// Every amount in a ReconProof is in the account's NATURAL orientation:
//   - asset (bank) accounts: debit-positive (a positive balance is cash on hand)
//   - liability (credit card / line of credit) accounts: credit-positive (a
//     positive balance is the amount OWED, exactly as the card statement prints it)
// The API computes in GL orientation (debit − credit) and multiplies by the
// orientation sign (+1 asset, −1 liability) once, at the edge.
//
// Section A identity (natural orientation):
//   Adjusted statement balance = statement balance + increases − decreases
//   Adjusted book balance      = book (GL) balance at D + unrecorded statement items
//   Unreconciled difference    = adjusted statement balance − adjusted book balance
// "Increases" are book items that raise the balance but are not on the statement
// yet (deposits in transit for a bank; charges for a card); "decreases" lower it
// (outstanding checks and payments for a bank; payments and credits for a card).

/** An outstanding check / payment older than this many days is "stale". */
export const RECON_OUTSTANDING_STALE_DAYS = 90;
/** An outstanding check / payment older than this many days is "stale-dated" (review / void / escheat). */
export const RECON_OUTSTANDING_STALE_DATED_DAYS = 180;
/** A deposit in transit older than this many days should have reached the bank — "investigate". */
export const RECON_DEPOSIT_IN_TRANSIT_INVESTIGATE_DAYS = 10;
/** A credit-card item recorded in the books but missing from the statement for longer than a billing cycle — "investigate". */
export const RECON_CARD_ITEM_INVESTIGATE_DAYS = 30;
/** Amounts within half a cent are treated as equal. */
export const RECON_PROOF_TOLERANCE = 0.005;

export type ReconOrientation = 'asset' | 'liability';
export type ReconItemSide = 'increase' | 'decrease';
export type ReconItemFlag = 'stale' | 'stale_dated' | 'investigate' | null;

export interface ReconItemFlagResult {
  flag: ReconItemFlag;
  /** Short human label, e.g. "Stale (120 days)"; null when not flagged. */
  label: string | null;
}

/** Whole days from an ISO date (YYYY-MM-DD) to another (UTC, no DST drift). */
export function reconAgeDays(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/**
 * Age flag for an outstanding item, measured as of the statement date.
 *   bank, decrease (outstanding check / payment): > 90 days stale, > 180 days stale-dated
 *   bank, increase (deposit in transit):          > 10 days investigate
 *   card, either side:                            > 30 days investigate
 */
export function reconItemFlag(orientation: ReconOrientation, side: ReconItemSide, ageDays: number): ReconItemFlagResult {
  if (orientation === 'asset') {
    if (side === 'decrease') {
      if (ageDays > RECON_OUTSTANDING_STALE_DATED_DAYS) {
        return { flag: 'stale_dated', label: `Stale-dated (${ageDays} days) — review / void / escheat` };
      }
      if (ageDays > RECON_OUTSTANDING_STALE_DAYS) return { flag: 'stale', label: `Stale (${ageDays} days)` };
      return { flag: null, label: null };
    }
    if (ageDays > RECON_DEPOSIT_IN_TRANSIT_INVESTIGATE_DAYS) {
      return { flag: 'investigate', label: `Investigate (${ageDays} days in transit)` };
    }
    return { flag: null, label: null };
  }
  if (ageDays > RECON_CARD_ITEM_INVESTIGATE_DAYS) {
    return { flag: 'investigate', label: `Investigate (${ageDays} days not on statement)` };
  }
  return { flag: null, label: null };
}

/** Professional labels per orientation (bank vs credit card). */
export interface ReconLabels {
  statementBalance: string;
  increases: string;
  decreases: string;
  adjustedStatementBalance: string;
  bookBalance: string;
  unrecorded: string;
  adjustedBookBalance: string;
  clearedIncreases: string;
  clearedDecreases: string;
}

export function reconLabels(orientation: ReconOrientation): ReconLabels {
  if (orientation === 'liability') {
    return {
      statementBalance: 'Balance per card statement (amount owed)',
      increases: 'Charges recorded in books, not yet on statement',
      decreases: 'Payments and credits recorded in books, not yet on statement',
      adjustedStatementBalance: 'Adjusted statement balance',
      bookBalance: 'Balance per books (general ledger)',
      unrecorded: 'Statement items not yet recorded in books',
      adjustedBookBalance: 'Adjusted book balance',
      clearedIncreases: 'Cleared charges',
      clearedDecreases: 'Cleared payments and credits',
    };
  }
  return {
    statementBalance: 'Balance per bank statement',
    increases: 'Deposits in transit',
    decreases: 'Outstanding checks and payments',
    adjustedStatementBalance: 'Adjusted bank balance',
    bookBalance: 'Balance per books (general ledger)',
    unrecorded: 'Unrecorded bank items (interest, fees, NSF, other)',
    adjustedBookBalance: 'Adjusted book balance',
    clearedIncreases: 'Cleared deposits and other credits',
    clearedDecreases: 'Cleared checks and payments',
  };
}

export interface ReconCountTotal {
  count: number;
  total: number;
}

export interface ReconScheduleItem {
  journalLineId: string;
  transactionId: string;
  txnDate: string;
  txnType: string;
  /** Check number when the transaction has one, else the transaction number. */
  number: string | null;
  payee: string | null;
  description: string | null;
  /** Positive amount on this schedule (natural orientation). */
  amount: number;
  /** Days from the transaction date to the statement date. */
  ageDays: number;
  flag: ReconItemFlag;
  flagLabel: string | null;
}

export interface ReconSchedule extends ReconCountTotal {
  label: string;
  items: ReconScheduleItem[];
}

export interface ReconUnrecordedItem {
  statementLineId: string;
  lineDate: string;
  description: string | null;
  checkNumber: string | null;
  /** Signed, natural orientation: positive raises the book balance once recorded. */
  amount: number;
}

export type ReconDiscrepancyReason =
  | 'deleted'
  | 'voided'
  | 'moved_account'
  | 'redated_after_reconciliation'
  | 'dated_after_statement'
  | 'edited_after_reconciliation';

export interface ReconDiscrepancyItem {
  /** The reconciliation that cleared the item. */
  reconciliationId: string;
  reconciliationDate: string;
  /** True when it was cleared by THIS reconciliation (vs a prior one). */
  thisReconciliation: boolean;
  journalLineId: string;
  transactionId: string | null;
  txnDate: string | null;
  txnType: string | null;
  number: string | null;
  description: string | null;
  /** Current signed natural amount on this account; null when the line no longer exists. */
  currentAmount: number | null;
  reasons: ReconDiscrepancyReason[];
  /** Latest audit-log edit after the reconciliation was completed (ISO timestamp). */
  editedAt: string | null;
}

export interface ReconPriorChange {
  reconciliationId: string;
  statementDate: string;
  /** Cleared activity when that reconciliation was completed. */
  clearedAtCompletion: number;
  /** The same reconciliation's cleared lines, summed from today's ledger. */
  clearedNow: number;
  /** clearedNow − clearedAtCompletion. */
  change: number;
}

export interface ReconProof {
  reconciliationId: string;
  accountId: string;
  accountName: string;
  accountNumber: string | null;
  accountType: string;
  orientation: ReconOrientation;
  status: string;
  statementDate: string;
  /** The date "today" was evaluated as (subsequent activity / register balance). */
  asOfToday: string;
  labels: ReconLabels;

  /** Section A — reconciliation summary (statement to books). */
  summary: {
    statementBalance: number;
    increases: ReconCountTotal;
    decreases: ReconCountTotal;
    adjustedStatementBalance: number;
    bookBalance: number;
    /** null = not applicable / not available (see unrecordedNote). */
    unrecorded: ReconCountTotal | null;
    unrecordedNote: string | null;
    adjustedBookBalance: number;
    unreconciledDifference: number;
    reconciledToBooks: boolean;
    /** Plain-English reasons when not reconciled (empty when it ties). */
    explanations: string[];
  };

  /** Classic cleared-activity roll (kept from the original worksheet). */
  clearedRoll: {
    beginningBalance: number;
    clearedIncreases: ReconCountTotal;
    clearedDecreases: ReconCountTotal;
    clearedBalance: number;
    statementBalance: number;
    /** statementBalance − clearedBalance (the worksheet "Difference"). */
    difference: number;
  };

  /** Section B — supporting schedules, oldest first. */
  schedules: {
    increases: ReconSchedule;
    decreases: ReconSchedule;
    unrecorded: ReconUnrecordedItem[];
  };
  flagCounts: { stale: number; staleDated: number; investigate: number };

  /** Section C — subsequent activity / register reconciliation. */
  subsequent: {
    /** Posted activity dated after the statement date through today. */
    afterStatement: ReconCountTotal;
    /** The uncleared subset of afterStatement. */
    unclearedAfterStatement: ReconCountTotal;
    /** Book balance at D + afterStatement. */
    registerBalanceToday: number;
    /** Activity dated after today (post-dated). */
    futureDated: ReconCountTotal;
    /** registerBalanceToday + futureDated. */
    endingRegisterBalance: number;
  };

  /** Section D — book-side integrity proof. */
  bookProof: {
    beginningBalance: number;
    clearedThisReconciliation: number;
    outstandingNet: number;
    /** beginning + cleared this reconciliation + outstanding items (net). */
    expectedBookBalance: number;
    bookBalance: number;
    /** bookBalance − expectedBookBalance; 0.00 when the books tie. */
    discrepancy: number;
    ties: boolean;
    components: {
      /** Previously reconciled transactions changed / deleted / voided since they were reconciled. */
      changesToPriorReconciled: number;
      /** Previously reconciled items now dated after this statement date. */
      priorReconciledNowAfterStatement: number;
      /** Items cleared on THIS reconciliation that are dated after D, voided, or moved. */
      clearedOutOfPeriod: number;
      /** Beginning balance not supported by the prior reconciliations' cleared activity (opening balance / chain break). */
      beginningBalanceVariance: number;
    };
    priorChanges: ReconPriorChange[];
    items: ReconDiscrepancyItem[];
    explanations: string[];
  };

  /** Section E — sign-off. */
  signOff: {
    preparedBy: string | null;
    preparedAt: string | null;
    reviewedBy: string | null;
    reviewedAt: string | null;
    statementFileName: string | null;
    statementAttachmentId: string | null;
    statementPeriod: string | null;
  };
}

/** Human text for a discrepancy reason. */
export function reconDiscrepancyReasonLabel(r: ReconDiscrepancyReason): string {
  switch (r) {
    case 'deleted': return 'Deleted after it was reconciled';
    case 'voided': return 'Voided / no longer posted';
    case 'moved_account': return 'Moved to another account';
    case 'redated_after_reconciliation': return 'Re-dated after its reconciliation date';
    case 'dated_after_statement': return 'Dated after this statement date';
    case 'edited_after_reconciliation': return 'Edited after it was reconciled (audit log)';
    default: return r;
  }
}

// ─── Statement layout ─────────────────────────────────────────────
// The ordered lines of each section, shared by the Reconcile screen, the
// report pages, the PDF and the CSV so every surface prints the same thing
// in the same order. `kind`: 'line' (an item, indented), 'subtotal' (a
// computed balance, ruled above), 'result' (the bottom line of the section).

export interface ReconStatementLine {
  key: string;
  label: string;
  amount: number;
  kind: 'line' | 'subtotal' | 'result';
}

function usDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}

/** Section A — reconciliation summary, statement to books. */
export function reconSummaryLines(p: ReconProof): ReconStatementLine[] {
  const L = p.labels;
  const D = usDate(p.statementDate);
  const s = p.summary;
  const lines: ReconStatementLine[] = [
    { key: 'statement', label: `${L.statementBalance}, ${D}`, amount: s.statementBalance, kind: 'line' },
    { key: 'increases', label: `Add: ${L.increases} (${s.increases.count})`, amount: s.increases.total, kind: 'line' },
    { key: 'decreases', label: `Less: ${L.decreases} (${s.decreases.count})`, amount: -s.decreases.total, kind: 'line' },
    { key: 'adjusted_statement', label: L.adjustedStatementBalance, amount: s.adjustedStatementBalance, kind: 'subtotal' },
    { key: 'books', label: `${L.bookBalance}, ${D}`, amount: s.bookBalance, kind: 'line' },
  ];
  if (s.unrecorded) {
    lines.push({ key: 'unrecorded', label: `Add/(less): ${L.unrecorded} (${s.unrecorded.count})`, amount: s.unrecorded.total, kind: 'line' });
  }
  lines.push({ key: 'adjusted_books', label: L.adjustedBookBalance, amount: s.adjustedBookBalance, kind: 'subtotal' });
  lines.push({ key: 'unreconciled', label: 'Unreconciled difference', amount: s.unreconciledDifference, kind: 'result' });
  return lines;
}

/** Cleared-activity roll — beginning balance through the worksheet difference. */
export function reconClearedRollLines(p: ReconProof): ReconStatementLine[] {
  const L = p.labels;
  const r = p.clearedRoll;
  return [
    { key: 'beginning', label: 'Beginning balance (prior reconciliation ending balance)', amount: r.beginningBalance, kind: 'line' },
    { key: 'cleared_increases', label: `Add: ${L.clearedIncreases} (${r.clearedIncreases.count})`, amount: r.clearedIncreases.total, kind: 'line' },
    { key: 'cleared_decreases', label: `Less: ${L.clearedDecreases} (${r.clearedDecreases.count})`, amount: -r.clearedDecreases.total, kind: 'line' },
    { key: 'cleared_balance', label: 'Cleared balance', amount: r.clearedBalance, kind: 'subtotal' },
    { key: 'statement_ending', label: `Statement ending balance, ${usDate(p.statementDate)}`, amount: r.statementBalance, kind: 'line' },
    { key: 'difference', label: 'Difference (statement − cleared)', amount: r.difference, kind: 'result' },
  ];
}

/** Section C — subsequent activity / register reconciliation. */
export function reconSubsequentLines(p: ReconProof): ReconStatementLine[] {
  const c = p.subsequent;
  const lines: ReconStatementLine[] = [
    { key: 'books', label: `${p.labels.bookBalance}, ${usDate(p.statementDate)}`, amount: p.summary.bookBalance, kind: 'line' },
    { key: 'after', label: `Activity dated after ${usDate(p.statementDate)} through ${usDate(p.asOfToday)} (${c.afterStatement.count}; ${c.unclearedAfterStatement.count} uncleared totaling ${reconMoney(c.unclearedAfterStatement.total)})`, amount: c.afterStatement.total, kind: 'line' },
    { key: 'register_today', label: `Register balance as of ${usDate(p.asOfToday)}`, amount: c.registerBalanceToday, kind: 'subtotal' },
  ];
  if (c.futureDated.count > 0) {
    lines.push({ key: 'future', label: `Post-dated activity after ${usDate(p.asOfToday)} (${c.futureDated.count})`, amount: c.futureDated.total, kind: 'line' });
    lines.push({ key: 'ending_register', label: 'Ending register balance', amount: c.endingRegisterBalance, kind: 'result' });
  }
  return lines;
}

/** Section D — book-side proof. */
export function reconBookProofLines(p: ReconProof): ReconStatementLine[] {
  const b = p.bookProof;
  const D = usDate(p.statementDate);
  const lines: ReconStatementLine[] = [
    { key: 'beginning', label: 'Beginning balance (prior reconciliation ending balance)', amount: b.beginningBalance, kind: 'line' },
    { key: 'cleared', label: 'Add/(less): Cleared on this reconciliation (net)', amount: b.clearedThisReconciliation, kind: 'line' },
    { key: 'outstanding', label: `Add/(less): Outstanding items at ${D} (net)`, amount: b.outstandingNet, kind: 'line' },
    { key: 'expected', label: 'Book balance supported by reconciled and outstanding items', amount: b.expectedBookBalance, kind: 'subtotal' },
    { key: 'books', label: `${p.labels.bookBalance}, ${D}`, amount: b.bookBalance, kind: 'line' },
    { key: 'discrepancy', label: 'Book-side discrepancy', amount: b.discrepancy, kind: 'result' },
  ];
  return lines;
}

/** Non-zero Section D components, labelled. */
export function reconDiscrepancyComponentLines(p: ReconProof): ReconStatementLine[] {
  const c = p.bookProof.components;
  const D = usDate(p.statementDate);
  const all: ReconStatementLine[] = [
    { key: 'changes', label: 'Changes to previously reconciled transactions', amount: c.changesToPriorReconciled, kind: 'line' },
    { key: 'prior_after', label: `Previously reconciled items now dated after ${D}`, amount: c.priorReconciledNowAfterStatement, kind: 'line' },
    { key: 'cleared_out', label: `Cleared on this reconciliation but dated after ${D}, voided or moved`, amount: c.clearedOutOfPeriod, kind: 'line' },
    { key: 'beginning_variance', label: 'Beginning balance not supported by prior reconciliations (opening balance)', amount: c.beginningBalanceVariance, kind: 'line' },
  ];
  return all.filter((l) => Math.abs(l.amount) >= RECON_PROOF_TOLERANCE);
}

/** Accounting-style money: 1,234.56 / (1,234.56). */
export function reconMoney(v: number): string {
  const x = Math.round(v * 100) / 100;
  const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return x < 0 ? `(${s})` : s;
}
