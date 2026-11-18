// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Bulk Import batch undo, closing-date password and rights (U-261, U-262,
// U-263; ClientLedger P31 E1): undo restores the exact pre-import state, a
// re-commit after undo creates everything again, blockers (live payment,
// later postings, a void payment on a batch-created customer), voided
// applications removed with the batch, closed periods, the admin right.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  importSessions, importRows, importBatches, transactions, companies, auditLog, paymentApplications, contacts, accounts,
} from '../db/schema/index.js';
import { importsRouter } from './imports.routes.js';
import { paymentsRouter } from './payments.routes.js';
import * as batchService from '../services/imports/import-batch.service.js';
import { loadCreatedSets, findPointers } from '../services/imports/import-undo.service.js';
import * as ledger from '../services/ledger.service.js';
import { hashClosingPassword } from '../services/closing-password.service.js';
import { Harness, type Co, key } from './receivables.test-support.js';
import { uploadSet, upload, glCsv, companySnapshot, cleanImports, batchRow, stamped, COA_CSV } from './imports-batch.test-support.js';

const h = new Harness();
let c: Co;

beforeEach(async () => {
  h.extraCleanup = [cleanImports];
  await h.start([['/api/v1/imports', importsRouter], ['/api/v1/payments', paymentsRouter]]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

const post = (p: string, body: unknown, token = c.token) =>
  h.request('POST', `/api/v1/imports${p}`, token, body, { 'Idempotency-Key': key() });
const get = (p: string) => h.request('GET', `/api/v1/imports${p}`, c.token);

async function createBatch(sessionIds: string[], options: Record<string, unknown> = {}) {
  const r = await h.request('POST', '/api/v1/imports/batches', c.token, { sourceSystem: 'accounting_power', kind: 'conversion', sessionIds, options });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return String(r.json['batch'].id);
}

async function run(p: string, body: Record<string, unknown> = {}, token = c.token) {
  const r = await post(p, body, token);
  if (r.status === 202) await batchService.__batchJobs.last;
  return r;
}

async function committedSet(options: Record<string, unknown> = {}) {
  const s = await uploadSet(c);
  const id = await createBatch([s.coa, s.vendors, s.tb, s.gl], options);
  const r = await run(`/batches/${id}/commit`, { backupRef: 'before-import.clb' });
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  expect((await batchRow(id)).status).toBe('committed');
  return { id, s };
}

/** Puts a document made by the services into a committed batch, as E2a will create them (stamps moved past its lines). */
async function adopt(batchId: string, txnId: string) {
  await db.update(transactions).set({ importBatchId: batchId }).where(eq(transactions.id, txnId));
  await db.execute(sql`UPDATE import_batches SET prior_values = jsonb_set(prior_values, '{stamps,linesCreatedMax}',
    to_jsonb((SELECT MAX(created_at)::text FROM journal_lines WHERE transaction_id = ${txnId}))) WHERE id = ${batchId}`);
}

async function receive(invoiceId: string, amount: string, customer = c.customer) {
  const r = await h.request('POST', '/api/v1/payments/receive', c.token, {
    customerId: customer, date: '2026-11-10', amount, depositTo: c.roles['checking'], applications: [{ invoiceId, amount }],
  }, { 'Idempotency-Key': key() });
  expect([200, 201], JSON.stringify(r.json)).toContain(r.status);
  const id = r.json['payment']?.id ?? r.json['transaction']?.id ?? r.json['id'];
  expect(id).toBeTruthy();
  return String(id);
}

async function voidPayment(id: string) {
  const r = await h.request('POST', `/api/v1/payments/${id}/void`, c.token, { reason: 'test' }, { 'Idempotency-Key': key() });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}

describe('undo (U-261)', () => {
  it('restores the exact pre-import state, frees re-import, and a re-commit creates all of it again', async () => {
    const before = await companySnapshot(c);
    const { id, s } = await committedSet({ fiscalYearStartMonth: 7 });
    expect(await stamped(c, id)).toEqual({ accounts: 5, contacts: 2, transactions: 7, tags: 0 });
    expect(await companySnapshot(c)).not.toEqual(before);

    const r = await run(`/batches/${id}/undo`, { backupRef: 'before-undo.clb' });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    const out = await get(`/batches/${id}`);
    expect(out.json['batch'].status, JSON.stringify(out.json)).toBe('undone');
    expect(out.json['batch'].undoneAt).toEqual(expect.any(String));
    expect(out.json['batch'].sessions.every((x: any) => x.status === 'undone')).toBe(true);
    expect(await companySnapshot(c)).toEqual(before);
    const [co] = await db.select({ m: companies.fiscalYearStartMonth }).from(companies).where(eq(companies.id, c.companyId));
    expect(co!.m).toBe(1);
    // Parsed rows are gone; the session rows stay as the record.
    for (const sid of Object.values(s)) {
      expect(await db.select().from(importRows).where(eq(importRows.sessionId, sid))).toHaveLength(0);
      expect((await db.select().from(importSessions).where(eq(importSessions.id, sid)))[0]!.activeCommit).toBe(false);
    }
    // One delete audit row per removed record with its before-image, and one for the batch.
    const deletes = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.action, 'delete')));
    expect(deletes.filter((d) => d.entityType === 'transaction')).toHaveLength(7);
    expect(deletes.filter((d) => d.entityType === 'account')).toHaveLength(5);
    expect(deletes.filter((d) => d.entityType === 'contact')).toHaveLength(2);
    const img = deletes.find((d) => d.entityType === 'transaction')!.beforeData as unknown;
    const parsed = (typeof img === 'string' ? JSON.parse(img) : img) as { lines: unknown[] };
    expect(parsed.lines.length).toBeGreaterThan(0);
    const batchRows = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'import_batch')));
    expect(batchRows).toHaveLength(1);

    // Undo again: 409. The same files import again, and everything is created again.
    expect((await post(`/batches/${id}/undo`, {})).json['error'].code).toBe('IMPORT_BATCH_UNDONE');
    const again = await uploadSet(c);
    const id2 = await createBatch([again.coa, again.vendors, again.tb, again.gl]);
    expect((await run(`/batches/${id2}/commit`, {})).status).toBe(202);
    expect((await batchRow(id2)).status).toBe('committed');
    expect(await stamped(c, id2)).toEqual({ accounts: 5, contacts: 2, transactions: 7, tags: 0 });
  });

  it('a posting outside the batch on an imported account blocks the undo', async () => {
    const { id } = await committedSet();
    const [cash] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountNumber, '9101')));
    const je = await ledger.postTransaction(c.tenantId, {
      txnType: 'journal_entry', txnDate: '2025-06-01', memo: 'later',
      lines: [{ accountId: cash!.id, debit: '10', credit: '0' }, { accountId: c.roles['expense']!, debit: '0', credit: '10' }],
    }, c.userId, c.companyId);
    const r = await post(`/batches/${id}/undo`, {});
    expect(r.status).toBe(409);
    expect(r.json['error'].code).toBe('IMPORT_UNDO_BLOCKED');
    const blockers = r.json['error'].details.blockers as Array<{ kind: string; reason: string; target: string }>;
    expect(blockers).toContainEqual(expect.objectContaining({ kind: 'journal_lines.account_id', reason: 'used_by_other_transaction', target: cash!.id }));
    expect((await batchRow(id)).status).toBe('committed');
    // Void the later entry: its lines still name the imported account, so it still blocks (used_by_void_transaction).
    await ledger.voidTransaction(c.tenantId, je.id, 'test', c.userId);
    const still = await post(`/batches/${id}/undo`, {});
    expect(still.status).toBe(409);
    expect(still.json['error'].details.blockers).toContainEqual(expect.objectContaining({ reason: 'used_by_void_transaction' }));
  });

  it('a live payment on an imported invoice blocks; once voided, undo removes the applications and the voided payment stays', async () => {
    const { id } = await committedSet();
    const inv = await h.invoice(c, { date: '2025-03-20', total: '250.00' });
    await adopt(id, inv);
    const pay = await receive(inv, '100.00');
    const blocked = await post(`/batches/${id}/undo`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.json['error'].details.blockers).toContainEqual(expect.objectContaining({ reason: 'payment_applied', target: inv }));

    await voidPayment(pay);
    const r = await run(`/batches/${id}/undo`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    const after = await batchRow(id);
    expect(after.status, JSON.stringify(after.error)).toBe('undone');
    expect(await db.select().from(transactions).where(eq(transactions.id, inv))).toHaveLength(0);
    expect(await db.select().from(paymentApplications).where(eq(paymentApplications.paymentId, pay))).toHaveLength(0);
    const [p] = await db.select().from(transactions).where(eq(transactions.id, pay));
    expect(p!.status).toBe('void');
    // Nothing points at a deleted id: journal lines, applications, payments.
    const dangling = await db.execute(sql`
      SELECT (SELECT count(*) FROM journal_lines jl WHERE jl.tenant_id = ${c.tenantId} AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = jl.transaction_id))
           + (SELECT count(*) FROM journal_lines jl WHERE jl.tenant_id = ${c.tenantId} AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = jl.account_id))
           + (SELECT count(*) FROM payment_applications pa WHERE pa.tenant_id = ${c.tenantId} AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = pa.invoice_id))
           AS n`);
    expect(Number((dangling.rows[0] as { n: string }).n)).toBe(0);
  });

  it('a voided payment on an invoice whose customer the batch created still blocks (owner decision pending)', async () => {
    const { id } = await committedSet();
    const [cust] = await db.insert(contacts).values({
      tenantId: c.tenantId, companyId: c.companyId, contactType: 'customer', displayName: 'Batch Customer', importBatchId: id,
    }).returning();
    const inv = await h.invoice(c, { date: '2025-03-20', total: '80.00' }, cust!.id);
    await adopt(id, inv);
    const pay = await receive(inv, '80.00', cust!.id);
    await voidPayment(pay);
    const r = await post(`/batches/${id}/undo`, {});
    expect(r.status).toBe(409);
    expect(r.json['error'].details.blockers).toContainEqual(expect.objectContaining({ reason: 'used_by_void_transaction', target: cust!.id }));
  });

  it('an imported transaction edited since the commit blocks; undo of a draft batch is refused', async () => {
    const { id } = await committedSet();
    const [t] = await db.select().from(transactions).where(and(eq(transactions.importBatchId, id), eq(transactions.txnType, 'journal_entry'))).limit(1);
    await ledger.voidTransaction(c.tenantId, t!.id, 'edit', c.userId);
    const r = await post(`/batches/${id}/undo`, {});
    expect(r.status).toBe(409);
    expect(r.json['error'].details.blockers).toContainEqual(expect.objectContaining({ kind: 'transactions', id: t!.id, reason: 'edited' }));
    const coa = await upload(c, 'coa-x.csv', COA_CSV.replace(/9(\d)01/g, '8$101'), 'coa');
    const draft = await createBatch([coa]);
    expect((await post(`/batches/${draft}/undo`, {})).json['error'].code).toBe('IMPORT_BATCH_NOT_COMMITTED');
  });
});

