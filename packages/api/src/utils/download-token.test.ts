// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { issueDownloadToken, consumeDownloadToken } from './download-token.js';

const claims = {
  userId: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  userRole: 'owner',
  isSuperAdmin: false,
  companyId: '33333333-3333-3333-3333-333333333333',
};

describe('download-token (stateless)', () => {
  it('round-trips issued claims without any shared store', () => {
    const { token, expiresIn } = issueDownloadToken(claims);
    expect(expiresIn).toBe(60);
    // A fresh verify (as a second process would do) recovers the claims —
    // no in-memory Map involved, which is the whole point of the fix.
    expect(consumeDownloadToken(token)).toEqual(claims);
  });

  it('rejects garbage and tampered tokens', () => {
    expect(consumeDownloadToken('not-a-token')).toBeNull();
    const { token } = issueDownloadToken(claims);
    expect(consumeDownloadToken(token + 'x')).toBeNull();
  });

  it('rejects a valid JWT that is not a download token (e.g. a session token)', () => {
    const sessionish = jwt.sign(
      { userId: claims.userId, tenantId: claims.tenantId, role: 'owner' },
      env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: 60 },
    );
    expect(consumeDownloadToken(sessionish)).toBeNull();
  });

  it('rejects an expired download token', () => {
    const expired = jwt.sign({ ...claims, typ: 'dl' }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: -5 });
    expect(consumeDownloadToken(expired)).toBeNull();
  });
});
