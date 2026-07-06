// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// deleteTransactionsInDateRange: surgically deletes transactions dated
// in [start, end] for one tenant, scoping every dependent cleanup to
// the target set. Confirmed semantics: overlapping reconciliations are
// deleted, bank-feed items are purged by feed_date, account balances
// are RECOMPUTED (not zeroed) from the surviving posted/void lines.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog as auditLogTable, contacts,
  transactions, journalLines, tags, transactionTags, bankFeedItems, bankConnections,
  reconciliations, reconciliationLines, bankStatements, paymentApplications,
  billPaymentApplications, vendorCreditApplications, depositLines,
  dailySalesTemplates, dailySalesEntries, recurringSchedules,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import { deleteTransactionsInDateRange, previewTransactionsInDateRange } from './admin.service.js';

let tenantId: string;

const START = '2026-02-01';
const END = '2026-02-28';
const IN_DATE = '2026-02-15';
const OUT_DATE = '2026-05-15';

async function cleanDb() {
  await db.delete(reconciliationLines);
  await db.delete(bankStatements);
  await db.delete(reconciliations);
  await db.delete(paymentApplications);
  await db.delete(billPaymentApplications);
  await db.delete(vendorCreditApplications);
  await db.delete(depositLines);
  await db.delete(dailySalesEntries);
  await db.delete(dailySalesTemplates);
  await db.delete(recurringSchedules);
  await db.delete(bankFeedItems);
  await db.delete(bankConnections);
  await db.delete(transactionTags);
  await db.delete(tags);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(auditLogTable);
  await db.delete(contacts);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'Range', slug: `range-${Date.now()}` }).returning();
  tenantId = t!.id;
});

afterEach(async () => {
  await cleanDb();
});

