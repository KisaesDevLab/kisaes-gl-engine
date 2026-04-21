// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Backup verification tests.
//
// The service has two distinct code paths — server-key (full
// decrypt + JSON parse) and passphrase (header-only envelope check).
// Both are exercised here against real on-disk fixtures so we
// validate the actual crypto + file-format contract, not a mock of
// it. A regression in either path is the kind of bug that hides
// until the day a restore is actually attempted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { encryptWithPassphrase } from './portable-encryption.service.js';
import { verifyLatestBackups, __internal } from './backup-verify.service.js';
import { db } from '../db/index.js';
import { auditLog as auditLogTable } from '../db/schema/audit-log.js';
import {
  tenants, users, sessions, accounts, companies, contacts, transactions,
  journalLines, tags, transactionTags,
  // Include every table that FK-references users or tenants so cleanup
  // doesn't fail mid-way and leave downstream test files looking at
  // partially-torn-down state. aiConfig in particular has a users FK
  // (migration 0054) that silently blocks `DELETE FROM users`.
  aiConfig, aiJobs, aiUsageLog, aiPromptTemplates,
} from '../db/schema/index.js';

let tmpDir: string;
let originalBackupDir: string | undefined;
let originalEncryptionKey: string | undefined;

async function cleanAuditLog(): Promise<void> {
  await db.delete(auditLogTable);
}

