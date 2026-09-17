// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Route-level coverage for Settings > Export Data (/api/v1/export/full).
// Guards the manifest shape the web page renders, the per-file download
// path, the optional txn_date window on the two dated files, and the
// tenant-isolation + formula-neutralisation contracts of the CSV bodies.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import { exportRouter } from './export.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let token = '';
let otherToken = '';
let tenantId = '';

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, payment_applications, deposit_lines,
    recurring_schedules, budget_lines, budgets,
    bank_feed_items, reconciliation_lines, reconciliations,
    plaid_account_mappings, plaid_accounts, plaid_items, bank_connections,
    transactions, contacts, items, tags, tag_groups, api_keys, sessions,
    accounts, companies, users, tenants
    CASCADE`);
}

interface RawResponse { status: number; contentType: string; disposition: string; body: string }

function get(path: string, bearer = token): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      method: 'GET', hostname: '127.0.0.1', port, path: `/api/v1/export${path}`,
      headers: { Authorization: `Bearer ${bearer}` },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({
        status: res.statusCode!,
        contentType: String(res.headers['content-type'] || ''),
        disposition: String(res.headers['content-disposition'] || ''),
        body: data,
      }));
    });
    r.on('error', reject);
    r.end();
  });
}

beforeAll(async () => {
  await cleanDb();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/export', exportRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });

  const stamp = Date.now();
  const result = await authService.register({
    email: `export-${stamp}@example.com`,
    password: 'password123456',
    displayName: 'Export Test',
    companyName: 'Export Co',
  });
  token = result.tokens.accessToken;
  tenantId = result.user.tenantId;

  const other = await authService.register({
    email: `export-other-${stamp}@example.com`,
    password: 'password123456',
    displayName: 'Other Tenant',
    companyName: 'Other Co',
  });
  otherToken = other.tokens.accessToken;

  const company = await db.query.companies.findFirst({ where: (c, { eq }) => eq(c.tenantId, tenantId) });
  const companyId = company!.id;
  const allAccounts = await db.query.accounts.findMany({ where: (a, { eq }) => eq(a.tenantId, tenantId) });
  const bank = allAccounts.find((a) => a.accountType === 'asset')!;
  const revenue = allAccounts.find((a) => a.accountType === 'revenue')!;

  // A contact whose name is a spreadsheet formula, an item, and a tag —
  // the master-data files must carry all three.
  await db.execute(sql`INSERT INTO contacts (tenant_id, company_id, contact_type, display_name, email)
    VALUES (${tenantId}, ${companyId}, 'vendor', '=HYPERLINK("http://evil")', 'v@example.com')`);
  await db.execute(sql`INSERT INTO items (tenant_id, company_id, name, unit_price, income_account_id)
    VALUES (${tenantId}, ${companyId}, 'Consulting Hour', '150.0000', ${revenue.id})`);
  await db.execute(sql`INSERT INTO tags (tenant_id, company_id, name) VALUES (${tenantId}, ${companyId}, 'Downtown')`);

  const post = (date: string, memo: string) =>
    ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: date, memo, lines: [
      { accountId: bank.id, debit: '100.00', credit: '0' },
      { accountId: revenue.id, debit: '0', credit: '100.00' },
    ] }, undefined, companyId);
  await post('2025-06-15', 'MEMO-2025');
  await post('2026-01-10', 'MEMO-2026-JAN');
  await post('2026-03-20', 'MEMO-2026-MAR');
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanDb();
  await pool.end();
});

describe('GET /export/full (manifest)', () => {
  it('lists all six files with row counts', async () => {
    const r = await get('/full');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { files: Array<{ name: string; rowCount: number }>; startDate: string | null; endDate: string | null };
    expect(body.files.map((f) => f.name)).toEqual([
      'accounts.csv', 'contacts.csv', 'items.csv', 'tags.csv', 'transactions.csv', 'journal_lines.csv',
    ]);
    const counts = Object.fromEntries(body.files.map((f) => [f.name, f.rowCount]));
    expect(counts['contacts.csv']).toBe(1);
    expect(counts['items.csv']).toBe(1);
    expect(counts['tags.csv']).toBe(1);
    expect(counts['transactions.csv']).toBe(3);
    expect(counts['journal_lines.csv']).toBe(6);
    expect(counts['accounts.csv']).toBeGreaterThan(0);
    expect(body.startDate).toBeNull();
    expect(body.endDate).toBeNull();
  });

  it('applies the date window to transactions and journal lines only', async () => {
    const r = await get('/full?start_date=2026-01-01&end_date=2026-12-31');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { files: Array<{ name: string; rowCount: number }>; startDate: string; endDate: string };
    const counts = Object.fromEntries(body.files.map((f) => [f.name, f.rowCount]));
    expect(counts['transactions.csv']).toBe(2);
    expect(counts['journal_lines.csv']).toBe(4);
    expect(counts['contacts.csv']).toBe(1);
    expect(body.startDate).toBe('2026-01-01');
    expect(body.endDate).toBe('2026-12-31');
  });

  it('accepts an open-ended range', async () => {
    const r = await get('/full?end_date=2025-12-31');
    const counts = Object.fromEntries((JSON.parse(r.body).files as Array<{ name: string; rowCount: number }>).map((f) => [f.name, f.rowCount]));
    expect(counts['transactions.csv']).toBe(1);
  });

  it('rejects malformed or inverted dates with 400', async () => {
    expect((await get('/full?start_date=01/01/2026')).status).toBe(400);
    expect((await get('/full?start_date=2026-13-40')).status).toBe(400);
    expect((await get('/full?start_date=2026-06-01&end_date=2026-01-01')).status).toBe(400);
  });
});

describe('GET /export/full/:fileName (download)', () => {
  it('streams transactions.csv for the requested range with a dated filename', async () => {
    const r = await get('/full/transactions.csv?start_date=2026-01-01&end_date=2026-12-31');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/csv');
    expect(r.disposition).toContain('filename="transactions_2026-01-01_to_2026-12-31.csv"');
    expect(r.body.split('\n')[0]).toBe('ID,Type,Number,Date,Status,Total,Memo,Contact,Invoice Status,Amount Paid,Balance Due');
    expect(r.body).toContain('MEMO-2026-JAN');
    expect(r.body).toContain('MEMO-2026-MAR');
    expect(r.body).not.toContain('MEMO-2025');
  });

  it('journal_lines.csv carries the transaction header fields on every posting', async () => {
    const r = await get('/full/journal_lines.csv?start_date=2025-01-01&end_date=2025-12-31');
    expect(r.status).toBe(200);
    expect(r.body.split('\n')[0]).toBe('ID,Transaction ID,Date,Type,Number,Status,Contact,Account Number,Account Name,Debit,Credit,Description,Line Tag');
    const rows = r.body.trim().split('\n').slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toContain('"journal_entry"');
  });

  it('master-data files include items and tags, and neutralise formulas', async () => {
    const items = await get('/full/items.csv');
    expect(items.body).toContain('"Consulting Hour"');
    expect(items.body).toContain('"150.0000"');
    const tags = await get('/full/tags.csv');
    expect(tags.body).toContain('"Downtown"');
    const contacts = await get('/full/contacts.csv');
    expect(contacts.body).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(contacts.disposition).toContain('filename="contacts.csv"');
  });

  it('returns 404 for a file name outside the fixed list', async () => {
    expect((await get('/full/users.csv')).status).toBe(404);
    expect((await get('/full/..%2Fetc%2Fpasswd')).status).toBe(404);
  });

  it('never leaks another tenant\'s rows', async () => {
    const r = await get('/full/transactions.csv', otherToken);
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('MEMO-');
    const c = await get('/full/contacts.csv', otherToken);
    expect(c.body).not.toContain('HYPERLINK');
  });
});
