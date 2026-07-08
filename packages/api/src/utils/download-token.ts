// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// Short-lived, signed tokens for "open PDF in new tab" flows where the browser
// can't carry an Authorization header. The web client requests one from
// /api/v1/downloads/token immediately before window.open, and the new tab hands
// it back via ?_dl=.
//
// Previously these were single-use tokens held in an in-memory Map. That broke
// whenever the token was minted and consumed by DIFFERENT processes — an API
// restart between issue and consume, or more than one API replica behind the
// proxy — which surfaced as "Invalid or expired download token" on every PDF
// export. A signed token is stateless: any process with the JWT secret can
// verify it, so no shared store is needed.
//
// Trade-off vs. the old design: a signed token is replayable within its short
// TTL (it isn't single-use). The 60s window plus its narrow, read-only export
// scope keeps that risk small — and far smaller than exports being broken.

const TTL_SECONDS = 60;
const DOWNLOAD_TOKEN_TYPE = 'dl';

export interface DownloadTokenClaims {
  userId: string;
  tenantId: string;
  userRole: string;
  isSuperAdmin: boolean;
  companyId: string | null;
}

export function issueDownloadToken(input: DownloadTokenClaims): { token: string; expiresIn: number } {
  const token = jwt.sign(
    { ...input, typ: DOWNLOAD_TOKEN_TYPE },
    env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: TTL_SECONDS },
  );
  return { token, expiresIn: TTL_SECONDS };
}

export function consumeDownloadToken(token: string): DownloadTokenClaims | null {
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
  if (typeof decoded === 'string') return null;
  const d = decoded as jwt.JwtPayload & Partial<DownloadTokenClaims> & { typ?: string };
  // Reject anything that isn't a download token (e.g. a session JWT) so this
  // path can't be used to mint export access from an unrelated token.
  if (d.typ !== DOWNLOAD_TOKEN_TYPE || !d.userId || !d.tenantId) return null;
  return {
    userId: d.userId,
    tenantId: d.tenantId,
    userRole: d.userRole ?? 'owner',
    isSuperAdmin: !!d.isSuperAdmin,
    companyId: d.companyId ?? null,
  };
}
