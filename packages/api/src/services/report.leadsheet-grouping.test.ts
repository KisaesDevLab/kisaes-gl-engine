// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// ?group_by=leadsheet on the P&L / Balance Sheet: groups follow the TB
// module's leadsheets (tb_groupings sort order), accounts on no leadsheet
// trail, the BS computed equity rows stay in 'Equity (Calculated)', and
// the comparative + CSV surfaces mirror the same groups.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, accounts, companies, auditLog, transactions, journalLines,
  tbGroupings, tbGroupingAccounts,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as accountsService from './accounts.service.js';
import * as reportService from './report.service.js';
import * as comparisonService from './report-comparison.service.js';
import { extractDataAndColumns } from '../routes/reports.routes.js';
import { toCsv } from './report-export.service.js';

let tenantId = '';
let companyId = '';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(tbGroupingAccounts).where(eq(tbGroupingAccounts.tenantId, tenantId));
  await db.delete(tbGroupings).where(eq(tbGroupings.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function leadsheet(code: string, name: string, sortOrder: number, accountIds: string[]) {
  const [g] = await db.insert(tbGroupings).values({ tenantId, companyId, name, leadsheetCode: code, sortOrder }).returning();
  for (const accountId of accountIds) {
    await db.insert(tbGroupingAccounts).values({ tenantId, companyId, groupingId: g!.id, accountId });
  }
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'Leadsheet Grouping Test', slug: `lsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'LSG Co' }).returning();
  companyId = c!.id;

  const mk = (name: string, accountType: string, accountNumber: string, detailType: string) =>
    accountsService.create(tenantId, { name, accountNumber, accountType: accountType as never, detailType });
  const checking = await mk('Checking', 'asset', '1000', 'bank');
  const savings = await mk('Savings', 'asset', '1010', 'bank');
  const ar = await mk('Receivables', 'asset', '1200', 'accounts_receivable');
  const prepaid = await mk('Prepaid', 'asset', '1400', 'other_current_asset');
  const sales = await mk('Sales', 'revenue', '4000', 'service');
  const rent = await mk('Rent', 'expense', '6000', 'rent_or_lease');
  const ads = await mk('Ads', 'expense', '6100', 'advertising');

  // B sorts before A on purpose: sort_order wins over the code.
  await leadsheet('B', 'Receivables', 0, [ar.id]);
  await leadsheet('A', 'Cash', 1, [checking.id, savings.id]);
  await leadsheet('M', 'Operating Expenses', 2, [rent.id, ads.id]);
  // Prepaid and Sales are on no leadsheet.

  await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry', txnDate: '2026-03-01', memo: 'Activity',
    lines: [
      { accountId: checking.id, debit: '100.00', credit: '0' },
      { accountId: savings.id, debit: '50.00', credit: '0' },
      { accountId: ar.id, debit: '25.00', credit: '0' },
      { accountId: prepaid.id, debit: '5.00', credit: '0' },
      { accountId: rent.id, debit: '30.00', credit: '0' },
      { accountId: ads.id, debit: '10.00', credit: '0' },
      { accountId: sales.id, debit: '0', credit: '220.00' },
    ],
  }, undefined, companyId);
});

afterEach(cleanDb);

describe('leadsheet grouping on financial reports', () => {
  it('Balance Sheet assets group by leadsheet sort order, unassigned last', async () => {
    const bs = await reportService.buildBalanceSheet(tenantId, '2026-12-31', 'accrual', null, null, 'leadsheet');
    expect(bs.groupBy).toBe('leadsheet');
    const assets = bs.groups!.assets;
    expect(assets.map((g) => g.label)).toEqual(['B — Receivables', 'A — Cash', 'Not on a leadsheet']);
    expect(assets[1]!.subtotal).toBe(150);
    expect(assets[1]!.leadsheetCode).toBe('A');
    expect(assets[2]!.entries.map((e) => e.name)).toEqual(['Prepaid']);
    // Computed net income has no account → its own trailing group.
    expect(bs.groups!.equity.at(-1)!.label).toBe('Equity (Calculated)');
  });

  it('P&L groups by leadsheet, company-scoped too', async () => {
    const pl = await reportService.buildProfitAndLoss(tenantId, '2026-01-01', '2026-12-31', 'accrual', companyId, null, 'leadsheet');
    expect(pl.groups!.expenses.map((g) => [g.label, g.subtotal])).toEqual([['M — Operating Expenses', 40]]);
    expect(pl.groups!.revenue.map((g) => g.label)).toEqual(['Not on a leadsheet']);
  });

  it('comparative Balance Sheet carries the same leadsheet groups', async () => {
    const cbs = await comparisonService.buildComparativeBS(tenantId, '2026-12-31', 'accrual', 'previous_year', null, 'leadsheet');
    const assets = (cbs as { groups?: { assets: Array<{ label: string; values: Array<number | null> }> } }).groups!.assets;
    expect(assets.map((g) => g.label)).toEqual(['B — Receivables', 'A — Cash', 'Not on a leadsheet']);
    expect(assets[1]!.values[0]).toBe(150);
    expect(assets[1]!.values[1]).toBe(0);
  });

  it('CSV export lists leadsheet groups in order', async () => {
    const bs = await reportService.buildBalanceSheet(tenantId, '2026-12-31', 'accrual', null, null, 'leadsheet');
    const { rows, columns } = extractDataAndColumns({ ...bs, display: 'condensed' });
    const csv = toCsv(rows, columns);
    const b = csv.indexOf('B — Receivables');
    const a = csv.indexOf('A — Cash');
    expect(b).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(b);
    expect(csv).not.toContain('Checking'); // condensed: subtotal rows only
  });
});
