// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Cross-host credential recovery. After a restore onto a server whose
// PLAID_ENCRYPTION_KEY differs from the source's, every restored
// *_encrypted column (Plaid, SMS/2FA, AI keys, firm integrations, storage
// OAuth tokens) fails AES-GCM authentication. This service re-encrypts them
// under THIS server's key, given the SOURCE key — supplied either directly
// (operator still has the old .env) or recovered from the parked source
// recovery file (/data/.env.recovery.source, written by cross-host restores
// from v2 bundles) by entering the ORIGINAL recovery key.
//
// The operation is verify-first (the source key must decrypt at least one
// stored ciphertext before anything is written) and runs in a single
// transaction — it either migrates everything it can decrypt or nothing.

import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { AppError } from '../utils/errors.js';
import { encrypt } from '../utils/encryption.js';
import { readSourceRecoveryFile, sourceRecoveryFileExists } from './env-recovery.service.js';

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** Same key-derivation rule as utils/encryption.ts getKey(), for an arbitrary key string. */
function deriveKey(keyMaterial: string): Buffer {
  if (keyMaterial.length === 64 && /^[0-9a-f]+$/i.test(keyMaterial)) {
    return Buffer.from(keyMaterial, 'hex');
  }
  return crypto.createHash('sha256').update(keyMaterial).digest();
}

/** decrypt() from utils/encryption.ts, parameterized by key. */
function decryptWith(keyMaterial: string, ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted data format');
  const iv = Buffer.from(parts[0]!, 'base64');
  const tag = Buffer.from(parts[1]!, 'base64');
  const encrypted = Buffer.from(parts[2]!, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(keyMaterial), iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

export interface ReencryptReport {
  perTable: Record<string, { reencrypted: number; alreadyCurrent: number; unreadable: number }>;
  totals: { reencrypted: number; alreadyCurrent: number; unreadable: number };
  sourceKeyOrigin: 'direct' | 'recovery_file';
}

interface EncryptedColumn {
  table: string;
  column: string;
}

// Covers every TOP-LEVEL text/varchar `*_encrypted` column (Plaid, SMS/2FA,
// AI keys, firm integrations, per-tenant storage OAuth tokens, …).
//
// KNOWN LIMITATION: ciphertext embedded inside JSON config BLOBS is not
// re-encrypted here — specifically `system_settings` rows whose value is JSON
// containing `application_key_encrypted`/`secret_*_encrypted`
// (backup_remote_config, storage_system_config) and `storage_providers.config`
// jsonb. Those are system-level integration settings the operator re-enters
// in Admin after a cross-host restore (and, for restore-from-B2, the operator
// supplies the backup-bucket creds fresh at restore time anyway), so they are
// intentionally out of scope for the automatic column-level re-encryption.
async function listEncryptedColumns(): Promise<EncryptedColumn[]> {
  const res = await db.execute(sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name LIKE '%\_encrypted'
      AND data_type IN ('text', 'character varying')
    ORDER BY table_name, column_name
  `);
  return (res.rows as { table_name: string; column_name: string }[])
    .filter((r) => IDENT_RE.test(r.table_name) && IDENT_RE.test(r.column_name))
    .map((r) => ({ table: r.table_name, column: r.column_name }));
}

/**
 * Resolve the source key: direct value wins; otherwise decrypt the parked
 * source recovery file with the operator's original recovery key.
 */
export function resolveSourceKey(input: { sourceKey?: string; recoveryKey?: string }): {
  key: string;
  origin: 'direct' | 'recovery_file';
} {
  if (input.sourceKey?.trim()) return { key: input.sourceKey.trim(), origin: 'direct' };
  if (input.recoveryKey?.trim()) {
    if (!sourceRecoveryFileExists()) {
      throw AppError.badRequest(
        'No source recovery file is present on this server. Cross-host restores from v0.9.115+ bundles park it automatically; otherwise paste the source PLAID_ENCRYPTION_KEY directly.',
      );
    }
    const contents = readSourceRecoveryFile(input.recoveryKey.trim());
    if (!contents) throw AppError.badRequest('Source recovery file not found');
    if (!contents.plaidEncryptionKey) {
      throw AppError.badRequest(
        'The source recovery file predates v2 and does not carry the credential-encryption key. Paste the source PLAID_ENCRYPTION_KEY directly instead.',
      );
    }
    return { key: contents.plaidEncryptionKey, origin: 'recovery_file' };
  }
  throw AppError.badRequest('Provide either the original recovery key or the source PLAID_ENCRYPTION_KEY');
}

/**
 * Re-encrypt every stored credential from the source key to this server's
 * current key. Values that already decrypt with the current key are left
 * untouched; values neither key can open are counted (never modified).
 */
export async function recoverCredentialEncryption(input: {
  sourceKey?: string;
  recoveryKey?: string;
}): Promise<ReencryptReport> {
  const { key: sourceKey, origin } = resolveSourceKey(input);
  const currentKey = process.env['PLAID_ENCRYPTION_KEY'];
  if (!currentKey) throw AppError.badRequest('PLAID_ENCRYPTION_KEY is not set on this server');
  if (deriveKey(sourceKey).equals(deriveKey(currentKey))) {
    throw AppError.badRequest('The supplied key is identical to this server’s current key — nothing to migrate');
  }

  const columns = await listEncryptedColumns();
  const report: ReencryptReport = {
    perTable: {},
    totals: { reencrypted: 0, alreadyCurrent: 0, unreadable: 0 },
    sourceKeyOrigin: origin,
  };
  const bump = (table: string, kind: keyof ReencryptReport['totals']) => {
    report.perTable[table] ??= { reencrypted: 0, alreadyCurrent: 0, unreadable: 0 };
    report.perTable[table]![kind] += 1;
    report.totals[kind] += 1;
  };

  // Verify-first: the source key must open at least one stored ciphertext.
  let sourceKeyOpensSomething = false;

  await db.transaction(async (tx) => {
    for (const { table, column } of columns) {
      // Address rows by ctid — not every table has a plain `id` column
      // (vendor_1099_profile keys on contact ids, join tables are composite).
      // ctid is stable for the duration of this transaction.
      const rows = await tx.execute(sql`
        SELECT ctid::text AS rid, ${sql.identifier(column)} AS value
        FROM ${sql.identifier(table)}
        WHERE ${sql.identifier(column)} IS NOT NULL AND ${sql.identifier(column)} <> ''
      `);
      for (const row of rows.rows as Array<{ rid: string; value: string }>) {
        try {
          decryptWith(currentKey, row.value);
          bump(table, 'alreadyCurrent');
          continue;
        } catch { /* not current-key — try the source key */ }
        let plaintext: string;
        try {
          plaintext = decryptWith(sourceKey, row.value);
        } catch {
          bump(table, 'unreadable');
          continue;
        }
        sourceKeyOpensSomething = true;
        await tx.execute(sql`
          UPDATE ${sql.identifier(table)}
          SET ${sql.identifier(column)} = ${encrypt(plaintext)}
          WHERE ctid = ${row.rid}::tid
        `);
        bump(table, 'reencrypted');
      }
    }

    if (report.totals.reencrypted > 0 && !sourceKeyOpensSomething) {
      throw AppError.badRequest('internal consistency error'); // unreachable
    }
    if (report.totals.reencrypted === 0 && report.totals.unreadable > 0) {
      // The key opened nothing — abort so a wrong key can never half-touch
      // the row set (transaction rolls back the zero writes regardless).
      throw AppError.badRequest(
        'The supplied key did not decrypt any stored credential. Check the key and try again; nothing was changed.',
      );
    }
  });

  return report;
}
