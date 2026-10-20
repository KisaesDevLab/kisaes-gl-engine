// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { isSecretKey, stripSecretKeys } from './secret-keys.js';

describe('isSecretKey', () => {
  it('matches snake_case and camelCase credential keys', () => {
    for (const k of [
      'smtp_pass', 'smtpPass', 'password_hash', 'passwordHash', 'access_token_encrypted', 'accessTokenEncrypted',
      'stripe_secret_key_encrypted', 'stripeSecretKeyEncrypted', 'remote_backup_passphrase_hash', 'tfaTotpSecretEncrypted',
      'api_key', 'apiKey', 'refresh_token', 'otp', 'credential', 'remote_backup_config', 'remoteBackupConfig', 'share_token', 'publicToken',
    ]) {
      expect(isSecretKey(k), k).toBe(true);
    }
  });

  it('leaves business keys and LLM token counts alone', () => {
    for (const k of ['business_name', 'businessName', 'total', 'memo', 'input_tokens', 'inputTokens', 'output_tokens', 'lock_date', 'smtp_host', 'passkeys_count']) {
      expect(isSecretKey(k), k).toBe(false);
    }
  });

  it('keeps content digests, expiry/limit bookkeeping and public ids in the audit trail', () => {
    for (const k of [
      'fileHash', 'file_hash', 'sourceFileHash', 'numbersHash', 'contentHash',
      'tokenExpiresAt', 'accessTokenExpiresAt', 'monthlyTokenLimit',
      'tfaTotpVerified', 'tfaTotpLastStep', 'credentialId', 'credential_id',
    ]) {
      expect(isSecretKey(k), k).toBe(false);
    }
  });

  it('still strips secrets that merely resemble an exempt name', () => {
    for (const k of ['fileHashSecret', 'passwordHash', 'tokenExpiresAtToken', 'credentialIdSecret', 'refreshTokenExpiresAt', 'tfaTotpSecret']) {
      expect(isSecretKey(k), k).toBe(true);
    }
  });
});

describe('stripSecretKeys', () => {
  it('drops matching keys at every depth, inside arrays too, and keeps everything else', () => {
    const d = new Date('2026-01-02T03:04:05Z');
    const input = {
      business_name: 'Co',
      smtp_pass: 'p1',
      nested: { stripe: { secretKeyEncrypted: 'p2', mode: 'live' }, when: d },
      list: [{ apiKey: 'p3', n: 1 }, 'x', 2, null],
      remote_backup_config: { token: 'p4' },
      inputTokens: 12,
      nothing: null,
    };
    expect(stripSecretKeys(input)).toEqual({
      business_name: 'Co',
      nested: { stripe: { mode: 'live' }, when: d },
      list: [{ n: 1 }, 'x', 2, null],
      inputTokens: 12,
      nothing: null,
    });
    // The input is not mutated.
    expect(input.smtp_pass).toBe('p1');
  });

  it('returns scalars, null and non-plain objects unchanged', () => {
    expect(stripSecretKeys('s')).toBe('s');
    expect(stripSecretKeys(null)).toBeNull();
    expect(stripSecretKeys(3)).toBe(3);
    const buf = Buffer.from('x');
    expect(stripSecretKeys(buf)).toBe(buf);
    expect(stripSecretKeys({})).toEqual({});
    expect(stripSecretKeys([])).toEqual([]);
  });
});
