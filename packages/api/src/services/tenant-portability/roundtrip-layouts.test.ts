// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-130: invoice layouts in tenant archives. A company's layouts (their line
// columns and which is default) and the layout each invoice prints with
// (transactions.invoice_layout_id) survive export -> verify -> import with
// remapped ids, and the import verifies. Runs in server mode against the
// test database.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accounts, companies, contacts } from '../../db/schema/index.js';
import * as authService from '../auth.service.js';
import * as invoiceService from '../invoice.service.js';
import * as layouts from '../invoice-template.service.js';
import { ArchiveReader } from './archive-reader.js';
import { runExport, type ExportResult } from './export.service.js';
import { runImport } from './import.service.js';
import { buildPortabilityPlan, SOFT_REFS, scopeSql, type PortabilityPlan } from './plan.js';

const PASS = 'layouts round trip passphrase 2026!';
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

/** Layouts and invoice -> layout names, ids replaced by names. */
async function layoutShape(tid: string) {
  const rows = await q<Record<string, unknown>>(`
    SELECT name, is_default AS d, line_columns AS cols FROM invoice_templates
    WHERE tenant_id = $1 AND company_id IS NOT NULL ORDER BY name`, [tid]);
  const invoices = await q<Record<string, unknown>>(`
    SELECT t.txn_number AS n, l.name AS layout, (t.invoice_layout_id IS NULL) AS default_layout
    FROM transactions t LEFT JOIN invoice_templates l ON l.tenant_id = t.tenant_id AND l.id = t.invoice_layout_id
    WHERE t.tenant_id = $1 AND t.txn_type = 'invoice' ORDER BY t.txn_number`, [tid]);
  const clients = await q<Record<string, unknown>>(`
    SELECT c.display_name AS n, l.name AS layout FROM contacts c
    JOIN invoice_templates l ON l.tenant_id = c.tenant_id AND l.id = c.default_invoice_layout_id
    WHERE c.tenant_id = $1 ORDER BY c.display_name`, [tid]);
  return { rows, invoices, clients };
}

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archives-layouts-'));
  process.env['CL_ARCHIVE_DIR'] = archiveRoot;
  const reg = await authService.register({
    email: `rtl-${stamp}@example.test`, password: 'password123', displayName: 'Owner', companyName: `RTL ${stamp}`,
  });
  tenantId = reg.user.tenantId;
  createdTenants.push(tenantId);
  callerId = crypto.randomUUID();
  await q(`INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, is_super_admin, is_active)
           VALUES ($1, $2, $3, $4, 'Caller', 'owner', true, true)`,
  [callerId, tenantId, `rtl-caller-${stamp}@example.test`, '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']);
  createdUsers.push(callerId);

  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const companyId = company!.id;
  const revenue = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) }))!.id;
  const [customer] = await db.insert(contacts).values({ tenantId, companyId, contactType: 'customer', displayName: 'Hartley Residence' }).returning();

  await layouts.listLayouts(tenantId, companyId);
  const svc = await layouts.createLayout(tenantId, companyId, { name: 'Service with dates', columns: { serviceDate: true } });
  const line = [{ accountId: revenue, description: 'Visit', quantity: '1', unitPrice: '80.00' }];
  await invoiceService.createInvoice(tenantId, { txnDate: '2026-10-05', contactId: customer!.id, txnNumber: `RTL-1-${stamp}`, lines: line, layoutId: svc.id }, undefined, companyId);
  await invoiceService.createInvoice(tenantId, { txnDate: '2026-10-06', contactId: customer!.id, txnNumber: `RTL-2-${stamp}`, lines: line }, undefined, companyId);
  // The client's default layout (set after the invoices, so the second one stays on the company default).
  await db.update(contacts).set({ defaultInvoiceLayoutId: svc.id }).where(eq(contacts.id, customer!.id));
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

describe('invoice layouts in tenant archives (U-130)', () => {
  it('classifies the new column', () => {
    expect(SOFT_REFS['transactions.invoice_layout_id']).toBe('tenant-ref:invoice_templates');
    expect(SOFT_REFS['contacts.default_invoice_layout_id']).toBe('tenant-ref:invoice_templates');
    expect(plan.byName.get('invoice_templates')).toBeTruthy();
  });

  it('layouts and each invoice layout survive with remapped ids; the import verifies', async () => {
    const reader = await ArchiveReader.open(archive.path!, PASS);
    await reader.verifyAll();
    const before = await layoutShape(tenantId);
    expect(before.rows.map((r) => [r['name'], r['d']])).toEqual([['Service with dates', false], ['Standard', true]]);
    expect(before.invoices.map((i) => [i['layout'], i['default_layout']])).toEqual([['Service with dates', false], [null, true]]);
    const imported = await runImport({ filePath: archive.path!, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    const after = await layoutShape(imported.tenantId);
    expect(after.rows).toEqual(before.rows);
    expect(before.clients).toEqual([{ n: 'Hartley Residence', layout: 'Service with dates' }]);
    expect(after.clients).toEqual(before.clients);
    expect(after.invoices.map((i) => [i['layout'], i['default_layout']])).toEqual([['Service with dates', false], [null, true]]);
    const leaked = await q<{ n: number }>(`SELECT count(*)::int AS n FROM transactions t
      WHERE t.tenant_id = $1 AND t.invoice_layout_id IN (SELECT id FROM invoice_templates WHERE tenant_id = $2)`, [imported.tenantId, tenantId]);
    expect(leaked[0]!.n).toBe(0);
  }, 600_000);
});
