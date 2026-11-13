// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-219 (reports-by-account-balance-v1, ClientLedger A09 Q-A09b): the
// Assets / Liabilities / Equity by Account summaries total each account's
// balance at the end date, equal to the Balance Sheet's account balance and
// to the detail group's endingBalance (beginningBalance + subtotal), on both
// bases. Revenue by Category stays the range's net (U-216).
//
// Equity by Account shows posted balances only: the Balance Sheet's computed
// earnings (prior years' net income folded into a designated Retained
// Earnings account, or its own "Retained Earnings (Prior Years)" row, and
// "Net Income (Current Year)") have no ledger lines and are not in it, so
// the summary total + those earnings = the Balance Sheet's total equity.
//
// Books: invoices A (Sep 15, 250.00) and B (Oct 20, 500.00) before the
// range; A paid in full and B in part inside it (cash recognizes them
// then); prior-year capital and income; a loan and a repayment, an owner's
// draw and an expense inside the range. A December range has no activity
// on most accounts, which must still be listed at their balance.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import { and, eq } from 'drizzle-orm';
import { accounts } from '../db/schema/index.js';
import { db } from '../db/index.js';
import * as ledger from '../services/ledger.service.js';
import { buildAccountDetailReport, buildBalanceSheet } from '../services/report.service.js';
import { ReportDecimal as Decimal } from '../services/report-exact.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { paymentsRouter } from './payments.routes.js';
import { reportsRouter } from './reports.routes.js';
import { Harness, type Co } from './receivables.test-support.js';

const h = new Harness();
let c: Co;
let capital = '';
let draws = '';
let loan = '';
let reAccount = '';

const D = (x: string | number | null | undefined) => new Decimal(String(x ?? 0)).toFixed(4);
const RANGES: Array<[string, string]> = [['2026-11-01', '2026-11-30'], ['2026-12-01', '2026-12-31'], ['2026-01-01', '2026-12-31']];
const GROUPS = [
  { path: '/assets-by-account', types: ['asset'], side: 'debit' as const, bs: 'assets' },
  { path: '/liabilities-by-account', types: ['liability'], side: 'credit' as const, bs: 'liabilities' },
  { path: '/equity-by-account', types: ['equity'], side: 'credit' as const, bs: 'equity' },
];

type BsEntry = { accountId: string | null; name: string; balanceExact: string; includesPriorYearsIncome?: true; priorYearsIncomeExact?: string };

async function summary(path: string, from: string, to: string, basis: 'accrual' | 'cash') {
  const r = await h.request('GET', `/api/v1/reports${path}?start_date=${from}&end_date=${to}&basis=${basis}`, c.token);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return Object.fromEntries((r.json['data'] as Array<{ account_id: string; total: string }>).map((x) => [x.account_id, D(x.total)]));
}

/** The Balance Sheet's balance per account at `to`; Retained Earnings without the prior years' income it folds in. */
async function bsPosted(to: string, basis: 'accrual' | 'cash', section: string) {
  const bs = await buildBalanceSheet(c.tenantId, to, basis, null, null, null, { exactAmounts: true }) as unknown as Record<string, unknown>;
  const m: Record<string, string> = {};
  let computed = new Decimal(0);
  for (const e of bs[section] as BsEntry[]) {
    if (e.accountId === null) { computed = computed.plus(e.balanceExact); continue; }
    const fold = e.includesPriorYearsIncome ? new Decimal(e.priorYearsIncomeExact!) : new Decimal(0);
    computed = computed.plus(fold);
    const posted = new Decimal(e.balanceExact).minus(fold);
    if (!posted.isZero()) m[e.accountId] = posted.toFixed(4);
  }
  return { posted: m, computed, bs };
}

