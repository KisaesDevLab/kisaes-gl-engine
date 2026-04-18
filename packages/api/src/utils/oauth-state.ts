// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import crypto from 'crypto';
import { env } from '../config/env.js';

// Signed, short-TTL state tokens for OAuth authorization flows.
//
// Without a state parameter, an attacker could trick a logged-in admin into
// visiting `.../remote-callback/google_drive?code=<attacker_code>`, binding
// the attacker's Drive account to the tenant's backup config so the attacker
// receives every backup. A signed state tied to the admin's userId and the
// provider defeats this: the callback only proceeds when the state the
// server issued matches the state that came back from the provider.

const STATE_TTL_SEC = 600; // 10 minutes — covers a reasonable OAuth round-trip

interface StatePayload {
  userId: string;
  provider: string;
  iat: number;
}

function sign(value: string): string {
  return crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(value)
    .digest('base64url');
}

export function issueOAuthState(userId: string, provider: string): string {
  const payload: StatePayload = { userId, provider, iat: Math.floor(Date.now() / 1000) };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(body);
  return `${body}.${sig}`;
}

export function verifyOAuthState(
  state: string | undefined,
  expectedUserId: string,
  expectedProvider: string,
): boolean {
  if (!state || typeof state !== 'string') return false;
  const dot = state.indexOf('.');
  if (dot <= 0) return false;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expectedSig = sign(body);
  // Constant-time compare to avoid signature-timing side channels.
  if (sig.length !== expectedSig.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return false;
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!payload.iat || now - payload.iat > STATE_TTL_SEC) return false;
  if (payload.userId !== expectedUserId) return false;
  if (payload.provider !== expectedProvider) return false;
  return true;
}
