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
import { ArchiveReader, validateManifest } from './archive-reader.js';
import { runExport, tableCursorSql, type ExportResult } from './export.service.js';
import { tablePartName } from './format.js';
import { assertOmissionsHold, runImport } from './import.service.js';
import { withArchiveConnection } from './session.js';
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
const ids: {
  live: string; liveAtt: string; converted: string; convertedAtt: string; plainAtt: string; billId: string;
  /** A live draft whose file a bill capture also uses (review L-7). */
  liveRef: string; liveRefAtt: string;
} = {
  live: '', liveAtt: '', converted: '', convertedAtt: '', plainAtt: '', billId: '', liveRef: '', liveRefAtt: '',
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
  }, async () => true));
  ids.converted = conv.id;
  ids.billId = done.transactionId;
  await runWithoutIdempotency(() => draftService.putTemplate(tenantId, companyId, callerId, {
    contactId: vendor!.id, fingerprint: `fp:rt-${stamp}`, fieldRegions: { total: { box: [1, 2, 3, 4] } }, expectedUpdatedAt: null,
  }));
  ids.plainAtt = await uploadDraft(Buffer.from(`%PDF-1.4 plain ${stamp}`));
  // A live draft's file that a bill capture also needs (NOT NULL, RESTRICT).
  ids.liveRefAtt = await uploadDraft(Buffer.from(`%PDF-1.4 captured ${stamp}`));
  ids.liveRef = (await runWithoutIdempotency(() => draftService.create(tenantId, companyId, callerId, { attachmentId: ids.liveRefAtt, kindHint: 'bill' }))).id;
  await db.execute(sql`INSERT INTO bill_captures (tenant_id, company_id, attachment_id, source, uploaded_by_user_id, content_sha256, file_name)
    VALUES (${tenantId}, ${companyId}, ${ids.liveRefAtt}, 'staff', ${callerId}, ${'c'.repeat(64)}, 'captured.pdf')`);

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
    expect((await partLines(backup.path!, 'document_drafts')).map((r) => r['id']).sort()).toEqual([ids.live, ids.converted, ids.liveRef].sort());
    expect(await partLines(backup.path!, 'vendor_layout_templates')).toHaveLength(1);
    const atts = (await partLines(backup.path!, 'attachments')).map((r) => r['id']);
    expect(atts).toEqual(expect.arrayContaining([ids.liveAtt, ids.convertedAtt, ids.plainAtt]));
    expect(reader.manifest.files.filter((f) => f.table === 'attachments').map((f) => f.rowId)).toEqual(expect.arrayContaining([ids.liveAtt]));
    expect((await partLines(backup.path!, 'accounts')).some((r) => r['card_last4'] === '4242')).toBe(true);
  }, 300_000);

  it('T7 transfer: converted drafts only, no layouts, no live draft file nothing else uses; the manifest says so; it verifies and imports', async () => {
    const reader = await ArchiveReader.open(transfer.path!, PASS);
    await reader.verifyAll();
    expect(reader.manifest.options.omitDocumentDrafts).toBe(true);
    expect(reader.manifest.omitted).toEqual(['attachments:live-document-drafts', 'audit_log:document-drafts', 'document_drafts:unconverted', 'vendor_layout_templates']);
    // The audit rows left out: every layout row and the live drafts' rows (counted before the export's own audit row).
    const auditLeft = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = ${tenantId}
      AND (entity_type = 'vendor_layout_template' OR (entity_type = 'document_draft' AND entity_id IN (${ids.live}, ${ids.liveRef})))`);
    expect(auditLeft[0]!.n).toBeGreaterThanOrEqual(3);
    expect(reader.manifest.omittedRows).toEqual({ attachments: 1, audit_log: auditLeft[0]!.n, document_drafts: 2 });
    // L-5: the converted draft travels with its bill.
    expect((await partLines(transfer.path!, 'document_drafts')).map((r) => r['id'])).toEqual([ids.converted]);
    expect(await partLines(transfer.path!, 'vendor_layout_templates')).toHaveLength(0);
    // L-6: no audit row of a layout or a draft left out; the converted draft's rows travel.
    const auditPart = await partLines(transfer.path!, 'audit_log');
    expect(auditPart.filter((r) => r['entity_type'] === 'vendor_layout_template')).toHaveLength(0);
    const draftAudit = auditPart.filter((r) => r['entity_type'] === 'document_draft');
    expect(draftAudit.length).toBeGreaterThan(0);
    expect(new Set(draftAudit.map((r) => r['entity_id']))).toEqual(new Set([ids.converted]));
    // L-7: the live draft's file a bill capture uses travels, with the capture.
    const atts = (await partLines(transfer.path!, 'attachments')).map((r) => r['id']);
    expect(atts).not.toContain(ids.liveAtt);
    expect(atts).toEqual(expect.arrayContaining([ids.convertedAtt, ids.plainAtt, ids.liveRefAtt]));
    expect((await partLines(transfer.path!, 'bill_captures')).map((r) => r['attachment_id'])).toEqual([ids.liveRefAtt]);
    expect(reader.manifest.warnings.filter((w) => /^(DANGLING|OUTSIDE)_REFERENCE:.*attachment/.test(w))).toEqual([]);
    const files = reader.manifest.files.filter((f) => f.table === 'attachments').map((f) => f.rowId);
    expect(files).not.toContain(ids.liveAtt);
    expect(files).toEqual(expect.arrayContaining([ids.convertedAtt, ids.liveRefAtt]));
    expect((await partLines(transfer.path!, 'accounts')).some((r) => r['card_last4'] === '4242')).toBe(true);
    const audit = await rows<{ a: string }>(sql`SELECT after_data #>> '{}' AS a FROM audit_log WHERE tenant_id = ${tenantId} AND entity_type = 'tenant_archive' AND entity_id = ${transfer.archiveId}`);
    expect(JSON.parse(audit[0]!.a)['omitDocumentDrafts']).toBe(true);

    const imported = await runImport({ filePath: transfer.path!, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    const n = await rows<{ d: number; t: number; a: number; b: number; c: number }>(sql`SELECT
      (SELECT count(*)::int FROM document_drafts WHERE tenant_id = ${imported.tenantId} AND status = 'converted') AS d,
      (SELECT count(*)::int FROM vendor_layout_templates WHERE tenant_id = ${imported.tenantId}) AS t,
      (SELECT count(*)::int FROM attachments WHERE tenant_id = ${imported.tenantId}) AS a,
      (SELECT count(*)::int FROM transactions WHERE tenant_id = ${imported.tenantId} AND txn_type = 'bill') AS b,
      (SELECT count(*)::int FROM bill_captures WHERE tenant_id = ${imported.tenantId}) AS c`);
    const src = await rows<{ a: number }>(sql`SELECT count(*)::int AS a FROM attachments WHERE tenant_id = ${tenantId}`);
    expect(n[0]).toEqual({ d: 1, t: 0, a: src[0]!.a - 1, b: 1, c: 1 });
    expect(await rows(sql`SELECT 1 FROM document_drafts WHERE tenant_id = ${imported.tenantId} AND status <> 'converted'`)).toHaveLength(0);
    // The imported converted draft still points at its bill.
    const conv = await rows<{ ok: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM document_drafts d JOIN transactions t ON t.id = d.converted_transaction_id
      WHERE d.tenant_id = ${imported.tenantId} AND t.tenant_id = ${imported.tenantId} AND t.txn_type = 'bill') AS ok`);
    expect(conv[0]!.ok).toBe(true);
    // The source keeps its drafts.
    expect((await db.select().from(documentDrafts).where(eq(documentDrafts.tenantId, tenantId))).length).toBe(3);
  }, 600_000);

  it('L-6: an archive with rows in a table its manifest lists as omitted is refused', async () => {
    // The manifest's own word: an omitted table that declares rows is damaged.
    const reader = await ArchiveReader.open(transfer.path!, PASS);
    const doctored = JSON.parse(JSON.stringify(reader.manifest)) as typeof reader.manifest;
    doctored.tables.find((t) => t.name === 'vendor_layout_templates')!.rows = 1;
    expect(() => validateManifest(doctored, reader.envelope)).toThrow(/omitted table has rows/);
    // The rows as inserted: a restored backup carries what a transfer leaves out.
    const restored = await runImport({ filePath: backup.path!, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(restored.tenantId);
    const check = (omitted: string[]) => withArchiveConnection((client) => assertOmissionsHold(client, plan, { ...reader.manifest, omitted }, restored.tenantId));
    for (const o of ['vendor_layout_templates', 'document_drafts:unconverted', 'audit_log:document-drafts']) {
      await expect(check([o]), o).rejects.toMatchObject({ code: 'ARCHIVE_CORRUPT' });
    }
    // The transfer's own import holds them.
    const fromTransfer = await runImport({ filePath: transfer.path!, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(fromTransfer.tenantId);
    await expect(withArchiveConnection((client) => assertOmissionsHold(client, plan, reader.manifest, fromTransfer.tenantId))).resolves.toBeUndefined();
  }, 600_000);

  it('T8 backup round trip: drafts come back and the claim index still holds', async () => {
    const imported = await runImport({ filePath: backup.path!, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    const drafts = await db.select().from(documentDrafts).where(eq(documentDrafts.tenantId, imported.tenantId));
    expect(drafts.map((d) => d.status).sort()).toEqual(['converted', 'new', 'new']);
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

  it('resetDocumentDrafts: the backup verifies and imports with no unconverted drafts or layouts; converted drafts stay; the audit row records it', async () => {
    const imported = await runImport({ filePath: backup.path!, passphrase: PASS, callerUserId: callerId, resetDocumentDrafts: true });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    const n = await rows<{ d: number; c: number; t: number }>(sql`SELECT
      (SELECT count(*)::int FROM document_drafts WHERE tenant_id = ${imported.tenantId}) AS d,
      (SELECT count(*)::int FROM document_drafts WHERE tenant_id = ${imported.tenantId} AND status = 'converted') AS c,
      (SELECT count(*)::int FROM vendor_layout_templates WHERE tenant_id = ${imported.tenantId}) AS t`);
    expect(n[0]).toEqual({ d: 1, c: 1, t: 0 });
    const audit = await rows<{ a: string }>(sql`SELECT after_data #>> '{}' AS a FROM audit_log WHERE tenant_id = ${imported.tenantId} AND entity_type = 'tenant_import'`);
    expect(JSON.parse(audit[0]!.a)['resetDocumentDrafts']).toBe(true);
    const { importArchiveSchema } = await import('../../routes/tenant-archives.routes.js');
    expect(importArchiveSchema.parse({ passphrase: PASS }).resetDocumentDrafts).toBe(false);
    const { exportArchiveSchema } = await import('../../routes/tenants.routes.js');
    expect(exportArchiveSchema.parse({ passphrase: PASS }).omitDocumentDrafts).toBe(false);
  }, 600_000);
});
