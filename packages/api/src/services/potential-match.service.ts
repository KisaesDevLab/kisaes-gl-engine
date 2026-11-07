// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, desc, eq, gt, gte, isNotNull, lte, ne, sql } from 'drizzle-orm';
import {
  AMOUNT_TOLERANCE_BANDS,
  BUCKET1_QUALIFY_THRESHOLD,
  DATE_TOLERANCE_BANDS_DAYS,
  MATCH_SCORE_WEIGHTS,
  MAX_MATCH_CANDIDATES,
  type MatchCandidate,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  bankFeedItems,
  contacts,
  recurringSchedules,
  transactions,
} from '../db/schema/index.js';
import { nameSimilarityFuzzy } from '../utils/string-similarity.js';

// Phase 3 §3.1 — five matchers + the orchestrator. Pure-data
// reads from the DB; no side effects, no writes. The result feeds
// into `practice-classification.service.upsertStateForFeedItem`
// via its `matchCandidates` parameter.

export interface FeedItemForMatching {
  id: string;
  tenantId: string;
  companyId: string | null;
  amount: string;        // signed; positive = expense, negative = deposit per existing convention
  feedDate: string;      // YYYY-MM-DD
  description: string | null;
  originalDescription: string | null;
  bankConnectionId: string;
}

// ─── Scoring helpers ───────────────────────────────────────────

function amountScore(feedAmount: number, candidateAmount: number): number {
  const a = Math.abs(feedAmount);
  const b = Math.abs(candidateAmount);
  if (a === 0 && b === 0) return 1;
  if (b === 0) return 0;
  const diffPct = Math.abs(a - b) / b;
  for (const band of AMOUNT_TOLERANCE_BANDS) {
    if (diffPct <= band.pct) return band.score;
  }
  return 0;
}

function dateScore(feedDate: string, candidateDate: string | null): number {
  if (!candidateDate) return 0;
  const a = new Date(feedDate + 'T00:00:00Z').getTime();
  const b = new Date(candidateDate + 'T00:00:00Z').getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  const days = Math.abs(a - b) / (24 * 60 * 60 * 1000);
  for (const band of DATE_TOLERANCE_BANDS_DAYS) {
    if (days <= band.days) return band.score;
  }
  return 0;
}

export function compositeScore(parts: {
  amount: number;
  date: number;
  name: number;
}): number {
  return (
    parts.amount * MATCH_SCORE_WEIGHTS.amount +
    parts.date * MATCH_SCORE_WEIGHTS.date +
    parts.name * MATCH_SCORE_WEIGHTS.name
  );
}

/**
 * A matcher's date window around a feed date, as the matchers have always
 * computed it (a Date from the YYYY-MM-DD string moved by local days,
 * read back as a UTC date).
 */
export function dateWindow(feedDate: string, days: number): { min: string; max: string } {
  const minDate = new Date(feedDate);
  minDate.setDate(minDate.getDate() - days);
  const maxDate = new Date(feedDate);
  maxDate.setDate(maxDate.getDate() + days);
  return { min: minDate.toISOString().slice(0, 10), max: maxDate.toISOString().slice(0, 10) };
}

// The scorers below turn the rows a matcher read into candidates. They are
// shared with the import batch (bank-import/post-process.ts), which reads
// the rows of many feed items at once.
type TxnRow = typeof transactions.$inferSelect;
export type OpenTxnRow = { txn: TxnRow; contactName: string | null };
export type RecurringRow = { schedule: typeof recurringSchedules.$inferSelect; txn: TxnRow; contactName: string | null };

// ─── Open-invoice matcher (§3.1) ───────────────────────────────