async function cleanOtherTables(): Promise<void> {
  await db.delete(transactionTags);
  await db.delete(tags);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(contacts);
  await db.delete(accounts);
  // These reference users/tenants and must be cleared first or the
  // users/tenants deletes fail under FK and leave the DB half-torn.
  await db.delete(aiUsageLog);
  await db.delete(aiJobs);
  await db.delete(aiPromptTemplates);
  await db.delete(aiConfig);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

function makeServerKeyBackup(serverKey: string, payload: object): Buffer {
  const iv = crypto.randomBytes(16);
  const keyHash = crypto.createHash('sha256').update(serverKey).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', keyHash, iv);
  const plaintext = Buffer.from(JSON.stringify(payload));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // [16 IV][16 authTag][encrypted]
  return Buffer.concat([iv, authTag, encrypted]);
}

describe('backup-verify', () => {
  beforeEach(async () => {
    await cleanAuditLog();
    await cleanOtherTables();
    // NB: test-global-setup sets BACKUP_DIR = /data/backups by default
    // (via the NODE_ENV=test path in config/env.ts). We point it at a
    // per-test tmp dir so we never read or write real backups.
    originalBackupDir = process.env['BACKUP_DIR'];
    originalEncryptionKey = process.env['BACKUP_ENCRYPTION_KEY'];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-verify-'));
    process.env['BACKUP_DIR'] = tmpDir;
    process.env['BACKUP_ENCRYPTION_KEY'] = 'test-server-key-' + Math.random().toString(36).slice(2);
  });

  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalBackupDir !== undefined) process.env['BACKUP_DIR'] = originalBackupDir;
    else delete process.env['BACKUP_DIR'];
    if (originalEncryptionKey !== undefined) process.env['BACKUP_ENCRYPTION_KEY'] = originalEncryptionKey;
    else delete process.env['BACKUP_ENCRYPTION_KEY'];
    await cleanAuditLog();
    await cleanOtherTables();
  });

  describe('header-only verification of passphrase backups', () => {
    it('marks a well-formed .vmb file as ok without the passphrase', async () => {
      const payload = Buffer.from(JSON.stringify({ metadata: { format: 'kis-books-backup-v3-portable' }, rows: [] }));
      const encrypted = encryptWithPassphrase(payload, 'correct horse battery staple');
      const tenantDir = path.join(tmpDir, 'tenant-1');
      fs.mkdirSync(tenantDir, { recursive: true });
      fs.writeFileSync(path.join(tenantDir, 'backup.vmb'), encrypted);

      const summary = await verifyLatestBackups();
      expect(summary.totalFiles).toBe(1);
      expect(summary.ok).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.results[0]?.method).toBe('passphrase');
      expect(summary.results[0]?.depth).toBe('header');
    });

    it('flags a truncated .vmb file as failed', async () => {
      const payload = Buffer.from(JSON.stringify({ metadata: {} }));
      const encrypted = encryptWithPassphrase(payload, 'passphrase');
      const tenantDir = path.join(tmpDir, 'tenant-1');
      fs.mkdirSync(tenantDir, { recursive: true });
      // Truncate aggressively so the header itself is incomplete.
      fs.writeFileSync(path.join(tenantDir, 'bad.vmb'), encrypted.subarray(0, 10));

      const summary = await verifyLatestBackups();
      expect(summary.ok).toBe(0);
      expect(summary.failed).toBe(1);
      expect(summary.results[0]?.error).toMatch(/file smaller than header/);
    });

    it('flags a file whose magic bytes are wrong (corrupted header)', async () => {
      const payload = Buffer.from(JSON.stringify({ metadata: {} }));
      const encrypted = encryptWithPassphrase(payload, 'passphrase');
      // Overwrite the first two bytes — but keep the length the same
      // so the smaller-than-header check passes and we fall through
      // to the magic-byte test.
      encrypted[0] = 0x00;
      encrypted[1] = 0x00;
      const tenantDir = path.join(tmpDir, 'tenant-1');
      fs.mkdirSync(tenantDir, { recursive: true });
      fs.writeFileSync(path.join(tenantDir, 'corrupt.vmb'), encrypted);

      const summary = await verifyLatestBackups();
      // Without the magic, detectEncryptionMethod now says server_key,
      // and the server_key decrypt will fail — either way the outcome
      // for the operator is the same: backup is not readable.
      expect(summary.ok).toBe(0);
      expect(summary.failed).toBe(1);
    });
  });

  describe('full verification of server-key backups', () => {
    it('decrypts and parses a .kbk produced with the current server key', async () => {
      const serverKey = process.env['BACKUP_ENCRYPTION_KEY']!;
      const encrypted = makeServerKeyBackup(serverKey, {
        metadata: { format: 'kis-books-backup-v2-tenant-scoped', rowCount: 42, tableCount: 5 },
        rows: [],
      });
      const tenantDir = path.join(tmpDir, 'tenant-2');
      fs.mkdirSync(tenantDir, { recursive: true });
      fs.writeFileSync(path.join(tenantDir, 'legacy.kbk'), encrypted);

      const summary = await verifyLatestBackups();
      expect(summary.ok).toBe(1);
      expect(summary.results[0]?.method).toBe('server_key');
      expect(summary.results[0]?.depth).toBe('full');
      expect(summary.results[0]?.metadata).toMatchObject({ rowCount: 42 });
    });

    it('reports the decrypt error when the server key has been rotated', async () => {
      const encrypted = makeServerKeyBackup('a-different-key-no-longer-valid', { metadata: {} });
      const tenantDir = path.join(tmpDir, 'tenant-3');
      fs.mkdirSync(tenantDir, { recursive: true });
      fs.writeFileSync(path.join(tenantDir, 'rotated.kbk'), encrypted);

      const summary = await verifyLatestBackups();
      expect(summary.ok).toBe(0);
      expect(summary.failed).toBe(1);
      expect(summary.results[0]?.error).toMatch(/Invalid encryption key|corrupted/i);
    });
  });

  describe('scanning', () => {
    it('returns empty summary when no backups exist', async () => {
      const summary = await verifyLatestBackups();
      expect(summary.totalFiles).toBe(0);
      expect(summary.ok).toBe(0);
      expect(summary.failed).toBe(0);
    });

    it('verifies only the newest file per tenant directory', async () => {
      const tenantDir = path.join(tmpDir, 'tenant-latest');
      fs.mkdirSync(tenantDir, { recursive: true });
      const older = encryptWithPassphrase(Buffer.from('{"metadata":{}}'), 'a');
      const newer = encryptWithPassphrase(Buffer.from('{"metadata":{}}'), 'a');
      fs.writeFileSync(path.join(tenantDir, 'older.vmb'), older);
      // Ensure differing mtime so the latest-file selection is stable.
      const oldMtime = new Date(Date.now() - 10_000);
      fs.utimesSync(path.join(tenantDir, 'older.vmb'), oldMtime, oldMtime);
      fs.writeFileSync(path.join(tenantDir, 'newer.vmb'), newer);

      const summary = await verifyLatestBackups();
      expect(summary.totalFiles).toBe(1);
      expect(summary.results[0]?.fileName).toBe('newer.vmb');
    });
  });

  describe('verifyPassphraseHeader unit', () => {
    it('accepts a correctly-sized VMBP v2 header', () => {
      const hdr = Buffer.concat([
        Buffer.from('VMBP', 'ascii'),
        Buffer.from([0x02]),
        Buffer.alloc(32),
        Buffer.alloc(12),
        Buffer.alloc(16),
      ]);
      const r = __internal.verifyPassphraseHeader(hdr);
      expect(r.ok).toBe(true);
    });

    it('rejects a version byte we do not know how to decrypt', () => {
      const hdr = Buffer.concat([
        Buffer.from('VMBP', 'ascii'),
        Buffer.from([0xFE]),
        Buffer.alloc(32),
        Buffer.alloc(12),
        Buffer.alloc(16),
      ]);
      const r = __internal.verifyPassphraseHeader(hdr);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/unsupported format version/);
    });
  });
});
