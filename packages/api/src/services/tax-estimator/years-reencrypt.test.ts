// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { taxEstTaxpayers } from '../../db/schema/tax-estimator-taxpayers.js';
import { taxEstYears } from '../../db/schema/tax-estimator-years.js';
import { recoverCredentialEncryption } from '../credential-reencrypt.service.js';
import { decrypt } from '../../utils/encryption.js';

// D9: prior-year tax / AGI are `*_encrypted` text columns, which is what enrols them in the
// credential re-encryption sweep. The sweep's column discovery is a non-exported query over
// information_schema; this test checks that query's result AND runs the real sweep.
const SOURCE_KEY = 'e'.repeat(63) + '1';
const FIRM = '00000000-0000-4000-8000-0000000000a5';
let taxpayerId = '';

function encryptWith(keyHex: string, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

afterAll(async () => {
  if (taxpayerId) await db.delete(taxEstTaxpayers).where(eq(taxEstTaxpayers.id, taxpayerId)); // cascades the year
});

describe('tax_est_years prior-year columns and the re-encryption sweep', () => {
  it('discovers (tax_est_years, prior_year_tax_encrypted) and the AGI column', async () => {
    const res = await db.execute(sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name LIKE '%\_encrypted'
        AND data_type IN ('text', 'character varying')`);
    const pairs = (res.rows as { table_name: string; column_name: string }[]).map((r) => `${r.table_name}.${r.column_name}`);
    expect(pairs).toContain('tax_est_years.prior_year_tax_encrypted');
    expect(pairs).toContain('tax_est_years.prior_year_agi_encrypted');
  });

  it('re-encrypts a prior-year value written under another server key so the service can read it again', async () => {
    const [tp] = await db.insert(taxEstTaxpayers).values({ firmId: FIRM, displayName: 'Reencrypt probe' }).returning();
    taxpayerId = tp!.id;
    await db.insert(taxEstYears).values({
      taxpayerId, taxYear: 2026,
      priorYearTaxEncrypted: encryptWith(SOURCE_KEY, '31500'), priorYearAgiEncrypted: encryptWith(SOURCE_KEY, '182000'),
    });
    const report = await recoverCredentialEncryption({ sourceKey: SOURCE_KEY });
    expect(report.perTable['tax_est_years']?.reencrypted).toBeGreaterThanOrEqual(2);
    const [row] = await db.select().from(taxEstYears).where(eq(taxEstYears.taxpayerId, taxpayerId));
    expect(decrypt(row!.priorYearTaxEncrypted!)).toBe('31500');
    expect(decrypt(row!.priorYearAgiEncrypted!)).toBe('182000');
  });
});
