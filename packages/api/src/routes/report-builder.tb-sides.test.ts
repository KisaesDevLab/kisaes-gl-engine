// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Report Builder Trial Balance debit / credit per account (U-225, ClientLedger
// PR-A2 engine review B-1). A tb_net section decides each account's side on
// the account's whole net for the section's scope, as buildTrialBalance does;
// every line shows its part of each account in that account's column (a slice
// against the account's side is negative there, never positive in the other
// column). So, for every group-by the editor allows and in every display mode:
//   - the section Total = buildTrialBalance's totals;
//   - an account line = its buildTrialBalance row, on one side only;
//   - the slices of an account (account then tag or contact) sum to it;
//   - any line = the sum of its children, and the outer lines plus the
//     earnings row = the Total;
//   - a line's drill subtotal = the line, and its rows' debit - credit = the
//     line's debit - credit.
// Books (the review's): standard TB at 2026-03-31 7,105.00 accrual and
// 7,405.00 cash; the review's wrong totals were 7,075.00 ([account_type]),
// 7,205.00 ([account, tag], [tag, account]), 7,405.00 ([account, contact])
// and 1,200.00 (no group-by) on accrual.

import 'express-async-errors';
import express from 'express';
import type { AddressInfo } from 'net';
import http from 'http';
import type { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BUILDER_STARTERS, type BuilderDefinition, type RbSectionNode } from '@kis-books/shared';
import { reportBuilderRouter } from './report-builder.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { db } from '../db/index.js';
import { accounts, billPaymentApplications, paymentApplications, tagGroups, tags } from '../db/schema/index.js';
import * as ledger from '../services/ledger.service.js';
import * as reportService from '../services/report.service.js';
import { ReportDecimal as Decimal } from '../services/report-exact.js';
import { makeCompany, cleanTenant, suffix, type Co } from '../services/templates/templates.test-helpers.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
let c: Co;
let bank2 = '';
let loan = '';
let tagA = '';
let tagB = '';
let group = '';
const FY = ['2025-01-01', '2026-01-01'];
const AS_OF = '2026-03-31';