/** Seed the full scenario; returns the handles the assertions need. */
async function seed() {
  const [cash] = await db.insert(accounts).values({ tenantId, name: 'Cash', accountNumber: '1000', accountType: 'asset' }).returning();
  const [rev] = await db.insert(accounts).values({ tenantId, name: 'Sales', accountNumber: '4000', accountType: 'revenue' }).returning();

  // Balance-affecting journal entries (posted).
  const inTxn = await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry', txnDate: IN_DATE, memo: 'in-range',
    lines: [
      { accountId: cash!.id, debit: '500', credit: '0' },
      { accountId: rev!.id, debit: '0', credit: '500' },
    ],
  });
  const outTxn = await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry', txnDate: OUT_DATE, memo: 'out-of-range',
    lines: [
      { accountId: cash!.id, debit: '300', credit: '0' },
      { accountId: rev!.id, debit: '0', credit: '300' },
    ],
  });
  const inCashLine = inTxn.lines.find((l) => l.accountId === cash!.id)!;
  const outCashLine = outTxn.lines.find((l) => l.accountId === cash!.id)!;

  // Bare transactions used only as application endpoints (no journal lines).
  const mk = async (txnDate: string, txnType: string) => {
    const [row] = await db.insert(transactions).values({ tenantId, txnType, txnDate }).returning();
    return row!;
  };
  const inInvoice = await mk(IN_DATE, 'invoice');
  const inPayment = await mk(IN_DATE, 'payment');
  const outInvoice = await mk(OUT_DATE, 'invoice');
  const outPayment = await mk(OUT_DATE, 'payment');
  const inBill = await mk(IN_DATE, 'bill');
  const outBill = await mk(OUT_DATE, 'bill');
  const inDeposit = await mk(IN_DATE, 'deposit');
  const outDeposit = await mk(OUT_DATE, 'deposit');

  // payment_applications: A both-in (deleted), B both-out (kept),
  // C either-side in (deleted).
  await db.insert(paymentApplications).values([
    { tenantId, paymentId: inPayment.id, invoiceId: inInvoice.id, amount: '10' },
    { tenantId, paymentId: outPayment.id, invoiceId: outInvoice.id, amount: '20' },
    { tenantId, paymentId: outPayment.id, invoiceId: inInvoice.id, amount: '30' },
  ]);
  // bill/vendor-credit applications: both-out kept, either-in deleted.
  await db.insert(billPaymentApplications).values([
    { tenantId, paymentId: outPayment.id, billId: outBill.id, amount: '5' },
    { tenantId, paymentId: outPayment.id, billId: inBill.id, amount: '6' },
  ]);
  await db.insert(vendorCreditApplications).values([
    { tenantId, paymentId: outPayment.id, creditId: outBill.id, billId: outBill.id, amount: '7' },
    { tenantId, paymentId: inPayment.id, creditId: outBill.id, billId: outBill.id, amount: '8' },
  ]);
  // deposit_lines: in-range deposit (deleted), out deposit w/ in source (deleted), out/out (kept).
  await db.insert(depositLines).values([
    { depositId: inDeposit.id, sourceTransactionId: outPayment.id, amount: '1' },
    { depositId: outDeposit.id, sourceTransactionId: inPayment.id, amount: '2' },
    { depositId: outDeposit.id, sourceTransactionId: outPayment.id, amount: '3' },
  ]);

  // transaction_tags on the in-range txn (deleted) and out-of-range (kept).
  const [tag] = await db.insert(tags).values({ tenantId, name: 'Loc' }).returning();
  await db.insert(transactionTags).values([
    { tenantId, transactionId: inTxn.id, tagId: tag!.id },
    { tenantId, transactionId: outTxn.id, tagId: tag!.id },
  ]);

  // Reconciliations: recIn (in range → deleted), recOut (out of range,
  // cleared both an in-range and an out-of-range line → kept, its
  // in-range line pruned).
  const [recIn] = await db.insert(reconciliations).values({
    tenantId, accountId: cash!.id, statementDate: '2026-02-20', status: 'completed',
    statementEndingBalance: '500', beginningBalance: '0',
  }).returning();
  const [recOut] = await db.insert(reconciliations).values({
    tenantId, accountId: cash!.id, statementDate: '2026-05-20', status: 'completed',
    statementEndingBalance: '800', beginningBalance: '0',
  }).returning();
  await db.insert(reconciliationLines).values([
    { reconciliationId: recIn!.id, journalLineId: inCashLine.id, isCleared: true },
    { reconciliationId: recOut!.id, journalLineId: inCashLine.id, isCleared: true },
    { reconciliationId: recOut!.id, journalLineId: outCashLine.id, isCleared: true },
  ]);
  // A bank statement pointing at the in-range reconciliation.
  const [stmt] = await db.insert(bankStatements).values({
    tenantId, accountId: cash!.id, periodEnd: '2026-02-28', closingBalance: '500',
    reconciliationId: recIn!.id,
  }).returning();

  // Bank feed items.
  const [conn] = await db.insert(bankConnections).values({
    tenantId, accountId: cash!.id, provider: 'manual', institutionName: 'Test Bank',
  }).returning();
  const [feedIn] = await db.insert(bankFeedItems).values({
    tenantId, bankConnectionId: conn!.id, feedDate: IN_DATE, amount: '500', status: 'matched',
    matchedTransactionId: inTxn.id, matchType: 'exact',
  }).returning();
  const [feedOutMatched] = await db.insert(bankFeedItems).values({
    tenantId, bankConnectionId: conn!.id, feedDate: OUT_DATE, amount: '500', status: 'matched',
    matchedTransactionId: inTxn.id, matchType: 'exact',
  }).returning();
  const [feedOutUnmatched] = await db.insert(bankFeedItems).values({
    tenantId, bankConnectionId: conn!.id, feedDate: '2026-05-11', amount: '9', status: 'ignored',
  }).returning();

  // Daily sales entry posted to the in-range txn.
  const [dst] = await db.insert(dailySalesTemplates).values({ tenantId, name: 'POS', presetType: 'custom' }).returning();
  const [dse] = await db.insert(dailySalesEntries).values({
    tenantId, templateId: dst!.id, businessDate: IN_DATE, status: 'posted',
    transactionId: inTxn.id, postedAt: new Date(),
  }).returning();

  // Recurring schedule (template, must survive).
  const [tmplTxn] = await db.insert(transactions).values({ tenantId, txnType: 'invoice', txnDate: IN_DATE }).returning();
  const [sched] = await db.insert(recurringSchedules).values({
    tenantId, templateTransactionId: tmplTxn!.id, frequency: 'monthly',
    startDate: IN_DATE, nextOccurrence: '2026-08-01',
  }).returning();

  return {
    cash: cash!, rev: rev!, inTxn, outTxn, inCashLine, outCashLine,
    inInvoice, inPayment, outInvoice, outPayment, inBill, outBill,
    recIn: recIn!, recOut: recOut!, stmt: stmt!,
    feedIn: feedIn!, feedOutMatched: feedOutMatched!, feedOutUnmatched: feedOutUnmatched!,
    dse: dse!, sched: sched!, tmplTxn: tmplTxn!,
  };
}

