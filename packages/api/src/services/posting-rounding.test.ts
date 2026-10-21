// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Posting builders round each line amount (and line tax) to the ledger's
// 4 places first and add up the rounded values for the total line
// (A/R, A/P, deposit account), so what is stored balances exactly under
// the exact balance rule (U-65). Two lines of 1.5 x 0.3333 = 0.49995 each
// store as 0.5000 + 0.5000; the total must be 1.0000, not 0.9999.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, userTenantAccess, userPermissions, companies, accounts, auditLog, contacts,
  transactions, journalLines, transactionTags, billPaymentApplications, vendorCreditApplications,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as invoiceService from './invoice.service.js';
import * as cashSaleService from './cash-sale.service.js';
import * as creditMemoService from './credit-memo.service.js';
import * as billService from './bill.service.js';
import * as vendorCreditService from './vendor-credit.service.js';
import * as billPaymentService from './bill-payment.service.js';
import * as ledger from './ledger.service.js';

let tenantId = '';
let ids: { bank: string; ar: string; ap: string; tax: string; revenue: string; expense: string; customer: string; vendor: string };

async function bySystemTag(tag: string) {
  const a = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)) });
  if (!a) throw new Error(`missing ${tag}`);
  return a.id;
}

beforeEach(async () => {
  const reg = await authService.register({
    email: `rounding-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: 'password123',
    displayName: 'Owner', companyName: 'Rounding Co',
  });
  tenantId = reg.user.tenantId;
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const revenue = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) });
  const expense = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')) });
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Rivera Remodel' }).returning();
  const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Cosmos Granite' }).returning();
  ids = {
    bank: bank!.id, revenue: revenue!.id, expense: expense!.id,
    ar: await bySystemTag('accounts_receivable'), ap: await bySystemTag('accounts_payable'),
    tax: await bySystemTag('sales_tax_payable'),
    customer: customer!.id, vendor: vendor!.id,
  };
});

afterEach(async () => {
  if (!tenantId) return;
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tenantId));
  await db.delete(vendorCreditApplications).where(eq(vendorCreditApplications.tenantId, tenantId));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId));
  if (staff.length) await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tenantId));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
});

async function linesOf(txnId: string) {
  return db.select().from(journalLines).where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));
}
const amountOn = (lines: Array<{ accountId: string; debit: string; credit: string }>, accountId: string, side: 'debit' | 'credit') =>
  lines.filter((l) => l.accountId === accountId).map((l) => l[side]);

const twoLines = (accountId: string, extra: Record<string, unknown> = {}) => [
  { accountId, quantity: '1.5', unitPrice: '0.3333', description: 'A', ...extra },
  { accountId, quantity: '1.5', unitPrice: '0.3333', description: 'B', ...extra },
];

describe('ledger.round4', () => {
  it('rounds half away from zero to 4 places, as numeric(19,4) stores', () => {
    expect(ledger.round4('0.49995').toFixed(4)).toBe('0.5000');
    expect(ledger.round4('-0.49995').toFixed(4)).toBe('-0.5000');
    expect(ledger.round4('0.49994').toFixed(4)).toBe('0.4999');
    expect(ledger.round4(null).toFixed(4)).toBe('0.0000');
  });
});

describe('posting builders sum rounded lines (M2)', () => {
  it('invoice: two lines of 1.5 x 0.3333 post A/R 1.0000; line tax is rounded per line too', async () => {
    const inv = await invoiceService.createInvoice(tenantId, {
      txnDate: '2026-07-31', contactId: ids.customer, lines: twoLines(ids.revenue, { isTaxable: false, taxRate: '0' }) as any,
    });
    const lines = await linesOf(inv.id);
    expect(amountOn(lines, ids.revenue, 'credit')).toEqual(['0.5000', '0.5000']);
    expect(amountOn(lines, ids.ar, 'debit')).toEqual(['1.0000']);
    expect(inv.total).toBe('1.0000');

    // 0.5000 x 8.25% = 0.04125 -> 0.0413 per line; tax 0.0826, A/R 1.0826.
    const taxed = await invoiceService.createInvoice(tenantId, {
      txnDate: '2026-07-31', contactId: ids.customer, lines: twoLines(ids.revenue, { isTaxable: true, taxRate: '0.0825' }) as any,
    });
    const tl = await linesOf(taxed.id);
    expect(tl.filter((l) => l.accountId === ids.revenue).map((l) => l.taxAmount)).toEqual(['0.0413', '0.0413']);
    expect(amountOn(tl, ids.tax, 'credit')).toEqual(['0.0826']);
    expect(amountOn(tl, ids.ar, 'debit')).toEqual(['1.0826']);
  });

  it('cash sale: deposit account gets the sum of the rounded lines', async () => {
    const sale = await cashSaleService.createCashSale(tenantId, {
      txnDate: '2026-07-31', depositToAccountId: ids.bank, lines: twoLines(ids.revenue, { isTaxable: false, taxRate: '0' }) as any,
    });
    const lines = await linesOf(sale.id);
    expect(amountOn(lines, ids.revenue, 'credit')).toEqual(['0.5000', '0.5000']);
    expect(amountOn(lines, ids.bank, 'debit')).toEqual(['1.0000']);
  });

  it('credit memo: A/R credit is the sum of the rounded lines', async () => {
    const memo = await creditMemoService.createCreditMemo(tenantId, {
      txnDate: '2026-07-31', contactId: ids.customer, lines: twoLines(ids.revenue) as any,
    });
    const lines = await linesOf(memo.id);
    expect(amountOn(lines, ids.revenue, 'debit')).toEqual(['0.5000', '0.5000']);
    expect(amountOn(lines, ids.ar, 'credit')).toEqual(['1.0000']);
  });

  it('bill and vendor credit: A/P is the sum of the rounded line amounts', async () => {
    const lines5 = [
      { accountId: ids.expense, amount: '0.33335' },
      { accountId: ids.expense, amount: '0.33335' },
    ];
    const bill = await billService.createBill(tenantId, { contactId: ids.vendor, txnDate: '2026-07-31', lines: lines5 });
    const bl = await linesOf(bill.id);
    expect(amountOn(bl, ids.expense, 'debit')).toEqual(['0.3334', '0.3334']);
    expect(amountOn(bl, ids.ap, 'credit')).toEqual(['0.6668']);

    const vc = await vendorCreditService.createVendorCredit(tenantId, { contactId: ids.vendor, txnDate: '2026-07-31', lines: lines5 });
    const vl = await linesOf(vc.id);
    expect(amountOn(vl, ids.expense, 'credit')).toEqual(['0.3334', '0.3334']);
    expect(amountOn(vl, ids.ap, 'debit')).toEqual(['0.6668']);
    expect(vc.total).toBe('0.6668');
  });

  it('bill payment with a credit: bill and credit amounts are rounded before the totals', async () => {
    const one = [{ accountId: ids.expense, amount: '1.0000' }];
    const b1 = await billService.createBill(tenantId, { contactId: ids.vendor, txnDate: '2026-07-01', lines: one });
    const b2 = await billService.createBill(tenantId, { contactId: ids.vendor, txnDate: '2026-07-01', lines: one });
    const vc = await vendorCreditService.createVendorCredit(tenantId, { contactId: ids.vendor, txnDate: '2026-07-01', lines: one });
    // Unrounded: bills 0.6667, credit 0.33335 -> A/P 0.6667 vs cash 0.3334 + credit 0.3334.
    const res = await billPaymentService.payBills(tenantId, {
      bankAccountId: ids.bank, txnDate: '2026-07-31', method: 'check', printLater: true,
      bills: [{ billId: b1.id, amount: '0.33335' }, { billId: b2.id, amount: '0.33335' }],
      credits: [{ creditId: vc.id, billId: b1.id, amount: '0.33335' }],
    } as any);
    expect(res).toBeDefined();
    const pays = await db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.txnType, 'bill_payment')));
    expect(pays).toHaveLength(1);
    const pl = await linesOf(pays[0]!.id);
    const sum = (side: 'debit' | 'credit') => pl.reduce((s, l) => s + Math.round(Number(l[side]) * 10000), 0);
    expect(sum('debit')).toBe(sum('credit'));
    expect(amountOn(pl, ids.ap, 'debit')).toContain('0.6668');
  });
});