// Deposits (negative-amount feed items per the existing
// convention) potentially match unpaid customer invoices. We
// constrain to invoices with balanceDue > 0 and either txn date
// within ~14 days of the feed date or a customer-name similarity
// boost — the matcher itself doesn't pre-filter beyond that
// because we want the scorer to be the source of truth.
async function matchOpenInvoices(item: FeedItemForMatching): Promise<MatchCandidate[]> {
  const feedAmount = parseFloat(item.amount);
  // Deposits arrive negative in our model; only consider invoices
  // when the feed item is actually a deposit (or zero, edge case).
  if (feedAmount > 0) return [];

  // 14-day date window — enough to catch the typical
  // invoice-then-deposit lag; the scoring tolerance bands narrow
  // the actual cutoff to ≤7 days for any non-zero score.
  const w = dateWindow(item.feedDate, 14);

  const rows = await db
    .select({
      txn: transactions,
      contactName: contacts.displayName,
    })
    .from(transactions)
    .leftJoin(contacts, eq(contacts.id, transactions.contactId))
    .where(
      and(
        eq(transactions.tenantId, item.tenantId),
        eq(transactions.txnType, 'invoice'),
        gt(transactions.balanceDue, '0'),
        gte(transactions.txnDate, w.min),
        lte(transactions.txnDate, w.max),
      ),
    )
    // Date order (as the import batch reads them): the same rows when more than the limit qualify.
    .orderBy(transactions.txnDate, transactions.id)
    .limit(200);
  return scoreOpenInvoices(item, rows);
}

export function scoreOpenInvoices(item: FeedItemForMatching, rows: OpenTxnRow[]): MatchCandidate[] {
  const feedAmount = parseFloat(item.amount);
  const out: MatchCandidate[] = [];
  for (const r of rows) {
    const cAmount = parseFloat(r.txn.balanceDue ?? r.txn.total ?? '0');
    const aScore = amountScore(Math.abs(feedAmount), cAmount);
    if (aScore === 0) continue;
    const dScore = dateScore(item.feedDate, r.txn.txnDate);
    const nScore = nameSimilarityFuzzy(item.originalDescription || item.description, r.contactName);
    const score = compositeScore({ amount: aScore, date: dScore, name: nScore });
    out.push({
      kind: 'invoice',
      targetId: r.txn.id,
      amount: cAmount.toFixed(4),
      date: r.txn.txnDate,
      contactName: r.contactName ?? null,
      score,
      amountScore: aScore,
      dateScore: dScore,
      nameScore: nScore,
      reason: `Invoice ${r.txn.txnNumber ?? r.txn.id.slice(0, 8)} for ${r.contactName ?? 'unknown customer'}`,
    });
  }
  return out;
}

// ─── Open-bill matcher (§3.1) ──────────────────────────────────

async function matchOpenBills(item: FeedItemForMatching): Promise<MatchCandidate[]> {
  const feedAmount = parseFloat(item.amount);
  // Expenses arrive positive; bills represent money to be paid out.
  if (feedAmount < 0) return [];

  const w = dateWindow(item.feedDate, 14);

  const rows = await db
    .select({
      txn: transactions,
      contactName: contacts.displayName,
    })
    .from(transactions)
    .leftJoin(contacts, eq(contacts.id, transactions.contactId))
    .where(
      and(
        eq(transactions.tenantId, item.tenantId),
        eq(transactions.txnType, 'bill'),
        gt(transactions.balanceDue, '0'),
        gte(transactions.txnDate, w.min),
        lte(transactions.txnDate, w.max),
      ),
    )
    .orderBy(transactions.txnDate, transactions.id)
    .limit(200);
  return scoreOpenBills(item, rows);
}

export function scoreOpenBills(item: FeedItemForMatching, rows: OpenTxnRow[]): MatchCandidate[] {
  const feedAmount = parseFloat(item.amount);
  const out: MatchCandidate[] = [];
  for (const r of rows) {
    const cAmount = parseFloat(r.txn.balanceDue ?? r.txn.total ?? '0');
    const aScore = amountScore(Math.abs(feedAmount), cAmount);
    if (aScore === 0) continue;
    const dScore = dateScore(item.feedDate, r.txn.txnDate);
    const nScore = nameSimilarityFuzzy(item.originalDescription || item.description, r.contactName);
    const score = compositeScore({ amount: aScore, date: dScore, name: nScore });
    out.push({
      kind: 'bill',
      targetId: r.txn.id,
      amount: cAmount.toFixed(4),
      date: r.txn.txnDate,
      contactName: r.contactName ?? null,
      score,
      amountScore: aScore,
      dateScore: dScore,
      nameScore: nScore,
      reason: `Bill ${r.txn.vendorInvoiceNumber ?? r.txn.txnNumber ?? r.txn.id.slice(0, 8)} from ${r.contactName ?? 'unknown vendor'}`,
    });
  }
  return out;
}

