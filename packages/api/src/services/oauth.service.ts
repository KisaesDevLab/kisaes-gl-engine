// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// OAuth 2.1 authorization server for the MCP endpoint, as the MCP
// authorization spec (2025-11-25) asks of one: discovery documents
// (RFC 9728, RFC 8414), clients that register themselves (RFC 7591),
// authorization code + PKCE S256 for public clients, the resource a token is
// for (RFC 8707), and refresh tokens that rotate.
//
// A user signs in to the app as themselves and approves the connector; the
// token then acts as that user. What it may do in each client's books is
// decided per call from the user's role there (mcp/context.ts), not here.

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { oauthClients, oauthTokens, oauthAuthorizationCodes } from '../db/schema/index.js';
import { env } from '../config/env.js';

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** An OAuth error response (RFC 6749 §5.2): `error` is the registered code. */
export class OAuthError extends Error {
  constructor(public readonly error: string, description: string, public readonly status = 400) {
    super(description);
    this.name = 'OAuthError';
  }
}

// ─── What this server is ────────────────────────────────────────

/** Scopes a connector may ask for. `all` is for API keys only and is never issued here. */
export const OAUTH_SCOPES = ['read', 'write', 'reports', 'banking', 'invoicing'] as const;

const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const CODE_SECONDS = 10 * 60;
const REQUEST_SECONDS = 15 * 60;
/** Self-registered clients that never got a token are removed after this long. */
const UNUSED_CLIENT_HOURS = 24;
const MAX_DYNAMIC_CLIENTS = 5000;

export function publicBaseUrl(): string {
  return env.PUBLIC_URL.replace(/\/+$/, '');
}

/** The resource a token is issued for: the URL a user types into their MCP client. */
export function mcpResourceUrl(): string {
  return `${publicBaseUrl()}/mcp`;
}

export function protectedResourceMetadataUrl(): string {
  return `${publicBaseUrl()}/.well-known/oauth-protected-resource`;
}

/** Two spellings of one resource URL: scheme and host compare case-insensitively, a trailing slash is ignored. */
export function sameResource(a: string, b: string): boolean {
  const norm = (raw: string): string | null => {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return null;
    }
  };
  const left = norm(a);
  return left !== null && left === norm(b);
}

export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [publicBaseUrl()],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Vibe MyBooks',
  };
}

export function authorizationServerMetadata(): Record<string, unknown> {
  const base = publicBaseUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...OAUTH_SCOPES],
  };
}

/**
 * The scopes a request gets: the known ones it asked for (space- or
 * comma-separated), or all of them when it named none we know. Clients ask
 * for things like `openid profile`, so an unknown scope is dropped, never an
 * error.
 */
export function grantableScopes(requested: string | undefined | null): string[] {
  const asked = String(requested ?? '').split(/[\s,]+/).filter(Boolean);
  const known = OAUTH_SCOPES.filter((s) => asked.includes(s));
  return known.length > 0 ? known : [...OAUTH_SCOPES];
}

// ─── Redirect URIs ──────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isLoopbackRedirect(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** The web redirect URIs a self-registering client may use (MCP_OAUTH_REDIRECT_ALLOWLIST). */
function allowedWebRedirects(): string[] {
  return env.MCP_OAUTH_REDIRECT_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * A client that registers itself is unknown to us, and whoever holds its
 * redirect URI receives the user's authorization code. So a self-registered
 * client may only redirect to the user's own machine (a loopback address:
 * mcp-remote, Claude Code) or to a web address the operator listed (Claude's
 * callback by default). Anything else needs a client an admin created.
 */
export function isAllowedDynamicRedirect(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url || url.hash) return false;
  if (isLoopbackRedirect(url)) return true;
  return url.protocol === 'https:' && allowedWebRedirects().includes(raw);
}

/**
 * Whether `candidate` is one of the client's registered redirect URIs.
 * Exact match, except that a loopback URI matches on any port (RFC 8252
 * §7.3: a native app picks a free port at run time).
 */
export function redirectUriMatches(registered: string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true;
  const url = parseUrl(candidate);
  if (!url || !isLoopbackRedirect(url)) return false;
  return registered.some((r) => {
    const reg = parseUrl(r);
    return !!reg && isLoopbackRedirect(reg) && reg.hostname === url.hostname && reg.pathname === url.pathname && reg.search === url.search;
  });
}

