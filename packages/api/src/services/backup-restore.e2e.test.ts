// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// END-TO-END DR guard: a bundle produced by createSystemBackup must restore
// FAITHFULLY through the exact read path (mergeBundleSections +
// restoreDatabaseSections + writeBackBundleFiles), including attachment FILES.
// This is the one test that proves the WRITE and READ halves connect — a
// mismatch here is silent data loss on the only operation that matters.
// BACKUP_DIR + UPLOAD_DIR are captured at module load, so set them first.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

let backupDir = '';
let uploadDir = '';
let backupSvc: typeof import('./backup.service.js');
let restoreSvc: typeof import('./system-restore.service.js');
let vmx: typeof import('./vmx-package.js');

const tenantId = crypto.randomUUID();
const accountId = crypto.randomUUID();
const attachmentId = crypto.randomUUID();
const attachableId = crypto.randomUUID();
const storageKey = `${tenantId}/attachments/${attachmentId}.pdf`;
const fileBytes = Buffer.from('THE-RECEIPT-PDF-BYTES-' + crypto.randomUUID());
const PASSPHRASE = 'e2e-dr-roundtrip-passphrase';
const SMTP_HOST = `e2e-${tenantId.slice(0, 8)}.mail.example.com`;

beforeAll(async () => {
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-bk-'));
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-up-'));
  process.env['BACKUP_DIR'] = backupDir;
  process.env['UPLOAD_DIR'] = uploadDir;
  backupSvc = await import('./backup.service.js');
  restoreSvc = await import('./system-restore.service.js');
  vmx = await import('./vmx-package.js');

  await db.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'E2E DR', ${'e2e-dr-' + tenantId.slice(0, 8)})`);
  await db.execute(sql`INSERT INTO accounts (id, tenant_id, name, account_type) VALUES (${accountId}, ${tenantId}, 'E2E Cash', 'bank')`);
  // A global (non-tenant) row — must ride the global_tables section.
  await db.execute(sql`INSERT INTO system_settings (key, value) VALUES ('smtp_host', ${SMTP_HOST}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  // An attachment + its real file on local disk.
  await db.execute(sql`
    INSERT INTO attachments (id, tenant_id, file_name, file_path, storage_key, storage_provider, attachable_type, attachable_id, file_size)
    VALUES (${attachmentId}, ${tenantId}, 'receipt.pdf', ${'/uploads/' + storageKey}, ${storageKey}, 'local', 'transaction', ${attachableId}, ${fileBytes.length})
  `);
  fs.mkdirSync(path.join(uploadDir, path.dirname(storageKey)), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, storageKey), fileBytes);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM attachments WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM accounts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM system_settings WHERE key = 'smtp_host' AND value = ${SMTP_HOST}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  for (const d of [backupDir, uploadDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('DR backup → restore end-to-end', () => {
  it('a createSystemBackup bundle restores DB rows AND attachment files faithfully', async () => {
    // 1) Full system backup WITH attachments.
    const result = await backupSvc.createSystemBackup(PASSPHRASE, undefined, { includeAttachments: true });
    expect(result.partCount).toBeGreaterThanOrEqual(1);
    const paths = result.files.map((f) => path.join(backupDir, '_system', f.fileName));
    for (const p of paths) expect(fs.existsSync(p)).toBe(true);

    // 2) Read the bundle back exactly as restore does.
    const pkg = paths.length === 1 && vmx.isPackageFormat(fs.readFileSync(paths[0]!))
      ? await vmx.readTenantPackage(paths[0]!, PASSPHRASE)
      : await vmx.readTenantPackageMulti(paths, PASSPHRASE);
    const content = pkg.data as Parameters<typeof restoreSvc.mergeBundleSections>[0];

    // 3) The bundle must CONTAIN what we seeded (write side).
    const sections = restoreSvc.mergeBundleSections(content);
    expect(sections['tenants']?.some((r) => r['id'] === tenantId)).toBe(true);
    expect(sections['accounts']?.some((r) => r['id'] === accountId)).toBe(true);
    expect(sections['system_settings']?.some((r) => r['key'] === 'smtp_host' && r['value'] === SMTP_HOST)).toBe(true);
    expect(sections['attachments']?.some((r) => r['id'] === attachmentId)).toBe(true);

    // 4) Simulate loss: delete the account row and the attachment file.
    await db.execute(sql`DELETE FROM accounts WHERE id = ${accountId}`);
    fs.rmSync(path.join(uploadDir, storageKey));
    expect((await db.execute(sql`SELECT 1 FROM accounts WHERE id = ${accountId}`)).rows).toHaveLength(0);

    // 5) Restore through the real read path (rows + files). Runs inside a
    // transaction like production, so restoreTableRows' per-row savepoints apply.
    const report = await db.transaction((tx) => restoreSvc.restoreDatabaseSections(tx, sections));
    expect(report.totals.failed).toBe(0);
    const fileReport = await restoreSvc.writeBackBundleFiles(sections, () => pkg.attachments());

    // 6) The account row is back, and the attachment file bytes match exactly.
    const acct = await db.execute(sql`SELECT name, account_type FROM accounts WHERE id = ${accountId}`);
    expect((acct.rows as Array<{ name: string; account_type: string }>)[0]).toMatchObject({ name: 'E2E Cash', account_type: 'bank' });

    expect(fileReport.perTable['attachments']?.restored).toBeGreaterThanOrEqual(1);
    const restoredFile = path.join(uploadDir, storageKey);
    expect(fs.existsSync(restoredFile)).toBe(true);
    expect(fs.readFileSync(restoredFile).equals(fileBytes)).toBe(true);
  }, 60000);
});