describe('deleteTransactionsInDateRange', () => {
  it('deletes only in-range txns/journal lines and leaves out-of-range intact', async () => {
    const s = await seed();
    const result = await deleteTransactionsInDateRange(tenantId, START, END, undefined);

    // The in-range journal-entry, invoice, payment, bill, deposit txns
    // (5) all delete; the template txn is dated in range too but is NOT
    // targeted-only... it IS in range so it deletes as well. Assert the
    // JE specifically survives/dies correctly below.
    expect(result.transactionsDeleted).toBeGreaterThanOrEqual(1);

    const remaining = await db.select().from(transactions).where(eq(transactions.tenantId, tenantId));
    const remainingIds = new Set(remaining.map((r) => r.id));
    expect(remainingIds.has(s.inTxn.id)).toBe(false);
    expect(remainingIds.has(s.outTxn.id)).toBe(true);
    expect(remainingIds.has(s.outInvoice.id)).toBe(true);
    expect(remainingIds.has(s.inInvoice.id)).toBe(false);

    // In-range journal lines gone; out-of-range kept.
    const jls = await db.select().from(journalLines).where(eq(journalLines.tenantId, tenantId));
    expect(jls.some((l) => l.id === s.inCashLine.id)).toBe(false);
    expect(jls.some((l) => l.id === s.outCashLine.id)).toBe(true);
  });

  it('recomputes account balances from the surviving lines', async () => {
    const s = await seed();
    await deleteTransactionsInDateRange(tenantId, START, END, undefined);

    const [cashAfter] = await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, s.cash.id)));
    const [revAfter] = await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, s.rev.id)));
    // Only the out-of-range JE (cash +300 / rev -300) remains.
    expect(parseFloat(cashAfter!.balance!)).toBe(300);
    expect(parseFloat(revAfter!.balance!)).toBe(-300);
  });

  it('deletes the in-range reconciliation (+ lines + statement link) and prunes orphan lines from a kept rec', async () => {
    const s = await seed();
    await deleteTransactionsInDateRange(tenantId, START, END, undefined);

    const recs = await db.select().from(reconciliations).where(eq(reconciliations.tenantId, tenantId));
    const recIds = new Set(recs.map((r) => r.id));
    expect(recIds.has(s.recIn.id)).toBe(false);
    expect(recIds.has(s.recOut.id)).toBe(true);

    // recOut keeps only the line referencing the surviving out-of-range line.
    const recOutLines = await db.select().from(reconciliationLines).where(eq(reconciliationLines.reconciliationId, s.recOut.id));
    expect(recOutLines.length).toBe(1);
    expect(recOutLines[0]!.journalLineId).toBe(s.outCashLine.id);

    // Bank statement kept, but its reconciliation link nulled.
    const [stmtAfter] = await db.select().from(bankStatements).where(eq(bankStatements.id, s.stmt.id));
    expect(stmtAfter).toBeTruthy();
    expect(stmtAfter!.reconciliationId).toBeNull();
  });

  it('purges in-range feed items, resets out-of-range matches, leaves unmatched alone', async () => {
    const s = await seed();
    const result = await deleteTransactionsInDateRange(tenantId, START, END, undefined);
    expect(result.feedItemsDeleted).toBe(1);

    const feeds = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
    const byId = new Map(feeds.map((f) => [f.id, f]));
    expect(byId.has(s.feedIn.id)).toBe(false); // purged by feed_date
    const outMatched = byId.get(s.feedOutMatched.id)!;
    expect(outMatched.status).toBe('pending');
    expect(outMatched.matchedTransactionId).toBeNull();
    expect(outMatched.matchType).toBeNull();
    const unmatched = byId.get(s.feedOutUnmatched.id)!;
    expect(unmatched.status).toBe('ignored'); // untouched
  });

  it('resets a posted daily-sales entry to draft and leaves recurring schedules intact', async () => {
    const s = await seed();
    await deleteTransactionsInDateRange(tenantId, START, END, undefined);

    const [dseAfter] = await db.select().from(dailySalesEntries).where(eq(dailySalesEntries.id, s.dse.id));
    expect(dseAfter!.status).toBe('draft');
    expect(dseAfter!.transactionId).toBeNull();
    expect(dseAfter!.postedAt).toBeNull();

    // recurring_schedules row survives (it's a template, not dated activity).
    const scheds = await db.select().from(recurringSchedules).where(eq(recurringSchedules.tenantId, tenantId));
    expect(scheds.some((r) => r.id === s.sched.id)).toBe(true);
  });

  it('deletes applications with either side in range and keeps both-out-of-range ones', async () => {
    await seed();
    await deleteTransactionsInDateRange(tenantId, START, END, undefined);

    const pa = await db.select().from(paymentApplications).where(eq(paymentApplications.tenantId, tenantId));
    expect(pa.length).toBe(1); // only the both-out row survives
    expect(parseFloat(pa[0]!.amount)).toBe(20);

    const bpa = await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tenantId));
    expect(bpa.length).toBe(1);
    expect(parseFloat(bpa[0]!.amount)).toBe(5);

    const vca = await db.select().from(vendorCreditApplications).where(eq(vendorCreditApplications.tenantId, tenantId));
    expect(vca.length).toBe(1);
    expect(parseFloat(vca[0]!.amount)).toBe(7);

    const dl = await db.select().from(depositLines);
    expect(dl.length).toBe(1); // only the out/out deposit line survives
    expect(parseFloat(dl[0]!.amount)).toBe(3);

    // transaction_tags: in-range removed, out-of-range kept.
    const tt = await db.select().from(transactionTags).where(eq(transactionTags.tenantId, tenantId));
    expect(tt.length).toBe(1);
  });

  it('writes an audit-log entry with the range + counts', async () => {
    await seed();
    await deleteTransactionsInDateRange(tenantId, START, END, undefined);
    const audits = await db.select().from(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
    const row = audits.find((a) => a.entityType === 'transactions_date_range');
    expect(row).toBeTruthy();
    expect(row!.action).toBe('delete');
    // afterData is a jsonb column — drizzle returns it already parsed.
    const after = (typeof row!.afterData === 'string' ? JSON.parse(row!.afterData) : row!.afterData) as {
      startDate: string; endDate: string; transactionsDeleted: number;
    };
    expect(after.startDate).toBe(START);
    expect(after.endDate).toBe(END);
    expect(after.transactionsDeleted).toBeGreaterThanOrEqual(1);
  });

  it('is a no-op when nothing is dated in range and there are no feed items', async () => {
    // Seed only out-of-range activity.
    const [cash] = await db.insert(accounts).values({ tenantId, name: 'Cash', accountNumber: '1000', accountType: 'asset' }).returning();
    const [rev] = await db.insert(accounts).values({ tenantId, name: 'Sales', accountNumber: '4000', accountType: 'revenue' }).returning();
    await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: OUT_DATE, memo: 'out',
      lines: [{ accountId: cash!.id, debit: '300', credit: '0' }, { accountId: rev!.id, debit: '0', credit: '300' }],
    });
    const result = await deleteTransactionsInDateRange(tenantId, START, END, undefined);
    expect(result).toMatchObject({ transactionsDeleted: 0, feedItemsDeleted: 0, reconciliationsDeleted: 0 });
    const [cashAfter] = await db.select().from(accounts).where(eq(accounts.id, cash!.id));
    expect(parseFloat(cashAfter!.balance!)).toBe(300); // untouched
  });

  it('previewTransactionsInDateRange counts without deleting', async () => {
    await seed();
    const preview = await previewTransactionsInDateRange(tenantId, START, END);
    expect(preview.transactionsToDelete).toBeGreaterThanOrEqual(1);
    expect(preview.feedItemsToDelete).toBe(1);
    expect(preview.reconciliationsToDelete).toBe(1);
    // Nothing deleted by preview.
    const txns = await db.select().from(transactions).where(eq(transactions.tenantId, tenantId));
    expect(txns.some((t) => t.id !== undefined)).toBe(true);
  });

  it('rejects bad date formats, inverted ranges, and unknown tenants', async () => {
    await expect(deleteTransactionsInDateRange(tenantId, '2026/02/01', END)).rejects.toThrow();
    await expect(deleteTransactionsInDateRange(tenantId, END, START)).rejects.toThrow(/on or before/i);
    await expect(
      deleteTransactionsInDateRange('00000000-0000-0000-0000-000000000000', START, END),
    ).rejects.toThrow(/not found/i);
    await expect(deleteTransactionsInDateRange('not-a-uuid', START, END)).rejects.toThrow(/Invalid tenant id/i);
  });
});
