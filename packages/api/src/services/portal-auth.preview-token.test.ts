// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, vi, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { verifyPreviewToken } from './portal-auth.service.js';

// Regression: verifyPreviewToken was the lone jwt.verify site that did not
// pin the algorithm. A preview token grants staff impersonation of a client
// portal, so it must fail closed against algorithm-confusion — verify must be
// called with { algorithms: ['HS256'] } like every other verify site.

describe('verifyPreviewToken — pins HS256 (fail closed)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes algorithms:[HS256] to jwt.verify', () => {
    const spy = vi.spyOn(jwt, 'verify').mockReturnValue({ contactId: 'c1' } as never);
    verifyPreviewToken('tok');
    expect(spy).toHaveBeenCalledWith('tok', expect.any(String), { algorithms: ['HS256'] });
  });

  it('maps a verification failure to a 401 PREVIEW_TOKEN_INVALID', () => {
    vi.spyOn(jwt, 'verify').mockImplementation(() => {
      throw new Error('invalid signature');
    });
    expect(() => verifyPreviewToken('tok')).toThrow(/invalid or expired/i);
  });
});
