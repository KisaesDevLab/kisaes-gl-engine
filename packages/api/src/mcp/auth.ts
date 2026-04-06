import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiKeys, oauthTokens, users } from '../db/schema/index.js';
import type { McpAuthContext } from '@kis-books/shared';

export async function resolveMcpAuth(token: string): Promise<McpAuthContext> {
  if (!token) throw new Error('AUTH_REQUIRED: No bearer token provided');

  const hash = crypto.createHash('sha256').update(token).digest('hex');

  // Try API key first (starts with "kis_")
  if (token.startsWith('kis_')) {
    const key = await db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.keyHash, hash), eq(apiKeys.isActive, true)),
    });
    if (!key) throw new Error('AUTH_REQUIRED: Invalid API key');
    if (key.revokedAt) throw new Error('AUTH_REQUIRED: API key has been revoked');
    if (key.expiresAt && new Date(key.expiresAt) < new Date()) throw new Error('AUTH_EXPIRED: API key has expired');

    // Update usage stats
    await db.update(apiKeys).set({
      lastUsedAt: new Date(),
      totalRequests: (key.totalRequests || 0) + 1,
    }).where(eq(apiKeys.id, key.id));

    const user = await db.query.users.findFirst({ where: eq(users.id, key.userId) });
    if (!user || !user.isActive) throw new Error('AUTH_REQUIRED: User account is inactive');

    const scopes = (key.scopes || 'all').split(',').filter(Boolean);
    const allowedCompanies = key.allowedCompanies ? key.allowedCompanies.split(',').filter(Boolean) : null;

    return {
      userId: user.id,
      tenantId: user.tenantId,
      source: 'api_key',
      keyId: key.id,
      scopes,
      allowedCompanies,
    };
  }

  // Try OAuth token
  const oauthToken = await db.query.oauthTokens.findFirst({
    where: and(eq(oauthTokens.accessTokenHash, hash)),
  });
  if (!oauthToken) throw new Error('AUTH_REQUIRED: Invalid token');
  if (oauthToken.revokedAt) throw new Error('AUTH_REQUIRED: Token has been revoked');
  if (new Date(oauthToken.accessTokenExpiresAt) < new Date()) throw new Error('AUTH_EXPIRED: Token has expired');

  const user = await db.query.users.findFirst({ where: eq(users.id, oauthToken.userId) });
  if (!user || !user.isActive) throw new Error('AUTH_REQUIRED: User account is inactive');

  return {
    userId: user.id,
    tenantId: user.tenantId,
    source: 'oauth',
    scopes: (oauthToken.scopes || 'all').split(',').filter(Boolean),
    allowedCompanies: null,
  };
}

export function checkScope(auth: McpAuthContext, requiredScope: string): void {
  if (auth.scopes.includes('all')) return;
  if (!auth.scopes.includes(requiredScope)) {
    throw new Error(`SCOPE_DENIED: This action requires the '${requiredScope}' scope`);
  }
}