describe('closed periods (U-262)', () => {
  async function lock(date: string, password?: string) {
    await db.update(companies).set({
      lockDate: date, lockDateSetAt: new Date(), lockDateSetBy: c.userId,
      ...(password ? { closingPasswordHash: await hashClosingPassword(password) } : {}),
    }).where(eq(companies.id, c.companyId));
  }
  const overrides = async () => (await db.select().from(auditLog).where(and(
    eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'closing_date_override')))).length;

  it('with a closing-date password: 423 without it, 403 when wrong (nothing claimed), one override row for the batch when right', async () => {
    const s = await uploadSet(c);
    const id = await createBatch([s.coa, s.vendors, s.tb, s.gl]);
    await lock('2025-02-28', 'Closing-Pass-1');
    const none = await post(`/batches/${id}/commit`, {});
    expect(none.status).toBe(423);
    expect(none.json['error']).toMatchObject({ code: 'TB_PERIOD_LOCKED', details: { closingPasswordRequired: true } });
    const wrong = await post(`/batches/${id}/commit`, { closingPassword: 'nope' });
    expect(wrong.status).toBe(403);
    expect(wrong.json['error'].code).toBe('CLOSING_PASSWORD_INVALID');
    // Confirmation alone does not open a password-locked period.
    expect((await post(`/batches/${id}/commit`, { confirmClosedPeriod: true })).status).toBe(423);
    expect((await batchRow(id)).status).toBe('draft');

    const ok = await run(`/batches/${id}/commit`, { closingPassword: 'Closing-Pass-1' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(202);
    expect((await batchRow(id)).status).toBe('committed');
    expect(await overrides()).toBe(1);

    // Undo goes through the same rule.
    expect((await post(`/batches/${id}/undo`, {})).status).toBe(423);
    const undone = await run(`/batches/${id}/undo`, { closingPassword: 'Closing-Pass-1' });
    expect(undone.status).toBe(202);
    expect((await batchRow(id)).status).toBe('undone');
    expect(await overrides()).toBe(2);
  });

  it('without a password: staff confirm with confirmClosedPeriod; one override row', async () => {
    const s = await uploadSet(c);
    const id = await createBatch([s.coa, s.vendors, s.tb, s.gl]);
    await lock('2025-12-31');
    const none = await post(`/batches/${id}/commit`, {});
    expect(none.status).toBe(423);
    expect(none.json['error'].details).toMatchObject({ canOverride: true, closingPasswordRequired: false });
    const ok = await run(`/batches/${id}/commit`, { confirmClosedPeriod: true });
    expect(ok.status).toBe(202);
    expect((await batchRow(id)).status).toBe('committed');
    expect(await overrides()).toBe(1);
  });

  it('429 after ten wrong passwords', async () => {
    const gl = await upload(c, 'gl.csv', glCsv(2025, [1]), 'gl_transactions');
    const coa = await upload(c, 'coa.csv', COA_CSV, 'coa');
    const id = await createBatch([coa, gl]);
    await lock('2025-06-30', 'Closing-Pass-2');
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post(`/batches/${id}/commit`, { closingPassword: `bad-${i}` })).status);
    expect(codes.slice(0, 10).every((x) => x === 403)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe('rights (U-263)', () => {
  it('commit and undo need the owner role (403 IMPORT_ADMIN_REQUIRED)', async () => {
    const bk = await h.staffToken(c, { imports: 'full' });
    const s = await uploadSet(c);
    const id = await createBatch([s.coa, s.vendors, s.tb, s.gl]);
    const r = await post(`/batches/${id}/commit`, {}, bk);
    expect(r.status).toBe(403);
    expect(r.json['error'].code).toBe('IMPORT_ADMIN_REQUIRED');
    expect((await run(`/batches/${id}/commit`, {})).status).toBe(202);
    const u = await post(`/batches/${id}/undo`, {}, bk);
    expect(u.status).toBe(403);
    expect(u.json['error'].code).toBe('IMPORT_ADMIN_REQUIRED');
    expect((await batchRow(id)).status).toBe('committed');
  });
});

describe('recovery of an interrupted undo', () => {
  it('a batch a crash left undoing is committed again, its rows untouched', async () => {
    const { id } = await committedSet();
    await db.update(importBatches).set({ status: 'undoing' }).where(eq(importBatches.id, id));
    await batchService.recoverInterruptedBatches();
    expect((await batchRow(id)).status).toBe('committed');
    expect(await stamped(c, id)).toEqual({ accounts: 5, contacts: 2, transactions: 7, tags: 0 });
  });
});

describe('undo sweep at size and leftovers (U-261)', () => {
  it('a batch with hundreds of its own lines on its accounts still sees one posting from outside', async () => {
    const coa = await upload(c, 'coa.csv', COA_CSV, 'coa');
    const head = 'Journal, Date, Reference, Description, Account, Account Name, Debit Amount, Credit Amount, Memo, Department, Updated by\n';
    let body = '';
    for (const y of [2015, 2016, 2017, 2018, 2019]) body += glCsv(y, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).split('\n').slice(1).join('\n');
    const gl = await upload(c, 'gl-big.csv', head + body, 'gl_transactions');
    const id = await createBatch([coa, gl]);
    expect((await run(`/batches/${id}/commit`, {})).status).toBe(202);
    expect((await batchRow(id)).status).toBe('committed');
    const lines = await db.execute(sql`SELECT count(*)::int AS n FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id WHERE t.import_batch_id = ${id}`);
    expect((lines.rows[0] as { n: number }).n).toBeGreaterThan(200);
    const [cash] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountNumber, '9101')));
    await ledger.postTransaction(c.tenantId, {
      txnType: 'journal_entry', txnDate: '2020-06-01', memo: 'later',
      lines: [{ accountId: cash!.id, debit: '10', credit: '0' }, { accountId: c.roles['expense']!, debit: '0', credit: '10' }],
    }, c.userId, c.companyId);
    const r = await post(`/batches/${id}/undo`, {});
    expect(r.status).toBe(409);
    expect(r.json['error'].details.blockers).toContainEqual(expect.objectContaining({ kind: 'journal_lines.account_id', target: cash!.id }));
  });

  it('after an undo with a voided payment, no column anywhere points at a deleted id', async () => {
    const { id } = await committedSet();
    const inv = await h.invoice(c, { date: '2025-03-20', total: '250.00' });
    await adopt(id, inv);
    const pay = await receive(inv, '100.00');
    await voidPayment(pay);
    const created = await db.transaction((tx) => loadCreatedSets(tx, c.tenantId, id));
    const deleted = [...created.txns, ...created.lines, ...created.accounts, ...created.contacts, ...created.items, ...created.tags, ...created.tagGroups];
    expect((await run(`/batches/${id}/undo`, {})).status).toBe(202);
    expect((await batchRow(id)).status).toBe('undone');
    const left = await db.transaction((tx) => findPointers(tx, c.tenantId, deleted));
    expect(left).toEqual([]);
  });

  it('accounts the import changed and the suspense account it made are restored exactly; a later rename blocks', async () => {
    const [seeded] = await db.select().from(accounts).where(and(
      eq(accounts.tenantId, c.tenantId), eq(accounts.accountType, 'expense'), sql`${accounts.accountNumber} IS NOT NULL`, sql`${accounts.systemTag} IS NULL`)).limit(1);
    const coaCsv = COA_CSV + `"${seeded!.accountNumber}","Renamed by import","E","Expenses","",""\n`;
    const before = await companySnapshot(c);
    const coa = await upload(c, 'coa.csv', coaCsv, 'coa', { updateExistingCoa: true });
    const id = await createBatch([coa]);
    expect((await run(`/batches/${id}/commit`, {})).status).toBe(202);
    const committed = await batchRow(id);
    expect(committed.status, JSON.stringify(committed.error)).toBe('committed');
    const [renamed] = await db.select().from(accounts).where(eq(accounts.id, seeded!.id));
    expect(renamed!.name).toBe('Renamed by import');
    const afterCoa = await companySnapshot(c);
    // U-265: a batch never posts to suspense; the old one-session commit still does, as a batch of its own.
    const gl = await upload(c, 'gl.csv', glCsv(2025, [1, 2], '9999'), 'gl_transactions');
    const single = await post(`/${gl}/commit`, {});
    expect(single.status, JSON.stringify(single.json)).toBe(200);
    expect(single.json['result'].unmappedToSuspense).toBe(1);
    const glBatch = String(single.json['session'].batchId);

    expect((await run(`/batches/${glBatch}/undo`, {})).status).toBe(202);
    expect((await batchRow(glBatch)).status).toBe('undone');
    expect(await companySnapshot(c)).toEqual(afterCoa);
    expect((await run(`/batches/${id}/undo`, {})).status).toBe(202);
    expect((await batchRow(id)).status).toBe('undone');
    expect(await companySnapshot(c)).toEqual(before);

    // Again, then someone renames the account the import changed: undo is blocked.
    const coa2 = await upload(c, 'coa2.csv', coaCsv, 'coa', { updateExistingCoa: true });
    const id2 = await createBatch([coa2]);
    expect((await run(`/batches/${id2}/commit`, {})).status).toBe(202);
    await db.update(accounts).set({ name: 'Renamed by hand' }).where(eq(accounts.id, seeded!.id));
    const r = await post(`/batches/${id2}/undo`, {});
    expect(r.status).toBe(409);
    expect(r.json['error'].details.blockers).toContainEqual(expect.objectContaining({ kind: 'accounts', id: seeded!.id, reason: 'changed_since' }));
  });
});