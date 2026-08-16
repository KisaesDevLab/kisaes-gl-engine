// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// End-to-end: export a seeded tenant to a v2 .vmx package, then single-phase
// import it as a new tenant and verify the rows + attachment binary survive.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TMP = path.join(os.tmpdir(), `vmx-rt-${Date.now()}`);
process.env['BACKUP_DIR'] = path.join(TMP, 'backups');
process.env['UPLOAD_DIR'] = path.join(TMP, 'uploads');

import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { tenants, companies, accounts, transactions, journalLines } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// Loaded dynamically INSIDE the test so the BACKUP_DIR/UPLOAD_DIR env set above
// is in effect when the service captures them at module load (static imports
// hoist above the env assignment).
type Svc = typeof import('./tenant-export.service.js');

const createdTenants: string[] = [];

async function cleanup() {
  for (const t of createdTenants.splice(0)) {
    await db.execute(sql`DELETE FROM attachments WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM journal_lines WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM transactions WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM accounts WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM companies WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM user_tenant_access WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM tenants WHERE id = ${t}`);
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}
afterEach(cleanup);

describe('tenant export → import round-trip (v2 package)', () => {
  it('exports a seeded tenant and re-imports it as a new tenant, attachment included', async () => {
    const svc: Svc = await import('./tenant-export.service.js');
    // ── Seed a source tenant ──
    const [t] = await db.insert(tenants).values({ name: 'RT Source', slug: `rt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }).returning();
    const tenantId = t!.id;
    createdTenants.push(tenantId);
    await db.insert(companies).values({ tenantId, businessName: 'RT Source Co' });
    const [acct] = await db.insert(accounts).values({ tenantId, name: 'Cash', accountType: 'asset', accountNumber: '1000', detailType: 'checking' }).returning();
    const [rev] = await db.insert(accounts).values({ tenantId, name: 'Sales', accountType: 'revenue', accountNumber: '4000', detailType: 'service' }).returning();
    const [txn] = await db.insert(transactions).values({ tenantId, txnType: 'journal_entry', txnDate: '2026-05-01', memo: 'seed' }).returning();
    await db.insert(journalLines).values([
      { tenantId, transactionId: txn!.id, accountId: acct!.id, debit: '100.0000', credit: '0' },
      { tenantId, transactionId: txn!.id, accountId: rev!.id, debit: '0', credit: '100.0000' },
    ]);

    // An attachment with a real file on disk.
    const attId = crypto.randomUUID();
    const relPath = `att/${attId}.bin`;
    const absPath = path.join(process.env['UPLOAD_DIR']!, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const fileBytes = crypto.randomBytes(2048);
    fs.writeFileSync(absPath, fileBytes);
    await db.execute(sql`
      INSERT INTO attachments (id, tenant_id, file_name, file_path, file_size, mime_type, attachable_type, attachable_id, storage_provider, storage_key)
      VALUES (${attId}, ${tenantId}, 'receipt.bin', ${`/uploads/${relPath}`}, ${fileBytes.length}, 'application/octet-stream', 'transaction', ${txn!.id}, 'local', ${relPath})
    `);

    // Audit rows — the export page includes the audit trail by default, and
    // audit_log.id is a bigserial (the importer used to write a UUID into it
    // and 500 on every default export). One row points at the transaction
    // (must be re-keyed on import), one carries a JSON array in after_data.
    await db.execute(sql`
      INSERT INTO audit_log (tenant_id, action, entity_type, entity_id, before_data, after_data, created_at)
      VALUES
        (${tenantId}, 'create', 'transaction', ${txn!.id}, NULL, ${JSON.stringify({ memo: 'seed' })}::jsonb, '2026-05-01T12:00:00Z'),
        (${tenantId}, 'update', 'settings', NULL, ${JSON.stringify([1, 2])}::jsonb, ${JSON.stringify([3])}::jsonb, '2026-05-02T12:00:00Z')
    `);

    // ── Export (v2 streamed package) ──
    const passphrase = 'round-trip-strong-pass-123';
    const exp = await svc.exportTenant(tenantId, passphrase, { includeAttachments: true, includeAudit: true, includeBankRules: true });
    expect(exp.counts['transactions']).toBe(1);
    expect(exp.counts['attachments']).toBe(1);
    expect(exp.counts['audit_entries']).toBe(2);
    const vmxPath = path.join(process.env['BACKUP_DIR']!, tenantId, 'exports', exp.fileName);
    const buf = fs.readFileSync(vmxPath);
    // v2 is a real zip (PK magic).
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);

    // ── Single-phase import as a new tenant ──
    const result = await svc.importNewTenantFromFile(buf, passphrase, 'RT Imported', []);
    createdTenants.push(result.tenant_id);
    expect(result.tenant_id).not.toBe(tenantId);
    expect(result.counts['transactions']).toBe(1);
    expect(result.counts['attachments']).toBe(1);
    expect(result.counts['audit_entries']).toBe(2);

    // The imported tenant really has the transaction.
    const txnCount = await db.execute(sql`SELECT count(*)::int AS c FROM transactions WHERE tenant_id = ${result.tenant_id}`);
    expect((txnCount.rows[0] as { c: number }).c).toBe(1);

    // Audit history landed: the transaction row's entity_id was re-keyed to
    // the imported transaction, and jsonb payloads (incl. arrays) survived.
    const newTxn = await db.execute(sql`SELECT id FROM transactions WHERE tenant_id = ${result.tenant_id} LIMIT 1`);
    const newTxnId = (newTxn.rows[0] as { id: string }).id;
    const audit = await db.execute(sql`
      SELECT action, entity_id::text AS entity_id, before_data, after_data
      FROM audit_log WHERE tenant_id = ${result.tenant_id} AND entity_type IN ('transaction','settings') ORDER BY created_at
    `);
    const rows = audit.rows as { action: string; entity_id: string | null; before_data: unknown; after_data: unknown }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.entity_id).toBe(newTxnId);
    expect(rows[0]!.after_data).toEqual({ memo: 'seed' });
    expect(rows[1]!.before_data).toEqual([1, 2]);
    expect(rows[1]!.after_data).toEqual([3]);

    // The attachment binary was written and matches the original bytes.
    const att = await db.execute(sql`SELECT file_path FROM attachments WHERE tenant_id = ${result.tenant_id} LIMIT 1`);
    const importedPath = (att.rows[0] as { file_path: string }).file_path;
    const onDisk = path.join(process.env['UPLOAD_DIR']!, importedPath.replace(/^\/uploads\//, ''));
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk).equals(fileBytes)).toBe(true);

    // Wrong passphrase is rejected as a 400 the UI can display — not a bare
    // Error that the error handler would turn into a 500 "Internal server error".
    const wrong = await svc.importNewTenantFromFile(buf, 'nope-nope-nope-1', 'X', []).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(AppError);
    expect((wrong as AppError).statusCode).toBe(400);
    expect((wrong as AppError).message).toMatch(/Incorrect passphrase/);

    // A ZIP that isn't a Vibe MyBooks package is a 400 too, not a 500.
    const junkZip = Buffer.concat([Buffer.from('PK\x03\x04'), crypto.randomBytes(64)]);
    const junk = await svc.importNewTenantFromFile(junkZip, passphrase, 'X', []).catch((e: unknown) => e);
    expect(junk).toBeInstanceOf(AppError);
    expect((junk as AppError).statusCode).toBe(400);
  });
});
