// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Transactions list → CSV / PDF export (GET /transactions/export).
// The export is the WHOLE filtered + sorted list (every page), one row per
// transaction, GL-style Debit / Credit columns and a totals row. Scoped and
// permissioned exactly like GET /transactions, audited with metadata only.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import { existsSync } from 'fs';
import { PDFDocument } from 'pdf-lib';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, userTenantAccess, transactions, journalLines,
  contacts, tags, transactionTags, permissionTemplates, userPermissions,
} from '../db/schema/index.js';
import { transactionsRouter } from './transactions.routes.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import * as permissionService from '../services/permission.service.js';
import { TXN_EXPORT_LIMITS } from '../services/transaction-list-export.service.js';
import { extractTextLayer } from '../services/extraction/pdf-detect.service.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;

const PFX = 'txn-export-routes';
const OWNER_A = `${PFX}-a@example.com`;
const OWNER_B = `${PFX}-b@example.com`;
const ALL_EMAILS = [OWNER_A, OWNER_B];
const PASSWORD = 'correct-horse-battery';
const DEFAULT_LIMITS = { ...TXN_EXPORT_LIMITS };

async function cleanDb() {
  const rows = await db.select({ id: users.id, tenantId: users.tenantId }).from(users).where(inArray(users.email, ALL_EMAILS));
  const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
  for (const tenantId of tenantIds) {
    const tenantUsers = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId));
    const userIds = tenantUsers.map((u) => u.id);
    if (userIds.length) {
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, userIds));
    }
    await db.delete(userPermissions).where(eq(userPermissions.tenantId, tenantId));
    await db.delete(permissionTemplates).where(eq(permissionTemplates.tenantId, tenantId));
    await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
    await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
    await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
    await db.delete(tags).where(eq(tags.tenantId, tenantId));
    await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
    await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
    await db.delete(companies).where(eq(companies.tenantId, tenantId));
    await db.delete(users).where(eq(users.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
}

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: Buffer; text: string; json: Record<string, unknown> | null }

