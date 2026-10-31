// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-128 invariant I8: billable cost links in tenant archives. An active and
// a released link, the billed / unbilled cost lines, the invoice's cost and
// markup lines (journal_lines.billable_source_line_id, a self reference) and
// the company markup account survive export -> verify -> import with
// remapped ids; I1 holds on the imported tenant and the import verifies.
// Runs in server mode against the test database.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accounts, companies, contacts } from '../../db/schema/index.js';
import * as authService from '../auth.service.js';
import * as ledger from '../ledger.service.js';
import * as invoiceService from '../invoice.service.js';
import { checkBillableInvariant } from '../billable-links.js';
import { ArchiveReader } from './archive-reader.js';
import { runExport, type ExportResult } from './export.service.js';
import { runImport } from './import.service.js';
import { buildPortabilityPlan, SOFT_REFS, scopeSql, type PortabilityPlan } from './plan.js';

const PASS = 'billable round trip passphrase 2026!';
const stamp = crypto.randomUUID().slice(0, 8);
let plan: PortabilityPlan;
let archiveRoot = '';
const createdTenants: string[] = [];
const createdUsers: string[] = [];
let tenantId = '';
let callerId = '';
let archive: ExportResult;

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.execute(sql.raw(text.replace(/\$(\d+)/g, (_m, n) => {
    const v = params[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  })));
  return r.rows as T[];
}

/** The tenant's billing state with ids replaced by stable descriptions, to compare across a remap. */
async function billingShape(tid: string) {
  const links = await q<Record<string, unknown>>(`
    SELECT l.cost_amount::text AS cost, l.markup_percent::text AS pct, l.markup_amount::text AS markup,
      l.released_at IS NOT NULL AS released, l.release_reason AS reason,
      src.description AS src_desc, src.billed_status AS src_status, inv.txn_number AS invoice,
      ma.name AS markup_account, (src.transaction_id = l.source_transaction_id) AS src_txn_ok
    FROM billable_cost_links l
    JOIN journal_lines src ON src.tenant_id = l.tenant_id AND src.id = l.source_line_id
    JOIN transactions inv ON inv.tenant_id = l.tenant_id AND inv.id = l.invoice_id
    LEFT JOIN accounts ma ON ma.tenant_id = l.tenant_id AND ma.id = l.markup_account_id
    WHERE l.tenant_id = $1 ORDER BY src.description, l.released_at NULLS LAST`, [tid]);
  const invLines = await q<Record<string, unknown>>(`
    SELECT jl.line_role AS role, jl.credit::text AS credit, src.description AS bills
    FROM journal_lines jl JOIN journal_lines src ON src.tenant_id = jl.tenant_id AND src.id = jl.billable_source_line_id
    WHERE jl.tenant_id = $1 AND jl.is_void_reversal = false ORDER BY src.description, jl.line_order`, [tid]);
  const markupAcct = await q<{ name: string | null }>(`
    SELECT a.name FROM companies c LEFT JOIN accounts a ON a.id = c.billable_markup_account_id WHERE c.tenant_id = $1`, [tid]);
  return { links, invLines, markupAccount: markupAcct.map((r) => r.name) };
}

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archives-billable-'));
  process.env['CL_ARCHIVE_DIR'] = archiveRoot;
  const reg = await authService.register({
    email: `rtb-${stamp}@example.test`, password: 'password123', displayName: 'Owner', companyName: `RTB ${stamp}`,
  });
  tenantId = reg.user.tenantId;
  createdTenants.push(tenantId);
  callerId = crypto.randomUUID();
  await q(`INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, is_super_admin, is_active)
           VALUES ($1, $2, $3, $4, 'Caller', 'owner', true, true)`,
  [callerId, tenantId, `rtb-caller-${stamp}@example.test`, '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']);
  createdUsers.push(callerId);

  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const companyId = company!.id;
  const byType = async (t: string) => (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, t)) }))!.id;
  const revenue = await byType('revenue');
  const expense = await byType('expense');
  const bank = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))
    ?? (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'asset')) }));
  const [markup] = await db.insert(accounts).values({ tenantId, companyId, name: `Markup income ${stamp}`, accountType: 'revenue' }).returning();
  await db.update(companies).set({ billableMarkupAccountId: markup!.id }).where(eq(companies.id, companyId));
  const [customer] = await db.insert(contacts).values({ tenantId, companyId, contactType: 'customer', displayName: 'Hartley Residence' }).returning();

  const expenseTxn = await ledger.postTransaction(tenantId, {
    txnType: 'expense', txnDate: '2026-10-01', total: '300.0000',
    lines: [
      { accountId: expense, debit: '200.0000', credit: '0', description: 'cost A', contactId: customer!.id, isBillable: true },
      { accountId: expense, debit: '100.0000', credit: '0', description: 'cost B', contactId: customer!.id, isBillable: true },
      { accountId: bank!.id, debit: '0', credit: '300.0000' },
    ],
  }, undefined, companyId);
  const [a, b] = expenseTxn.lines.filter((l) => l.isBillable);
  const inv = await invoiceService.createInvoice(tenantId, {
    txnDate: '2026-10-05', contactId: customer!.id, txnNumber: `RTB-${stamp}`,
    lines: [
      { billableSourceLineId: a!.id, accountId: revenue, markupPercent: '10', isTaxable: false },
      { billableSourceLineId: b!.id, accountId: revenue, isTaxable: false },
    ],
  }, undefined, companyId);
  // Release cost B: one active link (A) and one released link (B) go in the archive.
  const full = await invoiceService.getInvoice(tenantId, inv.id, companyId);
  await invoiceService.updateInvoice(tenantId, inv.id, {
    txnDate: '2026-10-05', contactId: customer!.id, expectedUpdatedAt: new Date(full.updatedAt!).toISOString(),
    lines: [{ billableSourceLineId: a!.id, accountId: revenue, markupPercent: '10', isTaxable: false }],
    releaseBillableSourceLineIds: [b!.id],
  }, undefined, companyId);
  expect(await checkBillableInvariant(db, tenantId)).toEqual([]);
  archive = await runExport(tenantId, callerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } });
}, 180_000);

