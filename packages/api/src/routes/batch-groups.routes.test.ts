// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Grouped batch save (ClientLedger Bulk Entry, U-67–U-74):
//   - atomic: row 37 of 50 failing at posting leaves nothing (no
//     transactions, no auto-created contact, check counter unchanged);
//   - mixed checks, deposits, card rows and a journal entry in one call,
//     source 'batch' + batchId, exact balances;
//   - check numbers unique (batch and books), counter advanced, print later;
//   - closing date: 423 / 403 list the row numbers, the password opens it;
//   - Idempotency-Key replay, 409 on a different body, nothing stored for
//     a failed batch, scoped by company;
//   - exact journal entry balance, A/R name rule, strings only;
//   - cross-company isolation, row cap, unsupported types, old shape.

import 'express-async-errors';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts, auditLog, batchSaveRequests, companies, contacts, journalLines, tags, transactions,
  users, userTenantAccess, userPermissions,
} from '../db/schema/index.js';
import { batchRouter } from './batch.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { hashClosingPassword } from '../services/closing-password.service.js';
import { makeCompany, cleanTenant, suffix, type Co, type Res } from '../services/templates/templates.test-helpers.js';
import * as authService from '../services/auth.service.js';
import { batchTimeouts, classifyDbError } from '../services/batch-groups.service.js';

class BatchServer {
  server: Server | null = null;
  port = 0;