function get(pathname: string, token: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const text = body.toString('utf8');
          let json: Record<string, unknown> | null = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Parse RFC 4180 CSV (quoted fields, "" escapes, embedded newlines). */
function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* CRLF */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

beforeEach(async () => {
  await cleanDb();
  Object.assign(TXN_EXPORT_LIMITS, DEFAULT_LIMITS);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transactions', transactionsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
});

afterAll(() => { Object.assign(TXN_EXPORT_LIMITS, DEFAULT_LIMITS); });

interface Seed {
  tenantId: string; companyId: string; userId: string; token: string;
  checking: string; savings: string; office: string; rent: string; sales: string;
  vendor: string; tagId: string;
  ids: { expense: string; deposit: string; split: string; transfer: string; voided: string };
}

async function seedTenant(email: string, companyName: string): Promise<Seed> {
  const reg = await authService.register({ email, password: PASSWORD, displayName: companyName, companyName });
  const tenantId = reg.user.tenantId;
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const companyId = company!.id;
  const mk = async (name: string, accountType: string, detailType: string) => {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, name, accountType, detailType }).returning();
    return a!.id;
  };
  const checking = await mk('XP Checking', 'asset', 'bank');
  const savings = await mk('XP Savings', 'asset', 'bank');
  const office = await mk('XP Office Supplies', 'expense', 'office_expenses');
  const rent = await mk('XP Rent', 'expense', 'rent_or_lease');
  const sales = await mk('XP Sales', 'revenue', 'sales_of_product_income');
  const [v] = await db.insert(contacts).values({ tenantId, companyId, contactType: 'vendor', displayName: '=HYPERLINK("http://evil",A1)' }).returning();
  const [t] = await db.insert(tags).values({ tenantId, companyId, name: 'XP Tag' }).returning();

  const expense = await ledger.postTransaction(tenantId, {
    txnType: 'expense', txnDate: '2026-01-05', txnNumber: '101', contactId: v!.id,
    memo: 'Paper, "A4"\nsecond line', total: '100.00',
    lines: [
      { accountId: office, debit: '100.00', credit: '0', tagId: t!.id },
      { accountId: checking, debit: '0', credit: '100.00' },
    ],
  }, reg.user.id, companyId);
  const deposit = await ledger.postTransaction(tenantId, {
    txnType: 'deposit', txnDate: '2026-02-10', txnNumber: 'DEP1', memo: '-cash sale', total: '250.00',
    lines: [
      { accountId: checking, debit: '250.00', credit: '0' },
      { accountId: sales, debit: '0', credit: '250.00' },
    ],
  }, reg.user.id, companyId);
  const split = await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry', txnDate: '2026-03-15', memo: 'Split JE',
    lines: [
      { accountId: office, debit: '40.00', credit: '0' },
      { accountId: rent, debit: '60.00', credit: '0' },
      { accountId: checking, debit: '0', credit: '100.00' },
    ],
  }, reg.user.id, companyId);
  const transfer = await ledger.postTransaction(tenantId, {
    txnType: 'transfer', txnDate: '2026-04-01', memo: 'To savings',
    lines: [
      { accountId: savings, debit: '75.00', credit: '0' },
      { accountId: checking, debit: '0', credit: '75.00' },
    ],
  }, reg.user.id, companyId);
  const voided = await ledger.postTransaction(tenantId, {
    txnType: 'expense', txnDate: '2026-05-01', txnNumber: '102', memo: 'Voided one', total: '30.00',
    lines: [
      { accountId: office, debit: '30.00', credit: '0' },
      { accountId: checking, debit: '0', credit: '30.00' },
    ],
  }, reg.user.id, companyId);
  await ledger.voidTransaction(tenantId, voided.id, 'test', reg.user.id);

  return {
    tenantId, companyId, userId: reg.user.id, token: reg.tokens.accessToken,
    checking, savings, office, rent, sales, vendor: v!.id, tagId: t!.id,
    ids: { expense: expense.id, deposit: deposit.id, split: split.id, transfer: transfer.id, voided: voided.id },
  };
}

const HEADER = ['Date', 'Type', 'Ref #', 'Name', 'Description', 'Account / Category', 'Debit', 'Credit', 'Tag', 'Status'];

async function csv(seed: Seed, qs: string) {
  const r = await get(`/api/v1/transactions/export?format=csv${qs ? `&${qs}` : ''}`, seed.token);
  expect(r.status).toBe(200);
  return { resp: r, rows: parseCsv(r.text) };
}

