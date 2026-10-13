// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Professional bank reconciliation proof (statement → adjusted bank balance →
// balance per books → unreconciled difference; schedules with aged-item flags;
// subsequent activity; book-side discrepancy proof). Seeds a bank account with
// a prior + current reconciliation, deposits in transit, outstanding checks,
// activity after the statement date, a previously-reconciled transaction
// changed after the fact, a credit-card account, a statement-driven in-progress
// reconciliation with an unrecorded bank fee, and multi-line / transfer
// entries — then checks the figures and the rendered Section A order.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, accounts, companies, auditLog, transactions, journalLines,
  reconciliations, reconciliationLines, bankStatements, bankStatementLines,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as reconciliation from './reconciliation.service.js';
import { buildReconciliationProof } from './reconciliation-proof.service.js';
import { renderProofHtml, proofCsvRows } from './reconciliation-proof-render.js';
import { buildReconciliationDetail, buildBankReconciliationSummary } from './report.service.js';

let tenantId = '';
let bankId = '';
let savingsId = '';
let cardId = '';
let revenueId = '';
let expenseId = '';

async function wipe() {
  if (!tenantId) return;
  await db.delete(bankStatementLines).where(eq(bankStatementLines.tenantId, tenantId));
  await db.delete(bankStatements).where(eq(bankStatements.tenantId, tenantId));
  await db.delete(reconciliationLines).where(inArray(
    reconciliationLines.reconciliationId,
    db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tenantId)),
  ));
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function setup() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [t] = await db.insert(tenants).values({ name: 'Rec Proof', slug: `rec-proof-${stamp}` }).returning();
  tenantId = t!.id;
  await db.insert(companies).values({ tenantId, businessName: 'Rec Proof Co' });
  const mk = async (name: string, accountType: string, detailType: string | null, accountNumber: string) => {
    const [a] = await db.insert(accounts).values({ tenantId, name, accountType, detailType, accountNumber }).returning();
    return a!.id;
  };
  bankId = await mk('Operating Checking', 'asset', 'bank', '1010');
  savingsId = await mk('Savings', 'asset', 'bank', '1020');
  cardId = await mk('Visa Card', 'liability', 'credit_card', '2100');
  revenueId = await mk('Sales', 'revenue', null, '4000');
  expenseId = await mk('Supplies', 'expense', null, '6000');
}

async function post(date: string, lines: Array<{ accountId: string; debit?: string; credit?: string }>, memo: string, checkNumber?: number) {
  const txn = await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry', txnDate: date, memo,
    lines: lines.map((l) => ({ accountId: l.accountId, debit: l.debit ?? '0', credit: l.credit ?? '0' })),
  });
  if (checkNumber != null) {
    await db.update(transactions).set({ checkNumber })
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txn.id)));
  }
  return txn.id;
}
const deposit = (date: string, amt: string, memo = `Deposit ${amt}`) =>
  post(date, [{ accountId: bankId, debit: amt }, { accountId: revenueId, credit: amt }], memo);
const check = (date: string, amt: string, no: number) =>
  post(date, [{ accountId: expenseId, debit: amt }, { accountId: bankId, credit: amt }], `Check ${no}`, no);

async function lineOf(txnId: string, accountId: string) {
  const rows = await db.select().from(journalLines)
    .where(and(eq(journalLines.transactionId, txnId), eq(journalLines.accountId, accountId)));
  return rows[0]!;
}
async function clear(recId: string, txnIds: string[], accountId = bankId) {
  const ids = [];
  for (const t of txnIds) ids.push((await lineOf(t, accountId)).id);
  await reconciliation.updateLines(tenantId, recId, ids.map((journalLineId) => ({ journalLineId, isCleared: true })));
}