  async start() {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/v1/batch', batchRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, () => { this.port = (this.server!.address() as AddressInfo).port; resolve(); });
    });
  }

  async stop() {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  request(pathname: string, token: string, body: unknown, companyId: string, headers: Record<string, string> = {}): Promise<Res & { headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request({
        hostname: '127.0.0.1', port: this.port, path: pathname, method: 'POST',
        headers: {
          'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Company-Id': companyId,
          'Content-Length': String(data.length), ...headers,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null, headers: res.headers });
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }
}

const srv = new BatchServer();
const tenantIds: string[] = [];
let c: Co;
let card: string;

beforeEach(async () => {
  await srv.start();
  c = await makeCompany('batch', tenantIds);
  const [cc] = await db.insert(accounts).values({
    tenantId: c.tenantId, companyId: c.companyId, name: 'Visa', accountType: 'liability', detailType: 'credit_card',
  }).returning();
  card = cc!.id;
});

afterEach(async () => {
  await srv.stop();
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const save = (body: unknown, headers: Record<string, string> = {}, co = c.companyId) =>
  srv.request('/api/v1/batch/save', c.token, body, co, headers);
const validate = (body: unknown, co = c.companyId) => srv.request('/api/v1/batch/validate', c.token, body, co);

async function txns() {
  return db.select().from(transactions).where(eq(transactions.tenantId, c.tenantId));
}
async function balance(id: string) {
  return (await db.query.accounts.findFirst({ where: eq(accounts.id, id) }))!.balance;
}
async function nextCheckNumber(bank: string) {
  const res = await db.execute(sql`
    SELECT check_settings->'nextCheckNumbers'->>${bank} AS n FROM companies WHERE id = ${c.companyId}
  `);
  return (res.rows[0] as { n: string | null }).n;
}

describe('atomic save', () => {
  it('row 37 of 50 failing at posting leaves nothing behind', async () => {
    const counterBefore = await nextCheckNumber(c.bank);
    const bankBefore = await balance(c.bank);
    const checks = Array.from({ length: 36 }, (_, i) => ({
      rowNumber: i + 1, date: '2026-04-01', accountId: c.expense, amount: '10.01',
      // Row 5 names a payee that does not exist yet: auto-created, then rolled back.
      ...(i === 4 ? { contactName: 'Brand New Vendor' } : {}),
    }));
    // Row 37 is a valid amount (15 integer digits, what numeric(19,4)
    // holds), but on top of rows 1-36 it takes the expense account's
    // balance past numeric(19,4): the database refuses it at posting.
    checks.push({ rowNumber: 37, date: '2026-04-01', accountId: c.expense, amount: '999999999999999.9999' } as typeof checks[number]);
    const deposits = Array.from({ length: 13 }, (_, i) => ({
      rowNumber: 38 + i, date: '2026-04-02', accountId: c.income, amount: '25.00',
    }));
    const res = await save({
      auto_create_contacts: true,
      groups: [
        { txn_type: 'check', context_account_id: c.bank, rows: checks },
        { txn_type: 'deposit', context_account_id: c.bank, rows: deposits },
      ],
    });
    // A database error at a row: classified (not a bare 500) and named.
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(res.json.error.code).toBe('BATCH_ROW_OUT_OF_RANGE');
    expect(res.json.error.details.rowNumbers).toEqual([37]);
    expect(res.json.error.details.rows[0].rowNumber).toBe(37);
    expect(res.json.error.message).toContain('Row 37');
    expect(JSON.stringify(res.json)).not.toContain('999999999999999');

    expect(await txns()).toHaveLength(0);
    expect(await db.select().from(journalLines).where(eq(journalLines.tenantId, c.tenantId))).toHaveLength(0);
    expect(await db.select().from(contacts).where(and(eq(contacts.tenantId, c.tenantId), eq(contacts.displayName, 'Brand New Vendor')))).toHaveLength(0);
    expect(await nextCheckNumber(c.bank)).toBe(counterBefore);
    expect(await balance(c.bank)).toBe(bankBefore);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'batch')));
    expect(audits).toHaveLength(0);
  });

  it('an invalid row blocks the save and every bad row is listed', async () => {
    const res = await save({
      groups: [{
        txn_type: 'deposit', context_account_id: c.bank, rows: [
          { rowNumber: 1, date: '2026-04-01', accountId: c.income, amount: '5.00' },
          { rowNumber: 2, date: '2026-02-30', accountId: c.income, amount: '5.00' },
          { rowNumber: 3, date: '2026-04-01', accountId: c.income, amount: '0' },
          { rowNumber: 4, date: '2026-04-01', accountName: 'No Such Account', amount: '1.00001' },
        ],
      }],
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('BATCH_INVALID');
    expect(res.json.error.details.rowNumbers).toEqual([2, 3, 4]);
    const row4 = res.json.error.details.rows.find((r: { rowNumber: number }) => r.rowNumber === 4);
    expect(row4.errors.map((e: { field: string }) => e.field).sort()).toEqual(['account_name', 'amount']);
    expect(await txns()).toHaveLength(0);
  });
});

describe('mixed batch', () => {
  it('checks, deposits, card rows and a journal entry post together, exactly', async () => {
    const bankBefore = await balance(c.bank);
    const res = await save({
      auto_create_contacts: true,
      groups: [
        {
          txn_type: 'check', context_account_id: c.bank, rows: [
            { rowNumber: 1, date: '2026-04-01', contactId: c.vendor, accountId: c.expense, amount: '100.10', memo: 'Slab' },
            { rowNumber: 2, date: '2026-04-01', contactName: 'Cosmos Granite', accountId: c.expense, amount: '0.07', refNo: '2001' },
            { rowNumber: 3, date: '2026-04-01', contactName: 'Print Me Co', accountId: c.expense2, amount: '33.33', printLater: true },
          ],
        },
        {
          txn_type: 'deposit', context_account_id: c.bank, rows: [
            { rowNumber: 4, date: '2026-04-02', contactId: c.customer, accountId: c.income, amount: '1000.01', refNo: 'DEP-7' },
            { rowNumber: 5, date: '2026-04-02', accountId: c.income, amount: '0.03' },
          ],
        },
        {
          txn_type: 'credit_card_charge', context_account_id: card, rows: [
            { rowNumber: 6, date: '2026-04-03', accountId: c.expense, amount: '12.34', refNo: 'R-1' },
          ],
        },
        {
          txn_type: 'credit_card_credit', context_account_id: card, rows: [
            { rowNumber: 7, date: '2026-04-03', accountId: c.expense, amount: '2.34' },
          ],
        },
        {
          txn_type: 'journal_entry', rows: [
            { rowNumber: 8, date: '2026-04-04', refNo: 'JE-1', accountId: c.expense, debit: '0.1', description: 'first' },
            { rowNumber: 9, date: '2026-04-04', refNo: 'JE-1', accountId: c.expense2, debit: '0.2', memo: 'second' },
            { rowNumber: 10, date: '2026-04-04', refNo: 'JE-1', accountId: c.savings, credit: '0.3' },
          ],
        },
      ],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const body = res.json;
    expect(body.savedCount).toBe(8);
    expect(body.createdContacts).toEqual([expect.objectContaining({ displayName: 'Print Me Co', contactType: 'vendor' })]);
    const byRow = new Map<number, { id: string; checkNumber?: number | null; txnNumber: string | null }>(
      body.transactions.map((t: { rowNumber: number }) => [t.rowNumber, t]),
    );
    expect(byRow.get(1)!.checkNumber).toBe(1001);
    expect(byRow.get(2)!.checkNumber).toBe(2001);
    expect(byRow.get(3)!.checkNumber).toBeNull();
    expect(byRow.get(4)!.txnNumber).toBe('DEP-7');
    expect(byRow.get(8)!.id).toBe(byRow.get(10)!.id);
    // Counter: auto 1001 then manual 2001 → next is 2002.
    expect(await nextCheckNumber(c.bank)).toBe('2002');

    const rows = await txns();
    expect(rows).toHaveLength(8);
    for (const t of rows) {
      expect(t.source).toBe('batch');
      expect(t.sourceId).toBe(body.batchId);
      expect(t.companyId).toBe(c.companyId);
    }
    const printLater = rows.find((t) => t.id === byRow.get(3)!.id)!;
    expect(printLater.printStatus).toBe('queue');
    expect(printLater.payeeNameOnCheck).toBe('Print Me Co');
    const cardCredit = rows.find((t) => t.id === byRow.get(7)!.id)!;
    expect(cardCredit.txnType).toBe('deposit');
    const je = rows.find((t) => t.id === byRow.get(8)!.id)!;
    expect(je.txnType).toBe('journal_entry');
    expect(je.txnNumber).toBe('JE-1');
    const jeLines = await db.select().from(journalLines).where(eq(journalLines.transactionId, je.id)).orderBy(journalLines.lineOrder);
    expect(jeLines.map((l) => l.description)).toEqual(['first', 'second', null]);

    // Bank: + 1000.01 + 0.03 − 100.10 − 0.07 − 33.33 = 866.54. Card: owed 12.34 − 2.34 = 10.00.
    expect(Number(await balance(c.bank)) - Number(bankBefore)).toBeCloseTo(866.54, 4);
    expect(await balance(card)).toMatch(/^-?10\.0000$/);
  });
});

describe('check numbers', () => {
  it('refuses a number twice in the batch and one already in the books', async () => {
    const first = await save({ groups: [{ txn_type: 'check', context_account_id: c.bank, rows: [
      { rowNumber: 1, date: '2026-04-01', accountId: c.expense, amount: '1.00', refNo: '5000' },
    ] }] });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const res = await save({ groups: [{ txn_type: 'check', context_account_id: c.bank, rows: [
      { rowNumber: 1, date: '2026-04-01', accountId: c.expense, amount: '1.00', refNo: '5000' },
      { rowNumber: 2, date: '2026-04-01', accountId: c.expense, amount: '1.00', refNo: '5001' },
      { rowNumber: 3, date: '2026-04-01', accountId: c.expense, amount: '1.00', refNo: '5001' },
      { rowNumber: 4, date: '2026-04-01', accountId: c.expense, amount: '1.00', refNo: '12a' },
      { rowNumber: 5, date: '2026-04-01', accountId: c.expense, amount: '1.00', refNo: '9', printLater: true, contactId: c.vendor },
      { rowNumber: 6, date: '2026-04-01', accountId: c.expense, amount: '1.00', printLater: true },
    ] }] });
    expect(res.status).toBe(400);
    expect(res.json.error.details.rowNumbers).toEqual([1, 3, 4, 5, 6]);
    expect(await txns()).toHaveLength(1);
  });
});

describe('closing date', () => {
  beforeEach(async () => {
    await db.update(companies).set({
      lockDate: '2026-02-28', closingPasswordHash: await hashClosingPassword('closing-pass-123'),
    }).where(eq(companies.id, c.companyId));
  });

  const body = () => ({ groups: [{ txn_type: 'deposit', context_account_id: c.bank, rows: [
    { rowNumber: 1, date: '2026-03-01', accountId: c.income, amount: '1.00' },
    { rowNumber: 2, date: '2026-02-15', accountId: c.income, amount: '2.00' },
    { rowNumber: 3, date: '2026-02-28', accountId: c.income, amount: '3.00' },
  ] }] });

  it('lists the closed-period rows on validate', async () => {
    const res = await validate(body());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ closingDate: '2026-02-28', closingPasswordRequired: true, closedPeriodRowNumbers: [2, 3] });
  });

  it('423 without the password, 403 with a wrong one, both naming the rows; the password saves', async () => {
    const none = await save(body());
    expect(none.status).toBe(423);
    expect(none.json.error).toMatchObject({ code: 'TB_PERIOD_LOCKED', details: { rowNumbers: [2, 3], closingPasswordRequired: true } });

    const staff = await save({ ...body(), overrideConfirmed: true });
    expect(staff.status).toBe(423);

    const wrong = await save({ ...body(), closingPassword: 'nope-nope-nope' });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error).toMatchObject({ code: 'CLOSING_PASSWORD_INVALID', details: { rowNumbers: [2, 3] } });
    expect(await txns()).toHaveLength(0);

    const ok = await save({ ...body(), closingPassword: 'closing-pass-123' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.savedCount).toBe(3);
    const overrides = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'closing_date_override'),
    ));
    expect(overrides).toHaveLength(2);
    expect(JSON.stringify(overrides)).not.toContain('closing-pass-123');
  });
});

