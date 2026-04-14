import crypto from 'crypto';

// Single-use, short-lived tokens for "open PDF in new tab" flows where the
// browser can't carry an Authorization header. The web client requests one
// from /api/v1/downloads/token immediately before window.open, the new tab
// hands it back via ?_dl=, the middleware consumes it once, and the token
// is gone. TTL is short enough that a token caught in a proxy log or
// browser history has very little lifetime, and single-use means a replay
// from that log fails.
//
// Contrast with the deprecated ?_token= path, which shipped the full 15min
// JWT in the URL — a credential with full API scope and a long tail.

const TTL_MS = 60 * 1000;

interface StoredToken {
  userId: string;
  tenantId: string;
  userRole: string;
  isSuperAdmin: boolean;
  companyId: string | null;
  expiresAt: number;
}

const store = new Map<string, StoredToken>();

function sweep(): void {
  const now = Date.now();
  for (const [key, val] of store.entries()) {
    if (now > val.expiresAt) store.delete(key);
  }
}

export function issueDownloadToken(input: {
  userId: string;
  tenantId: string;
  userRole: string;
  isSuperAdmin: boolean;
  companyId: string | null;
}): { token: string; expiresIn: number } {
  sweep();
  const token = crypto.randomBytes(24).toString('base64url');
  store.set(token, { ...input, expiresAt: Date.now() + TTL_MS });
  return { token, expiresIn: Math.floor(TTL_MS / 1000) };
}

export function consumeDownloadToken(token: string): StoredToken | null {
  const entry = store.get(token);
  if (!entry) return null;
  // Always single-use: delete on any consume attempt so a replay of a
  // captured token — even one that hasn't expired — fails.
  store.delete(token);
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}