describe('GET /transactions/export — CSV', () => {
  it('exports every matching transaction, newest first by default, GL-style debit/credit with a totals row', async () => {
    const a = await seedTenant(OWNER_A, 'Export Co A');
    const { resp, rows } = await csv(a, '');
    expect(resp.headers['content-type']).toContain('text/csv');
    expect(resp.headers['content-disposition']).toMatch(/attachment; filename="Transactions_.*\.csv"/);
    expect(rows[0]).toEqual(HEADER);
    const body = rows.slice(1);
    // 5 transactions + totals row
    expect(body).toHaveLength(6);
    expect(body.map((r) => r[0])).toEqual(['2026-05-01', '2026-04-01', '2026-03-15', '2026-02-10', '2026-01-05', '']);
    const [voided, transfer, split, deposit, expense, totals] = body as [string[], string[], string[], string[], string[], string[]];
    // Void: reversed, shows zero like the list does.
    expect(voided.slice(6, 8)).toEqual(['0.00', '0.00']);
    expect(voided[9]).toBe('void');
    // No category side (bank → bank): the entry's full amount both sides.
    expect(transfer.slice(5, 8)).toEqual(['', '75.00', '75.00']);
    expect(transfer[1]).toBe('Transfer');
    // Multi-category → Split, debits to the category side.
    expect(split.slice(5, 8)).toEqual(['Split', '100.00', '']);
    // Deposit credits income.
    expect(deposit.slice(1, 8)).toEqual(['Deposit', 'DEP1', '', "'-cash sale", 'XP Sales', '', '250.00']);
    // Expense debits the expense; tag + status columns.
    expect(expense.slice(5, 10)).toEqual(['XP Office Supplies', '100.00', '', 'XP Tag', 'posted']);
    // Totals (void excluded): debits 75+100+100, credits 75+250.
    expect(totals[4]).toBe('Total');
    expect(totals.slice(6, 8)).toEqual(['275.00', '325.00']);
    expect(resp.headers['x-export-row-count']).toBe('5');
    expect(resp.headers['x-export-truncated']).toBe('false');
  });

  it('quotes per RFC 4180 and neutralizes formula-looking cells', async () => {
    const a = await seedTenant(OWNER_A, 'Export Co A');
    const { resp } = await csv(a, 'txnType=expense&status=posted');
    expect(resp.text).toContain(`"'=HYPERLINK(""http://evil"",A1)"`);
    expect(resp.text).toContain('"Paper, ""A4""\nsecond line"');
    // CRLF record separators.
    expect(resp.text.split('\r\n')[0]).toBe('\uFEFF' + HEADER.map((h) => `"${h}"`).join(','));
    const rows = parseCsv(resp.text);
    expect(rows[1]![3]).toBe(`'=HYPERLINK("http://evil",A1)`);
    expect(rows[1]![4]).toBe('Paper, "A4"\nsecond line');
  });

  it('respects the account filter with that account’s own debit/credit and the requested sort', async () => {
    const a = await seedTenant(OWNER_A, 'Export Co A');
    const { rows } = await csv(a, `accountId=${a.checking}&sortBy=date&sortDir=asc`);
    const body = rows.slice(1);
    expect(body.map((r) => r[0])).toEqual(['2026-01-05', '2026-02-10', '2026-03-15', '2026-04-01', '2026-05-01', '']);
    expect(body.map((r) => [r[6], r[7]])).toEqual([
      ['', '100.00'], ['250.00', ''], ['', '100.00'], ['', '75.00'], ['0.00', '0.00'], ['250.00', '275.00'],
    ]);
    // Amount sort, ascending: void counts its original magnitude (30) like the list.
    const byAmount = (await csv(a, 'sortBy=amount&sortDir=asc')).rows.slice(1, -1).map((r) => r[0]);
    // 30 (void), 75, 100 + 100 (tie → newest-created first, like the list), 250.
    expect(byAmount).toEqual(['2026-05-01', '2026-04-01', '2026-03-15', '2026-01-05', '2026-02-10']);
  });

  it('applies type, status, contact, tag, search and date-range filters; ignores paging params', async () => {
    const a = await seedTenant(OWNER_A, 'Export Co A');
    const dates = async (qs: string) => (await csv(a, qs)).rows.slice(1, -1).map((r) => r[0]);
    expect(await dates('txnType=deposit')).toEqual(['2026-02-10']);
    expect(await dates('status=void')).toEqual(['2026-05-01']);
    expect(await dates(`contactId=${a.vendor}`)).toEqual(['2026-01-05']);
    expect(await dates(`tagId=${a.tagId}`)).toEqual(['2026-01-05']);
    expect(await dates('search=savings')).toEqual(['2026-04-01']);
    expect(await dates('startDate=2026-02-01&endDate=2026-03-31')).toEqual(['2026-03-15', '2026-02-10']);
    // A page of one is still the whole list — the export is never one page.
    expect(await dates('limit=1&offset=2')).toHaveLength(5);
  });

  it('caps the export and says so when the filtered set is larger', async () => {
    const a = await seedTenant(OWNER_A, 'Export Co A');
    TXN_EXPORT_LIMITS.csv = 2;
    const { resp, rows } = await csv(a, '');
    expect(resp.headers['x-export-truncated']).toBe('true');
    expect(resp.headers['x-export-row-count']).toBe('2');
    expect(rows[1]![0]).toBe('2026-05-01');
    expect(rows[2]![0]).toBe('2026-04-01');
    expect(rows[3]![4]).toBe('Total');
    // Totals are the exported rows' totals (void → 0; transfer 75/75).
    expect(rows[3]!.slice(6, 8)).toEqual(['75.00', '75.00']);
    expect(rows[4]![0]).toMatch(/Export truncated: first 2 of 5 matching transactions/);
  });

  it('returns a header + zero totals row when nothing matches', async () => {
    const a = await seedTenant(OWNER_A, 'Export Co A');
    const { rows } = await csv(a, 'startDate=2030-01-01');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.slice(6, 8)).toEqual(['0.00', '0.00']);
  });

  it('rejects an unknown format and invalid filters with 400', async () => {
    const a = await seedTenant(OWNER_A, 'Export Co A');
    expect((await get('/api/v1/transactions/export?format=xlsx', a.token)).status).toBe(400);
    expect((await get('/api/v1/transactions/export?format=csv&accountId=nope', a.token)).status).toBe(400);
    expect((await get('/api/v1/transactions/export?format=csv&sortBy=evil', a.token)).status).toBe(400);
  });

  it('never returns another tenant’s transactions, even with their account id', async () => {
    const a = await seedTenant(OWNER_A, 'Export Co A');
    const b = await seedTenant(OWNER_B, 'Export Co B');
    // Tenant B has its own five; A's ids never appear.
    const own = await csv(b, '');
    expect(own.rows.slice(1, -1)).toHaveLength(5);
    const leaked = await csv(b, `accountId=${a.checking}`);
    expect(leaked.rows.slice(1)).toHaveLength(1); // just the totals row
    expect(leaked.rows[1]!.slice(6, 8)).toEqual(['0.00', '0.00']);
    // A company id from another tenant is refused outright.
    const r = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/v1/transactions/export?format=csv', method: 'GET',
        headers: { Authorization: `Bearer ${b.token}`, 'X-Company-Id': a.companyId },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    expect(r).toBe(403);
  });

  it('requires the same permission as viewing the list', async () => {
    const a = await seedTenant(OWNER_A, 'Export Co A');
    const mkUser = async (key: string) => {
      const [u] = await db.insert(users).values({
        tenantId: a.tenantId, email: `${PFX}-${key}-${Date.now()}@example.com`, passwordHash: 'x', displayName: key, role: 'bookkeeper', isSuperAdmin: false,
      }).returning();
      return u!.id;
    };
    const denied = await mkUser('denied');
    const viewer = await mkUser('viewer');
    const noTxns = await permissionService.createTemplate(a.tenantId, { name: 'No Txns', permissions: { invoices: 'full' } }, a.userId);
    await permissionService.setUserPermissions(a.tenantId, denied, { templateId: noTxns.id }, a.userId);
    const viewOnly = await permissionService.createTemplate(a.tenantId, { name: 'Txn Viewer', permissions: { transactions: 'view' } }, a.userId);
    await permissionService.setUserPermissions(a.tenantId, viewer, { templateId: viewOnly.id }, a.userId);
    const tk = (userId: string) => jwt.sign({ userId, tenantId: a.tenantId, role: 'bookkeeper', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });

    expect((await get('/api/v1/transactions?limit=1', tk(denied))).status).toBe(403);
    expect((await get('/api/v1/transactions/export?format=csv', tk(denied))).status).toBe(403);
    expect((await get('/api/v1/transactions?limit=1', tk(viewer))).status).toBe(200);
    expect((await get('/api/v1/transactions/export?format=csv', tk(viewer))).status).toBe(200);
  });

  it('audits the export with metadata only', async () => {
    const a = await seedTenant(OWNER_A, 'Export Co A');
    await csv(a, `txnType=expense&search=Paper`);
    const rows = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, a.tenantId), eq(auditLog.entityType, 'transaction_list_export')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('download');
    expect(rows[0]!.userId).toBe(a.userId);
    const after = rows[0]!.afterData as Record<string, unknown>;
    expect(after).toMatchObject({ format: 'csv', rowCount: 1, matched: 1, truncated: false });
    expect(after['filters']).toMatchObject({ txnType: 'expense', search: 'Paper' });
    // No row data (payees, amounts, memos) in the audit record.
    expect(JSON.stringify(after)).not.toContain('HYPERLINK');
    expect(JSON.stringify(after)).not.toContain('100.00');
  });
});