beforeAll(async () => {
  await h.start([['/api/v1/payments', paymentsRouter], ['/api/v1/reports', reportsRouter]]);
  c = await h.company();
  await h.seed(c);
  const mk = async (name: string, num: string, accountType: string) =>
    (await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyId, name, accountNumber: num, accountType } as never).returning())[0]!.id;
  capital = await mk("Owner's Capital U219", '3910', 'equity');
  draws = await mk("Owner's Draws U219", '3920', 'equity');
  loan = await mk('Bank Loan U219', '2910', 'liability');
  reAccount = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'retained_earnings')) }))?.id ?? '';
  expect(reAccount).not.toBe('');

  const bank = c.roles['operating']!;
  const je = (date: string, lines: Array<{ accountId: string; debit: string; credit: string }>) =>
    ledger.postTransaction(c.tenantId, { txnType: 'journal_entry', txnDate: date, lines } as never, c.userId, c.companyId);
  // Prior year: capital and income (the prior years' earnings).
  await je('2025-06-01', [{ accountId: bank, debit: '1000.00', credit: '0' }, { accountId: capital, debit: '0', credit: '1000.00' }]);
  await je('2025-07-01', [{ accountId: bank, debit: '300.00', credit: '0' }, { accountId: c.roles['sales']!, debit: '0', credit: '300.00' }]);
  // In the range: payments of the earlier invoices, a loan and a repayment, a draw, an expense.
  const A = c.invoices.get('A')!;
  const B = c.invoices.get('B')!;
  const r1 = await h.receive(c, { date: '2026-11-05', amount: '250.00', depositTo: bank, applications: [{ invoiceId: A, amount: '250.00' }] });
  expect(r1.status, JSON.stringify(r1.json)).toBe(201);
  const r2 = await h.receive(c, { date: '2026-11-20', amount: '200.00', depositTo: bank, applications: [{ invoiceId: B, amount: '200.00' }] });
  expect(r2.status, JSON.stringify(r2.json)).toBe(201);
  await je('2026-11-08', [{ accountId: bank, debit: '2000.00', credit: '0' }, { accountId: loan, debit: '0', credit: '2000.00' }]);
  await je('2026-11-09', [{ accountId: loan, debit: '100.00', credit: '0' }, { accountId: bank, debit: '0', credit: '100.00' }]);
  await je('2026-11-11', [{ accountId: draws, debit: '40.00', credit: '0' }, { accountId: bank, debit: '0', credit: '40.00' }]);
  await je('2026-11-12', [{ accountId: c.roles['expense']!, debit: '50.00', credit: '0' }, { accountId: bank, debit: '0', credit: '50.00' }]);
}, 120_000);

afterAll(async () => { await h.stop(); });

describe('<Group> by Account summaries show the ending balance (reports-by-account-balance-v1, U-219)', () => {
  it('advertises the capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('reports-by-account-balance-v1');
  });

  for (const basis of ['accrual', 'cash'] as const) {
    for (const [from, to] of RANGES) {
      it(`each summary equals the Balance Sheet's account balance and the detail endingBalance (${basis}, ${from}..${to})`, async () => {
        for (const g of GROUPS) {
          const got = await summary(g.path, from, to, basis);
          const { posted } = await bsPosted(to, basis, g.bs);
          expect(got, g.path).toEqual(posted);
          const det = await buildAccountDetailReport(c.tenantId, from, to, {
            title: 't', accountTypes: g.types, normalSide: g.side, carryForward: true, detail: true, exactAmounts: true, basis,
          });
          if (!('groups' in det)) throw new Error('detail');
          const ends = Object.fromEntries(det.groups
            .filter((x) => !new Decimal(x.endingBalanceExact!).isZero())
            .map((x) => [x.accountId, D(x.endingBalanceExact)]));
          expect(ends, `${g.path} detail`).toEqual(got);
          for (const x of det.groups) {
            expect(D(new Decimal(x.beginningBalanceExact!).plus(x.subtotalExact!).toFixed(4)), `${g.path} ${x.name}`).toBe(D(x.endingBalanceExact));
          }
        }
      });
    }

    it(`Equity by Account is posted balances only; with the computed earnings it is the Balance Sheet's total equity (${basis})`, async () => {
      for (const designated of [true, false]) {
        if (!designated) await db.update(accounts).set({ systemTag: null }).where(eq(accounts.id, reAccount));
        try {
          for (const [from, to] of RANGES) {
            const got = await summary('/equity-by-account', from, to, basis);
            const { posted, computed, bs } = await bsPosted(to, basis, 'equity');
            expect(got).toEqual(posted);
            // The prior years' earnings exist and are not an Equity by Account line.
            expect(computed.isZero()).toBe(false);
            if (designated) expect(got[reAccount]).toBeUndefined();
            const sum = Object.values(got).reduce((s, v) => s.plus(v), new Decimal(0));
            expect(sum.plus(computed).toFixed(4)).toBe(D(bs['totalEquityExact'] as string));
            expect(got[capital]).toBe('1000.0000');
            expect(got[draws]).toBe(to < '2026-11-11' ? undefined : '-40.0000');
          }
        } finally {
          if (!designated) await db.update(accounts).set({ systemTag: 'retained_earnings' }).where(eq(accounts.id, reAccount));
        }
      }
    });
  }

  it('the start date no longer bounds the summary; the loan shows its balance in a month without activity', async () => {
    const dec = await summary('/liabilities-by-account', '2026-12-01', '2026-12-31', 'accrual');
    expect(dec[loan]).toBe('1900.0000');
    const assets = await summary('/assets-by-account', '2026-12-01', '2026-12-31', 'accrual');
    // A/R: invoice B's open 300.00.
    expect(assets[c.roles['accounts_receivable']!]).toBe('300.0000');
  });
});
