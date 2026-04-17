// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import fs from 'fs';
import path from 'path';
import { encryptWithPassphrase, decryptWithPassphrase } from './portable-encryption.service.js';
import { recoveryKeyToPassphrase, parseRecoveryKey } from './recovery-key.service.js';
import { writeAtomicSync } from '../utils/atomic-write.js';

/**
 * Encrypted backup of the three env values that cannot be reconstructed
 * without a pre-existing copy: ENCRYPTION_KEY, JWT_SECRET, DATABASE_URL.
 * Stored at /data/.env.recovery, encrypted with the operator's recovery key
 * (which is shown to them exactly once during setup).
 *
 * Reuses portable-encryption.service.ts so we don't maintain two separate
 * passphrase-based AES-256-GCM paths. The VMBP magic bytes are the same as
 * system backups; we rely on the file location + loader code to discriminate
 * purpose.
 *
 * Intentionally NOT stored: SMTP creds, Plaid keys, AI keys, etc. Those are
 * re-enterable through the admin UI after a recovery. Only values without a
 * re-entry path are recovered here.
 */

export interface RecoveryEnvValues {
  encryptionKey: string;
  jwtSecret: string;
  databaseUrl: string;
}

export interface RecoveryFileContents extends RecoveryEnvValues {
  version: 1;
  createdAt: string;
  installationId: string | null;
}

export function getRecoveryFilePath(): string {
  return path.join(process.env['DATA_DIR'] || '/data', '.env.recovery');
}

export function recoveryFileExists(): boolean {
  return fs.existsSync(getRecoveryFilePath());
}

/**
 * Create or overwrite /data/.env.recovery. The caller supplies the recovery
 * key (already parsed into canonical form) and the env values to protect.
 */
export function writeRecoveryFile(recoveryKey: string, values: RecoveryEnvValues, installationId: string | null): void {
  const parsed = parseRecoveryKey(recoveryKey);
  const passphrase = recoveryKeyToPassphrase(parsed);

  const payload: RecoveryFileContents = {
    version: 1,
    createdAt: new Date().toISOString(),
    installationId,
    encryptionKey: values.encryptionKey,
    jwtSecret: values.jwtSecret,
    databaseUrl: values.databaseUrl,
  };
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = encryptWithPassphrase(plaintext, passphrase);
  writeAtomicSync(getRecoveryFilePath(), encrypted, 0o600);
}

/**
 * Read /data/.env.recovery and decrypt it with the supplied key. Returns
 * null if the file does not exist. Throws on parse / decrypt failure with a
 * clear error — the caller displays this to the operator in the EnvMissing
 * diagnostic page.
 */
export function readRecoveryFile(recoveryKey: string): RecoveryFileContents | null {
  if (!recoveryFileExists()) return null;
  const parsed = parseRecoveryKey(recoveryKey);
  const passphrase = recoveryKeyToPassphrase(parsed);

  const fileBuf = fs.readFileSync(getRecoveryFilePath());
  let decrypted: Buffer;
  try {
    decrypted = decryptWithPassphrase(fileBuf, passphrase);
  } catch (err) {
    throw new Error(`recovery key did not decrypt the file — check for typos: ${(err as Error).message}`);
  }
  let json: RecoveryFileContents;
  try {
    json = JSON.parse(decrypted.toString('utf8')) as RecoveryFileContents;
  } catch {
    throw new Error('recovery file decrypted but contains invalid JSON');
  }
  if (json.version !== 1) {
    throw new Error(`unsupported recovery file version ${json.version}`);
  }
  if (!json.encryptionKey || !json.jwtSecret || !json.databaseUrl) {
    throw new Error('recovery file is missing one or more required fields');
  }
  return json;
}

/** Delete the recovery file. Used by factory-reset and regeneration flows. */
export function deleteRecoveryFile(): void {
  if (recoveryFileExists()) fs.unlinkSync(getRecoveryFilePath());
}
