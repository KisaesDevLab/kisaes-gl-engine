// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { recoverCredentialEncryption, resolveSourceKey } from './credential-reencrypt.service.js';
import { writeRecoveryFile, getRecoveryFilePath, getSourceRecoveryFilePath } from './env-recovery.service.js';
import { generateRecoveryKey } from './recovery-key.service.js';
import { decrypt } from '../utils/encryption.js';

// A distinct "source server" key, different from the test env's current key.
const SOURCE_KEY = 'f'.repeat(63) + '0';

/** encrypt() from utils/encryption.ts under an arbitrary key. */
function encryptWith(keyHex: string, plaintext: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

let tmpDataDir: string;
let originalDataDir: string | undefined;
const webhookMarker = 'https://reencrypt-test.example.com';

beforeAll(async () => {
  originalDataDir = process.env['DATA_DIR'];
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reencrypt-test-'));
  process.env['DATA_DIR'] = tmpDataDir;

  await db.execute(sql`
    INSERT INTO plaid_config (environment, client_id_encrypted, secret_sandbox_encrypted, webhook_url)
    VALUES ('sandbox', ${encryptWith(SOURCE_KEY, 'source-plaid-client')}, ${encryptWith(SOURCE_KEY, 'source-plaid-secret')}, ${webhookMarker})
  `);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM plaid_config WHERE webhook_url = ${webhookMarker}`);
  if (originalDataDir === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = originalDataDir;
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('resolveSourceKey', () => {
  it('recovers the source key from a parked v2 recovery file via the original recovery key', () => {
    const recoveryKey = generateRecoveryKey();
    writeRecoveryFile(
      recoveryKey,
      { encryptionKey: 'e'.repeat(64), jwtSecret: 'j'.repeat(40), databaseUrl: 'postgres://x', plaidEncryptionKey: SOURCE_KEY },
      null,
    );
    // Park it where cross-host restores put the SOURCE file.
    fs.copyFileSync(getRecoveryFilePath(), getSourceRecoveryFilePath());

    const resolved = resolveSourceKey({ recoveryKey });
    expect(resolved).toEqual({ key: SOURCE_KEY, origin: 'recovery_file' });
  });

  it('explains when the parked file predates v2 (no credential key inside)', () => {
    const recoveryKey = generateRecoveryKey();
    writeRecoveryFile(
      recoveryKey,
      { encryptionKey: 'e'.repeat(64), jwtSecret: 'j'.repeat(40), databaseUrl: 'postgres://x' },
      null,
    );
    fs.copyFileSync(getRecoveryFilePath(), getSourceRecoveryFilePath());
    expect(() => resolveSourceKey({ recoveryKey })).toThrow(/predates v2|does not carry/);
  });

  it('requires one of the two inputs', () => {
    expect(() => resolveSourceKey({})).toThrow(/Provide either/);
  });
});

describe('recoverCredentialEncryption', () => {
  it('rejects a wrong key without touching anything', async () => {
    await expect(
      recoverCredentialEncryption({ sourceKey: 'a'.repeat(64) }),
    ).rejects.toThrow(/did not decrypt any stored credential/);

    const row = await db.execute(sql`SELECT client_id_encrypted FROM plaid_config WHERE webhook_url = ${webhookMarker}`);
    // Still the source-key ciphertext: current key cannot open it.
    expect(() => decrypt((row.rows[0] as { client_id_encrypted: string }).client_id_encrypted)).toThrow();
  });

  it('re-encrypts source-keyed credentials under the current key', async () => {
    const report = await recoverCredentialEncryption({ sourceKey: SOURCE_KEY });

    expect(report.totals.reencrypted).toBeGreaterThanOrEqual(2); // client id + sandbox secret
    expect(report.perTable['plaid_config']!.reencrypted).toBe(2);
    expect(report.sourceKeyOrigin).toBe('direct');

    const row = await db.execute(sql`SELECT client_id_encrypted, secret_sandbox_encrypted FROM plaid_config WHERE webhook_url = ${webhookMarker}`);
    const r = row.rows[0] as { client_id_encrypted: string; secret_sandbox_encrypted: string };
    expect(decrypt(r.client_id_encrypted)).toBe('source-plaid-client');
    expect(decrypt(r.secret_sandbox_encrypted)).toBe('source-plaid-secret');
  });

  it('refuses when the supplied key equals the current key', async () => {
    await expect(
      recoverCredentialEncryption({ sourceKey: process.env['PLAID_ENCRYPTION_KEY']! }),
    ).rejects.toThrow(/identical/);
  });
});