describe('Idempotency-Key', () => {
  const body = () => ({ groups: [{ txn_type: 'deposit', context_account_id: c.bank, rows: [
    { rowNumber: 1, date: '2026-04-01', accountId: c.income, amount: '9.99' },
  ] }] });

  it('replays the same body, refuses a different one, and stores nothing for a failed batch', async () => {
    const key = { 'Idempotency-Key': 'bulk-entry-0001' };
    const first = await save(body(), key);
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const again = await save(body(), key);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json).toEqual(first.json);
    expect(await txns()).toHaveLength(1);

    const other = await save({ groups: [{ ...body().groups[0]!, rows: [{ ...body().groups[0]!.rows[0]!, amount: '9.98' }] }] }, key);
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // A failed batch leaves no record: the corrected retry with the same key posts.
    const failKey = { 'Idempotency-Key': 'bulk-entry-0002' };
    const bad = await save({ groups: [{ txn_type: 'deposit', context_account_id: c.bank, rows: [{ rowNumber: 1, date: 'x', accountId: c.income, amount: '1' }] }] }, failKey);
    expect(bad.status).toBe(400);
    const fixed = await save({ groups: [{ txn_type: 'deposit', context_account_id: c.bank, rows: [{ rowNumber: 1, date: '2026-04-01', accountId: c.income, amount: '1' }] }] }, failKey);
    expect(fixed.status).toBe(201);
    expect(await txns()).toHaveLength(2);

    expect((await save(body(), { 'Idempotency-Key': '' })).json.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
    const old = await save({ txn_type: 'deposit', context_account_id: c.bank, rows: [{ rowNumber: 1, date: '2026-04-01', accountId: c.income, amount: 1 }] }, { 'Idempotency-Key': 'k' });
    expect(old.status).toBe(400);
    expect(old.json.error.code).toBe('IDEMPOTENCY_UNSUPPORTED');
  });

  it('is scoped by company', async () => {
    const [bankB] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyB, name: 'Bank B', accountType: 'asset', detailType: 'bank' }).returning();
    const [incomeB] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyB, name: 'Income B', accountType: 'revenue' }).returning();
    const key = { 'Idempotency-Key': 'shared-key' };
    expect((await save(body(), key)).status).toBe(201);
    const inB = await save({ groups: [{ txn_type: 'deposit', context_account_id: bankB!.id, rows: [
      { rowNumber: 1, date: '2026-04-01', accountId: incomeB!.id, amount: '9.99' },
    ] }] }, key, c.companyB);
    expect(inB.status, JSON.stringify(inB.json)).toBe(201);
    expect(inB.headers['idempotent-replayed']).toBeUndefined();
    const records = await db.select().from(batchSaveRequests).where(eq(batchSaveRequests.tenantId, c.tenantId));
    expect(records).toHaveLength(2);
  });
});

