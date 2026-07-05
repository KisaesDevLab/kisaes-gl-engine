// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Statement Match Engine wave 1 (migration 0116):
//   - sign orientation both directions (statement money-in ⇔ jl.debit,
//     money-out ⇔ jl.credit) with auto-clear + persistence + audit
//   - exact-amount precondition: off-by-a-cent is NEVER pool A — it becomes
//     a SUGGEST-only near match flagged with the delta
//   - ambiguity gate: two exact-amount candidates → no auto, suggest w/ both
//   - check numbers: exact → auto even ~30 days out; mismatch → disqualified
//   - reverse uniqueness: two statement lines, one journal line → both demoted
//   - id-linked feed items (matchedTransactionId) → auto without scoring
//   - confirm / reject flows + one-line-per-journal-line uniqueness
//   - un-clearing a worksheet line resets the auto/confirmed statement line
//   - reconcile_only import: statement + lines, ZERO feed items
//   - statement-line backfill is idempotent

import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags,
  reconciliations, reconciliationLines, bankStatements, bankStatementLines,
  bankFeedItems, bankConnections, aiJobs, attachments,
} from '../db/schema/index.js';
import * as bankStatementsService from './bank-statements.service.js';
import * as statementMatch from './statement-match.service.js';
import * as reconciliation from './reconciliation.service.js';
import * as bankFeedService from './bank-feed.service.js';
import * as bankConnectionService from './bank-connection.service.js';
import * as accountsService from './accounts.service.js';
import * as ledger from './ledger.service.js';

let tenantId: string;
let bankAccountId: string;
let revenueAccountId: string;
let expenseAccountId: string;

async function cleanDb(): Promise<void> {
  await db.delete(bankStatementLines);
  await db.delete(bankFeedItems);
  await db.delete(bankStatements);
  await db.delete(bankConnections);
  await db.delete(reconciliationLines);
  await db.delete(reconciliations);
  await db.delete(aiJobs);
  await db.delete(attachments);
  await db.delete(transactionTags);
  await db.delete(tags);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(auditLog);
  await db.delete(contacts);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

async function setup(): Promise<void> {
  const [tenant] = await db.insert(tenants).values({
    name: 'Match Test',
    slug: 'match-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = tenant!.id;

  const bank = await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', accountNumber: '1010' });
  bankAccountId = bank.id;
  const revenue = await accountsService.create(tenantId, { name: 'Revenue', accountType: 'revenue', accountNumber: '4000' });
  revenueAccountId = revenue.id;
  const expense = await accountsService.create(tenantId, { name: 'Supplies', accountType: 'expense', accountNumber: '6000' });
  expenseAccountId = expense.id;
}

interface JobTxn { date: string; description: string; amount: string; type: 'debit' | 'credit'; balance?: string }
interface JobCheck { checkNumber: string; payee: string; amount?: string }

async function mkStatementJob(opts: {
  periodStart?: string;
  periodEnd?: string;
  openingBalance?: string;
  closingBalance?: string;
  transactions?: JobTxn[];
  checks?: JobCheck[];
}) {
  const [attachment] = await db.insert(attachments).values({
    tenantId,
    fileName: 'stmt.pdf',
    filePath: '/tmp/stmt.pdf',
    attachableType: 'bank_statement',
    attachableId: '00000000-0000-0000-0000-000000000001',
  }).returning();
  const [job] = await db.insert(aiJobs).values({
    tenantId,
    jobType: 'ocr_statement',
    status: 'complete',
    inputType: 'attachment',
    inputId: attachment!.id,
    outputData: {
      transactions: opts.transactions ?? [],
      checks: opts.checks ?? [],
      accountNumberMasked: '4321',
      statementPeriod: { start: opts.periodStart ?? '2026-04-01', end: opts.periodEnd ?? '2026-04-30' },
      openingBalance: opts.openingBalance ?? '0.00',
      closingBalance: opts.closingBalance ?? '100.00',
      institutionName: 'Test Bank',
      accountTypeHint: 'CHECKING',
      confidence: 0.95,
      qualityWarnings: [],
      extractionSource: 'text_layer',
      reconciliation: { status: 'verified', deltaCents: 0, expectedClosingCents: null, actualClosingCents: null, repaired: false },
      suspectRows: [],
      notes: null,
    },
  }).returning();
  return { job: job!, attachmentId: attachment!.id };
}

// Capture the statement (creates bank_statement_lines) + start its
// reconciliation. Returns { statementId, reconId }.
async function captureAndStart(opts: Parameters<typeof mkStatementJob>[0]) {
  const { job } = await mkStatementJob(opts);
  const capture = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });
  const recon = await reconciliation.start(tenantId, undefined, undefined, undefined, { statementId: capture!.statement.id });
  return { statementId: capture!.statement.id, reconId: recon.id, jobId: job.id };
}

// Post a spend (bank credit) or deposit (bank debit) touching the bank account.
async function postBank(opts: { date: string; amount: string; memo: string; direction: 'in' | 'out'; contactId?: string }) {
  const lines = opts.direction === 'in'
    ? [
        { accountId: bankAccountId, debit: opts.amount, credit: '0' },
        { accountId: revenueAccountId, debit: '0', credit: opts.amount },
      ]
    : [
        { accountId: expenseAccountId, debit: opts.amount, credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: opts.amount },
      ];
  return await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry',
    txnDate: opts.date,
    memo: opts.memo,
    ...(opts.contactId ? { contactId: opts.contactId } : {}),
    lines,
  });
}

