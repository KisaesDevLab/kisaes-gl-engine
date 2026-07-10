// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Presentation order for custom detail types (migration 0117,
// tenant_detail_types.sort_order) on every grouped report surface:
//   - standard P&L / Balance Sheet (?group_by=detail_type)
//   - comparative P&L
//   - CSV export (extractDataAndColumns + toCsv mirror the builders'
//     group arrays, so the CSV row order proves the export surface)
// Expected composition: stock detail-type groups keep the report's
// native first-occurrence order, CUSTOM groups follow ordered by
// sort_order (label tiebreak), null-detail groups trail.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags, tenantDetailTypes,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as accountsService from './accounts.service.js';
import * as reportService from './report.service.js';
import * as comparisonService from './report-comparison.service.js';
import * as detailTypesService from './detail-types.service.js';
import { extractDataAndColumns } from '../routes/reports.routes.js';
import { toCsv } from './report-export.service.js';

let tenantId: string;

async function cleanDb() {
  await db.delete(transactionTags);
  await db.delete(tags);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(auditLog);
  await db.delete(contacts);
  await db.delete(tenantDetailTypes);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

async function mkAccount(name: string, accountType: string, accountNumber: string, detailType: string) {
  return accountsService.create(tenantId, {
    name, accountNumber, accountType: accountType as never, detailType,
  });
}

async function post(memo: string, debits: Array<{ id: string; amount: string }>, credits: Array<{ id: string; amount: string }>, date: string) {
  const lines = [
    ...debits.map((d) => ({ accountId: d.id, debit: d.amount, credit: '0' })),
    ...credits.map((c) => ({ accountId: c.id, debit: '0', credit: c.amount })),
  ];
  return ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: date, memo, lines });
}

// Custom detail types are seeded so that neither the label-alphabetical
// order nor the account-number (first-occurrence) order matches the
// sort_order — only correct sort_order handling passes:
//   expense sort_order: Zeta Fees (0), Mid Costs (1), Legal Retainers (2)
//   labels alphabetically:  Legal < Mid < Zeta   (reverse)
//   account numbers:        legal 6100, zeta 6200, mid 6300 (different again)
let zetaId: string;

async function seed() {
  const zeta = await detailTypesService.create(tenantId, {
    accountType: 'expense', value: 'zeta_fees', label: 'Zeta Fees', sortOrder: 0,
  });
  zetaId = zeta.id;
  await detailTypesService.create(tenantId, {
    accountType: 'expense', value: 'mid_costs', label: 'Mid Costs', sortOrder: 1,
  });
  await detailTypesService.create(tenantId, {
    accountType: 'expense', value: 'legal_retainers', label: 'Legal Retainers', sortOrder: 2,
  });
  // Asset customs for the Balance Sheet: number order (art 1500 < crypto
  // 1600) is the reverse of sort_order (crypto 0, art 1).
  await detailTypesService.create(tenantId, {
    accountType: 'asset', value: 'crypto_wallet', label: 'Crypto Wallet', sortOrder: 0,
  });
  await detailTypesService.create(tenantId, {
    accountType: 'asset', value: 'art_collection', label: 'Art Collection', sortOrder: 1,
  });

  const cash = await mkAccount('Cash', 'asset', '1000', 'bank');
  const art = await mkAccount('Paintings', 'asset', '1500', 'art_collection');
  const crypto = await mkAccount('Cold Wallet', 'asset', '1600', 'crypto_wallet');
  const sales = await mkAccount('Sales', 'revenue', '4000', 'service');
  const ads = await mkAccount('Ads', 'expense', '6000', 'advertising');
  const legal = await mkAccount('Legal', 'expense', '6100', 'legal_retainers');
  const zetaAcct = await mkAccount('Zeta', 'expense', '6200', 'zeta_fees');
  const mid = await mkAccount('Mid', 'expense', '6300', 'mid_costs');

  await post('Activity',
    [
      { id: ads.id, amount: '10.00' },
      { id: legal.id, amount: '10.00' },
      { id: zetaAcct.id, amount: '10.00' },
      { id: mid.id, amount: '10.00' },
      { id: art.id, amount: '20.00' },
      { id: crypto.id, amount: '20.00' },
      { id: cash.id, amount: '30.00' },
    ],
    [{ id: sales.id, amount: '110.00' }],
    '2026-03-01',
  );
}

beforeEach(async () => {
  await cleanDb();
  const [tenant] = await db.insert(tenants).values({ name: 'DT Order Test', slug: `dto-${Date.now()}` }).returning();
  tenantId = tenant!.id;
  await seed();
});

afterEach(async () => {
  await cleanDb();
});

describe('custom detail-type presentation order in grouped reports', () => {
  it('P&L expense groups: stock first (native order), then customs by sort_order', async () => {
    const pl = await reportService.buildProfitAndLoss(
      tenantId, '2026-01-01', '2026-12-31', 'accrual', null, null, 'detail_type');
    const labels = (pl.groups?.expenses ?? []).map((g) => g.label);
    expect(labels).toEqual(['Advertising', 'Zeta Fees', 'Mid Costs', 'Legal Retainers']);
  });

  it('Balance Sheet asset groups follow sort_order after the stock groups', async () => {
    const bs = await reportService.buildBalanceSheet(
      tenantId, '2026-12-31', 'accrual', null, null, 'detail_type');
    const labels = (bs.groups?.assets ?? []).map((g) => g.label);
    expect(labels).toEqual(['Bank', 'Crypto Wallet', 'Art Collection']);
  });

  it('comparative P&L groups follow the same order', async () => {
    const cpl = await comparisonService.buildComparativePL(
      tenantId, '2026-01-01', '2026-12-31', 'accrual', 'previous_period', 6, 'month', null, 'detail_type');
    const labels = (cpl.groups?.expenses ?? []).map((g) => g.label);
    expect(labels).toEqual(['Advertising', 'Zeta Fees', 'Mid Costs', 'Legal Retainers']);
  });

  it('CSV export mirrors the grouped screen order', async () => {
    const pl = await reportService.buildProfitAndLoss(
      tenantId, '2026-01-01', '2026-12-31', 'accrual', null, null, 'detail_type');
    const { rows, columns } = extractDataAndColumns(pl);
    const csv = toCsv(rows, columns);
    const zeta = csv.indexOf('Zeta Fees');
    const mid = csv.indexOf('Mid Costs');
    const legal = csv.indexOf('Legal Retainers');
    expect(zeta).toBeGreaterThan(-1);
    expect(mid).toBeGreaterThan(zeta);
    expect(legal).toBeGreaterThan(mid);
  });

  it('updating sort_order (the PATCH route service) reorders the groups', async () => {
    // Push Zeta Fees to the end: Mid (1), Legal (2), Zeta (5).
    await detailTypesService.update(tenantId, zetaId, { sortOrder: 5 });
    const pl = await reportService.buildProfitAndLoss(
      tenantId, '2026-01-01', '2026-12-31', 'accrual', null, null, 'detail_type');
    const labels = (pl.groups?.expenses ?? []).map((g) => g.label);
    expect(labels).toEqual(['Advertising', 'Mid Costs', 'Legal Retainers', 'Zeta Fees']);
  });
});