describe('exact journal entries and strings only', () => {
  it('refuses 0.0001 out of balance and a JSON number; enforces the A/R name rule', async () => {
    const off = await save({ groups: [{ txn_type: 'journal_entry', rows: [
      { rowNumber: 1, date: '2026-04-01', entry: 'a', accountId: c.expense, debit: '100.0001' },
      { rowNumber: 2, date: '2026-04-01', entry: 'a', accountId: c.savings, credit: '100.0000' },
    ] }] });
    expect(off.status).toBe(400);
    expect(off.json.error.details.rows[0].errors[0].code).toBe('TXN_UNBALANCED');

    const num = await save({ groups: [{ txn_type: 'journal_entry', rows: [
      { rowNumber: 1, date: '2026-04-01', entry: 'a', accountId: c.expense, debit: 100 },
      { rowNumber: 2, date: '2026-04-01', entry: 'a', accountId: c.savings, credit: '100' },
    ] }] });
    expect(num.status).toBe(400);
    expect(num.json.error.code).toBe('VALIDATION_ERROR');

    const ar = await save({ groups: [{ txn_type: 'journal_entry', rows: [
      { rowNumber: 1, date: '2026-04-01', entry: 'a', accountId: c.ar, debit: '5' },
      { rowNumber: 2, date: '2026-04-01', entry: 'a', accountId: c.income, credit: '5' },
    ] }] });
    expect(ar.status).toBe(400);
    expect(ar.json.error.details.rows[0].errors[0].code).toBe('JE_AR_AP_NAME_REQUIRED');

    const named = await save({ groups: [{ txn_type: 'journal_entry', rows: [
      { rowNumber: 1, date: '2026-04-01', entry: 'a', accountId: c.ar, debit: '5', contactId: c.customer },
      { rowNumber: 2, date: '2026-04-01', entry: 'a', accountId: c.income, credit: '5' },
    ] }] });
    expect(named.status, JSON.stringify(named.json)).toBe(201);
    const [arLine] = await db.select().from(journalLines).where(and(eq(journalLines.tenantId, c.tenantId), eq(journalLines.accountId, c.ar)));
    expect(arLine!.contactId).toBe(c.customer);
  });
});

