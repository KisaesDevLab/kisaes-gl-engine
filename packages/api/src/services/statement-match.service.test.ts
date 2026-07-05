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
  accountTypeHint?: string;
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
      accountTypeHint: opts.accountTypeHint ?? 'CHECKING',
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
async function captureAndStart(opts: Parameters<typeof mkStatementJob>[0] & { accountId?: string }) {
  const { job } = await mkStatementJob(opts);
  const capture = await bankStatementsService.captureStatementOnImport(
    tenantId, { jobId: job.id, accountId: opts.accountId ?? bankAccountId },
  );
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

  // ─── Wave 2: grouped matches ─────────────────────────────────────

  describe('wave 2 — A1: one statement line ↔ many worksheet lines', () => {
    it('suggests (never auto-clears) an exact-sum set of 3 receipts for one deposit', async () => {
      await postBank({ date: '2026-04-05', amount: '10.00', memo: 'RECEIPT ALPHA', direction: 'in' });
      await postBank({ date: '2026-04-06', amount: '20.00', memo: 'RECEIPT BRAVO', direction: 'in' });
      await postBank({ date: '2026-04-07', amount: '30.00', memo: 'RECEIPT CHARLIE', direction: 'in' });
      const { statementId, reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-07', description: 'BRANCH DEPOSIT', amount: '60.00', type: 'credit' }],
      });

      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.autoCleared).toBe(0);
      expect(result.suggestions.length).toBe(1);
      const s = result.suggestions[0]!;
      expect(s.candidates.length).toBe(0);
      expect(s.groupCandidates?.length).toBe(1);
      const g = s.groupCandidates![0]!;
      expect(g.kind).toBe('one_to_many');
      expect(g.journalLines.length).toBe(3);
      expect(parseFloat(g.sum)).toBe(60);
      expect(g.dateSpanDays).toBe(2);
      // Every member is accounted for by the suggestion — no outstanding.
      expect(result.outstandingCount).toBe(0);

      // SUGGEST-only: worksheet untouched; persisted as 'suggested' with a
      // NULL matched_journal_line_id (set only on confirm).
      const worksheet = await worksheetOf(reconId);
      expect(worksheet.every((l) => !l.is_cleared)).toBe(true);
      const lines = await statementLinesOf(statementId);
      expect(lines[0]!.matchStatus).toBe('suggested');
      expect(lines[0]!.matchedJournalLineId).toBeNull();
      const breakdown = lines[0]!.scoreBreakdown as { groupCandidates: Array<{ kind: string; journalLines: unknown[] }> };
      expect(breakdown.groupCandidates.length).toBe(1);
      expect(breakdown.groupCandidates[0]!.journalLines.length).toBe(3);

      // Persisted view (reload) carries the group.
      const view = await statementMatch.getStatementMatches(tenantId, reconId);
      expect(view.suggestions.length).toBe(1);
      expect(view.suggestions[0]!.groupCandidates?.length).toBe(1);
      expect(view.outstandingCount).toBe(0);
    });

    it('a set off by a cent is NOT suggested — exact sum only', async () => {
      await postBank({ date: '2026-04-05', amount: '10.00', memo: 'RECEIPT ALPHA', direction: 'in' });
      await postBank({ date: '2026-04-06', amount: '20.00', memo: 'RECEIPT BRAVO', direction: 'in' });
      await postBank({ date: '2026-04-07', amount: '30.00', memo: 'RECEIPT CHARLIE', direction: 'in' });
      const { reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-07', description: 'BRANCH DEPOSIT', amount: '60.01', type: 'credit' }],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.suggestions.length).toBe(0);
      expect(result.unmatchedLines.length).toBe(1);
    });

    it('two distinct minimal sets → both returned for the picker (up to 3), never auto', async () => {
      await postBank({ date: '2026-04-05', amount: '10.00', memo: 'PAY TEN', direction: 'out' });
      await postBank({ date: '2026-04-06', amount: '20.00', memo: 'PAY TWENTY', direction: 'out' });
      await postBank({ date: '2026-04-07', amount: '30.00', memo: 'PAY THIRTY', direction: 'out' });
      await postBank({ date: '2026-04-08', amount: '40.00', memo: 'PAY FORTY', direction: 'out' });
      const { reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-08', description: 'COMBINED CHARGE', amount: '50.00', type: 'debit' }],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.autoCleared).toBe(0);
      expect(result.suggestions.length).toBe(1);
      const sets = result.suggestions[0]!.groupCandidates!;
      expect(sets.length).toBe(2);
      expect(sets.length).toBeLessThanOrEqual(3);
      for (const g of sets) {
        expect(g.journalLines.length).toBe(2);
        expect(parseFloat(g.sum)).toBe(-50);
      }
      const worksheet = await worksheetOf(reconId);
      expect(worksheet.every((l) => !l.is_cleared)).toBe(true);
    });

    it('subset size is capped at 5 members — six $10 lines never sum a $60 deposit', async () => {
      for (let i = 0; i < 6; i++) {
        await postBank({ date: '2026-04-05', amount: '10.00', memo: `RECEIPT ${i}`, direction: 'in' });
      }
      const { reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-06', description: 'BRANCH DEPOSIT', amount: '60.00', type: 'credit' }],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.suggestions.length).toBe(0);
      expect(result.unmatchedLines.length).toBe(1);
    });
  });

  describe('wave 2 — subset-sum bounds (pure helpers)', () => {
    const mkWsRow = (id: string, date: string, amount: string, dir: 'in' | 'out') => ({
      rec_line_id: `rl-${id}`,
      journal_line_id: id,
      is_cleared: false,
      debit: dir === 'in' ? amount : '0',
      credit: dir === 'in' ? '0' : amount,
      line_description: null,
      transaction_id: `t-${id}`,
      txn_date: date,
      txn_type: 'journal_entry',
      txn_number: null,
      memo: null,
      check_number: null,
      payee_name_on_check: null,
      contact_name: null,
    });

    const isoDaysBefore = (iso: string, days: number): string => {
      const d = new Date(iso + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - days);
      return d.toISOString().slice(0, 10);
    };

    it('buildGroupPool caps the pool at the 40 nearest-dated candidates', () => {
      // 45 candidates inside the 30-day window (3 per day over 15 days) —
      // only the 40 nearest-dated survive the cap.
      const rows = [];
      let n = 0;
      for (let day = 1; day <= 15; day++) {
        for (let k = 0; k < 3; k++) {
          n += 1;
          rows.push(mkWsRow(`jl-${String(n).padStart(2, '0')}`, isoDaysBefore('2026-04-30', day), '1.00', 'in'));
        }
      }
      const pool = statementMatch._internal.buildGroupPool(
        { amount: '100.0000', lineDate: '2026-04-30' },
        rows,
        new Set<string>(),
      );
      expect(pool.length).toBe(40);
      // Nearest-dated first: the farthest-dated candidates are dropped.
      expect(pool[0]!.absDays).toBe(1);
      expect(Math.max(...pool.map((p) => p.absDays))).toBe(14);

      // Beyond the [−30, +3] group window nothing qualifies at all.
      const far = [mkWsRow('jl-far', isoDaysBefore('2026-04-30', 45), '1.00', 'in')];
      expect(statementMatch._internal.buildGroupPool(
        { amount: '100.0000', lineDate: '2026-04-30' }, far, new Set<string>(),
      ).length).toBe(0);
    });

    it('findExactSumSets honors maxSets and the member date-span constraint', () => {
      const item = (id: string, cents: number, date: string) => ({ id, cents, date, absDays: 0 });
      // Many distinct pairs summing 100 — capped at maxSets.
      const pool = [
        item('a', 40, '2026-04-01'), item('b', 60, '2026-04-02'),
        item('c', 30, '2026-04-03'), item('d', 70, '2026-04-04'),
        item('e', 20, '2026-04-05'), item('f', 80, '2026-04-06'),
        item('g', 10, '2026-04-07'), item('h', 90, '2026-04-08'),
      ];
      const capped = statementMatch._internal.findExactSumSets(100, pool, {
        minSize: 2, maxSize: 5, maxSets: 3, maxExpansions: 10_000, minimalOnly: true,
      });
      expect(capped.length).toBe(3);
      for (const set of capped) expect(set.length).toBe(2);

      // Span constraint: a pair dated 20 days apart is rejected at 7 days.
      const spanPool = [item('x', 40, '2026-04-01'), item('y', 60, '2026-04-21')];
      const spanned = statementMatch._internal.findExactSumSets(100, spanPool, {
        minSize: 2, maxSize: 5, maxSets: 3, maxExpansions: 10_000, minimalOnly: false, maxSpanDays: 7,
      });
      expect(spanned.length).toBe(0);
    });
  });

  describe('wave 2 — A2: many statement lines ↔ one worksheet line', () => {
    it('exactly one set → suggestion attached to the first member, others referenced (not double-listed)', async () => {
      // Books recorded one monthly total; the bank shows 4 individual charges.
      await postBank({ date: '2026-04-05', amount: '100.00', memo: 'MONTHLY SAAS TOTAL', direction: 'out' });
      const { statementId, reconId } = await captureAndStart({
        transactions: [
          { date: '2026-04-05', description: 'SAAS CHARGE 1', amount: '25.00', type: 'debit' },
          { date: '2026-04-06', description: 'SAAS CHARGE 2', amount: '25.00', type: 'debit' },
          { date: '2026-04-07', description: 'SAAS CHARGE 3', amount: '25.00', type: 'debit' },
          { date: '2026-04-08', description: 'SAAS CHARGE 4', amount: '25.00', type: 'debit' },
        ],
      });

      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.autoCleared).toBe(0);
      expect(result.skippedAmbiguousGroups).toBe(0);
      expect(result.suggestions.length).toBe(1);
      const s = result.suggestions[0]!;
      // Attached to the FIRST (earliest-dated) statement line.
      expect(s.statementLine.description).toBe('SAAS CHARGE 1');
      const g = s.groupCandidates![0]!;
      expect(g.kind).toBe('many_to_one');
      expect(g.journalLines.length).toBe(1);
      expect(g.memberStatementLines.length).toBe(4);
      expect(parseFloat(g.sum)).toBe(-100);
      // Members are referenced through the suggestion, not double-listed.
      expect(result.unmatchedLines.length).toBe(0);
      expect(result.outstandingCount).toBe(0);

      // Persisted view mirrors that.
      const view = await statementMatch.getStatementMatches(tenantId, reconId);
      expect(view.suggestions.length).toBe(1);
      expect(view.suggestions[0]!.groupCandidates?.[0]?.kind).toBe('many_to_one');
      expect(view.unmatchedLines.length).toBe(0);
      expect(view.counts.suggested).toBe(1);
      expect(view.counts.unmatched).toBe(3); // members stay 'unmatched' in the DB
      const lines = await statementLinesOf(statementId);
      const primary = lines.find((l) => l.description === 'SAAS CHARGE 1')!;
      expect(primary.matchStatus).toBe('suggested');
      expect(primary.matchedJournalLineId).toBeNull();
    });

    it('two possible sets → skipped and counted, nothing suggested', async () => {
      await postBank({ date: '2026-04-05', amount: '50.00', memo: 'COMBINED TOTAL', direction: 'out' });
      const { reconId } = await captureAndStart({
        transactions: [
          { date: '2026-04-05', description: 'PART A', amount: '20.00', type: 'debit' },
          { date: '2026-04-06', description: 'PART B', amount: '20.00', type: 'debit' },
          { date: '2026-04-07', description: 'PART C', amount: '30.00', type: 'debit' },
        ],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.suggestions.length).toBe(0);
      expect(result.skippedAmbiguousGroups).toBe(1);
      expect(result.unmatchedLines.length).toBe(3);
    });
  });

  describe('wave 2 — grouped confirm', () => {
    async function a1Setup() {
      await postBank({ date: '2026-04-05', amount: '10.00', memo: 'RECEIPT ALPHA', direction: 'in' });
      await postBank({ date: '2026-04-06', amount: '20.00', memo: 'RECEIPT BRAVO', direction: 'in' });
      await postBank({ date: '2026-04-07', amount: '30.00', memo: 'RECEIPT CHARLIE', direction: 'in' });
      const { statementId, reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-07', description: 'BRANCH DEPOSIT', amount: '60.00', type: 'credit' }],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      const s = result.suggestions[0]!;
      const jlIds = s.groupCandidates![0]!.journalLines.map((j) => j.journalLineId);
      return { statementId, reconId, statementLineId: s.statementLine.id, jlIds };
    }

    it('confirming a set clears ALL members and records the full group', async () => {
      const { statementId, reconId, statementLineId, jlIds } = await a1Setup();
      const line = await statementMatch.confirmStatementLineGroup(tenantId, statementLineId, jlIds);
      expect(line.matchStatus).toBe('confirmed');

      const worksheet = await worksheetOf(reconId);
      for (const jl of jlIds) {
        expect(worksheet.find((w) => w.journal_line_id === jl)!.is_cleared).toBe(true);
      }
      const lines = await statementLinesOf(statementId);
      expect(lines[0]!.matchStatus).toBe('confirmed');
      expect(lines[0]!.matchedJournalLineId).toBe(jlIds[0]); // primary = first
      const breakdown = lines[0]!.scoreBreakdown as { group: { kind: string; journalLineIds: string[] } };
      expect(breakdown.group.kind).toBe('one_to_many');
      expect(breakdown.group.journalLineIds).toEqual(jlIds);
    });

    it('409 when the set does not sum exactly to the cent', async () => {
      const { statementLineId, jlIds } = await a1Setup();
      await expect(
        statementMatch.confirmStatementLineGroup(tenantId, statementLineId, jlIds.slice(0, 2)),
      ).rejects.toThrow(/sum exactly/i);
    });

    it('409 when a member journal line is already claimed by another statement line', async () => {
      // Two statement lines: the $60 deposit and a $20 line that could claim
      // RECEIPT BRAVO singly. No engine run — drive the confirms directly.
      await postBank({ date: '2026-04-05', amount: '10.00', memo: 'RECEIPT ALPHA', direction: 'in' });
      await postBank({ date: '2026-04-06', amount: '20.00', memo: 'RECEIPT BRAVO', direction: 'in' });
      await postBank({ date: '2026-04-07', amount: '30.00', memo: 'RECEIPT CHARLIE', direction: 'in' });
      const { statementId, reconId } = await captureAndStart({
        transactions: [
          { date: '2026-04-07', description: 'BRANCH DEPOSIT', amount: '60.00', type: 'credit' },
          { date: '2026-04-06', description: 'LONE DEPOSIT', amount: '20.00', type: 'credit' },
        ],
      });
      const worksheet = await worksheetOf(reconId);
      const jlOf = (amount: number) => worksheet.find((w) => parseFloat(w.debit) === amount)!.journal_line_id;
      const lines = await statementLinesOf(statementId);
      const line60 = lines.find((l) => parseFloat(l.amount) === 60)!;
      const line20 = lines.find((l) => parseFloat(l.amount) === 20)!;

      // Group-confirm the $60 set, then try to single-confirm a member.
      await statementMatch.confirmStatementLineGroup(tenantId, line60.id, [jlOf(10), jlOf(20), jlOf(30)]);
      await expect(
        statementMatch.confirmStatementLine(tenantId, line20.id, jlOf(20)),
      ).rejects.toThrow(/already matched/i);
    });

    it('un-clearing ANY group member resets the statement line', async () => {
      const { statementId, reconId, statementLineId, jlIds } = await a1Setup();
      await statementMatch.confirmStatementLineGroup(tenantId, statementLineId, jlIds);

      // Un-clear the SECOND member (not the primary matched_journal_line_id).
      await reconciliation.updateLines(tenantId, reconId, [{ journalLineId: jlIds[1]!, isCleared: false }]);
      const lines = await statementLinesOf(statementId);
      expect(lines[0]!.matchStatus).toBe('unmatched');
      expect(lines[0]!.matchedJournalLineId).toBeNull();
    });

    it('many-to-one confirm clears the one worksheet line, marks ALL members confirmed, and un-clearing resets them all', async () => {
      await postBank({ date: '2026-04-05', amount: '100.00', memo: 'MONTHLY SAAS TOTAL', direction: 'out' });
      const { statementId, reconId } = await captureAndStart({
        transactions: [
          { date: '2026-04-05', description: 'SAAS CHARGE 1', amount: '25.00', type: 'debit' },
          { date: '2026-04-06', description: 'SAAS CHARGE 2', amount: '25.00', type: 'debit' },
          { date: '2026-04-07', description: 'SAAS CHARGE 3', amount: '25.00', type: 'debit' },
          { date: '2026-04-08', description: 'SAAS CHARGE 4', amount: '25.00', type: 'debit' },
        ],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      const s = result.suggestions[0]!;
      const g = s.groupCandidates![0]!;
      const jlId = g.journalLines[0]!.journalLineId;
      const memberIds = g.memberStatementLines.filter((m) => m.id !== s.statementLine.id).map((m) => m.id);

      const line = await statementMatch.confirmStatementLineManyToOne(tenantId, s.statementLine.id, jlId, memberIds);
      expect(line.matchStatus).toBe('confirmed');
      const worksheet = await worksheetOf(reconId);
      expect(worksheet.find((w) => w.journal_line_id === jlId)!.is_cleared).toBe(true);
      let lines = await statementLinesOf(statementId);
      expect(lines.every((l) => l.matchStatus === 'confirmed')).toBe(true);
      const primary = lines.find((l) => l.id === s.statementLine.id)!;
      expect(primary.matchedJournalLineId).toBe(jlId);
      for (const m of lines.filter((l) => l.id !== s.statementLine.id)) {
        expect(m.matchedJournalLineId).toBeNull();
        const bd = m.scoreBreakdown as { group: { kind: string; primaryStatementLineId: string } };
        expect(bd.group.kind).toBe('many_to_one_member');
        expect(bd.group.primaryStatementLineId).toBe(s.statementLine.id);
      }

      // Un-clearing the one worksheet line resets primary AND members.
      await reconciliation.updateLines(tenantId, reconId, [{ journalLineId: jlId, isCleared: false }]);
      lines = await statementLinesOf(statementId);
      expect(lines.every((l) => l.matchStatus === 'unmatched' && l.matchedJournalLineId == null)).toBe(true);
    });

    it('many-to-one confirm 409s when the sum is off by a cent', async () => {
      await postBank({ date: '2026-04-05', amount: '100.00', memo: 'MONTHLY SAAS TOTAL', direction: 'out' });
      const { statementId, reconId } = await captureAndStart({
        transactions: [
          { date: '2026-04-05', description: 'SAAS CHARGE 1', amount: '25.00', type: 'debit' },
          { date: '2026-04-06', description: 'SAAS CHARGE 2', amount: '25.00', type: 'debit' },
          { date: '2026-04-07', description: 'SAAS CHARGE 3', amount: '25.00', type: 'debit' },
        ],
      });
      // 3 × $25 = $75 ≠ $100 — must 409.
      const lines = await statementLinesOf(statementId);
      const [first, ...rest] = lines;
      const worksheet = await worksheetOf(reconId);
      const jlId = worksheet[0]!.journal_line_id;
      await expect(
        statementMatch.confirmStatementLineManyToOne(tenantId, first!.id, jlId, rest.map((l) => l.id)),
      ).rejects.toThrow(/sum exactly/i);
    });
  });

  // ─── Wave 2 Feature B: create transaction from a statement line ──

  describe('wave 2 — create transaction from a statement line (Add to books)', () => {
    it('posts a balanced expense via the ledger, carries check/payee, clears it mid-session, confirms the line', async () => {
      const { statementId, reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-09', description: 'CHECK 0042', amount: '42.50', type: 'debit' }],
        checks: [{ checkNumber: '0042', payee: 'Window Cleaning Co', amount: '42.50' }],
      });
      const [line] = await statementLinesOf(statementId);

      const res = await statementMatch.createTransactionFromStatementLine(
        tenantId, line!.id, { accountId: expenseAccountId, memo: 'Window cleaning' },
      );
      expect(res.line.matchStatus).toBe('confirmed');

      // Balanced double-entry through the standard posting path.
      const jls = await db.select().from(journalLines)
        .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, res.transactionId)));
      expect(jls.length).toBe(2);
      const bankLeg = jls.find((l) => l.accountId === bankAccountId)!;
      const expenseLeg = jls.find((l) => l.accountId === expenseAccountId)!;
      expect(parseFloat(bankLeg.credit)).toBe(42.5);
      expect(parseFloat(bankLeg.debit)).toBe(0);
      expect(parseFloat(expenseLeg.debit)).toBe(42.5);

      const [txn] = await db.select().from(transactions).where(eq(transactions.id, res.transactionId));
      expect(txn!.txnType).toBe('expense');
      expect(txn!.txnDate).toBe('2026-04-09');
      expect(txn!.checkNumber).toBe(42);
      expect(txn!.payeeNameOnCheck).toBe('Window Cleaning Co');
      expect(txn!.source).toBe('statement_line');
      expect(txn!.memo).toBe('Window cleaning');

      // The new bank journal line appears CLEARED on the in-progress
      // worksheet (reconciliation_line inserted mid-session).
      const worksheet = await worksheetOf(reconId);
      const wsRow = worksheet.find((w) => w.journal_line_id === bankLeg.id);
      expect(wsRow?.is_cleared).toBe(true);

      // Statement line confirmed against the new bank journal line.
      const lines = await statementLinesOf(statementId);
      expect(lines[0]!.matchStatus).toBe('confirmed');
      expect(lines[0]!.matchedJournalLineId).toBe(bankLeg.id);

      // The wave-1 un-clear hook covers created lines too.
      await reconciliation.updateLines(tenantId, reconId, [{ journalLineId: bankLeg.id, isCleared: false }]);
      expect((await statementLinesOf(statementId))[0]!.matchStatus).toBe('unmatched');
    });

    it('posts a deposit for money-in lines', async () => {
      const { statementId } = await captureAndStart({
        transactions: [{ date: '2026-04-10', description: 'STRIPE PAYOUT', amount: '150.00', type: 'credit' }],
      });
      const [line] = await statementLinesOf(statementId);
      const res = await statementMatch.createTransactionFromStatementLine(
        tenantId, line!.id, { accountId: revenueAccountId },
      );
      const [txn] = await db.select().from(transactions).where(eq(transactions.id, res.transactionId));
      expect(txn!.txnType).toBe('deposit');
      const jls = await db.select().from(journalLines)
        .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, res.transactionId)));
      const bankLeg = jls.find((l) => l.accountId === bankAccountId)!;
      expect(parseFloat(bankLeg.debit)).toBe(150);
    });

    it('surfaces the ledger lock-date rejection and leaves the statement line untouched', async () => {
      await db.insert(companies).values({ tenantId, businessName: 'Lock Co', lockDate: '2026-12-31' });
      const { statementId } = await captureAndStart({
        transactions: [{ date: '2026-04-09', description: 'LOCKED SPEND', amount: '10.00', type: 'debit' }],
      });
      const [line] = await statementLinesOf(statementId);
      await expect(
        statementMatch.createTransactionFromStatementLine(tenantId, line!.id, { accountId: expenseAccountId }),
      ).rejects.toThrow(/lock date/i);
      const lines = await statementLinesOf(statementId);
      expect(lines[0]!.matchStatus).toBe('unmatched');
      expect(lines[0]!.matchedJournalLineId).toBeNull();
    });

    it('refuses an already-matched line and the bank account itself as the category', async () => {
      await postBank({ date: '2026-04-03', amount: '50.00', memo: 'COFFEE BARN PURCHASE', direction: 'out' });
      const { statementId, reconId } = await captureAndStart({
        transactions: [
          { date: '2026-04-03', description: 'COFFEE BARN PURCHASE', amount: '50.00', type: 'debit' },
          { date: '2026-04-04', description: 'MYSTERY FEE', amount: '5.00', type: 'debit' },
        ],
      });
      await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      const lines = await statementLinesOf(statementId);
      const matched = lines.find((l) => l.matchStatus === 'auto')!;
      const unmatched = lines.find((l) => l.matchStatus === 'unmatched')!;
      await expect(
        statementMatch.createTransactionFromStatementLine(tenantId, matched.id, { accountId: expenseAccountId }),
      ).rejects.toThrow(/already matched/i);
      await expect(
        statementMatch.createTransactionFromStatementLine(tenantId, unmatched.id, { accountId: bankAccountId }),
      ).rejects.toThrow(/not the bank account/i);
    });
  });

  // ─── QA hardening regressions ─────────────────────────────────────

  describe('credit-card (liability) statements end-to-end', () => {
    // Card statements print balances positive-owed; the books are
    // credit-normal. Charges must match card-credit journal lines, payments
    // card-debit lines, the one-click start must flip the printed balances
    // into GL orientation so the reconciliation can tie out, and continuity
    // must not false-alarm across periods.
    async function setupCard() {
      const card = await accountsService.create(tenantId, { name: 'Visa', accountType: 'liability', accountNumber: '2100' });
      // Charge $50 on the card (expense debit / card credit).
      await ledger.postTransaction(tenantId, {
        txnType: 'expense', txnDate: '2026-04-03', memo: 'CLOUD HOSTING CHARGE',
        lines: [
          { accountId: expenseAccountId, debit: '50.00', credit: '0' },
          { accountId: card.id, debit: '0', credit: '50.00' },
        ],
      });
      // Pay $30 to the card from checking (card debit / bank credit).
      await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry', txnDate: '2026-04-20', memo: 'PAYMENT THANK YOU',
        lines: [
          { accountId: card.id, debit: '30.00', credit: '0' },
          { accountId: bankAccountId, debit: '0', credit: '30.00' },
        ],
      });
      return card;
    }

    it('one-click start flips printed balances to GL orientation, the engine matches both directions, and the rec completes', async () => {
      const card = await setupCard();
      const { statementId, reconId } = await captureAndStart({
        accountId: card.id,
        accountTypeHint: 'CREDITCARD',
        openingBalance: '0.00',
        closingBalance: '20.00', // printed: $20 owed (50 charged − 30 paid)
        transactions: [
          // Parser-normalized feed convention: charge (spend) = debit,
          // payment (money in) = credit — mapSignedCentsToFeed already
          // inverted the raw credit-card signs at extraction time.
          { date: '2026-04-03', description: 'CLOUD HOSTING CHARGE', amount: '50.00', type: 'debit' },
          { date: '2026-04-20', description: 'PAYMENT THANK YOU', amount: '30.00', type: 'credit' },
        ],
      });

      // Statement-driven start stores the GL-oriented ending balance.
      const recon = await reconciliation.getReconciliation(tenantId, reconId);
      expect(parseFloat(String(recon.statementEndingBalance))).toBe(-20);
      expect(recon.continuityWarning).toBeNull(); // no prior rec — nothing to disagree with

      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.autoCleared).toBe(2);
      const lines = await statementLinesOf(statementId);
      const worksheet = await worksheetOf(reconId);
      const charge = lines.find((l) => parseFloat(l.amount) === -50)!;
      const chargeJl = worksheet.find((w) => w.journal_line_id === charge.matchedJournalLineId)!;
      expect(parseFloat(chargeJl.credit)).toBe(50); // spend = CREDIT on the card account
      const payment = lines.find((l) => parseFloat(l.amount) === 30)!;
      const paymentJl = worksheet.find((w) => w.journal_line_id === payment.matchedJournalLineId)!;
      expect(parseFloat(paymentJl.debit)).toBe(30); // payment = DEBIT on the card account

      // Cleared −50 + 30 = −20 == GL-oriented ending balance ⇒ completes.
      await reconciliation.complete(tenantId, reconId);
      const done = await reconciliation.getReconciliation(tenantId, reconId);
      expect(done.status).toBe('complete');
    });

    it('continuity across card periods compares in GL orientation (no false warning; real breaks still warn)', async () => {
      const card = await setupCard();
      const { reconId } = await captureAndStart({
        accountId: card.id,
        accountTypeHint: 'CREDITCARD',
        openingBalance: '0.00',
        closingBalance: '20.00',
        transactions: [
          { date: '2026-04-03', description: 'CLOUD HOSTING CHARGE', amount: '50.00', type: 'debit' },
          { date: '2026-04-20', description: 'PAYMENT THANK YOU', amount: '30.00', type: 'credit' },
        ],
      });
      await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      await reconciliation.complete(tenantId, reconId);

      // May: printed opening $20 owed — chains cleanly off the completed
      // April rec (ending −20 in GL orientation). Before the orientation
      // fix this false-alarmed with a delta of 2× the balance.
      const { job } = await mkStatementJob({
        periodStart: '2026-05-01', periodEnd: '2026-05-31',
        accountTypeHint: 'CREDITCARD',
        openingBalance: '20.00', closingBalance: '20.00',
        transactions: [{ date: '2026-05-05', description: 'NO ACTIVITY MARKER', amount: '1.00', type: 'debit' }],
      });
      const capture = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: card.id });
      const list = await bankStatementsService.listStatements(tenantId, { accountId: card.id });
      const mayRow = list.statements.find((s) => s.id === capture!.statement.id)!;
      expect(mayRow.continuityWarning).toBeNull();

      const started = await reconciliation.start(tenantId, undefined, undefined, undefined, { statementId: capture!.statement.id });
      expect(started.continuityWarning).toBeNull();
      expect(parseFloat(String(started.statementEndingBalance))).toBe(-20);

      // A REAL break (printed opening $25 ≠ $20 owed) still warns, with the
      // delta computed in GL orientation.
      const { job: badJob } = await mkStatementJob({
        periodStart: '2026-06-01', periodEnd: '2026-06-30',
        accountTypeHint: 'CREDITCARD',
        openingBalance: '25.00', closingBalance: '25.00',
        transactions: [{ date: '2026-06-05', description: 'MARKER', amount: '1.00', type: 'debit' }],
      });
      const badCapture = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: badJob.id, accountId: card.id });
      const list2 = await bankStatementsService.listStatements(tenantId, { accountId: card.id });
      const juneRow = list2.statements.find((s) => s.id === badCapture!.statement.id)!;
      expect(juneRow.continuityWarning).not.toBeNull();
      expect(juneRow.continuityWarning!.delta).toBeCloseTo(-5, 2); // −25 actual vs −20 expected
    });
  });

  describe('un-clear reset scoping (updateLines)', () => {
    it('does NOT reset another reconciliation\'s statement line when its journal line id is passed to a different rec', async () => {
      // Rec 1 on the checking account with an auto-matched line.
      await postBank({ date: '2026-04-03', amount: '50.00', memo: 'COFFEE BARN PURCHASE', direction: 'out' });
      const { statementId: stmt1, reconId: rec1 } = await captureAndStart({
        transactions: [{ date: '2026-04-03', description: 'COFFEE BARN PURCHASE', amount: '50.00', type: 'debit' }],
      });
      await statementMatch.matchStatement(tenantId, rec1, { apply: true });
      const [line1] = await statementLinesOf(stmt1);
      expect(line1!.matchStatus).toBe('auto');
      const claimedJl = line1!.matchedJournalLineId!;

      // Rec 2 on a DIFFERENT account, in progress at the same time.
      const savings = await accountsService.create(tenantId, { name: 'Savings', accountType: 'asset', accountNumber: '1020' });
      const { reconId: rec2 } = await captureAndStart({
        accountId: savings.id,
        transactions: [{ date: '2026-04-10', description: 'INTEREST', amount: '1.00', type: 'credit' }],
      });

      // A request against rec 2 naming rec 1's journal line must not touch
      // rec 1's statement line (the reconciliation_lines update itself
      // no-ops — the line isn't on rec 2's worksheet).
      await reconciliation.updateLines(tenantId, rec2, [{ journalLineId: claimedJl, isCleared: false }]);
      const [after] = await statementLinesOf(stmt1);
      expect(after!.matchStatus).toBe('auto');
      expect(after!.matchedJournalLineId).toBe(claimedJl);
      const ws1 = await worksheetOf(rec1);
      expect(ws1.find((w) => w.journal_line_id === claimedJl)!.is_cleared).toBe(true);

      // The legitimate un-clear on rec 1 still resets it — and clears the
      // stale score/breakdown with the status.
      await reconciliation.updateLines(tenantId, rec1, [{ journalLineId: claimedJl, isCleared: false }]);
      const [reset] = await statementLinesOf(stmt1);
      expect(reset!.matchStatus).toBe('unmatched');
      expect(reset!.matchedJournalLineId).toBeNull();
      expect(reset!.matchScore).toBeNull();
      expect(reset!.scoreBreakdown).toBeNull();
    });
  });

  describe('completed-reconciliation guards + undo reset', () => {
    // Books: $100 deposit (auto single) + $10/$20 receipts (confirmed A1
    // group vs a $30 statement deposit). Cleared 130 == closing 130.
    async function completeWithMixedMatches() {
      await postBank({ date: '2026-04-05', amount: '100.00', memo: 'BIG DEPOSIT', direction: 'in' });
      await postBank({ date: '2026-04-06', amount: '10.00', memo: 'RECEIPT ALPHA', direction: 'in' });
      await postBank({ date: '2026-04-07', amount: '20.00', memo: 'RECEIPT BRAVO', direction: 'in' });
      const { statementId, reconId } = await captureAndStart({
        closingBalance: '130.00',
        transactions: [
          { date: '2026-04-05', description: 'BIG DEPOSIT', amount: '100.00', type: 'credit' },
          { date: '2026-04-07', description: 'BRANCH DEPOSIT', amount: '30.00', type: 'credit' },
          { date: '2026-04-08', description: 'MYSTERY FEE', amount: '5.00', type: 'debit' },
        ],
      });
      const result = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(result.autoCleared).toBe(1);
      const grouped = result.suggestions.find((s) => s.groupCandidates?.length)!;
      await statementMatch.confirmStatementLineGroup(
        tenantId, grouped.statementLine.id,
        grouped.groupCandidates![0]!.journalLines.map((j) => j.journalLineId),
      );
      await reconciliation.complete(tenantId, reconId);
      return { statementId, reconId };
    }

    it('reject, create-transaction and match-statement are all blocked on a completed reconciliation', async () => {
      const { statementId, reconId } = await completeWithMixedMatches();
      const lines = await statementLinesOf(statementId);
      const unmatched = lines.find((l) => l.matchStatus === 'unmatched')!;

      await expect(statementMatch.rejectStatementLine(tenantId, unmatched.id))
        .rejects.toThrow(/already complete/i);
      await expect(
        statementMatch.createTransactionFromStatementLine(tenantId, unmatched.id, { accountId: expenseAccountId }),
      ).rejects.toThrow(/already complete/i);
      await expect(statementMatch.matchStatement(tenantId, reconId, { apply: true }))
        .rejects.toThrow(/already complete/i);
      await expect(statementMatch.confirmStatementLine(tenantId, unmatched.id, '00000000-0000-0000-0000-000000000009'))
        .rejects.toThrow(/already complete/i);
    });

    it('undo resets every auto/confirmed statement line — including group primaries — and clears score/breakdown', async () => {
      const { statementId, reconId } = await completeWithMixedMatches();
      await reconciliation.undo(tenantId, reconId);

      const lines = await statementLinesOf(statementId);
      for (const l of lines.filter((x) => x.description !== 'MYSTERY FEE')) {
        expect(l.matchStatus).toBe('unmatched');
        expect(l.matchedJournalLineId).toBeNull();
        expect(l.matchScore).toBeNull();
        expect(l.scoreBreakdown).toBeNull();
      }
      const worksheet = await worksheetOf(reconId);
      expect(worksheet.every((w) => !w.is_cleared)).toBe(true);

      // A fresh run over the undone rec re-matches from scratch.
      const rerun = await statementMatch.matchStatement(tenantId, reconId, { apply: true });
      expect(rerun.autoCleared).toBe(1);
      expect(rerun.skippedLines).toBe(0);
    });
  });

  describe('statement lines dated outside the period (parser noise)', () => {
    it('create-transaction refuses a line dated after the statement date', async () => {
      const { statementId } = await captureAndStart({
        periodEnd: '2026-04-30',
        transactions: [
          { date: '2026-05-15', description: 'NOISE FUTURE ROW', amount: '10.00', type: 'debit' },
        ],
      });
      const [line] = await statementLinesOf(statementId);
      await expect(
        statementMatch.createTransactionFromStatementLine(tenantId, line!.id, { accountId: expenseAccountId }),
      ).rejects.toThrow(/after the statement date/i);
      expect((await statementLinesOf(statementId))[0]!.matchStatus).toBe('unmatched');
    });
  });

  describe('tenant isolation', () => {
    it('another tenant\'s ids 404 on match, confirm, reject, create and the persisted view', async () => {
      await postBank({ date: '2026-04-03', amount: '50.00', memo: 'COFFEE BARN PURCHASE', direction: 'out' });
      const { statementId, reconId } = await captureAndStart({
        transactions: [{ date: '2026-04-03', description: 'COFFEE BARN PURCHASE', amount: '50.00', type: 'debit' }],
      });
      const [line] = await statementLinesOf(statementId);
      const worksheet = await worksheetOf(reconId);
      const jlId = worksheet[0]!.journal_line_id;

      const [intruder] = await db.insert(tenants).values({
        name: 'Intruder', slug: 'intruder-' + Date.now(),
      }).returning();
      const otherTenant = intruder!.id;

      await expect(statementMatch.matchStatement(otherTenant, reconId, { apply: true }))
        .rejects.toThrow(/not found/i);
      await expect(statementMatch.getStatementMatches(otherTenant, reconId))
        .rejects.toThrow(/not found/i);
      await expect(statementMatch.confirmStatementLine(otherTenant, line!.id, jlId))
        .rejects.toThrow(/not found/i);
      await expect(statementMatch.rejectStatementLine(otherTenant, line!.id))
        .rejects.toThrow(/not found/i);
      await expect(statementMatch.createTransactionFromStatementLine(otherTenant, line!.id, { accountId: expenseAccountId }))
        .rejects.toThrow(/not found/i);
      await expect(reconciliation.updateLines(otherTenant, reconId, [{ journalLineId: jlId, isCleared: false }]))
        .rejects.toThrow(/not found/i);

      // Nothing changed for the real tenant.
      expect((await statementLinesOf(statementId))[0]!.matchStatus).toBe('unmatched');
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