function redirectUrisOf(client: { redirectUris: string | null }): string[] {
  return (client.redirectUris || '').split(',').map((s) => s.trim()).filter(Boolean);
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

export interface ClientRegistrationInput {
  redirect_uris?: unknown;
  client_name?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
}

/**
 * Dynamic client registration (RFC 7591) for MCP connectors. Always a public
 * client: no secret is issued, PKCE proves the token request comes from
 * whoever started the authorization.
 */
export async function registerClient(input: ClientRegistrationInput): Promise<Record<string, unknown>> {
  const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (uris.length === 0 || uris.length > 10 || uris.length !== (input.redirect_uris as unknown[]).length) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be a list of 1 to 10 URLs');
  }
  for (const uri of uris) {
    if (uri.includes(',') || uri.length > 500 || !isAllowedDynamicRedirect(uri)) {
      throw new OAuthError(
        'invalid_redirect_uri',
        `Redirect URI not allowed: ${uri.slice(0, 200)}. A self-registered client may redirect to a loopback address or to a URL the administrator allows.`,
      );
    }
  }
  const method = input.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') {
    throw new OAuthError('invalid_client_metadata', 'Only token_endpoint_auth_method "none" (a public client using PKCE) can be registered');
  }
  const rawName = typeof input.client_name === 'string' ? input.client_name : '';
  // Shown on the consent screen: printable characters only, bounded.
  const name = rawName.replace(/[^\p{L}\p{N} .,_()'&+-]/gu, '').trim().slice(0, 100) || 'MCP client';

  // Clients register on every fresh connection. Drop the ones that never
  // finished signing in, then refuse to grow without bound.
  await db.execute(sql`
    DELETE FROM oauth_clients c
    WHERE c.is_dynamic = true
      AND c.created_at < now() - make_interval(hours => ${UNUSED_CLIENT_HOURS})
      AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM oauth_authorization_codes a WHERE a.client_id = c.id AND a.expires_at > now())`);
  const [{ n }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM oauth_clients WHERE is_dynamic = true`)).rows as [{ n: number }];
  if (n >= MAX_DYNAMIC_CLIENTS) {
    throw new OAuthError('temporarily_unavailable', 'Too many registered clients; try again later', 503);
  }

  const clientId = `kis_dyn_${crypto.randomBytes(16).toString('hex')}`;
  const [client] = await db.insert(oauthClients).values({
    clientId,
    // No secret exists for a public client. The column is NOT NULL, so it
    // holds the hash of a value nobody has.
    clientSecretHash: hash(crypto.randomBytes(32).toString('hex')),
    name,
    redirectUris: uris.join(','),
    grantTypes: 'authorization_code,refresh_token',
    scopes: OAUTH_SCOPES.join(','),
    tokenEndpointAuthMethod: 'none',
    isDynamic: true,
  }).returning();

  return {
    client_id: client!.clientId,
    client_id_issued_at: Math.floor((client!.createdAt ?? new Date()).getTime() / 1000),
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: OAUTH_SCOPES.join(' '),
  };
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

async function activeClient(clientId: unknown) {
  if (typeof clientId !== 'string' || !clientId) return null;
  const client = await db.query.oauthClients.findFirst({ where: eq(oauthClients.clientId, clientId) });
  return client && client.isActive ? client : null;
}

// ─── Authorization request ─────────────────────────────────────

/** A validated authorization request, carried through the consent screen in a signed token. */
export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  /** Returned to the client unchanged. */
  state: string | null;
  codeChallenge: string | null;
  resource: string | null;
}

export interface AuthorizationQuery {
  response_type?: unknown;
  client_id?: unknown;
  redirect_uri?: unknown;
  scope?: unknown;
  state?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
  resource?: unknown;
}

/** Thrown once the redirect URI is trusted: the error goes back to the client, not to a page. */
export class AuthorizationRedirectError extends Error {
  constructor(public readonly redirectUri: string, public readonly error: string, description: string, public readonly state: string | null) {
    super(description);
    this.name = 'AuthorizationRedirectError';
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Checks GET /oauth/authorize. An unknown client or a redirect URI that is
 * not the client's own is an OAuthError (shown as a page: the redirect
 * cannot be trusted). Anything after that is an AuthorizationRedirectError.
 */
export async function validateAuthorizationRequest(q: AuthorizationQuery): Promise<AuthorizationRequest> {
  const client = await activeClient(q.client_id);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client');
  const redirectUri = str(q.redirect_uri);
  if (!redirectUri || !redirectUriMatches(redirectUrisOf(client), redirectUri)) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uri is not registered for this client');
  }
  const state = str(q.state);
  if (state && state.length > 2000) throw new OAuthError('invalid_request', 'state is too long');
  const fail = (error: string, description: string) => new AuthorizationRedirectError(redirectUri, error, description, state);

  if (q.response_type !== undefined && q.response_type !== 'code') throw fail('unsupported_response_type', 'Only response_type=code is supported');

  const isPublic = client.tokenEndpointAuthMethod === 'none';
  const codeChallenge = str(q.code_challenge);
  if (codeChallenge) {
    if (q.code_challenge_method !== 'S256') throw fail('invalid_request', 'code_challenge_method must be S256');
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) throw fail('invalid_request', 'code_challenge is not a valid S256 challenge');
  } else if (isPublic) {
    throw fail('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256');
  }

  const resource = str(q.resource);
  if (resource && !sameResource(resource, mcpResourceUrl())) {
    throw fail('invalid_target', `This server issues tokens for ${mcpResourceUrl()} only`);
  }

  return {
    clientId: client.clientId,
    redirectUri,
    scopes: grantableScopes(str(q.scope)),
    state,
    codeChallenge,
    resource: resource ? mcpResourceUrl() : null,
  };
}

interface RequestClaims {
  typ: 'oauth_req';
  cid: string;
  ru: string;
  sc: string[];
  st: string | null;
  cc: string | null;
  rs: string | null;
}

/**
 * The request as a token the consent page hands back on approval, so
 * nothing the user approves can be altered in the browser between the two.
 * `typ` keeps it from ever being accepted as a session (middleware/auth.ts).
 */
export function signAuthorizationRequest(r: AuthorizationRequest): string {
  const claims: RequestClaims = { typ: 'oauth_req', cid: r.clientId, ru: r.redirectUri, sc: r.scopes, st: r.state, cc: r.codeChallenge, rs: r.resource };
  return jwt.sign(claims, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: REQUEST_SECONDS });
}

export function readAuthorizationRequest(token: unknown): AuthorizationRequest {
  if (typeof token !== 'string' || !token) throw new OAuthError('invalid_request', 'Missing authorization request');
  let claims: RequestClaims;
  try {
    claims = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as RequestClaims;
  } catch {
    throw new OAuthError('invalid_request', 'This sign-in request has expired. Start again from the app you are connecting.');
  }
  if (claims.typ !== 'oauth_req' || typeof claims.cid !== 'string' || typeof claims.ru !== 'string' || !Array.isArray(claims.sc)) {
    throw new OAuthError('invalid_request', 'Not an authorization request');
  }
  return { clientId: claims.cid, redirectUri: claims.ru, scopes: claims.sc, state: claims.st ?? null, codeChallenge: claims.cc ?? null, resource: claims.rs ?? null };
}

/** What the consent screen shows, read from the server's own records (never from the URL). */
export async function describeAuthorizationRequest(token: unknown) {
  const request = readAuthorizationRequest(token);
  const client = await activeClient(request.clientId);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client');
  const redirect = parseUrl(request.redirectUri);
  return {
    clientName: client.name,
    /** Registered itself; nobody at the firm has vetted it. */
    isDynamic: client.isDynamic,
    redirectUri: request.redirectUri,
    redirectHost: redirect ? redirect.host : request.redirectUri,
    redirectIsThisComputer: !!redirect && isLoopbackRedirect(redirect),
    scopes: request.scopes,
  };
}

/** Where to send the browser after a decision: the client's redirect URI with the answer. */
export function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

// ─── Authorization Code Flow ───────────────────────────────────

export interface AuthorizationCodeOptions {
  codeChallenge?: string | null;
  resource?: string | null;
}

export async function createAuthorizationCode(
  clientId: string, userId: string, redirectUri: string, scopes: string[], opts: AuthorizationCodeOptions = {},
) {
  const client = await activeClient(clientId);
  if (!client) throw new OAuthError('invalid_client', 'Invalid client');
  if (!redirectUriMatches(redirectUrisOf(client), redirectUri)) throw new OAuthError('invalid_redirect_uri', 'Invalid redirect URI');
  // A public client has nothing but PKCE to tie the token request to this approval.
  if (client.tokenEndpointAuthMethod === 'none' && !opts.codeChallenge) {
    throw new OAuthError('invalid_request', 'PKCE is required for this client');
  }

  const code = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + CODE_SECONDS * 1000);

  await db.insert(oauthAuthorizationCodes).values({
    clientId: client.id,
    userId,
    codeHash: hash(code),
    redirectUri,
    scopes: scopes.join(','),
    expiresAt,
    codeChallenge: opts.codeChallenge ?? null,
    codeChallengeMethod: opts.codeChallenge ? 'S256' : null,
    resource: opts.resource ?? null,
  });

  return code;
}

export interface TokenRequest {
  clientId: unknown;
  clientSecret?: unknown;
  code?: unknown;
  redirectUri?: unknown;
  codeVerifier?: unknown;
  refreshToken?: unknown;
  resource?: unknown;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** The client a token request comes from: a confidential client proves it with its secret. */
async function authenticateClient(req: TokenRequest) {
  const client = await activeClient(req.clientId);
  if (!client) throw new OAuthError('invalid_client', 'Invalid client', 401);
  if (client.tokenEndpointAuthMethod !== 'none') {
    const secret = typeof req.clientSecret === 'string' ? req.clientSecret : '';
    if (!secret || !timingSafeEqualHex(hash(secret), client.clientSecretHash)) {
      throw new OAuthError('invalid_client', 'Invalid client credentials', 401);
    }
  }
  return client;
}

function tokenResponse(accessToken: string, refreshToken: string, scopes: string) {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refreshToken,
    scope: scopes.split(',').filter(Boolean).join(' '),
  };
}

async function issueTokens(clientRowId: string, userId: string, scopes: string, resource: string | null) {
  const accessToken = `kis_at_${crypto.randomBytes(32).toString('hex')}`;
  const refreshToken = `kis_rt_${crypto.randomBytes(32).toString('hex')}`;
  await db.insert(oauthTokens).values({
    clientId: clientRowId,
    userId,
    accessTokenHash: hash(accessToken),
    refreshTokenHash: hash(refreshToken),
    scopes,
    accessTokenExpiresAt: new Date(Date.now() + ACCESS_TOKEN_SECONDS * 1000),
    refreshTokenExpiresAt: new Date(Date.now() + REFRESH_TOKEN_SECONDS * 1000),
    resource,
  });
  return tokenResponse(accessToken, refreshToken, scopes);
}

export async function exchangeCode(req: TokenRequest) {
  const client = await authenticateClient(req);
  const code = typeof req.code === 'string' ? req.code : '';
  const authCode = code
    ? await db.query.oauthAuthorizationCodes.findFirst({
        where: and(eq(oauthAuthorizationCodes.codeHash, hash(code)), eq(oauthAuthorizationCodes.clientId, client.id)),
      })
    : undefined;
  if (!authCode) throw new OAuthError('invalid_grant', 'Invalid authorization code');
  if (authCode.used) throw new OAuthError('invalid_grant', 'Authorization code already used');
  if (new Date() > authCode.expiresAt) throw new OAuthError('invalid_grant', 'Authorization code expired');
  if (authCode.redirectUri !== req.redirectUri) throw new OAuthError('invalid_grant', 'Redirect URI mismatch');

  if (authCode.codeChallenge) {
    const verifier = typeof req.codeVerifier === 'string' ? req.codeVerifier : '';
    const answer = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || answer !== authCode.codeChallenge) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed');
    }
  } else if (client.tokenEndpointAuthMethod === 'none') {
    throw new OAuthError('invalid_grant', 'PKCE is required for this client');
  }

  const resource = typeof req.resource === 'string' && req.resource ? req.resource : null;
  if (resource && !sameResource(resource, authCode.resource ?? mcpResourceUrl())) {
    throw new OAuthError('invalid_target', 'resource does not match the authorization request');
  }

  // Spend the code exactly once: two exchanges racing on the same code must
  // not both get tokens.
  const spent = await db.update(oauthAuthorizationCodes).set({ used: true })
    .where(and(eq(oauthAuthorizationCodes.id, authCode.id), eq(oauthAuthorizationCodes.used, false)))
    .returning({ id: oauthAuthorizationCodes.id });
  if (spent.length === 0) throw new OAuthError('invalid_grant', 'Authorization code already used');

  return issueTokens(client.id, authCode.userId, authCode.scopes, authCode.resource ?? (resource ? mcpResourceUrl() : null));
}

export async function refreshAccessToken(req: TokenRequest) {
  const client = await authenticateClient(req);
  const refreshToken = typeof req.refreshToken === 'string' ? req.refreshToken : '';
  const token = refreshToken
    ? await db.query.oauthTokens.findFirst({
        where: and(eq(oauthTokens.refreshTokenHash, hash(refreshToken)), eq(oauthTokens.clientId, client.id)),
      })
    : undefined;
  if (!token || token.revokedAt) throw new OAuthError('invalid_grant', 'Invalid refresh token');
  if (token.refreshTokenExpiresAt && new Date() > token.refreshTokenExpiresAt) throw new OAuthError('invalid_grant', 'Refresh token expired');
  const resource = typeof req.resource === 'string' && req.resource ? req.resource : null;
  if (resource && token.resource && !sameResource(resource, token.resource)) {
    throw new OAuthError('invalid_target', 'resource does not match the original grant');
  }

  // Rotate: the old pair stops working as the new one is issued. Only one
  // of two requests racing on the same refresh token wins.
  const revoked = await db.update(oauthTokens).set({ revokedAt: new Date() })
    .where(and(eq(oauthTokens.id, token.id), sql`${oauthTokens.revokedAt} IS NULL`))
    .returning({ id: oauthTokens.id });
  if (revoked.length === 0) throw new OAuthError('invalid_grant', 'Invalid refresh token');

  return issueTokens(client.id, token.userId, token.scopes, token.resource);
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
  }).from(oauthTokens).where(and(eq(oauthTokens.userId, userId), sql`${oauthTokens.revokedAt} IS NULL`));

  // Group by client, get client names
  const byClient = new Map<string, { clientId: string; name: string | undefined; scopes: string; authorizedAt: Date | null }>();
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
