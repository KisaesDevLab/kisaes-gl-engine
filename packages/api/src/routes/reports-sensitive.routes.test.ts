// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Sensitive accounts (U-33), E7-E8 over HTTP, exact strings, cash and
// accrual: the P&L leaves hidden rows out and its net income equals the
// Balance Sheet's earnings row; the Balance Sheet gap equals the hidden net
// (Q-P29a, asserted to document the rule); TB, GL and Transaction List show
// no hidden line; hiddenNotice only for the restricted viewer; unconverted
// report routes refuse.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import DecimalLib from 'decimal.js';
import * as ledger from '../services/ledger.service.js';
import { startSensitiveHarness, type SensitiveHarness } from './sensitive.test-fixtures.js';

const Decimal = DecimalLib.default || DecimalLib;
let h: SensitiveHarness;
const R = 'start_date=2026-01-01&end_date=2026-12-31';
const ASOF = 'as_of_date=2026-12-31';

beforeAll(async () => {
  h = await startSensitiveHarness('sens-reports');
  const post = (memo: string, lines: Array<{ accountId: string; debit: string; credit: string }>, txnType = 'expense') =>
    ledger.postTransaction(h.tenantId, { txnType: txnType as never, txnDate: '2026-03-01', memo, lines }, h.ownerId, h.companyId);
  await post('sale', [{ accountId: h.acct.bank, debit: '1000.00', credit: '0' }, { accountId: h.acct.sales, debit: '0', credit: '1000.00' }], 'deposit');
  await post('paper', [{ accountId: h.acct.supplies, debit: '10.00', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '10.00' }]);
  await post('payroll', [{ accountId: h.acct.wagesSub, debit: '4321.09', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '4321.09' }]);
  await post('mixed', [
    { accountId: h.acct.wages, debit: '1234.57', credit: '0' },
    { accountId: h.acct.supplies, debit: '5.00', credit: '0' },
    { accountId: h.acct.bank, debit: '0', credit: '1239.57' },
  ], 'journal_entry');
});

afterAll(async () => { await h.close(); });

function noCanary(text: string) {
  expect(text).not.toContain('Canary');
  expect(text).not.toContain('1234.57');
  expect(text).not.toContain(h.acct.wages);
  expect(text).not.toContain(h.acct.wagesSub);
}

