// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-92 (M6, T7, T8): document drafts in tenant archives. A backup (no
// option) carries drafts, layouts, every file and card_last4, and the claim
// index holds after the round trip. A transfer file (omitDocumentDrafts)
// carries the two tables with no rows and leaves out the attachments and
// files of live drafts (a converted draft's file travels with its bill);
// the manifest says so, both verify and import. resetDocumentDrafts on
// import removes drafts and layouts after verification.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accounts, attachments, companies, documentDrafts, users } from '../../db/schema/index.js';
import * as authService from '../auth.service.js';
import * as attachmentService from '../attachment.service.js';
import * as draftService from '../document-draft.service.js';
import { runWithoutIdempotency } from '../idempotency-context.js';
import { ArchiveReader } from './archive-reader.js';
import { runExport, tableCursorSql, type ExportResult } from './export.service.js';
import { tablePartName } from './format.js';
import { runImport } from './import.service.js';
import { buildPortabilityPlan, scopeSql, type PortabilityPlan } from './plan.js';

const PASS = 'document drafts round trip passphrase 2026!';
let plan: PortabilityPlan;
let archiveRoot = '';
const createdTenants: string[] = [];
let tenantId = '';
let companyId = '';
let callerId = '';
let backup: ExportResult;
let transfer: ExportResult;
const ids: { live: string; liveAtt: string; converted: string; convertedAtt: string; plainAtt: string; billId: string } = {
  live: '', liveAtt: '', converted: '', convertedAtt: '', plainAtt: '', billId: '',
};
let liveBytes = Buffer.alloc(0);

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(q)).rows as T[];
}

async function uploadDraft(bytes: Buffer) {
  const att = await attachmentService.upload(tenantId, {
    originalname: 'doc.pdf', buffer: bytes, mimetype: 'application/pdf', size: bytes.length,
  }, 'draft', crypto.randomUUID(), { companyId });
  return att!.id;
}

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archives-drafts-'));
  process.env['CL_ARCHIVE_DIR'] = archiveRoot;
  const stamp = crypto.randomUUID().slice(0, 8);
  const reg = await authService.register({
    email: `u92rt-${stamp}@example.com`, password: 'password123', displayName: 'Owner', companyName: `RTD ${stamp}`,
  });
  tenantId = reg.user.tenantId;
  createdTenants.push(tenantId);
  callerId = reg.user.id;
  await db.update(users).set({ isSuperAdmin: true } as never).where(eq(users.id, callerId));
  const [co] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  companyId = co!.id;
  const [vendor] = (await db.execute(sql`INSERT INTO contacts (tenant_id, contact_type, display_name) VALUES (${tenantId}, 'vendor', 'Cosmos Granite') RETURNING id`)).rows as Array<{ id: string }>;
  const expense = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')) });
  await db.insert(accounts).values({ tenantId, name: 'Visa', accountType: 'liability', detailType: 'credit_card', cardLast4: '4242' });

  // A live draft, a converted draft (its bill and file), a layout, and a plain draft attachment.
  liveBytes = Buffer.from(`%PDF-1.4 live ${stamp}`);
  ids.liveAtt = await uploadDraft(liveBytes);
  const live = await runWithoutIdempotency(() => draftService.create(tenantId, companyId, callerId, { attachmentId: ids.liveAtt, kindHint: 'bill' }));
  ids.live = live.id;
  ids.convertedAtt = await uploadDraft(Buffer.from(`%PDF-1.4 converted ${stamp}`));
  const conv = await runWithoutIdempotency(() => draftService.create(tenantId, companyId, callerId, { attachmentId: ids.convertedAtt, kindHint: 'bill' }));
  const done = await runWithoutIdempotency(() => draftService.convert(tenantId, companyId, callerId, conv.id, {
    kind: 'bill', expectedUpdatedAt: conv.updatedAt, acknowledgeDuplicateOf: [],
    body: { contactId: vendor!.id, txnDate: '2026-05-01', vendorInvoiceNumber: 'RT-1', lines: [{ accountId: expense!.id, amount: '88.00' }] },
  }));
  ids.converted = conv.id;
  ids.billId = done.transactionId;
  await runWithoutIdempotency(() => draftService.putTemplate(tenantId, companyId, callerId, {
    contactId: vendor!.id, fingerprint: `fp:rt-${stamp}`, fieldRegions: { total: { box: [1, 2, 3, 4] } }, expectedUpdatedAt: null,
  }));
  ids.plainAtt = await uploadDraft(Buffer.from(`%PDF-1.4 plain ${stamp}`));

  backup = await runExport(tenantId, callerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } });
  transfer = await runExport(tenantId, callerId, { passphrase: PASS, omitDocumentDrafts: true, host: { app: 'ClientLedger', kind: 'transfer' } });
}, 300_000);

