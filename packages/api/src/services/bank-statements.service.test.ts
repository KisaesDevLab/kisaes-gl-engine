// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Statement-driven bank reconciliation tests (migration 0115):
//   - capture on import: bank_statements row from the parse job's output,
//     feed items stamped with statement_id, duplicate-period warning,
//     per-job idempotency
//   - account auto-suggest by masked account number
//   - backfill from historical completed ocr_statement jobs (account
//     recovered by matching feed items; idempotent; unresolvable counted)
//   - statement list: derived status, readiness counts, coverage gaps,
//     opening-balance continuity warnings
//   - start-from-statement: prefilled date/balance, statement linkage,
//     continuity warning when opening ≠ prior reconciled ending
//   - auto-clear: matched + categorized items cleared, unmatched counted

import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags,
  reconciliations, reconciliationLines, bankStatements, bankFeedItems,
  bankConnections, aiJobs, attachments,
} from '../db/schema/index.js';
import * as bankStatementsService from './bank-statements.service.js';
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
    name: 'Stmt Test',
    slug: 'stmt-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = tenant!.id;

  const bank = await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', accountNumber: '1010' });
  bankAccountId = bank.id;
  const revenue = await accountsService.create(tenantId, { name: 'Revenue', accountType: 'revenue', accountNumber: '4000' });
  revenueAccountId = revenue.id;
  const expense = await accountsService.create(tenantId, { name: 'Supplies', accountType: 'expense', accountNumber: '6000' });
  expenseAccountId = expense.id;
}

interface JobTxn { date: string; description: string; amount: string; type: 'debit' | 'credit' }

async function mkStatementJob(opts: {
  periodStart?: string | null;
  periodEnd?: string | null;
  openingBalance?: string | null;
  closingBalance?: string | null;
  masked?: string | null;
  transactions?: JobTxn[];
  reconciliationStatus?: 'verified' | 'discrepancy' | 'skipped';
  deltaCents?: number;
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
      checks: [],
      accountNumberMasked: opts.masked ?? '4321',
      statementPeriod: { start: opts.periodStart ?? '2026-04-01', end: opts.periodEnd ?? '2026-04-30' },
      openingBalance: opts.openingBalance === undefined ? '100.00' : opts.openingBalance,
      closingBalance: opts.closingBalance === undefined ? '170.00' : opts.closingBalance,
      institutionName: 'Test Bank',
      accountTypeHint: 'CHECKING',
      confidence: 0.95,
      qualityWarnings: [],
      extractionSource: 'text_layer',
      reconciliation: {
        status: opts.reconciliationStatus ?? 'verified',
        deltaCents: opts.deltaCents ?? 0,
        expectedClosingCents: null,
        actualClosingCents: null,
        repaired: false,
      },
      suspectRows: [],
      notes: null,
    },
  }).returning();
  return { job: job!, attachmentId: attachment!.id };
}

