// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// U-119 (ClientLedger A07 PR-B, R-T1): every cash-basis virtual line has a
// `vkey`, never NULL and unique within its transaction, on every branch:
// pass-through lines (the journal line id), the scaled document lines
// (alloc_key:src_line_id:grp) and rule 2b's credit applied later
// ('2b:' + the application id). Two credits applied later inside one
// payment were indistinguishable before; now each has its own key. The
// Report Builder pages detail rows by (date, created_at, transaction, vkey).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, accounts, transactions, journalLines, paymentApplications, billPaymentApplications, auditLog, contacts,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as reportService from './report.service.js';

let tenantId = '';
const acct: Record<string, string> = {};

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(paymentApplications).where(eq(paymentApplications.tenantId, tenantId));
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function mk(key: string, accountType: string, accountNumber: string, detailType: string | null, systemTag: string | null = null) {
  const [a] = await db.insert(accounts).values({ tenantId, name: key, accountNumber, accountType, detailType, isSystem: !!systemTag, systemTag }).returning();
  acct[key] = a!.id;
}

// The document total (rule 3 scales by it): the sum of the debits.
const post = (txnType: string, date: string, lines: Array<{ accountId: string; debit: string; credit: string }>) =>
  ledger.postTransaction(tenantId, {
    txnType: txnType as never, txnDate: date, memo: txnType, lines,
    total: lines.reduce((s, l) => s + Number(l.debit), 0).toFixed(2),
  } as never);
const L = (accountId: string, debit: string, credit: string) => ({ accountId, debit, credit });

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'VKEY', slug: `vkey-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }).returning();
  tenantId = t!.id;
  await mk('cash', 'asset', '1000', 'checking');
  await mk('ar', 'asset', '1200', 'accounts_receivable', 'accounts_receivable');
  await mk('ap', 'liability', '2000', 'accounts_payable', 'accounts_payable');
  await mk('rev', 'revenue', '4000', 'service');
  await mk('rev2', 'revenue', '4100', 'service');
  await mk('exp', 'expense', '6000', 'repairs_maintenance');
});

afterEach(cleanDb);

describe('cash-basis vkey (R-T1)', () => {
  it('is set and unique per transaction on the pass-through, scaled and rule 2b branches', async () => {
    const inv1 = await post('invoice', '2026-01-05', [L(acct['ar']!, '100.00', '0'), L(acct['rev']!, '0', '60.00'), L(acct['rev2']!, '0', '40.00')]);
    const inv2 = await post('invoice', '2026-01-06', [L(acct['ar']!, '50.00', '0'), L(acct['rev']!, '0', '50.00')]);
    // One payment: part applied at once, two credits applied later inside it (rule 2b twice).
    const pay = await post('customer_payment', '2026-01-10', [L(acct['cash']!, '150.00', '0'), L(acct['ar']!, '0', '150.00')]);
    await db.insert(paymentApplications).values([
      { tenantId, paymentId: pay.id, invoiceId: inv1.id, amount: '70.0000' },
      { tenantId, paymentId: pay.id, invoiceId: inv1.id, amount: '30.0000', appliedDate: '2026-02-01' } as never,
      { tenantId, paymentId: pay.id, invoiceId: inv2.id, amount: '50.0000', appliedDate: '2026-02-01' } as never,
    ]);
    const bill = await post('bill', '2026-01-07', [L(acct['exp']!, '80.00', '0'), L(acct['ap']!, '0', '80.00')]);
    const billPay = await post('bill_payment', '2026-01-20', [L(acct['ap']!, '80.00', '0'), L(acct['cash']!, '0', '80.00')]);
    await db.insert(billPaymentApplications).values({ tenantId, paymentId: billPay.id, billId: bill.id, amount: '80.0000' });

    const r = await reportService.executeCashBasis(sql`
      WITH ${reportService.cashBasisLinesWith(tenantId, null, '2026-12-31', null)}
      SELECT transaction_id, vkey, line_id FROM cb_lines`);
    const rows = r.rows as Array<{ transaction_id: string; vkey: string | null; line_id: string | null }>;
    expect(rows.length).toBeGreaterThan(6);
    for (const row of rows) expect(row.vkey, JSON.stringify(row)).toEqual(expect.any(String));
    const keys = rows.map((x) => `${x.transaction_id}|${x.vkey}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Pass-through lines are keyed by their journal line.
    for (const row of rows.filter((x) => x.line_id !== null)) expect(row.vkey).toBe(row.line_id);
    // The two credits applied later on the payment: one rule-2b line each.
    const twoB = rows.filter((x) => x.transaction_id === pay.id && x.vkey!.startsWith('2b:'));
    expect(twoB).toHaveLength(2);
    // Scaled lines: alloc_key:src_line_id:grp.
    expect(rows.some((x) => /^bp:[0-9a-f-]{36}:[0-9a-f-]{36}:(true|false)$/.test(x.vkey!))).toBe(true);
    expect(rows.some((x) => /^(own|credit):[0-9a-f-]{36}:[0-9a-f-]{36}:(true|false)$/.test(x.vkey!))).toBe(true);
  });
});
