// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Bank account identities for file imports (U-06, owner Q-P25u).
 *
 * A bank file names its account (OFX BANKID / ACCTID). The client sends
 * those raw values over the loopback; the engine turns them into
 *   - maskedAccount: the last 4 characters of ACCTID (never more than 4
 *     digits visible), for display;
 *   - accountKeyHash: HMAC-SHA256 under the company's link key of
 *     "v1|" + trim(BANKID or "") + "|" + trim(ACCTID), lowercase hex;
 * and forgets the raw values. They are never stored, logged, audited or
 * kept in an idempotency record (the route takes them out of the body
 * before anything else sees it, takeBankIdentity in banking.routes.ts).
 *
 * The link key is per company (bank_link_keys), 32 random bytes encrypted
 * like the engine's other stored secrets (utils/encryption.ts). It travels
 * with the company in a tenant export and is encrypted again under the
 * importing install's key (SECRET_COLUMNS `reencrypt`), so a restored
 * company recognises its bank files with no questions. A company without
 * a key (old data) gets one on its first committed import; a dry run or a
 * lookup never creates one (nothing can be linked without it).
 */

import { createHmac, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { trimWs } from './keys.js';

export const LINK_KEY_VERSION = 'v1';
/** Longest BANKID / ACCTID accepted (OFX allows 9 and 22; CSV exports vary). */
export const IDENTITY_FIELD_MAX = 64;
export const MASK_VISIBLE = 4;

export interface RawBankIdentity { bankId?: string | null; acctId: string }
export interface BankIdentity { mask: string; accountKeyHash: string }

/** The last 4 characters of the trimmed ACCTID. */
export function maskedAccount(acctId: string): string {
  return Array.from(trimWs(acctId)).slice(-MASK_VISIBLE).join('');
}

/** At most 4 digits visible (the lookup's `mask`). */
export function isMasked(mask: string): boolean {
  return (mask.match(/\d/g) ?? []).length <= MASK_VISIBLE;
}

export function accountKeyHash(key: Buffer, raw: RawBankIdentity): string {
  return createHmac('sha256', key)
    .update(`${LINK_KEY_VERSION}|${trimWs(raw.bankId ?? '')}|${trimWs(raw.acctId)}`, 'utf8')
    .digest('hex');
}

/**
 * The company's link key; with `create`, one is made when the company has
 * none yet (two concurrent first imports agree on one: ON CONFLICT).
 */
export async function companyLinkKey(ex: DbOrTx, tenantId: string, companyId: string, create: boolean): Promise<Buffer | null> {
  const read = async (): Promise<{ key: Buffer | null; stored: string | null }> => {
    const r = await ex.execute(sql`SELECT key_encrypted FROM bank_link_keys WHERE tenant_id = ${tenantId} AND company_id = ${companyId}`);
    const stored = (r.rows as Array<{ key_encrypted: string | null }>)[0]?.key_encrypted ?? null;
    if (!stored) return { key: null, stored };
    try {
      const hex = decrypt(stored);
      return { key: /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null, stored };
    } catch {
      // Unreadable under this install's key (a restore whose re-encryption
      // failed): treated as missing; the saved identities stop matching and
      // the next import asks for the account again.
      return { key: null, stored };
    }
  };
  const existing = await read();
  if (existing.key || !create) return existing.key;
  // None yet (old data), or unreadable: a new key. Two concurrent first
  // imports agree on one (the row lock of the conflict, then the re-read).
  await ex.execute(sql`INSERT INTO bank_link_keys (tenant_id, company_id, key_encrypted)
    VALUES (${tenantId}, ${companyId}, ${encrypt(randomBytes(32).toString('hex'))})
    ON CONFLICT (company_id) DO UPDATE SET key_encrypted = EXCLUDED.key_encrypted
      WHERE bank_link_keys.key_encrypted IS NOT DISTINCT FROM ${existing.stored}`);
  return (await read()).key;
}

/** The identity the engine keeps for raw BANKID / ACCTID; null without a key. */
export async function bankIdentityOf(
  ex: DbOrTx, tenantId: string, companyId: string, raw: RawBankIdentity, create: boolean,
): Promise<BankIdentity & { keyed: boolean }> {
  const key = await companyLinkKey(ex, tenantId, companyId, create);
  return { mask: maskedAccount(raw.acctId), accountKeyHash: key ? accountKeyHash(key, raw) : '', keyed: key !== null };
}