describe('isolation and limits', () => {
  it('refuses another company’s account, name, tag and context account', async () => {
    const [expB] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyB, name: 'Only In B', accountType: 'expense' }).returning();
    const [bankB] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyB, name: 'Bank Only B', accountType: 'asset', detailType: 'bank' }).returning();
    const [vendorB] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyB, contactType: 'vendor', displayName: 'Vendor Only B' }).returning();
    const [tagB] = await db.insert(tags).values({ tenantId: c.tenantId, companyId: c.companyB, name: 'Tag Only B' }).returning();
    const other = await makeCompany('batch-other', tenantIds);

    const res = await validate({ groups: [{ txn_type: 'check', context_account_id: c.bank, rows: [
      { rowNumber: 1, date: '2026-04-01', accountId: expB!.id, amount: '1' },
      { rowNumber: 2, date: '2026-04-01', accountName: 'Only In B', amount: '1' },
      { rowNumber: 3, date: '2026-04-01', accountId: c.expense, contactId: vendorB!.id, amount: '1' },
      { rowNumber: 4, date: '2026-04-01', accountId: c.expense, tagId: tagB!.id, amount: '1' },
      { rowNumber: 5, date: '2026-04-01', accountId: other.expense, contactId: other.vendor, amount: '1' },
    ] }] });
    expect(res.status).toBe(200);
    expect(res.json.rows.map((r: { status: string }) => r.status)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid']);

    // By name a company-B vendor is not found: it would be created in A.
    const byName = await validate({ groups: [{ txn_type: 'check', context_account_id: c.bank, rows: [
      { rowNumber: 1, date: '2026-04-01', accountId: c.expense, contactName: 'Vendor Only B', amount: '1' },
    ] }] });
    expect(byName.json.rows[0]).toMatchObject({ status: 'warning', resolvedContactId: null, newContact: { displayName: 'Vendor Only B' } });
    const noAuto = await save({ groups: [{ txn_type: 'check', context_account_id: c.bank, rows: [
      { rowNumber: 1, date: '2026-04-01', accountId: c.expense, contactName: 'Vendor Only B', amount: '1' },
    ] }] });
    expect(noAuto.status).toBe(400);
    expect(noAuto.json.error.code).toBe('BATCH_CONTACT_NOT_FOUND');

    const ctx = await save({ groups: [{ txn_type: 'check', context_account_id: bankB!.id, rows: [
      { rowNumber: 1, date: '2026-04-01', accountId: c.expense, amount: '1' },
    ] }] });
    expect(ctx.status).toBe(400);
    expect(ctx.json.error).toMatchObject({ code: 'BATCH_CONTEXT_ACCOUNT_INVALID', details: { groupIndex: 0 } });
    expect(await txns()).toHaveLength(0);
  });

  it('caps a request at 10,000 rows, wants unique row numbers and the grouped types only', async () => {
    const row = (n: number) => ({ rowNumber: n, date: '2026-04-01', accountId: c.income, amount: '1' });
    const big = await save({ groups: [
      { txn_type: 'deposit', context_account_id: c.bank, rows: Array.from({ length: 5000 }, (_, i) => row(i + 1)) },
      { txn_type: 'deposit', context_account_id: c.bank, rows: Array.from({ length: 5001 }, (_, i) => row(5001 + i)) },
    ] });
    expect(big.status).toBe(400);
    expect(big.json.error.code).toBe('VALIDATION_ERROR');

    const dup = await save({ groups: [
      { txn_type: 'deposit', context_account_id: c.bank, rows: [row(1)] },
      { txn_type: 'deposit', context_account_id: c.bank, rows: [row(1)] },
    ] });
    expect(dup.status).toBe(400);

    const invoice = await save({ groups: [{ txn_type: 'invoice', rows: [row(1)] }] });
    expect(invoice.status).toBe(400);
    expect(await txns()).toHaveLength(0);
  });

  it('keeps the single-type shape working', async () => {
    const res = await save({ txn_type: 'expense', context_account_id: c.bank, rows: [
      { rowNumber: 1, date: '2026-04-01', accountId: c.expense, amount: 12.5 },
    ] });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.savedCount).toBe(1);

    // Its lookups are company scoped too.
    const [expB] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyB, name: 'Old Shape B', accountType: 'expense' }).returning();
    const v = await validate({ txn_type: 'expense', context_account_id: c.bank, rows: [
      { rowNumber: 1, date: '2026-04-01', accountId: expB!.id, amount: 1 },
      { rowNumber: 2, date: '2026-04-01', accountName: 'Old Shape B', amount: 1 },
    ] });
    expect(v.status).toBe(200);
    expect(v.json.invalidCount).toBe(2);
  });
});

// ─── Security review of #163 ─────────────────────────────────────