// ─── Unposted journal-entry matcher (§3.1) ─────────────────────

// "Unposted JE" in our model = a journal_entry transaction whose
// status is 'posted' but whose memo references a bank deposit /
// payment we expect to reconcile against. We keep the matcher
// simple here: same date window, exact amount match required (no
// amount tolerance for JEs — they're authored deliberately), name
// match against memo.
async function matchUnpostedJEs(item: FeedItemForMatching): Promise<MatchCandidate[]> {
  const feedAmount = parseFloat(item.amount);
  if (feedAmount === 0) return [];

  const w = dateWindow(item.feedDate, 7);

  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.tenantId, item.tenantId),
        eq(transactions.txnType, 'journal_entry'),
        gte(transactions.txnDate, w.min),
        lte(transactions.txnDate, w.max),
        eq(transactions.total, Math.abs(feedAmount).toFixed(4)),
      ),
    )
    .orderBy(transactions.txnDate, transactions.id)
    .limit(50);
  return scoreUnpostedJEs(item, rows);
}

export function scoreUnpostedJEs(item: FeedItemForMatching, rows: TxnRow[]): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  for (const r of rows) {
    const dScore = dateScore(item.feedDate, r.txnDate);
    const nScore = nameSimilarityFuzzy(item.originalDescription || item.description, r.memo);
    const score = compositeScore({ amount: 1.0, date: dScore, name: nScore });
    out.push({
      kind: 'journal_entry',
      targetId: r.id,
      amount: r.total ?? '0',
      date: r.txnDate,
      contactName: null,
      score,
      amountScore: 1.0,
      dateScore: dScore,
      nameScore: nScore,
      reason: `Journal entry ${r.txnNumber ?? r.id.slice(0, 8)}`,
    });
  }
  return out;
}

// ─── Inter-account transfer detector (§3.1) ────────────────────

// A transfer is two bank-feed items: one debit on account A
// (positive amount), one credit on account B (negative amount),
// same absolute amount, within a 3-day window. The detector
// returns the OTHER feed item as a candidate so applying the
// match can pair the two into a single transfer transaction.
async function matchInterAccountTransfers(item: FeedItemForMatching): Promise<MatchCandidate[]> {
  const feedAmount = parseFloat(item.amount);
  if (feedAmount === 0) return [];

  const w = dateWindow(item.feedDate, 3);
  const targetAmount = (-feedAmount).toFixed(4);

  // Opposite sign means SUM = 0 between the pair. Match by exact
  // opposite-sign amount; date window ≤3 days. Exclude the same
  // feed item, the same bank connection (transfers are between
  // *different* accounts), and items already matched.
  const rows = await db
    .select()
    .from(bankFeedItems)
    .where(
      and(
        eq(bankFeedItems.tenantId, item.tenantId),
        ne(bankFeedItems.id, item.id),
        ne(bankFeedItems.bankConnectionId, item.bankConnectionId),
        eq(bankFeedItems.amount, targetAmount),
        gte(bankFeedItems.feedDate, w.min),
        lte(bankFeedItems.feedDate, w.max),
      ),
    )
    .orderBy(bankFeedItems.feedDate, bankFeedItems.id)
    .limit(20);
  return scoreTransfers(item, rows);
}

