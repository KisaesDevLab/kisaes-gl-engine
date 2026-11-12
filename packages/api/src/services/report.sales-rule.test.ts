// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// U-119 (ClientLedger A07 PR-B): the one sales rule (Q-A07b) behind Sales by
// Client and Sales by Item — natural net of income lines of sale documents,
// so a discount line reduces sales; the line's client, else the document's;
// daily sales count; a cash-only entry stays off the accrual report — and
// the A/R Aging Summary's exact buckets (Q-A07c): each item's exact open,
// so two items open 10.005 make 20.0100 (the cent figures stay 20.02).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, accounts, transactions, journalLines, contacts, auditLog, items } from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as reportService from './report.service.js';

let tenantId = '';
const id: Record<string, string> = {};

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(items).where(eq(items.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

type Line = { accountId: string; debit: string; credit: string; contactId?: string; itemId?: string };
const post = (txnType: string, date: string, lines: Line[], extra: Record<string, unknown> = {}) =>
  ledger.postTransaction(tenantId, {
    txnType: txnType as never, txnDate: date, memo: txnType, lines,
    total: lines.reduce((s, l) => s + Number(l.debit), 0).toFixed(4), ...extra,
  } as never);

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'SR', slug: `sr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }).returning();
  tenantId = t!.id;
  const acct = async (k: string, accountType: string, detailType: string | null, systemTag: string | null = null) => {
    const [a] = await db.insert(accounts).values({ tenantId, name: k, accountNumber: k, accountType, detailType, isSystem: !!systemTag, systemTag }).returning();
    id[k] = a!.id;
  };
  await acct('cash', 'asset', 'checking');
  await acct('ar', 'asset', 'accounts_receivable', 'accounts_receivable');
  await acct('rev', 'revenue', 'service');
  await acct('disc', 'revenue', 'discounts_refunds_given');
  for (const n of ['Header Co', 'Line Co']) {
    const [c] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: n }).returning();
    id[n] = c!.id;
  }
  const [it] = await db.insert(items).values({ tenantId, name: 'Visit', incomeAccountId: id['rev']! }).returning();
  id['item'] = it!.id;
});

afterEach(cleanDb);

const byName = (rows: Array<Record<string, unknown>>, key: string) =>
  Object.fromEntries(rows.map((r) => [String(r[key]), Number(r['total']).toFixed(2)]));

describe('the sales rule (Q-A07b)', () => {
  it('accrual: discount lines reduce sales; the line client wins; daily sales count; cash-only entries do not', async () => {
    // An invoice for Header Co with a 100 line (item) and a -10 discount line.
    await post('invoice', '2026-03-01', [
      { accountId: id['ar']!, debit: '90.00', credit: '0' },
      { accountId: id['rev']!, debit: '0', credit: '100.00', itemId: id['item']! },
      { accountId: id['disc']!, debit: '10.00', credit: '0' },
    ], { contactId: id['Header Co'] });
    // A sales receipt whose income line names another client.
    await post('cash_sale', '2026-03-02', [
      { accountId: id['cash']!, debit: '40.00', credit: '0' },
      { accountId: id['rev']!, debit: '0', credit: '40.00', contactId: id['Line Co']! },
    ], { contactId: id['Header Co'] });
    await post('daily_sales', '2026-03-03', [
      { accountId: id['cash']!, debit: '25.00', credit: '0' },
      { accountId: id['rev']!, debit: '0', credit: '25.00' },
    ]);
    // A cash-only entry is not on accrual reports.
    await post('cash_sale', '2026-03-04', [
      { accountId: id['cash']!, debit: '7.00', credit: '0' },
      { accountId: id['rev']!, debit: '0', credit: '7.00' },
    ], { contactId: id['Header Co'], basis: 'cash' });

    const sc = await reportService.buildSalesByCustomer(tenantId, '2026-01-01', '2026-12-31', null, null, 'accrual');
    expect(byName(sc.data as Array<Record<string, unknown>>, 'customer_name')).toEqual({ 'Header Co': '90.00', 'Line Co': '40.00', Uncategorized: '25.00' });
    const si = await reportService.buildSalesByItem(tenantId, '2026-01-01', '2026-12-31', null, null, 'accrual');
    expect(byName(si.data as Array<Record<string, unknown>>, 'item_name')).toEqual({ Visit: '100.00', Uncategorized: '55.00' });
  });
});

describe('A/R Aging Summary exact buckets (Q-A07c)', () => {
  it('ages each item\'s exact open: two items open 10.005 make 20.0100; the cent figures are unchanged', async () => {
    for (const d of ['2026-05-01', '2026-05-02']) {
      await post('invoice', d, [
        { accountId: id['ar']!, debit: '10.005', credit: '0' },
        { accountId: id['rev']!, debit: '0', credit: '10.005' },
      ], { contactId: id['Header Co'], dueDate: '2026-06-30' });
    }
    const r = await reportService.buildARAgingSummary(tenantId, '2026-05-31');
    expect(r.totalExact).toBe('20.0100');
    expect(r.bucketsExact.current).toBe('20.0100');
    expect(r.total).toBe(20.02);
    const [c] = r.customers;
    expect(c).toMatchObject({ total: '20.02', totalExact: '20.0100', bucketsExact: { current: '20.0100' } });
  });
});
