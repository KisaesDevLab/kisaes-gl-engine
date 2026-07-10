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

    // ── Export (v2 streamed package) ──
    const passphrase = 'round-trip-strong-pass-123';
    const exp = await svc.exportTenant(tenantId, passphrase, { includeAttachments: true, includeAudit: false, includeBankRules: true });
    expect(exp.counts['transactions']).toBe(1);
    expect(exp.counts['attachments']).toBe(1);
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

    // The imported tenant really has the transaction.
    const txnCount = await db.execute(sql`SELECT count(*)::int AS c FROM transactions WHERE tenant_id = ${result.tenant_id}`);
    expect((txnCount.rows[0] as { c: number }).c).toBe(1);

    // The attachment binary was written and matches the original bytes.
    const att = await db.execute(sql`SELECT file_path FROM attachments WHERE tenant_id = ${result.tenant_id} LIMIT 1`);
    const importedPath = (att.rows[0] as { file_path: string }).file_path;
    const onDisk = path.join(process.env['UPLOAD_DIR']!, importedPath.replace(/^\/uploads\//, ''));
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk).equals(fileBytes)).toBe(true);

    // Wrong passphrase is rejected.
    await expect(svc.importNewTenantFromFile(buf, 'nope-nope-nope-1', 'X', [])).rejects.toThrow(/passphrase|corrupt/i);
  });
});
