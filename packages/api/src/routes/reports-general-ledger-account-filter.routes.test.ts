// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// General Ledger account filter (GET /reports/general-ledger?account_ids=).
// Guards:
//   - no filter / empty / malformed-only = every account (unchanged report)
//   - account_ids returns ONLY the selected account sections, and each
//     section is byte-identical to the unfiltered report's section
//     (filter removes whole sections, never lines; beginning + running +
//     ending balances unchanged)
//   - an explicitly selected account with no activity still gets a section
//   - a foreign-tenant account id is ignored (never widens, never leaks)
//   - the response carries the resolved accountFilter for the header
//   - CSV export honours the filter
//   - the PDF header note lists the accounts (or "N accounts")

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { accounts } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import { reportsRouter, glAccountFilterNote } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { toReportHtml } from '../services/report-export.service.js';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';

let cashId = '';
let rentId = '';
let salesId = '';
let travelId = '';
let foreignId = '';

const stamp = Date.now();

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, payment_applications, deposit_lines,
    recurring_schedules, budget_lines, budgets,
    bank_feed_items, reconciliation_lines, reconciliations,
    plaid_account_mappings, plaid_accounts, plaid_items, bank_connections,
    transactions, contacts, tags, tag_groups, api_keys, sessions,
    accounts, companies, users, tenants
    CASCADE`);
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

interface RawResponse { status: number; contentType: string; body: string }

function get(path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      method: 'GET', hostname: '127.0.0.1', port, path: `/api/v1/reports${path}`,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({
        status: res.statusCode!,
        contentType: String(res.headers['content-type'] || ''),
        body: data,
      }));
    });
    r.on('error', reject);
    r.end();
  });
}

const RANGE = 'start_date=2026-01-01&end_date=2026-12-31';

interface GLAcct { id: string; name: string; beginningBalance: number; endingBalance: number; lines: Array<{ runningBalance: number }> }

beforeAll(async () => {
  await cleanDb();
  await startApp();

  const result = await authService.register({
    email: `gl-acctfilter-${stamp}@example.com`,
    password: 'password123456',
    displayName: 'GL Filter Test',
    companyName: 'GL Filter Co',
  });
  token = result.tokens.accessToken;
  tenantId = result.user.tenantId;
  const company = await db.query.companies.findFirst({ where: (c, { eq }) => eq(c.tenantId, tenantId) });
  const companyId = company!.id;

  const mk = async (tid: string, name: string, accountNumber: string, accountType: 'asset' | 'revenue' | 'expense') => {
    const [a] = await db.insert(accounts).values({ tenantId: tid, name, accountNumber, accountType }).returning();
    return a!;
  };
  const cash = await mk(tenantId, 'GLF Cash', '1001', 'asset');
  const sales = await mk(tenantId, 'GLF Sales', '4001', 'revenue');
  const rent = await mk(tenantId, 'GLF Rent', '6000', 'expense');
  const travel = await mk(tenantId, 'GLF Travel', '6200', 'expense'); // never used
  cashId = cash.id; rentId = rent.id; salesId = sales.id; travelId = travel.id;

  const post = (date: string, memo: string, lines: Array<{ accountId: string; debit: string; credit: string }>) =>
    ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: date, memo, lines }, undefined, companyId);

  // Prior-period activity → Cash carries a $5,000 beginning balance.
  await post('2025-12-15', 'Opening capital', [
    { accountId: cash.id, debit: '5000.00', credit: '0' },
    { accountId: sales.id, debit: '0', credit: '5000.00' },
  ]);
  await post('2026-01-15', 'January rent', [
    { accountId: rent.id, debit: '1000.00', credit: '0' },
    { accountId: cash.id, debit: '0', credit: '1000.00' },
  ]);
  await post('2026-02-01', 'A sale', [
    { accountId: cash.id, debit: '300.00', credit: '0' },
    { accountId: sales.id, debit: '0', credit: '300.00' },
  ]);

  // A second tenant with its own account — its id must never be honoured.
  const other = await authService.register({
    email: `gl-acctfilter-other-${stamp}@example.com`,
    password: 'password123456',
    displayName: 'Other',
    companyName: 'Other Co',
  });
  const foreign = await mk(other.user.tenantId, 'FOREIGN SECRET ACCOUNT', '9999', 'asset');
  foreignId = foreign.id;
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanDb();
  await pool.end();
});

async function gl(qs = ''): Promise<{ accounts: GLAcct[]; accountFilter?: unknown; totalDebits: number; totalCredits: number }> {
  const r = await get(`/general-ledger?${RANGE}${qs}`);
  expect(r.status).toBe(200);
  return JSON.parse(r.body);
}

describe('GET /reports/general-ledger account_ids filter', () => {
  it('no filter returns every account with activity or a balance (and no accountFilter)', async () => {
    const data = await gl();
    const names = data.accounts.map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(['GLF Cash', 'GLF Rent', 'GLF Sales']));
    expect(names).not.toContain('GLF Travel');
    expect(data.accountFilter).toBeUndefined();
  });

  it('returns only the selected accounts, each section identical to the unfiltered report', async () => {
    const all = await gl();
    const data = await gl(`&account_ids=${cashId},${rentId}`);
    expect(data.accounts.map((a) => a.id)).toEqual([cashId, rentId]);

    const cashAll = all.accounts.find((a) => a.id === cashId)!;
    const cashFiltered = data.accounts.find((a) => a.id === cashId)!;
    expect(cashFiltered).toEqual(cashAll);
    expect(cashFiltered.beginningBalance).toBeCloseTo(5000, 2);
    expect(cashFiltered.lines.map((l) => l.runningBalance)).toEqual([4000, 4300]);
    expect(cashFiltered.endingBalance).toBeCloseTo(4300, 2);

    // Totals cover the selected sections only.
    expect(data.totalDebits).toBeCloseTo(1300, 2);
    expect(data.totalCredits).toBeCloseTo(1000, 2);

    expect(data.accountFilter).toEqual({
      accounts: [
        { id: cashId, accountNumber: '1001', name: 'GLF Cash' },
        { id: rentId, accountNumber: '6000', name: 'GLF Rent' },
      ],
    });
  });

  it('an explicitly selected account with no activity still gets an empty section', async () => {
    const data = await gl(`&account_ids=${travelId}`);
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0]!.name).toBe('GLF Travel');
    expect(data.accounts[0]!.lines).toEqual([]);
    expect(data.accounts[0]!.endingBalance).toBe(0);
  });

  it('ignores a foreign-tenant account id — never widens, never leaks', async () => {
    const mixed = await gl(`&account_ids=${rentId},${foreignId}`);
    expect(mixed.accounts.map((a) => a.id)).toEqual([rentId]);
    expect(JSON.stringify(mixed)).not.toContain('FOREIGN SECRET ACCOUNT');

    const onlyForeign = await gl(`&account_ids=${foreignId}`);
    expect(onlyForeign.accounts).toEqual([]);
    expect(JSON.stringify(onlyForeign)).not.toContain('FOREIGN SECRET ACCOUNT');
  });

  it('empty or malformed-only account_ids means all accounts', async () => {
    const all = await gl();
    const empty = await gl('&account_ids=');
    const junk = await gl('&account_ids=not-a-uuid,,');
    expect(empty.accounts.map((a) => a.id)).toEqual(all.accounts.map((a) => a.id));
    expect(junk.accounts.map((a) => a.id)).toEqual(all.accounts.map((a) => a.id));
    expect(junk.accountFilter).toBeUndefined();
  });

  it('cash basis honours the filter too', async () => {
    const data = await gl(`&basis=cash&account_ids=${rentId}`);
    expect(data.accounts.map((a) => a.id)).toEqual([rentId]);
  });

  it('CSV export honours the filter', async () => {
    const r = await get(`/general-ledger?${RANGE}&account_ids=${rentId}&format=csv`);
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/csv');
    expect(r.body).toContain('GLF Rent');
    expect(r.body).not.toContain('GLF Cash');
    expect(r.body).not.toContain('GLF Sales');
  });

  it('unfiltered CSV still includes every account', async () => {
    const r = await get(`/general-ledger?${RANGE}&format=csv`);
    expect(r.body).toContain('GLF Rent');
    expect(r.body).toContain('GLF Cash');
    expect(r.body).toContain('GLF Sales');
  });
});

describe('glAccountFilterNote (printed header)', () => {
  const a = (n: number) => ({ id: `id-${n}`, accountNumber: String(1000 + n), name: `Acct ${n}` });

  it('is empty when there is no filter', () => {
    expect(glAccountFilterNote(undefined, false)).toBe('');
  });

  it('lists a few accounts by number and name', () => {
    expect(glAccountFilterNote({ accounts: [a(1), a(2)] }, false)).toBe('Accounts: 1001 Acct 1, 1002 Acct 2');
  });

  it('omits account numbers when the Account # option is off', () => {
    expect(glAccountFilterNote({ accounts: [a(1)] }, true)).toBe('Accounts: Acct 1');
  });

  it('collapses a long selection to a count', () => {
    const many = Array.from({ length: 7 }, (_, i) => a(i));
    expect(glAccountFilterNote({ accounts: many }, false)).toBe('Accounts: 7 accounts selected');
  });

  it('says so when no selected account belongs to the tenant', () => {
    expect(glAccountFilterNote({ accounts: [] }, false)).toBe('Accounts: none of the selected accounts were found');
  });
});

describe('toReportHtml header note', () => {
  it('renders the note (escaped) under the date line, and nothing when absent', () => {
    const withNote = toReportHtml('General Ledger', 'Co', 'Jan 1 to Dec 31', '<table></table>', '', 'Accounts: <b>Cash</b>');
    expect(withNote).toContain('Jan 1 to Dec 31<br>Accounts: &lt;b&gt;Cash&lt;/b&gt;');
    const without = toReportHtml('General Ledger', 'Co', 'Jan 1 to Dec 31', '<table></table>');
    expect(without).toContain('<div class="meta">Jan 1 to Dec 31</div>');
  });
});