// Two months on Operating Checking. January: opening deposit 1,000, check
// #101 for 200 cleared; check #102 for 50 and two old checks stay out.
// February: deposit 300 cleared; deposits 40 (Feb 10) and 125 (Feb 25) in
// transit. After Feb 28: check #103 for 60 (Mar 5) and a post-dated deposit.
interface Seed { janRec: string; febRec: string; chk101: string; janDeposit: string }
async function seedBank(): Promise<Seed> {
  const janDeposit = await deposit('2026-01-05', '1000.00', 'Opening deposit');
  const chk101 = await check('2026-01-10', '200.00', 101);
  await check('2026-01-20', '50.00', 102);
  await check('2025-08-01', '75.00', 90); // 211 days old at Feb 28 → stale-dated
  await check('2025-11-01', '30.00', 95); // 119 days → stale
  const jan = await reconciliation.start(tenantId, bankId, '2026-01-31', '800.00');
  await clear(jan.id, [janDeposit, chk101]);
  await reconciliation.complete(tenantId, jan.id);

  const febDep = await deposit('2026-02-03', '300.00');
  await deposit('2026-02-10', '40.00'); // 18 days in transit → investigate
  await deposit('2026-02-25', '125.00'); // 3 days → fine
  await check('2026-03-05', '60.00', 103); // after D
  await deposit('2026-04-01', '10.00'); // post-dated (after "today")
  const feb = await reconciliation.start(tenantId, bankId, '2026-02-28', '1100.00');
  await clear(feb.id, [febDep]);
  await reconciliation.complete(tenantId, feb.id);
  return { janRec: jan.id, febRec: feb.id, chk101, janDeposit };
}

const TODAY = '2026-03-10';