async function statementLinesOf(statementId: string) {
  return db.select().from(bankStatementLines)
    .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.statementId, statementId)));
}

async function worksheetOf(reconId: string) {
  const view = await reconciliation.getReconciliation(tenantId, reconId);
  return view.lines as Array<{ journal_line_id: string; is_cleared: boolean; debit: string; credit: string }>;
}

describe('Statement Match Engine', () => {
  beforeEach(async () => {
    await cleanDb();
    await setup();
  });

  describe('statement line capture', () => {
    it('stores signed lines (money-in positive, money-out negative) with check numbers and payees', async () => {
      const { job } = await mkStatementJob({
        transactions: [
          { date: '2026-04-03', description: 'POS PURCHASE COFFEE BARN', amount: '12.50', type: 'debit' },
          { date: '2026-04-07', description: 'ACH DEPOSIT ACME PAYROLL', amount: '2000.00', type: 'credit', balance: '2100.00' },
          { date: '2026-04-09', description: 'CHECK 0042', amount: '50.00', type: 'debit' },
        ],
        checks: [{ checkNumber: '0042', payee: 'Window Cleaning Co', amount: '50.00' }],
      });
      const capture = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });
      const lines = await statementLinesOf(capture!.statement.id);
      expect(lines.length).toBe(3);
      const spend = lines.find((l) => l.description === 'POS PURCHASE COFFEE BARN')!;
      expect(parseFloat(spend.amount)).toBe(-12.5);
      const deposit = lines.find((l) => l.description === 'ACH DEPOSIT ACME PAYROLL')!;
      expect(parseFloat(deposit.amount)).toBe(2000);
      expect(parseFloat(deposit.runningBalance!)).toBe(2100);
      const check = lines.find((l) => l.description === 'CHECK 0042')!;
      expect(parseFloat(check.amount)).toBe(-50);
      expect(check.checkNumber).toBe('0042');
      expect(check.payee).toBe('Window Cleaning Co');
      expect(lines.every((l) => l.matchStatus === 'unmatched')).toBe(true);
    });
  });

  describe('matchStatement — sign orientation + auto tier', () => {
    it('auto-clears both directions: deposits match jl.debit>0, withdrawals match jl.credit>0', async () => {
      // Books: money OUT $50 (bank credit) and money IN $200 (bank debit).
      await postBank({ date: '2026-04-03', amount: '50.00', memo: 'COFFEE BARN PURCHASE', direction: 'out' });
      await postBank({ date: '2026-04-07', amount: '200.00', memo: 'ACME PAYROLL DEPOSIT', direction: 'in' });

      const { statementId, reconId } = await captureAndStart({
        transactions: [
          { date: '2026-04-03', description: 'COFFEE BARN PURCHASE', amount: '50.00', type: 'debit' },
          { date: '2026-04-07', description: 'ACME PAYROLL DEPOSIT', amount: '200.00', type: 'credit' },
        ],
      });

      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.autoCleared).toBe(2);
      expect(result.suggestions.length).toBe(0);
      expect(result.unmatchedLines.length).toBe(0);
      expect(result.outstandingCount).toBe(0);

      // Worksheet lines really cleared, matched to the right journal lines.
      const worksheet = await worksheetOf(reconId);
      expect(worksheet.every((l) => l.is_cleared)).toBe(true);

      const lines = await statementLinesOf(statementId);
      expect(lines.every((l) => l.matchStatus === 'auto' && l.matchedJournalLineId != null)).toBe(true);
      const spendLine = lines.find((l) => parseFloat(l.amount) < 0)!;
      const spendJl = worksheet.find((w) => w.journal_line_id === spendLine.matchedJournalLineId)!;
      expect(parseFloat(spendJl.credit)).toBe(50); // money out ⇔ credit on the bank account
      const depositLine = lines.find((l) => parseFloat(l.amount) > 0)!;
      const depositJl = worksheet.find((w) => w.journal_line_id === depositLine.matchedJournalLineId)!;
      expect(parseFloat(depositJl.debit)).toBe(200); // money in ⇔ debit on the bank account

      // Score + breakdown persisted.
      expect(parseFloat(spendLine.matchScore!)).toBeGreaterThanOrEqual(0.9);
      const breakdown = spendLine.scoreBreakdown as { tier: string; candidates: Array<{ pool: string }> };
      expect(breakdown.tier).toBe('auto');
      expect(breakdown.candidates[0]!.pool).toBe('A');

      // One summary audit entry with the per-line breakdowns. after_data is
      // jsonb — the helper stores JSON.stringify output, so unwrap either shape.
      const audits = await db.select().from(auditLog).where(and(
        eq(auditLog.tenantId, tenantId),
        eq(auditLog.entityType, 'reconciliation'),
      ));
      const parsed = audits.map((a) => {
        let v: unknown = a.afterData;
        while (typeof v === 'string') v = JSON.parse(v);
        return v as { statementMatch?: { autoCleared: number; lines: unknown[] } };
      });
      const matchAudits = parsed.filter((p) => p.statementMatch);
      expect(matchAudits.length).toBe(1);
      expect(matchAudits[0]!.statementMatch!.autoCleared).toBe(2);
      expect(matchAudits[0]!.statementMatch!.lines.length).toBe(2);
    });

    it('re-runs skip already-resolved lines', async () => {
      await postBank({ date: '2026-04-03', amount: '50.00', memo: 'COFFEE BARN PURCHASE', direction: 'out' });
      const { reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-03', description: 'COFFEE BARN PURCHASE', amount: '50.00', type: 'debit' }],
      });
      const first = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(first.autoCleared).toBe(1);
      const second = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(second.autoCleared).toBe(0);
      expect(second.skippedLines).toBe(1);
    });
  });

  describe('matchStatement — amount precondition', () => {
    it('off by a cent is never pool A: suggest-only near match flagged with the delta', async () => {
      await postBank({ date: '2026-04-05', amount: '99.99', memo: 'OFFICE SUPPLIES STORE', direction: 'out' });
      const { statementId, reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-05', description: 'OFFICE SUPPLIES STORE', amount: '100.00', type: 'debit' }],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.autoCleared).toBe(0);
      expect(result.suggestions.length).toBe(1);
      const cand = result.suggestions[0]!.candidates[0]!;
      expect(cand.pool).toBe('B');
      expect(Math.abs(cand.amountDelta)).toBeCloseTo(0.01, 4);
      // Persisted as suggested, worksheet NOT cleared.
      const lines = await statementLinesOf(statementId);
      expect(lines[0]!.matchStatus).toBe('suggested');
      const worksheet = await worksheetOf(reconId);
      expect(worksheet.every((l) => !l.is_cleared)).toBe(true);
    });

    it('a >1% amount difference is not a candidate at all', async () => {
      await postBank({ date: '2026-04-05', amount: '90.00', memo: 'OFFICE SUPPLIES STORE', direction: 'out' });
      const { reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-05', description: 'OFFICE SUPPLIES STORE', amount: '100.00', type: 'debit' }],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.autoCleared).toBe(0);
      expect(result.suggestions.length).toBe(0);
      expect(result.unmatchedLines.length).toBe(1);
      expect(result.outstandingCount).toBe(1); // the $90 book entry is a timing item
    });
  });

  describe('matchStatement — ambiguity gate', () => {
    it('two exact-amount candidates are NEVER auto — suggest with both listed', async () => {
      await postBank({ date: '2026-04-10', amount: '25.00', memo: 'SUBSCRIPTION ALPHA', direction: 'out' });
      await postBank({ date: '2026-04-10', amount: '25.00', memo: 'SUBSCRIPTION BETA', direction: 'out' });
      const { statementId, reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-10', description: 'SUBSCRIPTION ALPHA', amount: '25.00', type: 'debit' }],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.autoCleared).toBe(0);
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0]!.candidates.length).toBe(2);
      const lines = await statementLinesOf(statementId);
      expect(lines[0]!.matchStatus).toBe('suggested');
      const worksheet = await worksheetOf(reconId);
      expect(worksheet.every((l) => !l.is_cleared)).toBe(true);
    });
  });

  describe('matchStatement — check numbers', () => {
    it('exact check number auto-clears even ~30 days out', async () => {
      const txn = await postBank({ date: '2026-03-28', amount: '500.00', memo: 'March rent', direction: 'out' });
      await db.update(transactions).set({ checkNumber: 1234, payeeNameOnCheck: 'Property LLC' })
        .where(eq(transactions.id, txn.id));
      const { statementId, reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-25', description: 'CHECK 1234', amount: '500.00', type: 'debit' }],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.autoCleared).toBe(1);
      const lines = await statementLinesOf(statementId);
      expect(lines[0]!.matchStatus).toBe('auto');
      const breakdown = lines[0]!.scoreBreakdown as { candidates: Array<{ checkExact: boolean }> };
      expect(breakdown.candidates[0]!.checkExact).toBe(true);
    });

    it('mismatched check numbers disqualify the candidate entirely', async () => {
      const txn = await postBank({ date: '2026-04-09', amount: '75.00', memo: 'CHECK 2222', direction: 'out' });
      await db.update(transactions).set({ checkNumber: 2222 }).where(eq(transactions.id, txn.id));
      const { reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-09', description: 'CHECK 1111', amount: '75.00', type: 'debit' }],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.autoCleared).toBe(0);
      expect(result.suggestions.length).toBe(0);
      expect(result.unmatchedLines.length).toBe(1);
    });
  });

  describe('matchStatement — reverse uniqueness', () => {
    it('two statement lines pointing at ONE journal line demote both to suggest', async () => {
      await postBank({ date: '2026-04-10', amount: '40.00', memo: 'DUPLICATE VENDOR PAYMENT', direction: 'out' });
      const { statementId, reconId } = await captureAndStart({
        transactions: [
          { date: '2026-04-10', description: 'DUPLICATE VENDOR PAYMENT', amount: '40.00', type: 'debit' },
          { date: '2026-04-11', description: 'DUPLICATE VENDOR PAYMENT', amount: '40.00', type: 'debit' },
        ],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.autoCleared).toBe(0);
      expect(result.suggestions.length).toBe(2);
      const lines = await statementLinesOf(statementId);
      expect(lines.every((l) => l.matchStatus === 'suggested')).toBe(true);
      const worksheet = await worksheetOf(reconId);
      expect(worksheet.every((l) => !l.is_cleared)).toBe(true);
    });
  });

  describe('matchStatement — id-linked feed items', () => {
    it('a stamped feed item with matchedTransactionId resolves AUTO without scoring', async () => {
      // Description scores ~0 on name, so the scored path alone would only
      // reach SUGGEST (0.55 + 0.25 + 0 = 0.80 < 0.90) — the id link is what
      // makes it AUTO.
      const { job } = await mkStatementJob({
        transactions: [{ date: '2026-04-12', description: 'ZZQX 9917 XKCD', amount: '61.75', type: 'debit' }],
      });
      const capture = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });
      const statementId = capture!.statement.id;
      const conn = await bankConnectionService.getOrCreateManualConnection(tenantId, bankAccountId, 'Statement Import');
      await bankFeedService.importStatementItems(tenantId, conn.id, [
        { date: '2026-04-12', description: 'ZZQX 9917 XKCD', amount: '61.75', type: 'debit' },
      ], [], statementId);
      const [item] = await db.select().from(bankFeedItems)
        .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.statementId, statementId)));
      await bankFeedService.categorize(tenantId, item!.id, { accountId: expenseAccountId });

      const recon = await reconciliation.start(tenantId, undefined, undefined, undefined, { statementId });
      const result = await statementMatch.matchStatement(tenantId, recon.id, { apply: true });
      expect(result.autoCleared).toBe(1);
      const lines = await statementLinesOf(statementId);
      expect(lines[0]!.matchStatus).toBe('auto');
      const breakdown = lines[0]!.scoreBreakdown as { candidates: Array<{ idLinked?: boolean }> };
      expect(breakdown.candidates[0]!.idLinked).toBe(true);
    });
  });

  describe('confirm / reject', () => {
    async function suggestedSetup() {
      await postBank({ date: '2026-04-10', amount: '25.00', memo: 'SUBSCRIPTION ALPHA', direction: 'out' });
      await postBank({ date: '2026-04-10', amount: '25.00', memo: 'SUBSCRIPTION BETA', direction: 'out' });
      const { statementId, reconId } = await captureAndStart({
        transactions: [
          { date: '2026-04-10', description: 'SUBSCRIPTION ALPHA', amount: '25.00', type: 'debit' },
          { date: '2026-04-11', description: 'SUBSCRIPTION BETA', amount: '25.00', type: 'debit' },
        ],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.suggestions.length).toBe(2);
      return { statementId, reconId, result };
    }

    it('confirm clears the chosen worksheet line and marks the statement line confirmed', async () => {
      const { statementId, reconId, result } = await suggestedSetup();
      const s = result.suggestions[0]!;
      const chosen = s.candidates[0]!;
      const line = await statementMatch.confirmStatementLine(tenantId, s.statementLine.id, chosen.journalLineId);
      expect(line.matchStatus).toBe('confirmed');
      const worksheet = await worksheetOf(reconId);
      expect(worksheet.find((w) => w.journal_line_id === chosen.journalLineId)!.is_cleared).toBe(true);
      const lines = await statementLinesOf(statementId);
      const confirmed = lines.find((l) => l.id === s.statementLine.id)!;
      expect(confirmed.matchStatus).toBe('confirmed');
      expect(confirmed.matchedJournalLineId).toBe(chosen.journalLineId);
    });

    it('enforces one statement line per journal line (409 on a second confirm)', async () => {
      const { result } = await suggestedSetup();
      const [s1, s2] = result.suggestions;
      const jl = s1!.candidates[0]!.journalLineId;
      await statementMatch.confirmStatementLine(tenantId, s1!.statementLine.id, jl);
      await expect(
        statementMatch.confirmStatementLine(tenantId, s2!.statementLine.id, jl),
      ).rejects.toThrow(/already matched/i);
    });

    it('rejects a worksheet line id that is not on the reconciliation', async () => {
      const { result } = await suggestedSetup();
      await expect(
        statementMatch.confirmStatementLine(tenantId, result.suggestions[0]!.statementLine.id, '00000000-0000-0000-0000-000000000009'),
      ).rejects.toThrow(/not on this reconciliation/i);
    });

    it('reject marks the line rejected, leaves the worksheet untouched, and re-runs skip it', async () => {
      const { statementId, reconId, result } = await suggestedSetup();
      const s = result.suggestions[0]!;
      const line = await statementMatch.rejectStatementLine(tenantId, s.statementLine.id);
      expect(line.matchStatus).toBe('rejected');
      const lines = await statementLinesOf(statementId);
      const rejected = lines.find((l) => l.id === s.statementLine.id)!;
      expect(rejected.matchStatus).toBe('rejected');
      expect(rejected.matchedJournalLineId).toBeNull();
      const worksheet = await worksheetOf(reconId);
      expect(worksheet.every((w) => !w.is_cleared)).toBe(true);
      // Re-run: rejected line is skipped, not resurrected.
      const rerun = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(rerun.skippedLines).toBe(1);
      const after = await statementLinesOf(statementId);
      expect(after.find((l) => l.id === s.statementLine.id)!.matchStatus).toBe('rejected');
    });
  });

  describe('un-clearing resets the statement line', () => {
    it('updateLines(isCleared=false) flips an auto-matched line back to unmatched', async () => {
      await postBank({ date: '2026-04-03', amount: '50.00', memo: 'COFFEE BARN PURCHASE', direction: 'out' });
      const { statementId, reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-03', description: 'COFFEE BARN PURCHASE', amount: '50.00', type: 'debit' }],
      });
      await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      let lines = await statementLinesOf(statementId);
      expect(lines[0]!.matchStatus).toBe('auto');
      const jlId = lines[0]!.matchedJournalLineId!;

      await reconciliation.updateLines(tenantId, reconId, [{ journalLineId: jlId, isCleared: false }]);
      lines = await statementLinesOf(statementId);
      expect(lines[0]!.matchStatus).toBe('unmatched');
      expect(lines[0]!.matchedJournalLineId).toBeNull();
      const worksheet = await worksheetOf(reconId);
      expect(worksheet.find((w) => w.journal_line_id === jlId)!.is_cleared).toBe(false);
    });
  });

  describe('getStatementMatches (persisted view)', () => {
    it('returns counts, suggestions with candidates, unmatched lines and the outstanding count after reload', async () => {
      await postBank({ date: '2026-04-03', amount: '50.00', memo: 'COFFEE BARN PURCHASE', direction: 'out' });
      await postBank({ date: '2026-04-05', amount: '99.99', memo: 'OFFICE SUPPLIES STORE', direction: 'out' });
      await postBank({ date: '2026-04-20', amount: '300.00', memo: 'OUTSTANDING CHECK NEVER CLEARED', direction: 'out' });
      const { reconId } = await captureAndStart({
        transactions: [
          { date: '2026-04-03', description: 'COFFEE BARN PURCHASE', amount: '50.00', type: 'debit' },
          { date: '2026-04-05', description: 'OFFICE SUPPLIES STORE', amount: '100.00', type: 'debit' },
          { date: '2026-04-08', description: 'MYSTERY FEE ON STATEMENT', amount: '5.00', type: 'debit' },
        ],
      });
      await statementMatch.matchStatement(tenantId, reconId, { apply: true });

      const view = await statementMatch.getStatementMatches(tenantId, reconId);
      expect(view.counts.auto).toBe(1);
      expect(view.counts.suggested).toBe(1);
      expect(view.counts.unmatched).toBe(1);
      expect(view.suggestions.length).toBe(1);
      expect(view.suggestions[0]!.candidates.length).toBeGreaterThan(0);
      expect(view.unmatchedLines.length).toBe(1);
      expect(view.unmatchedLines[0]!.description).toBe('MYSTERY FEE ON STATEMENT');
      // The $300 book check is in the books but not on the statement; the
      // $99.99 book entry is accounted for by the suggestion.
      expect(view.outstandingCount).toBe(1);
    });
  });

  describe('reconcile_only import', () => {
    it('creates the statement + lines and ZERO feed items', async () => {
      const { job } = await mkStatementJob({
        transactions: [
          { date: '2026-04-03', description: 'RECONLY SPEND', amount: '10.00', type: 'debit' },
          { date: '2026-04-04', description: 'RECONLY DEPOSIT', amount: '20.00', type: 'credit' },
        ],
      });
      const result = await bankStatementsService.importReconcileOnly(tenantId, { jobId: job.id, accountId: bankAccountId });
      expect(result.lineCount).toBe(2);
      const stmts = await db.select().from(bankStatements).where(eq(bankStatements.tenantId, tenantId));
      expect(stmts.length).toBe(1);
      expect(stmts[0]!.id).toBe(result.statementId);
      const lines = await statementLinesOf(result.statementId);
      expect(lines.length).toBe(2);
      const items = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
      expect(items.length).toBe(0);
      // Idempotent: a second call reuses the statement and its lines.
      const again = await bankStatementsService.importReconcileOnly(tenantId, { jobId: job.id, accountId: bankAccountId });
      expect(again.statementId).toBe(result.statementId);
      expect(again.lineCount).toBe(2);
    });

    it('fails cleanly when the parse lacks the fields a statement record needs', async () => {
      const [job] = await db.insert(aiJobs).values({
        tenantId,
        jobType: 'ocr_statement',
        status: 'complete',
        inputType: 'attachment',
        outputData: { transactions: [], statementPeriod: null, closingBalance: null },
      }).returning();
      await expect(
        bankStatementsService.importReconcileOnly(tenantId, { jobId: job!.id, accountId: bankAccountId }),
      ).rejects.toThrow(/could not be created/i);
    });
  });

  describe('backfillStatementLines', () => {
    it('populates lines for statements captured before 0116 and is idempotent', async () => {
      const { job } = await mkStatementJob({
        transactions: [{ date: '2026-04-03', description: 'BACKFILL ROW', amount: '10.00', type: 'debit' }],
      });
      const capture = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });
      // Simulate a pre-0116 statement: strip its lines.
      await db.delete(bankStatementLines).where(eq(bankStatementLines.statementId, capture!.statement.id));

      const first = await bankStatementsService.backfillStatementLines(tenantId);
      expect(first.statementsPopulated).toBe(1);
      expect(first.linesCreated).toBe(1);
      expect((await statementLinesOf(capture!.statement.id)).length).toBe(1);

      const second = await bankStatementsService.backfillStatementLines(tenantId);
      expect(second.statementsPopulated).toBe(0);
      expect(second.linesCreated).toBe(0);
      expect((await statementLinesOf(capture!.statement.id)).length).toBe(1);
    });
  });
});
