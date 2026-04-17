// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const keyHex = process.env['PLAID_ENCRYPTION_KEY'];
  // No environment-specific fallback. Previously the dev path derived the
  // key from JWT_SECRET (or a literal string 'dev-fallback-key'), which
  // meant a misdeployed NODE_ENV or a missing env var would encrypt secrets
  // with a trivially-recoverable key. Allowed secrets rot when the key can
  // be guessed, so require it in every environment. Tests set this via the
  // .env test fixtures; the setup wizard generates one for production.
  if (!keyHex || keyHex.length < 32) {
    throw new Error(
      'PLAID_ENCRYPTION_KEY must be set (minimum 32 chars or 64 hex chars). ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (keyHex.length === 64 && /^[0-9a-f]+$/i.test(keyHex)) {
    return Buffer.from(keyHex, 'hex');
  }
  return crypto.createHash('sha256').update(keyHex).digest();
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all base64)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted data format');

  const iv = Buffer.from(parts[0]!, 'base64');
  const tag = Buffer.from(parts[1]!, 'base64');
  const encrypted = Buffer.from(parts[2]!, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}