// Rendering needs Chromium, which CI's unit job does not install
// (npm ci --ignore-scripts). The HTML + footer stamping are covered without
// it in transaction-list-export.service.test.ts; this renders for real
// wherever a browser is available.
async function chromeAvailable(): Promise<boolean> {
  try {
    const exe: string = process.env['PUPPETEER_EXECUTABLE_PATH'] || await (await import('puppeteer')).default.executablePath();
    return !!exe && existsSync(exe);
  } catch { return false; }
}
const HAS_CHROME = await chromeAvailable();

async function pdfText(buf: Buffer): Promise<string> {
  const pages = await extractTextLayer(buf);
  return pages.map((p) => p.text).join('\n');
}

describe.skipIf(!HAS_CHROME)('GET /transactions/export — PDF (real render)', () => {
  it('renders a landscape GL-style PDF with company, title, filters, printed time, page numbers and totals', async () => {
    const a = await seedTenant(OWNER_A, 'Export Co A');
    const r = await get(
      `/api/v1/transactions/export?format=pdf&accountId=${a.checking}&startDate=2026-01-01&endDate=2026-12-31&status=posted&sortBy=date&sortDir=asc&tz=America/Chicago`,
      a.token,
    );
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.body.subarray(0, 4).toString()).toBe('%PDF');
    const doc = await PDFDocument.load(r.body);
    const { width, height } = doc.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([792, 612]); // landscape letter
    const text = await pdfText(r.body);
    expect(text).toContain('Export Co A');
    expect(text).toContain('Transactions');
    expect(text).toContain('01/01/2026 to 12/31/2026');
    expect(text).toContain('Account: XP Checking');
    expect(text).toContain('Status: Posted');
    expect(text).toContain('Sorted by: Date (oldest first)');
    expect(text).toMatch(/Printed \d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} [AP]M C[SD]T/);
    expect(text).toContain('Page 1 of 1');
    // Column headers (the report stylesheet upper-cases them).
    for (const h of ['DATE', 'TYPE', 'REF #', 'NAME', 'DESCRIPTION', 'ACCOUNT / CATEGORY', 'TAG', 'DEBIT', 'CREDIT']) {
      expect(text).toContain(h);
    }
    expect(text).not.toContain('STATUS');
    // Tag column: the tagged expense shows its tag (no Status column).
    expect(text).toContain('XP Tag');
    expect(text).toContain('XP Sales');
    expect(text).toContain('250.00');
    expect(text).toContain('275.00');
  }, 60_000);

  it('prints the truncation note in the PDF when capped', async () => {
    const a = await seedTenant(OWNER_A, 'Export Co A');
    TXN_EXPORT_LIMITS.pdf = 1;
    const r = await get('/api/v1/transactions/export?format=pdf', a.token);
    expect(r.status).toBe(200);
    expect(r.headers['x-export-truncated']).toBe('true');
    const text = await pdfText(r.body);
    expect(text).toMatch(/Export truncated: first 1 of 5 matching transactions/);
    expect(text).toContain('All dates');
  }, 60_000);
});