export function scoreTransfers(item: FeedItemForMatching, rows: Array<typeof bankFeedItems.$inferSelect>): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  for (const r of rows) {
    if (r.status !== 'pending') continue;
    const dScore = dateScore(item.feedDate, r.feedDate);
    const score = compositeScore({ amount: 1.0, date: dScore, name: 0 });
    out.push({
      kind: 'transfer',
      targetId: r.id,
      amount: r.amount,
      date: r.feedDate,
      contactName: null,
      score,
      amountScore: 1.0,
      dateScore: dScore,
      nameScore: 0,
      reason: `Transfer pair candidate (other feed item ${r.id.slice(0, 8)})`,
    });
  }
  return out;
}

// ─── Recurring template matcher (§3.1) ─────────────────────────

async function matchRecurringTemplates(item: FeedItemForMatching): Promise<MatchCandidate[]> {
  const feedAmount = parseFloat(item.amount);
  if (feedAmount === 0) return [];

  const w = dateWindow(item.feedDate, 7);

  const rows = await db
    .select({
      schedule: recurringSchedules,
      txn: transactions,
      contactName: contacts.displayName,
    })
    .from(recurringSchedules)
    .innerJoin(transactions, eq(transactions.id, recurringSchedules.templateTransactionId))
    .leftJoin(contacts, eq(contacts.id, transactions.contactId))
    .where(
      and(
        eq(recurringSchedules.tenantId, item.tenantId),
        eq(recurringSchedules.isActive, true),
        gte(recurringSchedules.nextOccurrence, w.min),
        lte(recurringSchedules.nextOccurrence, w.max),
        isNotNull(transactions.total),
      ),
    )
    .orderBy(recurringSchedules.nextOccurrence, recurringSchedules.id)
    .limit(50);
  return scoreRecurring(item, rows);
}

export function scoreRecurring(item: FeedItemForMatching, rows: RecurringRow[]): MatchCandidate[] {
  const feedAmount = parseFloat(item.amount);
  const out: MatchCandidate[] = [];
  for (const r of rows) {
    const tplAmount = parseFloat(r.txn.total ?? '0');
    if (tplAmount === 0) continue;
    const aScore = amountScore(Math.abs(feedAmount), tplAmount);
    if (aScore === 0) continue;
    const dScore = dateScore(item.feedDate, r.schedule.nextOccurrence);
    const nScore = nameSimilarityFuzzy(item.originalDescription || item.description, r.contactName);
    const score = compositeScore({ amount: aScore, date: dScore, name: nScore });
    out.push({
      kind: 'recurring',
      targetId: r.schedule.id,
      amount: tplAmount.toFixed(4),
      date: r.schedule.nextOccurrence,
      contactName: r.contactName ?? null,
      score,
      amountScore: aScore,
      dateScore: dScore,
      nameScore: nScore,
      reason: `Upcoming ${r.schedule.frequency} recurrence for ${r.contactName ?? 'template ' + r.txn.id.slice(0, 8)}`,
    });
  }
  return out;
}

// ─── Orchestrator ──────────────────────────────────────────────

export async function findMatches(
  tenantId: string,
  feedItemId: string,
): Promise<MatchCandidate[]> {
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  if (!item) return [];

  const input: FeedItemForMatching = {
    id: item.id,
    tenantId: item.tenantId,
    companyId: item.companyId,
    amount: item.amount,
    feedDate: item.feedDate,
    description: item.description,
    originalDescription: item.originalDescription,
    bankConnectionId: item.bankConnectionId,
  };

  const all = (await Promise.all([
    matchOpenInvoices(input),
    matchOpenBills(input),
    matchUnpostedJEs(input),
    matchInterAccountTransfers(input),
    matchRecurringTemplates(input),
  ])).flat();

  return rankCandidates(all);
}

/** The qualifying candidates, best first, at most MAX_MATCH_CANDIDATES. */
export function rankCandidates(all: MatchCandidate[]): MatchCandidate[] {
  return all
    .filter((c) => c.score >= BUCKET1_QUALIFY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCH_CANDIDATES);
}

// Exposed for testing the individual matchers in isolation.
export const _internal = {
  amountScore,
  dateScore,
  matchOpenInvoices,
  matchOpenBills,
  matchUnpostedJEs,
  matchInterAccountTransfers,
  matchRecurringTemplates,
};