afterAll(async () => {
  for (const id of createdTenants) {
    for (const t of [...plan.scoped].reverse()) {
      const where = scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`);
      await q(`DELETE FROM "${t}" a WHERE ${where}`).catch(() => undefined);
    }
    await q(`DELETE FROM tenant_archive_imports WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [id]).catch(() => undefined);
    await q(`DELETE FROM user_tenant_access WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM users WHERE tenant_id = $1`, [id]).catch(() => undefined);
  }
  for (const u of createdUsers) await q(`DELETE FROM users WHERE id = $1`, [u]).catch(() => undefined);
  for (const id of createdTenants) await q(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  fs.rmSync(archiveRoot, { recursive: true, force: true });
  delete process.env['CL_ARCHIVE_DIR'];
});

describe('billable cost links in tenant archives (U-128, I8)', () => {
  it('classifies the new columns (plan.test fails closed otherwise)', () => {
    expect(SOFT_REFS['billable_cost_links.source_line_id']).toBe('tenant-ref:journal_lines');
    expect(SOFT_REFS['billable_cost_links.invoice_id']).toBe('tenant-ref:transactions');
    expect(SOFT_REFS['journal_lines.billable_source_line_id']).toBe('tenant-ref:journal_lines');
    expect(SOFT_REFS['companies.billable_markup_account_id']).toBe('tenant-ref:accounts');
    expect(plan.byName.get('billable_cost_links')).toBeTruthy();
  });

  it('links, billed marks and cost / markup lines survive with remapped ids; I1 holds; the import verifies', async () => {
    const reader = await ArchiveReader.open(archive.path!, PASS);
    await reader.verifyAll();
    const before = await billingShape(tenantId);
    expect(before.links).toHaveLength(2);
    expect(before.links.map((l) => [l['src_desc'], l['released'], l['src_status']])).toEqual([
      ['cost A', false, 'billed'], ['cost B', true, 'unbilled'],
    ]);
    const imported = await runImport({ filePath: archive.path!, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    expect(await billingShape(imported.tenantId)).toEqual(before);
    expect(await checkBillableInvariant(db, imported.tenantId)).toEqual([]);
    // Every id was remapped: nothing of the imported links names a source-tenant row.
    const leaked = await q<{ n: number }>(`SELECT count(*)::int AS n FROM billable_cost_links l
      WHERE l.tenant_id = $1 AND (l.source_line_id IN (SELECT id FROM journal_lines WHERE tenant_id = $2)
        OR l.invoice_id IN (SELECT id FROM transactions WHERE tenant_id = $2))`, [imported.tenantId, tenantId]);
    expect(leaked[0]!.n).toBe(0);
  }, 600_000);
});
