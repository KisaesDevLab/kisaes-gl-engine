// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { looksLikeCiphertext } from './tfa.service.js';
import { encrypt } from '../utils/encryption.js';

// The TOTP verifier may fall back to treating a stored value as a raw
// secret ONLY for legacy plaintext rows. Ciphertext that fails to decrypt
// must surface as "secret unreadable" (a restore/key-rotation problem), never
// as an endless "Invalid code".
describe('looksLikeCiphertext', () => {
  it('recognises encrypt() output', () => {
    expect(looksLikeCiphertext(encrypt('JBSWY3DPEHPK3PXP'))).toBe(true);
  });

  it('rejects legacy raw base32 secrets', () => {
    expect(looksLikeCiphertext('JBSWY3DPEHPK3PXP')).toBe(false);
    expect(looksLikeCiphertext('')).toBe(false);
    expect(looksLikeCiphertext('a:b')).toBe(false);
    expect(looksLikeCiphertext('not base64!:x:y')).toBe(false);
  });
});
