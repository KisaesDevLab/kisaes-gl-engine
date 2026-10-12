// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import { taxEstTaxpayers } from '../../db/schema/tax-estimator-taxpayers.js';
import { taxEstSnapshots } from '../../db/schema/tax-estimator-estimate.js';
import { recoverCredentialEncryption } from '../credential-reencrypt.service.js';
import { decrypt } from '../../utils/encryption.js';

// D9 / Phase 12: the snapshot payload and summary are `*_encrypted` text columns, which
// enrols them in the credential re-encryption sweep. The immutability trigger must let
// the sweep rewrite the ciphertext (and nothing else).
const SOURCE_KEY = 'd'.repeat(63) + '2';
const FIRM = '00000000-0000-4000-8000-0000000012a6';
let taxpayerId = '';

function encryptWith(keyHex: string, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

afterAll(async () => {
  if (taxpayerId) await db.delete(taxEstTaxpayers).where(eq(taxEstTaxpayers.id, taxpayerId)); // cascades the snapshot
  await pool.end();
});

describe('tax_est_snapshots ciphertext and the re-encryption sweep', () => {
  it('discovers (tax_est_snapshots, payload_encrypted) and summary_encrypted', async () => {
    const res = await db.execute(sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name LIKE '%\_encrypted'
        AND data_type IN ('text', 'character varying')`);
    const pairs = (res.rows as { table_name: string; column_name: string }[]).map((r) => `${r.table_name}.${r.column_name}`);
    expect(pairs).toContain('tax_est_snapshots.payload_encrypted');
    expect(pairs).toContain('tax_est_snapshots.summary_encrypted');
  });

  it('re-encrypts a snapshot written under another server key through the immutability trigger', async () => {
    const [tp] = await db.insert(taxEstTaxpayers).values({ firmId: FIRM, displayName: 'Snapshot reencrypt probe' }).returning();
    taxpayerId = tp!.id;
    const payload = JSON.stringify({ version: 1, priorYearTax: '31500' });
    const summary = JSON.stringify({ total: '43732' });
    const [row] = await db.insert(taxEstSnapshots).values({
      firmId: FIRM, taxpayerId, taxYear: 2026, scenarioId: crypto.randomUUID(), scenarioName: 'Base', reason: 'finalize',
      engineVersion: 'test', inputsHash: 'a'.repeat(64), payloadEncrypted: encryptWith(SOURCE_KEY, payload), payloadSha256: sha(payload),
      summaryEncrypted: encryptWith(SOURCE_KEY, summary), summarySha256: sha(summary), payloadBytes: payload.length,
    }).returning();
    const report = await recoverCredentialEncryption({ sourceKey: SOURCE_KEY });
    expect(report.perTable['tax_est_snapshots']?.reencrypted).toBeGreaterThanOrEqual(2);
    const [after] = await db.select().from(taxEstSnapshots).where(eq(taxEstSnapshots.id, row!.id));
    expect(decrypt(after!.payloadEncrypted)).toBe(payload);
    expect(decrypt(after!.summaryEncrypted)).toBe(summary);
    expect(after!.payloadSha256).toBe(sha(payload));
  });
});