/** A bookkeeper of c's tenant with exactly these permissions (null: no permission row = full). */
async function bookkeeper(overrides: Record<string, string> | null) {
  const [u] = await db.insert(users).values({
    tenantId: c.tenantId, email: `bk-${suffix()}@example.com`, passwordHash: 'x', displayName: 'Bookkeeper', role: 'bookkeeper',
  }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper' });
  if (overrides) await db.insert(userPermissions).values({ tenantId: c.tenantId, userId: u!.id, overrides: overrides as never });
  const token = (await authService.issueSession({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper', email: u!.email } as never)).accessToken;
  return { id: u!.id, token };
}

const depositRow = (n: number) => ({ rowNumber: n, date: '2026-04-01', accountId: c.income, amount: '1.00' });
const checkRow = (n: number, extra: Record<string, unknown> = {}) => ({ rowNumber: n, date: '2026-04-01', accountId: c.expense, amount: '1.00', ...extra });

describe('permissions per row type (H1)', () => {
  it('needs create on the row type resource for validate and save, and on contacts to create names', async () => {
    const bk = await bookkeeper({ batch_entry: 'full', transactions: 'full', banking: 'full', checks: 'view', contacts: 'view' });
    const body = { groups: [
      { txn_type: 'deposit', context_account_id: c.bank, rows: [depositRow(1)] },
      { txn_type: 'check', context_account_id: c.bank, rows: [checkRow(2)] },
    ] };
    const v = await srv.request('/api/v1/batch/validate', bk.token, body, c.companyId);
    expect(v.status).toBe(403);
    expect(v.json.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { groupIndex: 1, resource: 'checks' } });
    const s1 = await srv.request('/api/v1/batch/save', bk.token, body, c.companyId);
    expect(s1.status).toBe(403);
    expect(s1.json.error.details).toMatchObject({ groupIndex: 1, resource: 'checks' });
    expect(await txns()).toHaveLength(0);

    const named = { auto_create_contacts: true, groups: [{ txn_type: 'deposit', context_account_id: c.bank, rows: [{ ...depositRow(1), contactName: 'Brand New Customer' }] }] };
    const s2 = await srv.request('/api/v1/batch/save', bk.token, named, c.companyId);
    expect(s2.status).toBe(403);
    expect(s2.json.error.details).toEqual({ resource: 'contacts' });
    expect(await txns()).toHaveLength(0);

    const ok = await srv.request('/api/v1/batch/save', bk.token, { groups: [body.groups[0]] }, c.companyId);
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
  });

  it('maps each row type to its resource', async () => {
    const cases: Array<[string, string, string | null]> = [
      ['journal_entry', 'transactions', null],
      ['expense', 'transactions', c.bank],
      ['credit_card_charge', 'transactions', card],
      ['credit_card_credit', 'banking', card],
      ['deposit', 'banking', c.bank],
      ['check', 'checks', c.bank],
    ];
    const bk = await bookkeeper({ batch_entry: 'full', transactions: 'none', banking: 'none', checks: 'none' });
    for (const [type, resource, ctx] of cases) {
      const res = await srv.request('/api/v1/batch/validate', bk.token, { groups: [
        { txn_type: type, ...(ctx ? { context_account_id: ctx } : {}), rows: [checkRow(1)] },
      ] }, c.companyId);
      expect(res.status, type).toBe(403);
      expect(res.json.error.details, type).toEqual({ groupIndex: 0, resource });
    }
  });
});

describe('journal entry sides (M2)', () => {
  it('refuses a negative debit or credit, even when the entry balances', async () => {
    const res = await validate({ groups: [{ txn_type: 'journal_entry', rows: [
      { rowNumber: 1, date: '2026-04-01', entry: 'a', accountId: c.expense, debit: '-5.00' },
      { rowNumber: 2, date: '2026-04-01', entry: 'a', accountId: c.savings, credit: '-5.00' },
    ] }] });
    expect(res.status).toBe(200);
    expect(res.json.invalidCount).toBe(2);
    expect(res.json.rows[0].errors).toContainEqual(expect.objectContaining({ field: 'debit', code: 'VALIDATION_ERROR' }));
    expect(res.json.rows[1].errors).toContainEqual(expect.objectContaining({ field: 'credit', code: 'VALIDATION_ERROR' }));
    const zero = await validate({ groups: [{ txn_type: 'journal_entry', rows: [
      { rowNumber: 1, date: '2026-04-01', entry: 'a', accountId: c.expense, debit: '5', credit: '-0' },
      { rowNumber: 2, date: '2026-04-01', entry: 'a', accountId: c.savings, credit: '5' },
    ] }] });
    expect(zero.json.invalidCount).toBe(0);
  });
});

describe('account kinds (M3)', () => {
  it('limits group accounts to bank / credit card kinds by row type', async () => {
    const [prepaid] = await db.insert(accounts).values({
      tenantId: c.tenantId, companyId: c.companyId, name: 'Prepaid', accountType: 'asset', detailType: 'prepaid_expense',
    }).returning();
    const [loan] = await db.insert(accounts).values({
      tenantId: c.tenantId, companyId: c.companyId, name: 'Loan', accountType: 'liability', detailType: 'long_term_liability',
    }).returning();
    const refused: Array<[string, string]> = [
      ['deposit', card], ['check', card], ['credit_card_charge', c.bank], ['credit_card_credit', c.bank],
      ['check', prepaid!.id], ['deposit', c.ar], ['expense', loan!.id], ['expense', c.ap], ['credit_card_charge', loan!.id],
    ];
    for (const [type, ctx] of refused) {
      const res = await validate({ groups: [{ txn_type: type, context_account_id: ctx, rows: [checkRow(1)] }] });
      expect(res.status, `${type} ${ctx}`).toBe(400);
      expect(res.json.error).toMatchObject({ code: 'BATCH_CONTEXT_ACCOUNT_INVALID', details: { groupIndex: 0 } });
    }
    for (const [type, ctx] of [['expense', c.bank], ['expense', card], ['check', c.bank], ['deposit', c.savings]] as const) {
      const res = await validate({ groups: [{ txn_type: type, context_account_id: ctx, rows: [checkRow(1)] }] });
      expect(res.status, `${type} ${ctx}`).toBe(200);
    }
  });

  it('refuses A/R and A/P as the account of non-journal rows; journal rows keep the name rule', async () => {
    const res = await validate({ groups: [
      { txn_type: 'deposit', context_account_id: c.bank, rows: [{ ...depositRow(1), accountId: c.ar, contactId: c.customer }] },
      { txn_type: 'check', context_account_id: c.bank, rows: [checkRow(2, { accountId: c.ap, contactId: c.vendor })] },
      { txn_type: 'journal_entry', rows: [
        { rowNumber: 4, date: '2026-04-01', entry: 'a', accountId: c.ar, debit: '5', contactId: c.customer },
        { rowNumber: 5, date: '2026-04-01', entry: 'a', accountId: c.income, credit: '5' },
      ] },
    ] });
    expect(res.status).toBe(200);
    const byRow = new Map<number, { status: string; errors: Array<{ field: string; code?: string }> }>(
      res.json.rows.map((r: { rowNumber: number }) => [r.rowNumber, r]),
    );
    for (const n of [1, 2]) {
      expect(byRow.get(n)!.errors).toContainEqual(expect.objectContaining({ field: 'account_name', code: 'BATCH_ACCOUNT_AR_AP' }));
    }
    expect(byRow.get(4)!.status).toBe('valid');
    expect(byRow.get(5)!.status).toBe('valid');
  });
});

describe('bounded batch transaction (M4)', () => {
  /** Holds a lock in another transaction until the returned function is called. */
  async function holdLock(statement: ReturnType<typeof sql>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const held = new Promise<void>((r) => { ready = r; });
    const holder = db.transaction(async (tx) => { await tx.execute(statement); ready(); await gate; });
    await held;
    return async () => { release(); await holder; };
  }

  it('a second batch save of the tenant is 409 BATCH_BUSY at once; nothing is posted', async () => {
    const body = { groups: [{ txn_type: 'deposit', context_account_id: c.bank, rows: [depositRow(1)] }] };
    const free = await holdLock(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`batch-save-tenant:${c.tenantId}`}, 0))`);
    try {
      const res = await save(body, { 'Idempotency-Key': 'busy-1' });
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe('BATCH_BUSY');
    } finally {
      await free();
    }
    expect(await txns()).toHaveLength(0);
    // The retry with the same key now saves.
    expect((await save(body, { 'Idempotency-Key': 'busy-1' })).status).toBe(201);
  });

  it('gives up on a held row lock after lock_timeout: 409 BATCH_BUSY', async () => {
    const before = batchTimeouts.lock;
    batchTimeouts.lock = '200ms';
    const free = await holdLock(sql`SELECT 1 FROM companies WHERE id = ${c.companyId} FOR UPDATE`);
    try {
      const res = await save({ groups: [{ txn_type: 'check', context_account_id: c.bank, rows: [checkRow(1)] }] });
      expect(res.status, JSON.stringify(res.json)).toBe(409);
      expect(res.json.error.code).toBe('BATCH_BUSY');
    } finally {
      batchTimeouts.lock = before;
      await free();
    }
    expect(await txns()).toHaveLength(0);
  });

  it('advances the check counter of the active company only', async () => {
    await db.update(companies).set({ checkSettings: { nextCheckNumbers: { [c.bank]: 77 } } as never }).where(eq(companies.id, c.companyB));
    const res = await save({ groups: [{ txn_type: 'check', context_account_id: c.bank, rows: [checkRow(1), checkRow(2, { refNo: '4000' })] }] });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(await nextCheckNumber(c.bank)).toBe('4001');
    const [b] = await db.select().from(companies).where(eq(companies.id, c.companyB));
    expect((b!.checkSettings as { nextCheckNumbers: Record<string, number> }).nextCheckNumbers[c.bank]).toBe(77);
  });
});

describe('Idempotency-Key per user (L5)', () => {
  it('another user with the same key is refused, not replayed', async () => {
    const body = { groups: [{ txn_type: 'deposit', context_account_id: c.bank, rows: [depositRow(1)] }] };
    const key = { 'Idempotency-Key': 'per-user-1' };
    expect((await save(body, key)).status).toBe(201);
    const bk = await bookkeeper(null);
    const other = await srv.request('/api/v1/batch/save', bk.token, body, c.companyId, key);
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(other.json.error.details).toBeUndefined();
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(await txns()).toHaveLength(1);
  });
});

describe('check counter simulation (L6)', () => {
  it('a typed number an earlier empty row takes automatically is a row error on validate', async () => {
    const next = Number((await nextCheckNumber(c.bank)) ?? 1001);
    const clash = await validate({ groups: [{ txn_type: 'check', context_account_id: c.bank, rows: [
      checkRow(1), checkRow(2, { refNo: String(next) }),
    ] }] });
    expect(clash.status).toBe(200);
    expect(clash.json.rows[0].status).toBe('valid');
    expect(clash.json.rows[1].errors).toContainEqual(expect.objectContaining({ field: 'ref_no', code: 'CHECK_NUMBER_DUPLICATE' }));

    // Typed first, then automatic: the counter moves past the typed number.
    const fine = await save({ groups: [{ txn_type: 'check', context_account_id: c.bank, rows: [
      checkRow(1, { refNo: String(next) }), checkRow(2),
    ] }] });
    expect(fine.status, JSON.stringify(fine.json)).toBe(201);
    expect(fine.json.transactions.map((t: { checkNumber: number }) => t.checkNumber)).toEqual([next, next + 1]);
  });
});

describe('database errors and exact sums (L7, L8)', () => {
  it('classifies database errors and leaves others alone', () => {
    const wrapped = (code: string) => Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('pg'), { code }) });
    expect(classifyDbError(wrapped('22003'))).toMatchObject({ statusCode: 400, code: 'BATCH_ROW_OUT_OF_RANGE' });
    expect(classifyDbError(wrapped('23503'))).toMatchObject({ statusCode: 400, code: 'BATCH_ROW_REJECTED' });
    expect(classifyDbError(wrapped('23505'))).toMatchObject({ statusCode: 409, code: 'BATCH_ROW_CONFLICT' });
    expect(classifyDbError(wrapped('40P01'))).toMatchObject({ statusCode: 409, code: 'BATCH_ROW_CONFLICT' });
    expect(classifyDbError(wrapped('55P03'))).toMatchObject({ statusCode: 409, code: 'BATCH_BUSY' });
    expect(classifyDbError(wrapped('57014'))).toMatchObject({ statusCode: 409, code: 'BATCH_TIMEOUT' });
    expect(classifyDbError(wrapped('XX000'))).toBeNull();
    expect(classifyDbError(new Error('no code'))).toBeNull();
  });

  it('compares journal entry totals beyond 20 significant digits exactly', async () => {
    // 11 x 999,999,999,999,999.9999 against 10 of them plus ...9998: off
    // by 0.0001 at 21 significant digits (decimal.js's default precision
    // of 20 would round both totals to the same value).
    const big = '999999999999999.9999';
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => ({ rowNumber: i + 1, date: '2026-04-01', entry: 'a', accountId: c.expense, debit: big })),
      ...Array.from({ length: 10 }, (_, i) => ({ rowNumber: 12 + i, date: '2026-04-01', entry: 'a', accountId: c.savings, credit: big })),
      { rowNumber: 22, date: '2026-04-01', entry: 'a', accountId: c.savings, credit: '999999999999999.9998' },
    ];
    const res = await validate({ groups: [{ txn_type: 'journal_entry', rows }] });
    expect(res.status).toBe(200);
    expect(res.json.rows[0].errors).toContainEqual(expect.objectContaining({ code: 'TXN_UNBALANCED' }));
    const tooBig = await validate({ groups: [{ txn_type: 'deposit', context_account_id: c.bank, rows: [{ ...depositRow(1), amount: '1000000000000000' }] }] });
    expect(tooBig.json.rows[0].errors).toContainEqual(expect.objectContaining({ field: 'amount' }));
  });
});

describe('parse-csv column_mapping (L9)', () => {
  async function parseCsv(mapping: string) {
    const form = new FormData();
    form.append('file', new Blob(['date,amount\n2026-04-01,5.00\n'], { type: 'text/csv' }), 'rows.csv');
    form.append('txn_type', 'expense');
    form.append('column_mapping', mapping);
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/v1/batch/parse-csv`, {
      method: 'POST', body: form, headers: { Authorization: `Bearer ${c.token}`, 'X-Company-Id': c.companyId },
    });
    return { status: res.status, json: await res.json() as Res['json'] };
  }

  it('accepts field -> column index (0 or more) and refuses anything else', async () => {
    expect((await parseCsv('{"date":0,"amount":1}')).status).toBe(200);
    for (const bad of ['{"date":-1}', '{"date":"0"}', '{"date":1.5}', '[0,1]', '"x"', '{"date":{"a":1}}', 'not json']) {
      const res = await parseCsv(bad);
      expect(res.status, bad).toBe(400);
      expect(res.json.error.code, bad).toBe('VALIDATION_ERROR');
    }
  });
});