describe('buildReconciliationProof', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await wipe(); });

  it('ties a bank reconciliation to the books (Section A, roll, schedules, subsequent, proof)', async () => {
    const s = await seedBank();
    const p = await buildReconciliationProof(tenantId, s.febRec, { today: TODAY });

    expect(p.orientation).toBe('asset');
    // Section A
    expect(p.summary.statementBalance).toBe(1100);
    expect(p.summary.increases).toEqual({ count: 2, total: 165 });
    expect(p.summary.decreases).toEqual({ count: 3, total: 155 });
    expect(p.summary.adjustedStatementBalance).toBe(1110);
    expect(p.summary.bookBalance).toBe(1110);
    expect(p.summary.unrecorded).toBeNull(); // completed rec: not applicable
    expect(p.summary.adjustedBookBalance).toBe(1110);
    expect(p.summary.unreconciledDifference).toBe(0);
    expect(p.summary.reconciledToBooks).toBe(true);
    expect(p.summary.explanations).toEqual([]);

    // Cleared roll
    expect(p.clearedRoll).toEqual({
      beginningBalance: 800,
      clearedIncreases: { count: 1, total: 300 },
      clearedDecreases: { count: 0, total: 0 },
      clearedBalance: 1100,
      statementBalance: 1100,
      difference: 0,
    });

    // Schedules oldest-first, with flags at the thresholds.
    const dit = p.schedules.increases.items;
    expect(dit.map((i) => [i.txnDate, i.amount, i.ageDays, i.flag])).toEqual([
      ['2026-02-10', 40, 18, 'investigate'],
      ['2026-02-25', 125, 3, null],
    ]);
    const oc = p.schedules.decreases.items;
    expect(oc.map((i) => [i.number, i.amount, i.ageDays, i.flag])).toEqual([
      ['90', 75, 211, 'stale_dated'],
      ['95', 30, 119, 'stale'],
      ['102', 50, 39, null],
    ]);
    expect(oc[0]!.flagLabel).toContain('review / void / escheat');
    expect(p.flagCounts).toEqual({ stale: 1, staleDated: 1, investigate: 1 });

    // Subsequent activity: check #103 (−60) through today, +10 post-dated.
    expect(p.subsequent.afterStatement).toEqual({ count: 1, total: -60 });
    expect(p.subsequent.unclearedAfterStatement).toEqual({ count: 1, total: -60 });
    expect(p.subsequent.registerBalanceToday).toBe(1050);
    expect(p.subsequent.futureDated).toEqual({ count: 1, total: 10 });
    expect(p.subsequent.endingRegisterBalance).toBe(1060);

    // Book-side proof ties.
    expect(p.bookProof).toMatchObject({
      beginningBalance: 800, clearedThisReconciliation: 300, outstandingNet: 10,
      expectedBookBalance: 1110, bookBalance: 1110, discrepancy: 0, ties: true,
    });
    expect(p.bookProof.items).toEqual([]);
    expect(p.signOff.reviewedBy).toBeNull();
  });

  it('a prior reconciliation stays historically correct: items cleared later are outstanding at its date', async () => {
    const s = await seedBank();
    const p = await buildReconciliationProof(tenantId, s.janRec, { today: TODAY });
    // At Jan 31 the books held 1000 − 200 − 50 − 75 − 30 = 645; statement 800.
    expect(p.summary.bookBalance).toBe(645);
    expect(p.summary.decreases).toEqual({ count: 3, total: 155 });
    expect(p.summary.adjustedStatementBalance).toBe(645);
    expect(p.summary.reconciledToBooks).toBe(true);
    expect(p.bookProof.ties).toBe(true);
    // Feb activity is "after D" for January.
    expect(p.subsequent.afterStatement.count).toBe(4); // Feb 3, Feb 10, Feb 25, Mar 5
    expect(p.subsequent.futureDated.count).toBe(1); // Apr 1 (after "today")
  });

  it('detects a previously reconciled transaction changed after its reconciliation (discrepancy)', async () => {
    const s = await seedBank();
    // Simulate an edit that bypassed the reconciled-line guard: check #101
    // goes from 200 to 210 after January was completed, with an audit row.
    const l = await lineOf(s.chk101, bankId);
    await db.update(journalLines).set({ credit: '210.0000' }).where(eq(journalLines.id, l.id));
    const e = await lineOf(s.chk101, expenseId);
    await db.update(journalLines).set({ debit: '210.0000' }).where(eq(journalLines.id, e.id));
    await db.insert(auditLog).values({
      tenantId, action: 'update', entityType: 'transaction', entityId: s.chk101,
      beforeData: { total: '200' }, afterData: { total: '210' }, createdAt: new Date(Date.now() + 60_000),
    });

    const p = await buildReconciliationProof(tenantId, s.febRec, { today: TODAY });
    expect(p.summary.bookBalance).toBe(1100);
    expect(p.summary.adjustedStatementBalance).toBe(1110);
    expect(p.summary.unreconciledDifference).toBe(10);
    expect(p.summary.reconciledToBooks).toBe(false);
    expect(p.summary.explanations.join(' ')).toContain('Reconciliation discrepancies');

    expect(p.bookProof.ties).toBe(false);
    expect(p.bookProof.discrepancy).toBe(-10);
    expect(p.bookProof.components.changesToPriorReconciled).toBe(-10);
    expect(p.bookProof.components.beginningBalanceVariance).toBe(0);
    expect(p.bookProof.priorChanges).toEqual([
      { reconciliationId: s.janRec, statementDate: '2026-01-31', clearedAtCompletion: 800, clearedNow: 790, change: -10 },
    ]);
    expect(p.bookProof.items).toHaveLength(1);
    expect(p.bookProof.items[0]).toMatchObject({
      reconciliationId: s.janRec, transactionId: s.chk101, number: '101', currentAmount: -210,
      reasons: ['edited_after_reconciliation'], thisReconciliation: false,
    });
    expect(p.bookProof.explanations[0]).toContain('changed, voided or deleted');
  });

  it('detects a reconciled item re-dated after the statement date and a deleted reconciled line', async () => {
    const s = await seedBank();
    await db.update(transactions).set({ txnDate: '2026-03-02' }).where(eq(transactions.id, s.chk101));
    let p = await buildReconciliationProof(tenantId, s.febRec, { today: TODAY });
    expect(p.summary.bookBalance).toBe(1310);
    expect(p.bookProof.discrepancy).toBe(200);
    expect(p.bookProof.components.priorReconciledNowAfterStatement).toBe(200);
    expect(p.bookProof.components.changesToPriorReconciled).toBe(0);
    expect(p.bookProof.items[0]!.reasons).toEqual(['redated_after_reconciliation', 'dated_after_statement']);
    expect(p.summary.unreconciledDifference).toBe(-200);

    // Put the date back, then hard-delete the reconciled deposit's lines.
    await db.update(transactions).set({ txnDate: '2026-01-10' }).where(eq(transactions.id, s.chk101));
    await db.delete(journalLines).where(eq(journalLines.transactionId, s.janDeposit));
    p = await buildReconciliationProof(tenantId, s.febRec, { today: TODAY });
    expect(p.bookProof.discrepancy).toBe(-1000);
    expect(p.bookProof.components.changesToPriorReconciled).toBe(-1000);
    const del = p.bookProof.items.find((i) => i.reasons.includes('deleted'));
    expect(del).toBeDefined();
    expect(del!.currentAmount).toBeNull();
  });

  it('flags an opening balance the prior reconciliations do not support', async () => {
    const s = await seedBank();
    // A beginning balance that doesn't chain from January's cleared activity.
    await db.update(reconciliations).set({ beginningBalance: '850.0000' }).where(eq(reconciliations.id, s.febRec));
    const p = await buildReconciliationProof(tenantId, s.febRec, { today: TODAY });
    expect(p.bookProof.discrepancy).toBe(-50);
    expect(p.bookProof.components.beginningBalanceVariance).toBe(-50);
    expect(p.bookProof.explanations.join(' ')).toContain('beginning balance');
  });

  it('reconciles a credit card in amount-owed orientation with card wording', async () => {
    const charge = (date: string, amt: string) =>
      post(date, [{ accountId: expenseId, debit: amt }, { accountId: cardId, credit: amt }], `Charge ${amt}`);
    const c1 = await charge('2026-01-05', '100.00');
    const c2 = await charge('2026-01-15', '50.00');
    const pay = await post('2026-01-20', [{ accountId: cardId, debit: '80.00' }, { accountId: bankId, credit: '80.00' }], 'Card payment');
    await charge('2026-01-29', '30.00'); // not on statement yet
    await charge('2025-11-01', '20.00'); // 91 days → investigate
    // Statement prints 70.00 owed; manual start flips it into GL orientation.
    const rec = await reconciliation.start(tenantId, cardId, '2026-01-31', '70.00');
    await clear(rec.id, [c1, c2, pay], cardId);
    await reconciliation.complete(tenantId, rec.id);

    const p = await buildReconciliationProof(tenantId, rec.id, { today: TODAY });
    expect(p.orientation).toBe('liability');
    expect(p.labels.statementBalance).toContain('card statement');
    expect(p.labels.increases).toContain('Charges recorded in books');
    expect(p.summary.statementBalance).toBe(70);
    expect(p.summary.increases).toEqual({ count: 2, total: 50 });
    expect(p.summary.decreases).toEqual({ count: 0, total: 0 });
    expect(p.summary.adjustedStatementBalance).toBe(120);
    expect(p.summary.bookBalance).toBe(120);
    expect(p.summary.reconciledToBooks).toBe(true);
    expect(p.clearedRoll).toMatchObject({
      beginningBalance: 0, clearedIncreases: { count: 2, total: 150 }, clearedDecreases: { count: 1, total: 80 },
      clearedBalance: 70, difference: 0,
    });
    expect(p.schedules.increases.items.map((i) => i.flag)).toEqual(['investigate', null]);
    expect(p.bookProof.ties).toBe(true);
  });

  it('lists statement lines with no book transaction as unrecorded bank items (in progress)', async () => {
    const dep = await deposit('2026-01-05', '1000.00');
    const chk = await check('2026-01-10', '200.00', 101);
    const [stmt] = await db.insert(bankStatements).values({
      tenantId, accountId: bankId, periodStart: '2026-01-01', periodEnd: '2026-01-31',
      openingBalance: '0', closingBalance: '795.0000',
    }).returning();
    await db.insert(bankStatementLines).values([
      { tenantId, statementId: stmt!.id, lineDate: '2026-01-06', description: 'DEPOSIT', amount: '1000.0000' },
      { tenantId, statementId: stmt!.id, lineDate: '2026-01-12', description: 'CHECK 101', checkNumber: '101', amount: '-200.0000' },
      { tenantId, statementId: stmt!.id, lineDate: '2026-01-31', description: 'MONTHLY SERVICE FEE', amount: '-5.0000' },
    ]);
    const rec = await reconciliation.start(tenantId, undefined, undefined, undefined, { statementId: stmt!.id });
    await clear(rec.id, [dep, chk]);

    const p = await buildReconciliationProof(tenantId, rec.id, { today: TODAY });
    expect(p.status).toBe('in_progress');
    expect(p.clearedRoll.difference).toBe(-5);
    expect(p.summary.unrecorded).toEqual({ count: 1, total: -5 });
    expect(p.schedules.unrecorded[0]).toMatchObject({ description: 'MONTHLY SERVICE FEE', amount: -5 });
    expect(p.summary.adjustedStatementBalance).toBe(795);
    expect(p.summary.bookBalance).toBe(800);
    expect(p.summary.adjustedBookBalance).toBe(795);
    expect(p.summary.reconciledToBooks).toBe(true);
    expect(p.signOff.preparedBy).toBeNull();

    // Un-clearing the check leaves the worksheet short — not reconciled, and
    // the check is NOT reported as an unrecorded bank item (it pairs with the book line).
    await reconciliation.updateLines(tenantId, rec.id, [{ journalLineId: (await lineOf(chk, bankId)).id, isCleared: false }]);
    const p2 = await buildReconciliationProof(tenantId, rec.id, { today: TODAY });
    expect(p2.summary.unrecorded).toEqual({ count: 1, total: -5 });
    expect(p2.summary.reconciledToBooks).toBe(false);
    expect(p2.summary.unreconciledDifference).toBe(-200);
    expect(p2.summary.explanations[0]).toContain('Clearing is not finished');
  });

  it('uses each bank line of a multi-line entry and counts a transfer once on this account', async () => {
    await post('2026-01-05', [
      { accountId: bankId, debit: '100.00' }, { accountId: bankId, credit: '30.00' }, { accountId: revenueId, credit: '70.00' },
    ], 'Split JE');
    await post('2026-01-07', [{ accountId: savingsId, debit: '25.00' }, { accountId: bankId, credit: '25.00' }], 'Transfer to savings');
    const rec = await reconciliation.start(tenantId, bankId, '2026-01-31', '0.00');
    const p = await buildReconciliationProof(tenantId, rec.id, { today: TODAY });
    expect(p.summary.increases).toEqual({ count: 1, total: 100 });
    expect(p.summary.decreases).toEqual({ count: 2, total: 55 });
    expect(p.summary.bookBalance).toBe(45);
    expect(p.summary.adjustedStatementBalance).toBe(45);
    expect(p.bookProof.ties).toBe(true);
    // Voided transactions drop out of the books and the schedules alike.
    const v = await check('2026-01-08', '9.00', 104);
    await ledger.voidTransaction(tenantId, v, 'test');
    const p2 = await buildReconciliationProof(tenantId, rec.id, { today: TODAY });
    expect(p2.summary.bookBalance).toBe(45);
    expect(p2.summary.decreases.count).toBe(2);
  });

  it('renders Section A in order with the right figures (detail HTML, CSV, report DTOs)', async () => {
    const s = await seedBank();
    const detail = await buildReconciliationDetail(tenantId, s.febRec, { today: TODAY });
    expect(detail.proof.summary.bookBalance).toBe(1110);
    const html = renderProofHtml(detail.proof, {
      mode: 'detail', cleared: detail.cleared,
      clearedTotals: { payments: detail.totals.clearedPayments, deposits: detail.totals.clearedDeposits },
    });
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const order = [
      'Balance per bank statement, 02/28/2026 1,100.00',
      'Add: Deposits in transit (2) 165.00',
      'Less: Outstanding checks and payments (3) (155.00)',
      'Adjusted bank balance 1,110.00',
      'Balance per books (general ledger), 02/28/2026 1,110.00',
      'Adjusted book balance 1,110.00',
      'Unreconciled difference 0.00',
      'Reconciled to books',
      'Cleared activity',
      'Supporting schedules',
      'Cleared transactions (1)',
      'Subsequent activity',
      'Register balance as of 03/10/2026 1,050.00',
      'Book-side proof',
      'Sign-off',
      'Reviewed by',
    ];
    let at = -1;
    for (const needle of order) {
      const i = text.indexOf(needle, at + 1);
      expect(i, `missing/out of order: ${needle}`).toBeGreaterThan(at);
      at = i;
    }
    expect(text).toContain('Stale-dated (211 days)');

    const csv = proofCsvRows(detail.proof, { mode: 'detail', cleared: detail.cleared });
    const labels = csv.map((r) => String(r['line'] ?? ''));
    const iStmt = labels.findIndex((l) => l.startsWith('Balance per bank statement'));
    const iAdj = labels.indexOf('Adjusted bank balance');
    const iBooks = labels.findIndex((l) => l.startsWith('Balance per books'));
    const iUnrec = labels.indexOf('Unreconciled difference');
    expect(iStmt).toBeGreaterThanOrEqual(0);
    expect(iStmt).toBeLessThan(iAdj);
    expect(iAdj).toBeLessThan(iBooks);
    expect(iBooks).toBeLessThan(iUnrec);
    expect(csv[iAdj]!['amount']).toBe(1110);

    // Summary report: per-account latest completed reconciliation, or one rec.
    const all = await buildBankReconciliationSummary(tenantId, '', null, { today: TODAY });
    const bankProof = all.proofs.find((p) => p.accountId === bankId)!;
    expect(bankProof.reconciliationId).toBe(s.febRec);
    const one = await buildBankReconciliationSummary(tenantId, '', null, { reconciliationId: s.janRec, today: TODAY });
    expect(one.proofs).toHaveLength(1);
    expect(one.proofs[0]!.statementDate).toBe('2026-01-31');
    expect(one.accounts.map((a) => a.accountId)).toEqual([bankId]);
    const summaryHtml = renderProofHtml(one.proofs[0]!, { mode: 'summary', topItems: 1 });
    expect(summaryHtml).toContain('more (oldest shown)');
  });

  it('404s an unknown reconciliation', async () => {
    await expect(buildReconciliationProof(tenantId, '00000000-0000-0000-0000-000000000000')).rejects.toThrow('not found');
  });
});

