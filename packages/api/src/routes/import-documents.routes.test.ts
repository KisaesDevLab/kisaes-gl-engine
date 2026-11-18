// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Spreadsheet documents (U-268, imports-transactions-v1; ClientLedger P31 E4):
// a Generic "transactions" file of multi-line invoices, bills and journal
// entries posts through the invoice, bill and journal entry services in one
// batch transaction. Row problems at upload carry the column (field); a
// refusal at commit posts nothing; undo removes everything (counters
// included); a re-commit after undo creates all of it again; the closing-date
// password opens a closed period once per batch.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, auditLog, companies, contacts, items, journalLines, tags, transactions } from '../db/schema/index.js';
import { importsRouter } from './imports.routes.js';
import * as importsService from '../services/imports/imports.service.js';
import * as batchService from '../services/imports/import-batch.service.js';
import { parseTransactions } from '../services/imports/adapters/transactions.js';
import { hashClosingPassword } from '../services/closing-password.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { Harness, type Co, key } from './receivables.test-support.js';
import { cleanImports, batchRow, companySnapshot } from './imports-batch.test-support.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

const h = new Harness();
let c: Co;
/** Account cells as the file names them: the income account by number (or name), expense by name, A/R by name. */
let ref: { income: string; expense: string; ar: string; vendor: string; item: string; tag: string };

const HEADER = 'group_id,type,date,number,name,due_date,memo,line_account,line_item,line_description,line_amount,line_debit,line_credit,line_tag';

