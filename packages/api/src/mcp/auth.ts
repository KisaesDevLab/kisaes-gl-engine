// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiKeys, oauthClients, oauthTokens, users } from '../db/schema/index.js';
import type { McpAuthContext } from '@kis-books/shared';
import { sameResource } from '../services/oauth.service.js';

/** The bearer token was missing, unknown, expired or may not be used: HTTP 401 (403 for `forbidden`). */
export class McpAuthError extends Error {
  constructor(public readonly code: string, message: string, public readonly forbidden = false) {
    super(`${code}: ${message}`);
    this.name = 'McpAuthError';
  }
}

export interface McpAuthOptions {
  /** Admin > MCP / API > OAuth sign-in. Off: only API keys authenticate. */
  oauthEnabled: boolean;
  /** This install's MCP URL; an OAuth token issued for another resource is refused (RFC 8707). */
  resource: string;
}

/**
 * The user behind every credential must still be usable, as on every other
 * way in (middleware/principal-check.ts): active, and not waiting to choose
 * a new password after a temporary one.
 */
function assertUserUsable(user: typeof users.$inferSelect | undefined): asserts user is typeof users.$inferSelect {
  if (!user || !user.isActive) throw new McpAuthError('AUTH_REQUIRED', 'User account is inactive');
  if (user.passwordChangeRequired) {
    throw new McpAuthError('PASSWORD_CHANGE_REQUIRED', 'Choose a new password in the app to continue', true);
  }
}

export async function resolveMcpAuth(token: string, opts: McpAuthOptions): Promise<McpAuthContext> {
  if (!token) throw new McpAuthError('AUTH_REQUIRED', 'No bearer token provided');

  const hash = crypto.createHash('sha256').update(token).digest('hex');

  // OAuth access tokens are minted with a `kis_at_` prefix (see
  // oauth.service.ts). API keys generated via the web UI use an
  // `sk_live_` prefix (see api-keys.routes.ts). We route by prefix so the
  // right table is queried; anything else is rejected up front.
  const isOauth = token.startsWith('kis_at_');
  const isApiKey = token.startsWith('sk_live_') || token.startsWith('sk_test_');

  if (isApiKey) {
    const key = await db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.keyHash, hash), eq(apiKeys.isActive, true)),
    });
    if (!key) throw new McpAuthError('AUTH_REQUIRED', 'Invalid API key');
    if (key.revokedAt) throw new McpAuthError('AUTH_REQUIRED', 'API key has been revoked');
    if (key.expiresAt && new Date(key.expiresAt) < new Date()) throw new McpAuthError('AUTH_EXPIRED', 'API key has expired');

    const user = await db.query.users.findFirst({ where: eq(users.id, key.userId) });
    assertUserUsable(user);

    // Update usage stats
    await db.update(apiKeys).set({
      lastUsedAt: new Date(),
      totalRequests: (key.totalRequests || 0) + 1,
    }).where(eq(apiKeys.id, key.id));

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

  if (isOauth) {
    if (!opts.oauthEnabled) throw new McpAuthError('AUTH_REQUIRED', 'OAuth sign-in is turned off on this server');
    const oauthToken = await db.query.oauthTokens.findFirst({
      where: and(eq(oauthTokens.accessTokenHash, hash)),
    });
    if (!oauthToken) throw new McpAuthError('AUTH_REQUIRED', 'Invalid token');
    if (oauthToken.revokedAt) throw new McpAuthError('AUTH_REQUIRED', 'Token has been revoked');
    if (new Date(oauthToken.accessTokenExpiresAt) < new Date()) throw new McpAuthError('AUTH_EXPIRED', 'Token has expired');
    // A token issued for another resource is not ours to accept. Tokens
    // from before resources were recorded carry none and stay valid.
    if (oauthToken.resource && !sameResource(oauthToken.resource, opts.resource)) {
      throw new McpAuthError('AUTH_REQUIRED', 'Token was not issued for this server');
    }
    const client = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, oauthToken.clientId) });
    if (!client || !client.isActive) throw new McpAuthError('AUTH_REQUIRED', 'The app this token belongs to is no longer allowed');

    const user = await db.query.users.findFirst({ where: eq(users.id, oauthToken.userId) });
    assertUserUsable(user);

    return {
      userId: user.id,
      tenantId: user.tenantId,
      source: 'oauth',
      scopes: (oauthToken.scopes || 'all').split(',').filter(Boolean),
      allowedCompanies: null,
      oauthClientId: client.id,
    };
  }

  throw new McpAuthError('AUTH_REQUIRED', 'Unrecognized token format');
}

export function checkScope(auth: McpAuthContext, requiredScope: string): void {
  if (auth.scopes.includes('all')) return;
  if (!auth.scopes.includes(requiredScope)) {
    throw new Error(`SCOPE_DENIED: This action requires the '${requiredScope}' scope`);
  }
}