function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: ReturnType<typeof JSON.parse> }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1/report-builder${p}`, method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}`, 'X-Company-Id': c.companyId, ...(data ? { 'Content-Length': String(data.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

type Col = { key: string; kind: string };
type Row = { kind: string; nodeId: string; path: string[]; caption: string; cells: Array<string | null> };
type RunJson = { rows: Row[]; columns: Col[]; fingerprint: string; stamp: number };

const D = (x: string | number | null | undefined) => new Decimal(x ?? 0).toFixed(4);
const Dn = (x: string | null | undefined) => (x === null || x === undefined ? null : new Decimal(x).toFixed(4));

type L = { accountId: string; debit: string; credit: string; contactId?: string; tagId?: string };
const post = (txnType: string, date: string, lines: L[], extra: Record<string, unknown> = {}) =>
  ledger.postTransaction(c.tenantId, {
    txnType: txnType as never, txnDate: date, memo: txnType, lines,
    total: lines.reduce((s, l) => s.plus(l.debit), new Decimal(0)).toFixed(4), ...extra,
  } as never, c.userId, c.companyId);

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/report-builder', reportBuilderRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
  c = await makeCompany(`rbtb${suffix().slice(-4)}`, tenantIds);
  const [b2] = await db.insert(accounts).values({ tenantId: c.tenantId, name: `Overdrawn ${suffix()}`, accountType: 'asset', detailType: 'bank' }).returning();
  const [ln] = await db.insert(accounts).values({ tenantId: c.tenantId, name: `Loan ${suffix()}`, accountType: 'liability', detailType: 'long_term_liability' }).returning();
  bank2 = b2!.id; loan = ln!.id;
  const [g] = await db.insert(tagGroups).values({ tenantId: c.tenantId, companyId: c.companyId, name: `Jobs ${suffix()}` }).returning();
  group = g!.id;
  const [a] = await db.insert(tags).values({ tenantId: c.tenantId, groupId: group, name: `Job A ${suffix()}` }).returning();
  const [b] = await db.insert(tags).values({ tenantId: c.tenantId, groupId: group, name: `Job B ${suffix()}` }).returning();
  tagA = a!.id; tagB = b!.id;

  // 2025: a loan, prior-year income, an invoice paid 400.00 then 600.00 (in 2026), a bill paid in 2026.
  await post('journal_entry', '2025-11-01', [{ accountId: c.bank, debit: '5000.00', credit: '0' }, { accountId: loan, debit: '0', credit: '5000.00' }]);
  await post('cash_sale', '2025-06-30', [{ accountId: c.bank, debit: '500.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '500.00' }]);
  const inv = await post('invoice', '2025-12-10', [{ accountId: c.ar, debit: '1000.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '1000.00' }], { contactId: c.customer, dueDate: '2026-01-09' });
  const bill = await post('bill', '2025-12-05', [{ accountId: c.expense, debit: '300.00', credit: '0' }, { accountId: c.ap, debit: '0', credit: '300.00' }], { contactId: c.vendor, dueDate: '2026-01-04' });
  const p1 = await post('customer_payment', '2025-12-20', [{ accountId: c.bank, debit: '400.00', credit: '0' }, { accountId: c.ar, debit: '0', credit: '400.00' }], { contactId: c.customer });
  await db.insert(paymentApplications).values({ tenantId: c.tenantId, companyId: c.companyId, paymentId: p1.id, invoiceId: inv.id, amount: '400.0000' });
  const bp = await post('bill_payment', '2026-01-20', [{ accountId: c.ap, debit: '300.00', credit: '0' }, { accountId: c.bank, debit: '0', credit: '300.00' }], { contactId: c.vendor });
  await db.insert(billPaymentApplications).values({ tenantId: c.tenantId, companyId: c.companyId, paymentId: bp.id, billId: bill.id, amount: '300.0000' });
  // 2026: Savings +1,000.00 on job A and -100.00 on job B (one account, debit-net 900.00, a credit-side slice).
  await post('journal_entry', '2026-01-10', [{ accountId: c.savings, debit: '1000.00', credit: '0', tagId: tagA }, { accountId: c.income, debit: '0', credit: '1000.00' }]);
  await post('journal_entry', '2026-01-25', [{ accountId: c.expense, debit: '100.00', credit: '0' }, { accountId: c.savings, debit: '0', credit: '100.00', tagId: tagB }]);
  await post('journal_entry', '2026-02-01', [{ accountId: loan, debit: '200.00', credit: '0' }, { accountId: c.bank, debit: '0', credit: '200.00' }]);
  const p2 = await post('customer_payment', '2026-02-15', [{ accountId: c.bank, debit: '600.00', credit: '0' }, { accountId: c.ar, debit: '0', credit: '600.00' }], { contactId: c.customer });
  await db.insert(paymentApplications).values({ tenantId: c.tenantId, companyId: c.companyId, paymentId: p2.id, invoiceId: inv.id, amount: '600.0000' });
  await post('cash_sale', '2026-02-20', [{ accountId: c.bank, debit: '75.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '75.00' }]);
  // An overdrawn bank (a credit-balance asset).
  await post('expense', '2026-03-05', [{ accountId: c.expense, debit: '30.00', credit: '0' }, { accountId: bank2, debit: '0', credit: '30.00' }], { contactId: c.vendor });
  // An account whose whole net is zero but whose job slices are not: 50.00 on job A, -50.00 on job B.
  await post('journal_entry', '2026-03-10', [{ accountId: c.expense2, debit: '50.00', credit: '0', tagId: tagA }, { accountId: c.bank, debit: '0', credit: '50.00' }]);
  await post('journal_entry', '2026-03-12', [{ accountId: c.bank, debit: '50.00', credit: '0' }, { accountId: c.expense2, debit: '0', credit: '50.00', tagId: tagB }]);
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const tbDef = (groupBy: string[], display: 'summary' | 'expandable' | 'detail', filters: RbSectionNode['filters'] = []): BuilderDefinition => {
  const d = JSON.parse(JSON.stringify(BUILDER_STARTERS.find((s) => s.key === 'trial_balance')!.definition)) as BuilderDefinition;
  const s = d.nodes[0] as RbSectionNode;
  s.groupBy = groupBy.map((key) => (key === 'tag' ? { key, tagGroupId: group } : { key })) as RbSectionNode['groupBy'];
  s.display = display;
  s.filters = [...s.filters, ...filters];
  return d;
};

async function runDef(definition: unknown, ref: Record<string, unknown>): Promise<RunJson> {
  const r = await call('POST', '/run', { definition, fiscalYearStarts: FY, ...ref });
  expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
  return r.json;
}

/** Every page of a drill: the subtotal and the rows' debit - credit (each row on its own side). */
async function drill(definition: unknown, ref: Record<string, unknown>, run: RunJson, path: string[], v: number) {
  let net = new Decimal(0);
  let subtotal: Array<string | null> = [];
  let cursor: string | null = null;
  do {
    const r = await call('POST', '/run/detail', { definition, fiscalYearStarts: FY, ...ref, nodeId: 'accounts', path, fingerprint: run.fingerprint, stamp: run.stamp, ...(cursor ? { cursor } : {}) });
    expect(r.status, `${path.join('/')} ${JSON.stringify(r.json).slice(0, 300)}`).toBe(200);
    subtotal = r.json.subtotal;
    for (const row of r.json.rows as Row[]) {
      if (row.kind !== 'detail' && row.kind !== 'opening') continue;
      net = net.plus(row.cells[v] ?? 0).minus(row.cells[v + 1] ?? 0);
    }
    cursor = r.json.cursor;
  } while (cursor);
  return { subtotal, net };
}

const GROUP_BYS: string[][] = [
  [], ['account'], ['account_type'], ['account_type', 'account'], ['account', 'tag'], ['tag', 'account'],
  ['account', 'contact'], ['account_type', 'account', 'tag'], ['tag', 'account_type', 'account'], ['contact', 'account', 'tag'],
];
const isSub = (a: string[], b: string[]) => a.length < b.length && a.every((x, i) => x === b[i]);

describe('Trial Balance debit / credit per account (B-1)', () => {
  for (const basis of ['accrual', 'cash'] as const) {
    it(`the Total and every line tie to buildTrialBalance for every group-by and mode (${basis})`, async () => {
      const ref = { dates: { asOf: AS_OF }, basis };
      const std = await reportService.buildTrialBalance(c.tenantId, '2026-01-01', AS_OF, c.companyId, null, basis, { exactAmounts: true }) as unknown as
        { totalDebitsExact: string; totalCreditsExact: string; data: Array<{ accountId: string | null; debitExact: string; creditExact: string }> };
      const stdTotal = [D(std.totalDebitsExact), D(std.totalCreditsExact)];
      // The review's books: the standard Trial Balance.
      expect(stdTotal).toEqual(basis === 'accrual' ? [D('7105'), D('7105')] : [D('7405'), D('7405')]);
      const stdOf = new Map(std.data.filter((r) => r.accountId).map((r) => [r.accountId!, [Dn(new Decimal(r.debitExact).isZero() ? null : r.debitExact), Dn(new Decimal(r.creditExact).isZero() ? null : r.creditExact)]]));

      for (const groupBy of GROUP_BYS) {
        const label = `[${groupBy.join(', ')}]`;
        const full = await runDef(tbDef(groupBy, 'expandable'), { ...ref, expandAll: true });
        const v = full.columns.findIndex((x) => x.kind !== 'field');
        const pair = (r: Row) => [Dn(r.cells[v]), Dn(r.cells[v + 1])];
        const total = full.rows.find((r) => r.kind === 'total')!;
        expect(pair(total), `${label} Total`).toEqual(stdTotal);

        // Every mode gives the same Total.
        for (const [mode, def, extra] of [
          ['summary', tbDef(groupBy, 'summary'), {}],
          ['expandable collapsed', tbDef(groupBy, 'expandable'), {}],
          ['detail', tbDef(groupBy, 'detail'), {}],
          ['export', tbDef(groupBy, 'expandable'), { expandAll: true, purpose: 'export' }],
        ] as Array<[string, BuilderDefinition, Record<string, unknown>]>) {
          const run = await runDef(def, { ...ref, ...extra });
          expect(pair(run.rows.find((r) => r.kind === 'total')!), `${label} ${mode} Total`).toEqual(stdTotal);
          // Lines shown in any mode are the same figures as when all are expanded.
          for (const l of run.rows.filter((r) => r.kind === 'line')) {
            expect(pair(l), `${label} ${mode} ${l.path.join('/')}`).toEqual(pair(full.rows.find((r) => r.kind === 'line' && r.path.join() === l.path.join())!));
          }
        }

        const lines = full.rows.filter((r) => r.kind === 'line');
        const sumOf = (rows: Row[]) => [0, 1].map((k) => rows.reduce((acc, r) => acc.plus(r.cells[v + k] ?? 0), new Decimal(0)).toFixed(4));
        const acctLevel = groupBy.indexOf('account');
        for (const l of lines) {
          const depth = l.path.length - 1;
          // Debit - credit of a line is its net, whatever the column.
          // An account line (or a slice of one) shows one side only; an account line = its buildTrialBalance row.
          if (acctLevel >= 0 && depth > acctLevel) expect(l.cells[v] === null || l.cells[v + 1] === null, `${label} ${l.path.join('/')} one side`).toBe(true);
          if (acctLevel >= 0 && depth === acctLevel + 1) {
            const id = l.path[acctLevel + 1]!.slice('account:'.length);
            // A whole account (no tag or contact above it).
            if (groupBy.slice(0, acctLevel).every((k) => k === 'account_type')) {
              expect(pair(l), `${label} account ${id}`).toEqual(stdOf.get(id) ?? [null, null]);
            }
          }
          // A line with lines below it = the sum of them.
          const kids = lines.filter((k) => k.path.length === l.path.length + 1 && isSub(l.path, k.path));
          if (kids.length) expect(pair(l).map((x) => x ?? D(0)), `${label} ${l.path.join('/')} = its lines`).toEqual(sumOf(kids));
        }
        // The outer lines and the earnings row = the Total.
        const outer = full.rows.filter((r) => (r.kind === 'line' && r.path.length === 2) || r.kind === 'earnings');
        if (groupBy.length) expect(sumOf(outer), `${label} outer lines = Total`).toEqual(stdTotal);

        // Every line's drill: subtotal = the line; the rows' debit - credit = the line's.
        for (const l of lines) {
          const d = await drill(tbDef(groupBy, 'expandable'), ref, full, l.path, v);
          expect([Dn(d.subtotal[v]), Dn(d.subtotal[v + 1])], `${label} drill ${l.path.join('/')}`).toEqual(pair(l));
          expect(d.net.toFixed(4), `${label} drill rows ${l.path.join('/')}`).toBe(new Decimal(l.cells[v] ?? 0).minus(l.cells[v + 1] ?? 0).toFixed(4));
        }
      }

      // Savings by job: 900.00 debit = 1,000.00 and (100.00), both in Debit.
      const byTag = await runDef(tbDef(['account', 'tag'], 'expandable'), { ...ref, expandAll: true });
      const v = byTag.columns.findIndex((x) => x.kind !== 'field');
      const at = (...p: string[]) => byTag.rows.find((r) => r.kind === 'line' && r.path.join() === ['n:accounts', ...p].join())!;
      const cellPair = (r: Row) => [Dn(r.cells[v]), Dn(r.cells[v + 1])];
      expect(cellPair(at(`account:${c.savings}`))).toEqual([D('900'), null]);
      expect(cellPair(at(`account:${c.savings}`, `tag:${tagA}`))).toEqual([D('1000'), null]);
      expect(cellPair(at(`account:${c.savings}`, `tag:${tagB}`))).toEqual([D('-100'), null]);
      // A zero-balance account: no figure; its slices 50.00 and (50.00) in Debit.
      expect(cellPair(at(`account:${c.expense2}`))).toEqual([null, null]);
      expect(cellPair(at(`account:${c.expense2}`, `tag:${tagA}`))).toEqual([D('50'), null]);
      expect(cellPair(at(`account:${c.expense2}`, `tag:${tagB}`))).toEqual([D('-50'), null]);
      // The overdrawn bank stays on the credit side under its account type.
      const byType = await runDef(tbDef(['account_type', 'account'], 'summary'), ref);
      expect(cellPair(byType.rows.find((r) => r.kind === 'line' && r.path.join() === ['n:accounts', 'account_type:asset'].join())!))
        .toEqual(basis === 'accrual' ? [D('6975'), D('30')] : [D('6975'), D('30')]);
      expect(cellPair(byType.rows.find((r) => r.kind === 'line' && r.path[2] === `account:${bank2}`)!)).toEqual([null, D('30')]);
    });

    it(`a tag filter decides each account's side on the filtered net, as buildTrialBalance does (${basis})`, async () => {
      const ref = { dates: { asOf: AS_OF }, basis };
      for (const tag of [tagA, tagB]) {
        const std = await reportService.buildTrialBalance(c.tenantId, '2026-01-01', AS_OF, c.companyId, tag, basis, { exactAmounts: true }) as unknown as
          { totalDebitsExact: string; totalCreditsExact: string; data: Array<{ accountId: string | null; debitExact: string; creditExact: string }> };
        for (const groupBy of [['account'], ['account', 'contact'], ['account_type'], []]) {
          const run = await runDef(tbDef(groupBy, 'summary', [{ field: 'tag', op: 'in', ids: [tag] }]), ref);
          const v = run.columns.findIndex((x) => x.kind !== 'field');
          const total = run.rows.find((r) => r.kind === 'total')!;
          expect([Dn(total.cells[v]), Dn(total.cells[v + 1])], `${tag === tagA ? 'A' : 'B'} [${groupBy.join(', ')}]`).toEqual([D(std.totalDebitsExact), D(std.totalCreditsExact)]);
          if (groupBy[0] === 'account' && tag === tagB) {
            // Savings, a debit-balance account, is credit-net within job B: its job-B figure is a credit.
            const sv = run.rows.find((r) => r.kind === 'line' && r.path[1] === `account:${c.savings}`)!;
            expect([Dn(sv.cells[v]), Dn(sv.cells[v + 1])]).toEqual([null, D('100')]);
          }
        }
      }
    });
  }
});