beforeEach(async () => {
  h.extraCleanup = [cleanImports];
  await h.start([['/api/v1/imports', importsRouter]]);
  c = await h.company();
  const acct = async (id: string) => (await db.select().from(accounts).where(eq(accounts.id, id)))[0]!;
  const income = await acct(c.roles['income']!);
  const expense = await acct(c.roles['expense']!);
  const ar = await acct(c.roles['accounts_receivable']!);
  await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: 'Cedar Supply' });
  await db.insert(items).values({
    tenantId: c.tenantId, companyId: c.companyId, name: 'Consulting', itemType: 'service',
    incomeAccountId: income.id, expenseAccountId: expense.id,
  });
  await db.insert(tags).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'North Barn' });
  ref = { income: income.accountNumber ?? income.name, expense: expense.name, ar: ar.name, vendor: 'Cedar Supply', item: 'Consulting', tag: 'North Barn' };
});
afterEach(async () => { await h.stop(); });

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csv = (rows: string[][]) => `${HEADER}\r\n${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

/** row: group, type, date, number, name, due, memo, account, item, description, amount, debit, credit, tag */
const row = (...cells: string[]) => [...cells, ...Array(14 - cells.length).fill('')];

/** Two invoices (one numbered, one taking the counter), a two-line bill and a three-line journal entry. */
function goodRows() {
  return [
    row('INV-1', 'invoice', '2026-09-15', '1001', 'Bluestem Veterinary Clinic', '2026-10-15', 'September work', ref.income, '', 'Herd check', '1200.00'),
    row('INV-1', 'invoice', '2026-09-15', '1001', 'Bluestem Veterinary Clinic', '2026-10-15', 'September work', '', ref.item, 'Advice', '300.25', '', '', ref.tag),
    row('INV-2', 'invoice', '2026-09-20', '', 'Prairie Fork Kennels', '', '', ref.income, '', 'Kennel visit', '80.00'),
    row('INV-2', 'invoice', '2026-09-20', '', 'Prairie Fork Kennels', '', '', ref.income, '', 'Discount', '-5.00'),
    row('B-1', 'bill', '2026-09-18', 'V-778', ref.vendor, '2026-10-18', '', ref.expense, '', 'Feed', '410.1234', '', '', ref.tag),
    row('B-1', 'bill', '2026-09-18', 'V-778', ref.vendor, '2026-10-18', '', '', ref.item, 'Outside help', '89.8766'),
    row('JE-1', 'journal_entry', '2026-09-30', 'ADJ-9', '', '', 'Reclass', ref.expense, '', 'Move', '', '75.50'),
    row('JE-1', 'journal_entry', '2026-09-30', 'ADJ-9', '', '', 'Reclass', ref.income, '', 'Move', '', '', '70.50'),
    row('JE-1', 'journal_entry', '2026-09-30', 'ADJ-9', '', '', 'Reclass', ref.income, '', 'Move', '', '', '5.00'),
    row('JE-1', 'journal_entry', '2026-09-30', 'ADJ-9', '', '', 'Reclass', ref.income, '', 'Zero line', '', '0', ''),
  ];
}

async function upload(text: string) {
  return await importsService.createSession({
    tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
    file: { originalname: 'transactions.csv', buffer: Buffer.from(text, 'utf8') },
    kind: 'transactions', sourceSystem: 'generic', options: {} as never, role: 'post',
  });
}

const post = (p: string, body: unknown) => h.request('POST', `/api/v1/imports${p}`, c.token, body, { 'Idempotency-Key': key() });

async function batchOf(sessionId: string) {
  const r = await h.request('POST', '/api/v1/imports/batches', c.token, { sourceSystem: 'generic', kind: 'transactions', sessionIds: [sessionId], options: {} });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return String(r.json['batch'].id);
}

async function run(p: string, body: Record<string, unknown> = { backupRef: 'before-import.clb' }) {
  const r = await post(p, body);
  if (r.status === 202) await batchService.__batchJobs.last;
  return r;
}

async function commitFile(text: string) {
  const s = await upload(text);
  expect(s.validationErrors, JSON.stringify(s.validationErrors)).toEqual([]);
  const id = await batchOf(s.session.id);
  const r = await run(`/batches/${id}/commit`);
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  return { id, sessionId: s.session.id };
}

const batchTxns = (batchId: string) => db.select().from(transactions)
  .where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.importBatchId, batchId)));

describe('U-268 spreadsheet documents: parse', () => {
  it('advertises imports-transactions-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('imports-transactions-v1');
  });

  it('reads exact amounts, groups by group_id, drops zero journal lines', () => {
    const grid = csv(goodRows()).trim().split('\r\n').map((l) => l.split(','));
    const { documents, errors, lineCount } = parseTransactions(grid);
    expect(errors).toEqual([]);
    expect(lineCount).toBe(10);
    expect(documents.map((d) => [d.groupId, d.docType, d.lines.length])).toEqual([
      ['INV-1', 'invoice', 2], ['INV-2', 'invoice', 2], ['B-1', 'bill', 2], ['JE-1', 'journal_entry', 3],
    ]);
    expect(documents[2]!.lines.map((l) => l.amount)).toEqual(['410.1234', '89.8766']);
    expect(documents[3]!.lines.map((l) => l.amount)).toEqual(['75.50', '-70.50', '-5.00']);
    expect(documents[0]).toMatchObject({ rowNumber: 2, date: '2026-09-15', number: '1001', dueDate: '2026-10-15', memo: 'September work' });
  });

  it('row problems carry the column: unbalanced, mixed group, amounts, type, dates, items on journal lines', () => {
    const grid = (rows: string[][]) => [HEADER.split(','), ...rows];
    const codes = (rows: string[][]) => parseTransactions(grid(rows)).errors.map((e) => [e.rowNumber, e.field ?? null, e.code]);
    expect(codes([
      row('J', 'journal_entry', '2026-09-30', '', '', '', '', ref.income, '', '', '', '10.00'),
      row('J', 'journal_entry', '2026-09-30', '', '', '', '', ref.expense, '', '', '', '', '9.99'),
    ])).toEqual([[2, null, 'IMPORT_UNBALANCED']]);
    expect(codes([
      row('I', 'invoice', '2026-09-30', '', 'A', '', '', ref.income, '', '', '10.00'),
      row('I', 'invoice', '2026-10-01', '', 'A', '', '', ref.income, '', '', '10.00'),
    ])).toEqual([[3, 'date', 'IMPORT_MIXED_GROUP']]);
    expect(codes([
      row('I', 'invoice', '2026-09-30', '', 'A', '', '', ref.income, '', '', ''),
      row('K', 'invoice', '2026-09-30', '', 'A', '', '', ref.income, '', '', '1e3'),
      row('L', 'invoice', '2026-09-30', '', 'A', '', '', ref.income, '', '', '10.005'),
      row('M', 'bill', '2026-09-30', '', 'V', '', '', ref.expense, '', '', '1.23456'),
    ]).map((x) => x.slice(1))).toEqual([
      ['line_amount', 'IMPORT_AMOUNT_INVALID'], ['line_amount', 'IMPORT_AMOUNT_INVALID'], ['line_amount', 'IMPORT_AMOUNT_CENTS'], ['line_amount', 'IMPORT_AMOUNT_INVALID'],
    ]);
    expect(codes([
      row('X', 'estimate', '2026-09-30', '', 'A', '', '', ref.income, '', '', '10.00'),
      row('Y', 'invoice', '2026-02-30', '', 'A', '', '', ref.income, '', '', '10.00'),
      row('Z', 'bill', '2026-09-30', '', '', '', '', ref.expense, '', '', '10.00'),
      row('W', 'journal_entry', '2026-09-30', '', '', '', '', '', ref.item, '', '', '10.00'),
      row('V', 'invoice', '2026-09-30', '', 'A', '', '', ref.income, '', '', '-10.00'),
    ])).toEqual([
      [2, 'type', 'IMPORT_UNKNOWN_TYPE'], [3, 'date', 'IMPORT_BAD_DATE'], [4, 'name', 'IMPORT_MISSING_FIELD'],
      [5, 'line_item', 'IMPORT_FIELD_NOT_ALLOWED'], [6, 'line_amount', 'IMPORT_DOCUMENT_TOTAL'],
    ]);
  });

  it('upload: unknown names, accounts, items and tags are IMPORT_UNKNOWN_REF with their column; preview counts lines and documents', async () => {
    const s = await upload(csv([
      ...goodRows(),
      row('I9', 'invoice', '2026-09-30', '', 'Nobody Ltd', '', '', 'No Such Account', 'No Such Item', '', '10.00', '', '', 'No Such Tag'),
    ]));
    expect(s.validationErrors.map((e) => [e.rowNumber, e.field, e.code])).toEqual([
      [12, 'name', 'IMPORT_UNKNOWN_REF'], [12, 'line_account', 'IMPORT_UNKNOWN_REF'], [12, 'line_item', 'IMPORT_UNKNOWN_REF'], [12, 'line_tag', 'IMPORT_UNKNOWN_REF'],
    ]);
    // Messages never carry the names.
    expect(s.validationErrors.some((e) => /Nobody|No Such/.test(e.message))).toBe(false);
    expect(s.preview).toMatchObject({ totalRows: 11, documentCount: 5, documents: { invoice: 3, bill: 1, journal_entry: 1 } });
    // Re-checked at commit (a chart or name file of the same batch could bring them): the batch fails, all listed.
    const id = await batchOf(s.session.id);
    expect((await run(`/batches/${id}/commit`)).status).toBe(202);
    const g = await h.request('GET', `/api/v1/imports/batches/${id}`, c.token);
    expect(g.json['batch'].status).toBe('failed');
    expect(g.json['error']).toMatchObject({ code: 'IMPORT_UNKNOWN_REF', rowNumber: 12, field: 'name', details: { refCount: 4 } });
    expect(await batchTxns(id)).toHaveLength(0);
    // Other upload problems block before the 202.
    const bad = await upload(csv([row('J', 'journal_entry', '2026-09-30', '', '', '', '', ref.income, '', '', '', '10.00')]));
    const id2 = await batchOf(bad.session.id);
    const r = await post(`/batches/${id2}/commit`, { backupRef: 'x.clb' });
    expect([r.status, r.json['error'].code]).toEqual([409, 'IMPORT_HAS_ERRORS']);
  });

  it('a transactions file is Generic only', async () => {
    await expect(importsService.createSession({
      tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
      file: { originalname: 't.csv', buffer: Buffer.from(csv(goodRows())) },
      kind: 'transactions', sourceSystem: 'quickbooks_desktop', options: {} as never,
    })).rejects.toMatchObject({ code: 'IMPORT_WRONG_KIND' });
  });
});

describe('U-268 spreadsheet documents: commit, undo, re-commit', () => {
  it('posts multi-line invoices (no sales tax), bills and journal entries exactly, in the batch', async () => {
    const [co] = await db.select({ next: companies.invoiceNextNumber }).from(companies).where(eq(companies.id, c.companyId));
    const { id, sessionId } = await commitFile(csv(goodRows()));
    const b = await batchRow(id);
    expect(b.status).toBe('committed');
    expect((b.result as Body).sessions[sessionId]).toEqual({ created: 4, skipped: 0, documents: { invoice: 2, bill: 1, journal_entry: 1 } });

    const docs = await batchTxns(id);
    expect(docs).toHaveLength(4);
    expect(docs.every((d) => d.source === 'import_transactions' && d.sourceId?.startsWith(`${sessionId}:`))).toBe(true);
    const inv1 = docs.find((d) => d.txnType === 'invoice' && d.txnNumber === '1001')!;
    expect(inv1).toMatchObject({ txnDate: '2026-09-15', dueDate: '2026-10-15', memo: 'September work', contactId: c.customer });
    expect([String(inv1.total), String(inv1.taxAmount)].map((x) => Number(x).toFixed(2))).toEqual(['1500.25', '0.00']);
    const inv2 = docs.find((d) => d.txnType === 'invoice' && d.txnNumber !== '1001')!;
    expect(Number(inv2.total).toFixed(2)).toBe('75.00');
    // No number: it took the next one from the counter (undo gives it back, see below).
    expect(inv2.txnNumber).toBeTruthy();
    const [co2] = await db.select({ next: companies.invoiceNextNumber }).from(companies).where(eq(companies.id, c.companyId));
    expect(co2!.next).not.toBe(co!.next);
    const bill = docs.find((d) => d.txnType === 'bill')!;
    expect(bill.vendorInvoiceNumber).toBe('V-778');
    expect(Number(bill.total).toFixed(4)).toBe('500.0000');
    const je = docs.find((d) => d.txnType === 'journal_entry')!;
    expect(je.txnNumber).toBe('ADJ-9');
    const jl = await db.select().from(journalLines).where(eq(journalLines.transactionId, je.id));
    expect(jl.map((l) => [Number(l.debit).toFixed(2), Number(l.credit).toFixed(2)]).sort()).toEqual([['0.00', '5.00'], ['0.00', '70.50'], ['75.50', '0.00']]);
    // The tag landed on the tagged lines.
    const [tag] = await db.select().from(tags).where(and(eq(tags.tenantId, c.tenantId), eq(tags.name, 'North Barn')));
    const tagged = await db.select().from(journalLines).where(and(eq(journalLines.tenantId, c.tenantId), eq(journalLines.tagId, tag!.id)));
    expect(tagged.length).toBeGreaterThanOrEqual(2);

    // The same data again is refused while committed.
    await expect(upload(csv(goodRows()))).rejects.toMatchObject({ code: 'IMPORT_ALREADY_COMMITTED' });
  });

  it('a refusal at commit posts nothing: a reference gone since upload (IMPORT_UNKNOWN_REF, field), a service refusal on a later document', async () => {
    const before = await companySnapshot(c);
    const s = await upload(csv(goodRows()));
    await db.update(contacts).set({ displayName: 'Cedar Supply Renamed' }).where(and(eq(contacts.tenantId, c.tenantId), eq(contacts.displayName, 'Cedar Supply')));
    const id = await batchOf(s.session.id);
    expect((await run(`/batches/${id}/commit`)).status).toBe(202);
    const g = await h.request('GET', `/api/v1/imports/batches/${id}`, c.token);
    expect(g.json['batch'].status).toBe('failed');
    expect(g.json['error']).toMatchObject({ code: 'IMPORT_UNKNOWN_REF', rowNumber: 6, field: 'name', details: { refCount: 1, refs: [{ rowNumber: 6, field: 'name', reason: 'unknown' }] } });
    expect(JSON.stringify(g.json['error'])).not.toContain('Cedar');
    await db.update(contacts).set({ displayName: 'Cedar Supply' }).where(and(eq(contacts.tenantId, c.tenantId), eq(contacts.displayName, 'Cedar Supply Renamed')));
    expect(await companySnapshot(c)).toEqual(before);

    // The invoices post first; the journal entry after them names A/R with no customer: the ledger refuses, all rolls back.
    const s2 = await upload(csv([
      ...goodRows().slice(0, 4),
      row('JE-2', 'journal_entry', '2026-09-30', '', '', '', '', ref.ar, '', '', '', '10.00'),
      row('JE-2', 'journal_entry', '2026-09-30', '', '', '', '', ref.income, '', '', '', '', '10.00'),
    ]));
    expect(s2.validationErrors).toEqual([]);
    const id2 = await batchOf(s2.session.id);
    expect((await run(`/batches/${id2}/commit`)).status).toBe(202);
    const g2 = await h.request('GET', `/api/v1/imports/batches/${id2}`, c.token);
    expect(g2.json['batch'].status).toBe('failed');
    expect(g2.json['error']).toMatchObject({ code: 'JE_AR_AP_NAME_REQUIRED', rowNumber: 6 });
    expect(await companySnapshot(c)).toEqual(before);
  });

  it('undo removes every document and gives the invoice counter back; a re-commit after undo creates all of them again', async () => {
    const before = await companySnapshot(c);
    const { id } = await commitFile(csv(goodRows()));
    expect(await batchTxns(id)).toHaveLength(4);
    const u = await run(`/batches/${id}/undo`, { backupRef: 'before-undo.clb' });
    expect(u.status, JSON.stringify(u.json)).toBe(202);
    expect((await batchRow(id)).status).toBe('undone');
    expect(await companySnapshot(c)).toEqual(before);

    // The same file again: allowed now, and it creates all four.
    const again = await commitFile(csv(goodRows()));
    expect((await batchRow(again.id)).status).toBe('committed');
    const docs = await batchTxns(again.id);
    expect(docs.map((d) => d.txnType).sort()).toEqual(['bill', 'invoice', 'invoice', 'journal_entry']);
  });

  it('a closed period: 423 without the closing-date password, 403 when wrong, one override audit row when right', async () => {
    const s = await upload(csv(goodRows()));
    const id = await batchOf(s.session.id);
    await db.update(companies).set({
      lockDate: '2026-09-16', lockDateSetAt: new Date(), lockDateSetBy: c.userId, closingPasswordHash: await hashClosingPassword('Closing-Pass-1'),
    }).where(eq(companies.id, c.companyId));
    const none = await post(`/batches/${id}/commit`, { backupRef: 'x.clb' });
    expect([none.status, none.json['error'].code]).toEqual([423, 'TB_PERIOD_LOCKED']);
    const wrong = await post(`/batches/${id}/commit`, { backupRef: 'x.clb', closingPassword: 'nope' });
    expect([wrong.status, wrong.json['error'].code]).toEqual([403, 'CLOSING_PASSWORD_INVALID']);
    expect((await batchRow(id)).status).toBe('draft');
    const ok = await run(`/batches/${id}/commit`, { backupRef: 'x.clb', closingPassword: 'Closing-Pass-1' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(202);
    expect((await batchRow(id)).status).toBe('committed');
    expect(await batchTxns(id)).toHaveLength(4);
    const overrides = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'closing_date_override')));
    expect(overrides).toHaveLength(1);
  });
});
