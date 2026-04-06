import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { oauthClients, oauthTokens, oauthAuthorizationCodes } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// ─── Client Management ─────────────────────────────────────────

export async function createClient(input: { name: string; redirectUris: string[]; scopes?: string[] }, createdBy: string) {
  const clientId = `kis_oauth_${crypto.randomBytes(16).toString('hex')}`;
  const clientSecret = `kis_secret_${crypto.randomBytes(32).toString('hex')}`;

  const [client] = await db.insert(oauthClients).values({
    clientId,
    clientSecretHash: hash(clientSecret),
    name: input.name,
    redirectUris: input.redirectUris.join(','),
    scopes: (input.scopes || ['all']).join(','),
    createdBy,
  }).returning();

  return { ...client!, clientSecret }; // Secret shown once
}

export async function listClients() {
  return db.select({
    id: oauthClients.id, clientId: oauthClients.clientId, name: oauthClients.name,
    redirectUris: oauthClients.redirectUris, scopes: oauthClients.scopes,
    isActive: oauthClients.isActive, createdAt: oauthClients.createdAt,
  }).from(oauthClients);
}

export async function revokeClient(clientId: string) {
  await db.update(oauthClients).set({ isActive: false }).where(eq(oauthClients.id, clientId));
  // Revoke all tokens for this client
  await db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.clientId, clientId));
}

// ─── Authorization Code Flow ───────────────────────────────────

export async function createAuthorizationCode(clientId: string, userId: string, redirectUri: string, scopes: string[]) {
  const client = await db.query.oauthClients.findFirst({ where: eq(oauthClients.clientId, clientId) });
  if (!client || !client.isActive) throw AppError.badRequest('Invalid client');

  const allowedUris = (client.redirectUris || '').split(',');
  if (!allowedUris.includes(redirectUri)) throw AppError.badRequest('Invalid redirect URI');

  const code = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await db.insert(oauthAuthorizationCodes).values({
    clientId: client.id,
    userId,
    codeHash: hash(code),
    redirectUri,
    scopes: scopes.join(','),
    expiresAt,
  });

  return code;
}

export async function exchangeCode(clientId: string, clientSecret: string, code: string, redirectUri: string) {
  const client = await db.query.oauthClients.findFirst({ where: eq(oauthClients.clientId, clientId) });
  if (!client || !client.isActive) throw AppError.unauthorized('Invalid client');
  if (hash(clientSecret) !== client.clientSecretHash) throw AppError.unauthorized('Invalid client credentials');

  const authCode = await db.query.oauthAuthorizationCodes.findFirst({
    where: and(eq(oauthAuthorizationCodes.codeHash, hash(code)), eq(oauthAuthorizationCodes.clientId, client.id)),
  });
  if (!authCode) throw AppError.badRequest('Invalid authorization code');
  if (authCode.used) throw AppError.badRequest('Authorization code already used');
  if (new Date() > authCode.expiresAt) throw AppError.badRequest('Authorization code expired');
  if (authCode.redirectUri !== redirectUri) throw AppError.badRequest('Redirect URI mismatch');

  // Mark code as used
  await db.update(oauthAuthorizationCodes).set({ used: true }).where(eq(oauthAuthorizationCodes.id, authCode.id));

  // Generate tokens
  const accessToken = `kis_at_${crypto.randomBytes(32).toString('hex')}`;
  const refreshToken = `kis_rt_${crypto.randomBytes(32).toString('hex')}`;
  const accessExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await db.insert(oauthTokens).values({
    clientId: client.id,
    userId: authCode.userId,
    accessTokenHash: hash(accessToken),
    refreshTokenHash: hash(refreshToken),
    scopes: authCode.scopes,
    accessTokenExpiresAt: accessExpiresAt,
    refreshTokenExpiresAt: refreshExpiresAt,
  });

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: authCode.scopes,
  };
}

export async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string) {
  const client = await db.query.oauthClients.findFirst({ where: eq(oauthClients.clientId, clientId) });
  if (!client || !client.isActive) throw AppError.unauthorized('Invalid client');
  if (hash(clientSecret) !== client.clientSecretHash) throw AppError.unauthorized('Invalid client credentials');

  const token = await db.query.oauthTokens.findFirst({
    where: and(eq(oauthTokens.refreshTokenHash, hash(refreshToken)), eq(oauthTokens.clientId, client.id)),
  });
  if (!token || token.revokedAt) throw AppError.unauthorized('Invalid refresh token');
  if (token.refreshTokenExpiresAt && new Date() > token.refreshTokenExpiresAt) throw AppError.unauthorized('Refresh token expired');

  // Revoke old token
  await db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.id, token.id));

  // Issue new tokens
  const newAccessToken = `kis_at_${crypto.randomBytes(32).toString('hex')}`;
  const newRefreshToken = `kis_rt_${crypto.randomBytes(32).toString('hex')}`;

  await db.insert(oauthTokens).values({
    clientId: client.id,
    userId: token.userId,
    accessTokenHash: hash(newAccessToken),
    refreshTokenHash: hash(newRefreshToken),
    scopes: token.scopes,
    accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  });

  return {
    access_token: newAccessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: newRefreshToken,
    scope: token.scopes,
  };
}

export async function revokeToken(token: string) {
  const h = hash(token);
  // Try access token
  await db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.accessTokenHash, h));
  // Try refresh token
  await db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.refreshTokenHash, h));
}

export async function getUserAuthorizedApps(userId: string) {
  const tokens = await db.select({
    clientId: oauthTokens.clientId,
    scopes: oauthTokens.scopes,
    createdAt: oauthTokens.createdAt,
  }).from(oauthTokens).where(and(eq(oauthTokens.userId, userId)));

  // Group by client, get client names
  const byClient = new Map<string, any>();
  for (const t of tokens) {
    if (!byClient.has(t.clientId)) {
      const client = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, t.clientId) });
      byClient.set(t.clientId, { clientId: t.clientId, name: client?.name, scopes: t.scopes, authorizedAt: t.createdAt });
    }
  }
  return Array.from(byClient.values());
}

export async function revokeUserApp(userId: string, clientId: string) {
  await db.update(oauthTokens).set({ revokedAt: new Date() })
    .where(and(eq(oauthTokens.userId, userId), eq(oauthTokens.clientId, clientId)));
}