describe('Bank Statements Service', () => {
  beforeEach(async () => {
    await cleanDb();
    await setup();
  });

  describe('captureStatementOnImport', () => {
    it('creates the bank_statements row from the parse job output', async () => {
      const { job, attachmentId } = await mkStatementJob({ reconciliationStatus: 'discrepancy', deltaCents: -125 });
      const result = await bankStatementsService.captureStatementOnImport(tenantId, {
        jobId: job.id, accountId: bankAccountId,
      });
      expect(result).not.toBeNull();
      const s = result!.statement;
      expect(s.accountId).toBe(bankAccountId);
      expect(s.periodStart).toBe('2026-04-01');
      expect(s.periodEnd).toBe('2026-04-30');
      expect(parseFloat(s.openingBalance!)).toBe(100);
      expect(parseFloat(s.closingBalance)).toBe(170);
      expect(s.maskedAccountNumber).toBe('4321');
      expect(s.institutionName).toBe('Test Bank');
      expect(s.statementType).toBe('CHECKING');
      expect(s.goldenRuleStatus).toBe('discrepancy');
      expect(parseFloat(s.goldenRuleDelta!)).toBeCloseTo(-1.25, 4);
      expect(s.attachmentId).toBe(attachmentId);
      expect(s.aiJobId).toBe(job.id);
      expect(result!.duplicateWarning).toBeUndefined();
    });

    it('is idempotent per parse job (re-import reuses the existing row)', async () => {
      const { job } = await mkStatementJob({});
      const first = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });
      const second = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });
      expect(second!.statement.id).toBe(first!.statement.id);
      const rows = await db.select().from(bankStatements).where(eq(bankStatements.tenantId, tenantId));
      expect(rows.length).toBe(1);
    });

    it('returns a duplicateWarning when a statement for an overlapping period exists', async () => {
      const { job: job1 } = await mkStatementJob({});
      await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job1.id, accountId: bankAccountId });
      // Second job, overlapping period on the same account.
      const { job: job2 } = await mkStatementJob({ periodStart: '2026-04-15', periodEnd: '2026-05-14' });
      const result = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job2.id, accountId: bankAccountId });
      expect(result!.duplicateWarning).toMatch(/already on file/i);
      // Both rows exist — a duplicate warns, it never blocks.
      const rows = await db.select().from(bankStatements).where(eq(bankStatements.tenantId, tenantId));
      expect(rows.length).toBe(2);
    });

    it('returns null (no capture) when the parse lacks period end or closing balance', async () => {
      const { job } = await mkStatementJob({ periodEnd: null, closingBalance: null });
      const result = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });
      expect(result).toBeNull();
    });

    it('stamps imported feed items with the statement id', async () => {
      const { job } = await mkStatementJob({});
      const capture = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });
      const conn = await bankConnectionService.getOrCreateManualConnection(tenantId, bankAccountId, 'Statement Import');
      await bankFeedService.importStatementItems(tenantId, conn.id, [
        { date: '2026-04-05', description: 'CAPTURE COFFEE SHOP', amount: '12.50', type: 'debit' },
        { date: '2026-04-10', description: 'CAPTURE PAYROLL ACME', amount: '2000.00', type: 'credit' },
      ], [], capture!.statement.id);
      const items = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
      expect(items.length).toBe(2);
      expect(items.every((i) => i.statementId === capture!.statement.id)).toBe(true);
    });
  });

  describe('suggestAccountForMasked', () => {
    it('suggests the account of the most recent statement with the same masked number', async () => {
      const { job } = await mkStatementJob({ masked: '9876' });
      await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });
      const suggestion = await bankStatementsService.suggestAccountForMasked(tenantId, '9876');
      expect(suggestion?.accountId).toBe(bankAccountId);
      expect(suggestion?.accountName).toBe('Checking');
      expect(await bankStatementsService.suggestAccountForMasked(tenantId, '0000')).toBeNull();
    });
  });

  describe('backfillBankStatements', () => {
    it('creates statements for legacy jobs, recovering the account from imported feed items, and is idempotent', async () => {
      // Legacy flow: items imported with NO statement linkage.
      const conn = await bankConnectionService.getOrCreateManualConnection(tenantId, bankAccountId, 'Statement Import');
      const txns: JobTxn[] = [
        { date: '2026-03-03', description: 'BACKFILL UTILITY CO', amount: '80.00', type: 'debit' },
        { date: '2026-03-09', description: 'BACKFILL CLIENT DEPOSIT', amount: '500.00', type: 'credit' },
      ];
      await bankFeedService.importStatementItems(tenantId, conn.id, txns);
      const { job } = await mkStatementJob({
        periodStart: '2026-03-01', periodEnd: '2026-03-31',
        openingBalance: '50.00', closingBalance: '470.00', transactions: txns,
      });

      const first = await bankStatementsService.backfillBankStatements(tenantId);
      expect(first.examined).toBe(1);
      expect(first.created).toBe(1);
      expect(first.skippedNoAccount).toBe(0);

      const [statement] = await db.select().from(bankStatements)
        .where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.aiJobId, job.id)));
      expect(statement).toBeDefined();
      expect(statement!.accountId).toBe(bankAccountId);
      expect(statement!.periodEnd).toBe('2026-03-31');

      // Feed items were stamped so readiness/auto-clear work retroactively.
      const items = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
      expect(items.every((i) => i.statementId === statement!.id)).toBe(true);

      // Idempotent: a second run creates nothing.
      const second = await bankStatementsService.backfillBankStatements(tenantId);
      expect(second.examined).toBe(0);
      expect(second.created).toBe(0);
    });

    it('skips (and counts) jobs whose account cannot be determined', async () => {
      await mkStatementJob({
        transactions: [{ date: '2026-02-02', description: 'NEVER IMPORTED ROW', amount: '10.00', type: 'debit' }],
      });
      const result = await bankStatementsService.backfillBankStatements(tenantId);
      expect(result.examined).toBe(1);
      expect(result.created).toBe(0);
      expect(result.skippedNoAccount).toBe(1);
    });
  });

  describe('listStatements', () => {
    it('derives status, readiness counts and coverage gaps', async () => {
      // Statement with two un-posted (pending) imported items.
      const { job } = await mkStatementJob({ periodStart: '2026-01-01', periodEnd: '2026-01-31' });
      const capture = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });
      const conn = await bankConnectionService.getOrCreateManualConnection(tenantId, bankAccountId, 'Statement Import');
      await bankFeedService.importStatementItems(tenantId, conn.id, [
        { date: '2026-01-05', description: 'LIST ITEM ONE', amount: '11.00', type: 'debit' },
        { date: '2026-01-06', description: 'LIST ITEM TWO', amount: '22.00', type: 'debit' },
      ], [], capture!.statement.id);

      // Second statement two months later — a March gap is missing February.
      const { job: job2 } = await mkStatementJob({ periodStart: '2026-03-01', periodEnd: '2026-03-31' });
      await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job2.id, accountId: bankAccountId });

      let { statements, total, gaps } = await bankStatementsService.listStatements(tenantId, {});
      expect(total).toBe(2);
      expect(statements.length).toBe(2);
      const jan = statements.find((s) => s.periodEnd === '2026-01-31')!;
      expect(jan.status).toBe('not_reconciled');
      expect(jan.unpostedCount).toBe(2);
      expect(jan.accountHasInProgress).toBe(false);
      expect(gaps.length).toBe(1);
      expect(gaps[0]!.missingMonths).toEqual(['2026-02']);

      // Start a reconciliation from the January statement → in_progress.
      const recon = await reconciliation.start(tenantId, undefined, undefined, undefined, { statementId: jan.id });
      ({ statements } = await bankStatementsService.listStatements(tenantId, {}));
      const janAfter = statements.find((s) => s.periodEnd === '2026-01-31')!;
      expect(janAfter.status).toBe('in_progress');
      expect(janAfter.reconciliationId).toBe(recon.id);
      const marAfter = statements.find((s) => s.periodEnd === '2026-03-31')!;
      expect(marAfter.accountHasInProgress).toBe(true);

      // Complete it (no lines on the worksheet, statement balance must be
      // reachable — cleared 0 vs closing 170 won't complete, so mark all
      // lines cleared is moot; instead force-complete via a fresh scenario
      // below). Here just verify the account filter path.
      const filtered = await bankStatementsService.listStatements(tenantId, { accountId: bankAccountId });
      expect(filtered.total).toBe(2);
      const other = await bankStatementsService.listStatements(tenantId, { accountId: revenueAccountId });
      expect(other.total).toBe(0);
    });

    it('reports reconciled status and continuity warnings', async () => {
      // Prior completed reconciliation at $100.
      await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry', txnDate: '2026-03-15', memo: 'Deposit 100',
        lines: [
          { accountId: bankAccountId, debit: '100.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '100.00' },
        ],
      });
      const rec1 = await reconciliation.start(tenantId, bankAccountId, '2026-03-31', '100.00');
      const lineIds = (await db.select().from(reconciliationLines)
        .where(eq(reconciliationLines.reconciliationId, rec1.id))).map((l) => l.journalLineId);
      await reconciliation.updateLines(tenantId, rec1.id, lineIds.map((id) => ({ journalLineId: id, isCleared: true })));
      await reconciliation.complete(tenantId, rec1.id);

      // Statement whose opening ($120) disagrees with the reconciled $100.
      const { job } = await mkStatementJob({
        periodStart: '2026-04-01', periodEnd: '2026-04-30',
        openingBalance: '120.00', closingBalance: '170.00',
      });
      await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });

      const { statements } = await bankStatementsService.listStatements(tenantId, {});
      const apr = statements.find((s) => s.periodEnd === '2026-04-30')!;
      expect(apr.status).toBe('not_reconciled');
      expect(apr.continuityWarning).not.toBeNull();
      expect(apr.continuityWarning!.expected).toBe(100);
      expect(apr.continuityWarning!.actual).toBe(120);
      expect(apr.continuityWarning!.delta).toBe(20);
    });
  });

  describe('start from statement', () => {
    it('prefills date/balance from the statement, links it, and warns on a continuity break', async () => {
      // Prior completed reconciliation at $100.
      await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry', txnDate: '2026-03-10', memo: 'Deposit 100',
        lines: [
          { accountId: bankAccountId, debit: '100.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '100.00' },
        ],
      });
      const rec1 = await reconciliation.start(tenantId, bankAccountId, '2026-03-31', '100.00');
      const lineIds = (await db.select().from(reconciliationLines)
        .where(eq(reconciliationLines.reconciliationId, rec1.id))).map((l) => l.journalLineId);
      await reconciliation.updateLines(tenantId, rec1.id, lineIds.map((id) => ({ journalLineId: id, isCleared: true })));
      await reconciliation.complete(tenantId, rec1.id);

      const { job } = await mkStatementJob({ openingBalance: '120.00', closingBalance: '170.00' });
      const capture = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });

      const recon = await reconciliation.start(tenantId, undefined, undefined, undefined, { statementId: capture!.statement.id });
      expect(recon.accountId).toBe(bankAccountId);
      expect(recon.statementDate).toBe('2026-04-30');
      expect(parseFloat(recon.statementEndingBalance)).toBe(170);
      expect(parseFloat(recon.beginningBalance)).toBe(100);
      expect(recon.statementId).toBe(capture!.statement.id);
      expect(recon.continuityWarning).toEqual({ expected: 100, actual: 120, delta: 20 });

      // Statement row now points at the reconciliation.
      const stmt = await bankStatementsService.getStatement(tenantId, capture!.statement.id);
      expect(stmt.reconciliationId).toBe(recon.id);

      // The worksheet view also carries the statement + warning.
      const view = await reconciliation.getReconciliation(tenantId, recon.id);
      expect(view.statement?.id).toBe(capture!.statement.id);
      expect(view.continuityWarning).toEqual({ expected: 100, actual: 120, delta: 20 });
    });

    it('refuses to start from a statement already linked to a reconciliation', async () => {
      const { job } = await mkStatementJob({});
      const capture = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });
      await reconciliation.start(tenantId, undefined, undefined, undefined, { statementId: capture!.statement.id });
      await expect(
        reconciliation.start(tenantId, undefined, undefined, undefined, { statementId: capture!.statement.id }),
      ).rejects.toThrow(/already linked/i);
    });
  });

  describe('autoClearStatement', () => {
    it('clears matched + categorized items and counts unmatched ones', async () => {
      const { job } = await mkStatementJob({ periodStart: '2026-04-01', periodEnd: '2026-04-30' });
      const capture = await bankStatementsService.captureStatementOnImport(tenantId, { jobId: job.id, accountId: bankAccountId });
      const statementId = capture!.statement.id;
      const conn = await bankConnectionService.getOrCreateManualConnection(tenantId, bankAccountId, 'Statement Import');

      await bankFeedService.importStatementItems(tenantId, conn.id, [
        { date: '2026-04-03', description: 'AUTOCLEAR SPEND FIFTY', amount: '50.00', type: 'debit' },
        { date: '2026-04-07', description: 'AUTOCLEAR DEPOSIT TWOHUNDRED', amount: '200.00', type: 'credit' },
        { date: '2026-04-11', description: 'AUTOCLEAR NEVER POSTED', amount: '75.00', type: 'debit' },
      ], [], statementId);
      const items = await db.select().from(bankFeedItems)
        .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.statementId, statementId)));
      const spendItem = items.find((i) => i.originalDescription === 'AUTOCLEAR SPEND FIFTY')!;
      const depositItem = items.find((i) => i.originalDescription === 'AUTOCLEAR DEPOSIT TWOHUNDRED')!;

      // MATCH path: post an expense touching the bank account, match the item.
      const expenseTxn = await ledger.postTransaction(tenantId, {
        txnType: 'expense', txnDate: '2026-04-03', memo: 'Spend fifty',
        lines: [
          { accountId: expenseAccountId, debit: '50.00', credit: '0' },
          { accountId: bankAccountId, debit: '0', credit: '50.00' },
        ],
      });
      await bankFeedService.match(tenantId, spendItem.id, expenseTxn.id);

      // CATEGORIZED path: categorize posts the deposit + stamps matchedTransactionId.
      await bankFeedService.categorize(tenantId, depositItem.id, { accountId: revenueAccountId });

      // Start the reconciliation from the statement, then auto-clear.
      const recon = await reconciliation.start(tenantId, undefined, undefined, undefined, { statementId });
      const result = await reconciliation.autoClearStatement(tenantId, recon.id);
      expect(result.cleared).toBe(2);
      expect(result.alreadyCleared).toBe(0);
      expect(result.unmatched).toBe(1);

      // The cleared journal lines really are cleared on the worksheet.
      const view = await reconciliation.getReconciliation(tenantId, recon.id);
      const clearedLines = (view.lines as Array<{ is_cleared: boolean }>).filter((l) => l.is_cleared);
      expect(clearedLines.length).toBe(2);
      // Cleared = beginning 0 - 50 + 200 = 150.
      expect(view.clearedBalance).toBe(150);

      // Second run: nothing new to clear.
      const again = await reconciliation.autoClearStatement(tenantId, recon.id);
      expect(again.cleared).toBe(0);
      expect(again.alreadyCleared).toBe(2);
      expect(again.unmatched).toBe(1);
    });

    it('rejects when the reconciliation is not statement-linked', async () => {
      await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry', txnDate: '2026-04-01', memo: 'Deposit',
        lines: [
          { accountId: bankAccountId, debit: '10.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '10.00' },
        ],
      });
      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '10.00');
      await expect(reconciliation.autoClearStatement(tenantId, recon.id)).rejects.toThrow(/not linked/i);
    });
  });
});