describe('statements and ledger reports for a viewer without sensitive_accounts', () => {
  it('nothing marked: the bookkeeper sees what the owner sees, no notice', async () => {
    for (const p of [`/api/v1/reports/profit-loss?${R}&exact=1`, `/api/v1/reports/trial-balance?${R}&exact=1`]) {
      const bk = await h.call('bk', 'GET', p);
      const own = await h.call('owner', 'GET', p);
      expect(bk.status).toBe(200);
      expect(bk.json.hiddenNotice).toBeUndefined();
      expect(bk.json).toEqual(own.json);
    }
  });

  it('after marking: P&L, BS, TB tie to the rule in both bases', async () => {
    await h.markWages();
    for (const basis of ['accrual', 'cash']) {
      const pl = await h.call('bk', 'GET', `/api/v1/reports/profit-loss?${R}&basis=${basis}&exact=1`);
      expect(pl.status).toBe(200);
      expect(pl.json.hiddenNotice).toBe(true);
      noCanary(pl.text);
      expect(pl.json.totalExpensesExact).toBe('15.0000');
      expect(pl.json.netIncomeExact).toBe('985.0000');
      const ownPl = await h.call('owner', 'GET', `/api/v1/reports/profit-loss?${R}&basis=${basis}&exact=1`);
      expect(ownPl.json.netIncomeExact).toBe('-4570.6600');
      expect(ownPl.json.hiddenNotice).toBeUndefined();
      expect(ownPl.text).toContain('Canary Wages');

      const bs = await h.call('bk', 'GET', `/api/v1/reports/balance-sheet?${ASOF}&basis=${basis}&exact=1`);
      expect(bs.status).toBe(200);
      expect(bs.json.hiddenNotice).toBe(true);
      noCanary(bs.text);
      const ni = bs.json.equity.find((e: { name: string }) => e.name === 'Net Income (Current Year)');
      expect(ni.balanceExact).toBe(pl.json.netIncomeExact);
      // Q-P29a: the gap equals the hidden accounts' net (4321.09 + 1234.57).
      const gap = new Decimal(bs.json.totalAssetsExact).minus(bs.json.totalLiabilitiesAndEquityExact);
      expect(gap.toFixed(4)).toBe('-5555.6600');
      const ownBs = await h.call('owner', 'GET', `/api/v1/reports/balance-sheet?${ASOF}&basis=${basis}&exact=1`);
      expect(ownBs.json.totalAssetsExact).toBe(ownBs.json.totalLiabilitiesAndEquityExact);

      const tb = await h.call('bk', 'GET', `/api/v1/reports/trial-balance?${R}&basis=${basis}&exact=1`);
      expect(tb.status).toBe(200);
      expect(tb.json.hiddenNotice).toBe(true);
      noCanary(tb.text);
      expect(new Decimal(tb.json.totalCreditsExact).minus(tb.json.totalDebitsExact).toFixed(4)).toBe('5555.6600');
    }
  });

  it('legacy (non-exact) P&L, compare and CSV also leave hidden rows out', async () => {
    const pl = await h.call('bk', 'GET', `/api/v1/reports/profit-loss?${R}`);
    expect(pl.status).toBe(200);
    expect(pl.json.hiddenNotice).toBe(true);
    expect(pl.json.totalExpenses).toBe(15);
    noCanary(pl.text);
    const cmp = await h.call('bk', 'GET', `/api/v1/reports/profit-loss?${R}&compare=previous_period`);
    expect(cmp.status).toBe(200);
    noCanary(cmp.text);
    const csv = await h.call('bk', 'GET', `/api/v1/reports/profit-loss?${R}&format=csv`);
    expect(csv.status).toBe(200);
    noCanary(csv.text);
    expect(csv.text).toContain('Some amounts are hidden for your role');
  });

  it('GL and Transaction List show only visible lines; a mixed entry keeps its visible lines', async () => {
    for (const p of [
      `/api/v1/reports/general-ledger?${R}`, `/api/v1/reports/general-ledger?${R}&exact=1`,
      `/api/v1/reports/general-ledger?${R}&exact=1&account_ids=${h.acct.wages}`,
      `/api/v1/reports/transaction-list?${R}`, `/api/v1/reports/transaction-list?${R}&exact=1`,
      `/api/v1/reports/transaction-list?${R}&basis=cash`,
    ]) {
      const r = await h.call('bk', 'GET', p);
      expect(r.status, p).toBe(200);
      expect(r.json.hiddenNotice, p).toBe(true);
      noCanary(r.text);
    }
    // The converted POST forms (account lists in the body) too.
    for (const p of ['/api/v1/reports/general-ledger?exact=1', '/api/v1/reports/transaction-list?exact=1']) {
      const r = await h.call('bk', 'POST', p, { start_date: '2026-01-01', end_date: '2026-12-31', account_ids: [h.acct.wages, h.acct.supplies] });
      expect(r.status, `${p} ${r.text.slice(0, 200)}`).toBe(200);
      expect(r.json.hiddenNotice, p).toBe(true);
      noCanary(r.text);
    }
    const tl = await h.call('bk', 'GET', `/api/v1/reports/transaction-list?${R}&exact=1`);
    const mixed = tl.json.data.filter((l: { memo: string }) => l.memo === 'mixed');
    expect(mixed.map((l: { account_name: string }) => l.account_name).sort()).toEqual(['Checking', 'Supplies']);
    const own = await h.call('owner', 'GET', `/api/v1/reports/transaction-list?${R}&exact=1`);
    expect(own.text).toContain('1234.57');
  });

  it('dashboard (E11): revenue and expenses leave hidden accounts out, exact strings', async () => {
    const bk = await h.call('bk', 'GET', '/api/v1/dashboard/snapshot?exact=1&asOf=2026-03-31');
    expect(bk.status).toBe(200);
    expect(bk.json.mtd).toEqual({ revenue: '1000.0000', expenses: '15.0000', netIncome: '985.0000' });
    noCanary(bk.text);
    const own = await h.call('owner', 'GET', '/api/v1/dashboard/snapshot?exact=1&asOf=2026-03-31');
    expect(own.json.mtd).toEqual({ revenue: '1000.0000', expenses: '5570.6600', netIncome: '-4570.6600' });
    const sum = await h.call('bk', 'GET', '/api/v1/dashboard/summary?exact=1&asOf=2026-03-31');
    expect(sum.status).toBe(200);
    expect(sum.json.snapshot.mtd.expenses).toBe('15.0000');
    expect(sum.json.errors).toEqual([]);
    noCanary(sum.text);
    const trend = await h.call('bk', 'GET', '/api/v1/dashboard/trend?exact=1&asOf=2026-03-31&months=1');
    expect(trend.json.data[0].expenses).toBe('15.0000');
  });

  it('unconverted report routes refuse the bookkeeper, not the owner', async () => {
    for (const p of ['/api/v1/reports/cash-flow', '/api/v1/reports/sales-tax-liability', '/api/v1/chat/conversations', '/api/v1/reports/vendor-1099-summary']) {
      const r = await h.call('bk', 'GET', p);
      expect(r.status, p).toBe(403);
      expect(r.json.error.code).toBe('SENSITIVE_HIDDEN');
    }
    expect((await h.call('owner', 'GET', `/api/v1/reports/cash-flow?${R}`)).status).toBe(200);
  });
});