afterAll(async () => {
  for (const id of createdTenants) {
    for (const t of [...plan.scoped].reverse()) {
      const where = scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`);
      await db.execute(sql.raw(`DELETE FROM "${t}" a WHERE ${where}`)).catch(() => undefined);
    }
    await db.execute(sql`DELETE FROM tenant_archive_imports WHERE tenant_id = ${id}`).catch(() => undefined);
    await db.execute(sql`DELETE FROM user_tenant_access WHERE tenant_id = ${id}`).catch(() => undefined);
  }
  await db.execute(sql`DELETE FROM users WHERE id = ${callerId}`).catch(() => undefined);
  for (const id of createdTenants) await db.execute(sql`DELETE FROM users WHERE tenant_id = ${id}`).catch(() => undefined);
  for (const id of createdTenants) await db.execute(sql`DELETE FROM tenants WHERE id = ${id}`).catch(() => undefined);
  fs.rmSync(archiveRoot, { recursive: true, force: true });
  delete process.env['CL_ARCHIVE_DIR'];
});

async function partLines(file: string, table: string): Promise<Array<Record<string, unknown>>> {
  const reader = await ArchiveReader.open(file, PASS);
  const text = (await reader.readPart(tablePartName(table), 64 * 1024 * 1024)).toString('utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('document drafts in tenant archives (U-92)', () => {
  it('a table exported with no rows still binds the tenant id (omitted tables, includeAudit false)', () => {
    const omit = { columns: new Set<string>(), tables: new Set(['document_drafts']), rowFilters: new Set(['attachments']) };
    for (const [name, includeAudit] of [['document_drafts', true], ['audit_log', false], ['attachments', true]] as const) {
      const q = tableCursorSql(plan, plan.byName.get(name)!, includeAudit, omit);
      expect(q, name).toContain('$1');
    }
    expect(tableCursorSql(plan, plan.byName.get('attachments')!, true, omit)).toContain('NOT EXISTS (SELECT 1 FROM document_drafts dd');
  });

  it('T7 backup: everything travels, card_last4 included; nothing is listed as omitted', async () => {
    const reader = await ArchiveReader.open(backup.path!, PASS);
    await reader.verifyAll();
    expect(reader.manifest.options.omitDocumentDrafts).toBe(false);
    expect(reader.manifest.omitted).toEqual([]);
    expect(reader.manifest.omittedRows).toBeUndefined();
    expect((await partLines(backup.path!, 'document_drafts')).map((r) => r['id']).sort()).toEqual([ids.live, ids.converted].sort());
    expect(await partLines(backup.path!, 'vendor_layout_templates')).toHaveLength(1);
    const atts = (await partLines(backup.path!, 'attachments')).map((r) => r['id']);
    expect(atts).toEqual(expect.arrayContaining([ids.liveAtt, ids.convertedAtt, ids.plainAtt]));
    expect(reader.manifest.files.filter((f) => f.table === 'attachments').map((f) => f.rowId)).toEqual(expect.arrayContaining([ids.liveAtt]));
    expect((await partLines(backup.path!, 'accounts')).some((r) => r['card_last4'] === '4242')).toBe(true);
  }, 300_000);

  it('T7 transfer: no drafts, no layouts, no live draft file; the manifest says so; it verifies and imports', async () => {
    const reader = await ArchiveReader.open(transfer.path!, PASS);
    await reader.verifyAll();
    expect(reader.manifest.options.omitDocumentDrafts).toBe(true);
    expect(reader.manifest.omitted).toEqual(['attachments:live-document-drafts', 'document_drafts', 'vendor_layout_templates']);
    expect(reader.manifest.omittedRows).toEqual({ attachments: 1 });
    expect(await partLines(transfer.path!, 'document_drafts')).toHaveLength(0);
    expect(await partLines(transfer.path!, 'vendor_layout_templates')).toHaveLength(0);
    const atts = (await partLines(transfer.path!, 'attachments')).map((r) => r['id']);
    expect(atts).not.toContain(ids.liveAtt);
    expect(atts).toEqual(expect.arrayContaining([ids.convertedAtt, ids.plainAtt]));
    const files = reader.manifest.files.filter((f) => f.table === 'attachments').map((f) => f.rowId);
    expect(files).not.toContain(ids.liveAtt);
    expect(files).toContain(ids.convertedAtt);
    expect((await partLines(transfer.path!, 'accounts')).some((r) => r['card_last4'] === '4242')).toBe(true);
    const audit = await rows<{ a: string }>(sql`SELECT after_data #>> '{}' AS a FROM audit_log WHERE tenant_id = ${tenantId} AND entity_type = 'tenant_archive' AND entity_id = ${transfer.archiveId}`);
    expect(JSON.parse(audit[0]!.a)['omitDocumentDrafts']).toBe(true);

    const imported = await runImport({ filePath: transfer.path!, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    const n = await rows<{ d: number; t: number; a: number; b: number }>(sql`SELECT
      (SELECT count(*)::int FROM document_drafts WHERE tenant_id = ${imported.tenantId}) AS d,
      (SELECT count(*)::int FROM vendor_layout_templates WHERE tenant_id = ${imported.tenantId}) AS t,
      (SELECT count(*)::int FROM attachments WHERE tenant_id = ${imported.tenantId}) AS a,
      (SELECT count(*)::int FROM transactions WHERE tenant_id = ${imported.tenantId} AND txn_type = 'bill') AS b`);
    const src = await rows<{ a: number }>(sql`SELECT count(*)::int AS a FROM attachments WHERE tenant_id = ${tenantId}`);
    expect(n[0]).toEqual({ d: 0, t: 0, a: src[0]!.a - 1, b: 1 });
    // The source keeps its drafts.
    expect((await db.select().from(documentDrafts).where(eq(documentDrafts.tenantId, tenantId))).length).toBe(2);
  }, 600_000);

  it('T8 backup round trip: drafts come back and the claim index still holds', async () => {
    const imported = await runImport({ filePath: backup.path!, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    const drafts = await db.select().from(documentDrafts).where(eq(documentDrafts.tenantId, imported.tenantId));
    expect(drafts.map((d) => d.status).sort()).toEqual(['converted', 'new']);
    const newCompany = drafts[0]!.companyId;
    // The same bytes uploaded again in the restored company are already claimed.
    const att = await attachmentService.upload(imported.tenantId, {
      originalname: 'again.pdf', buffer: liveBytes, mimetype: 'application/pdf', size: liveBytes.length,
    }, 'draft', crypto.randomUUID(), { companyId: newCompany });
    await expect(runWithoutIdempotency(() => draftService.create(imported.tenantId, newCompany, callerId, { attachmentId: att!.id, kindHint: 'unknown' })))
      .rejects.toMatchObject({ statusCode: 409, code: 'DOCUMENT_ALREADY_CLAIMED' });
    // Its live draft still guards its file.
    const live = drafts.find((d) => d.status === 'new')!;
    await expect(attachmentService.remove(imported.tenantId, live.attachmentId!, newCompany)).rejects.toMatchObject({ statusCode: 409, code: 'ATTACHMENT_IN_USE' });
  }, 600_000);

  it('resetDocumentDrafts: the backup verifies and imports with no drafts or layouts; the audit row records it', async () => {
    const imported = await runImport({ filePath: backup.path!, passphrase: PASS, callerUserId: callerId, resetDocumentDrafts: true });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    const n = await rows<{ d: number; t: number }>(sql`SELECT
      (SELECT count(*)::int FROM document_drafts WHERE tenant_id = ${imported.tenantId}) AS d,
      (SELECT count(*)::int FROM vendor_layout_templates WHERE tenant_id = ${imported.tenantId}) AS t`);
    expect(n[0]).toEqual({ d: 0, t: 0 });
    const audit = await rows<{ a: string }>(sql`SELECT after_data #>> '{}' AS a FROM audit_log WHERE tenant_id = ${imported.tenantId} AND entity_type = 'tenant_import'`);
    expect(JSON.parse(audit[0]!.a)['resetDocumentDrafts']).toBe(true);
    const { importArchiveSchema } = await import('../../routes/tenant-archives.routes.js');
    expect(importArchiveSchema.parse({ passphrase: PASS }).resetDocumentDrafts).toBe(false);
    const { exportArchiveSchema } = await import('../../routes/tenants.routes.js');
    expect(exportArchiveSchema.parse({ passphrase: PASS }).omitDocumentDrafts).toBe(false);
  }, 600_000);
});
