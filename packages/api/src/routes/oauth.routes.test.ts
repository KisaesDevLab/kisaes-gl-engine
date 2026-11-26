// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// The connector sign-in, end to end over HTTP, as an MCP client walks it:
// 401 from /mcp -> discovery -> registration -> authorize (PKCE) -> consent
// -> token -> /mcp with the token -> refresh.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import crypto from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { apiKeys, companies, mcpConfig, oauthClients, oauthTokens, users } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import { handleMcpMethodNotAllowed, handleMcpRequest } from '../mcp/server.js';
import { oauthRouter, oauthWellKnownRouter } from './oauth.routes.js';

let server: Server;
let base = '';
let sessionToken = '';
let companyId = '';
const PUBLIC = env.PUBLIC_URL.replace(/\/+$/, '');
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transactions, contacts, api_keys, mcp_request_log, sessions, user_tenant_access, mcp_config,
    oauth_tokens, oauth_authorization_codes, oauth_clients,
    accounts, companies, users, tenants
    CASCADE`);
}

interface Reply { status: number; json: any; headers: Headers }

async function http(method: string, path: string, opts: { json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }
  const res = await fetch(`${base}${path}`, { method, headers, body, redirect: 'manual' });
  const raw = await res.text();
  let json: any = raw;
  try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

const mcp = (token: string | null, body: unknown, headers: Record<string, string> = {}) =>
  http('POST', '/mcp', { json: body, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

async function register(redirectUris: string[], extra: Record<string, unknown> = {}) {
  return http('POST', '/oauth/register', { json: { client_name: 'Claude', redirect_uris: redirectUris, token_endpoint_auth_method: 'none', ...extra } });
}

/** GET /oauth/authorize as the browser, then approve as the signed-in user. Returns the callback URL. */
async function signIn(clientId: string, redirectUri: string, challenge: string, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: 'st&te/=1',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'read write openid', resource: `${PUBLIC}/mcp`, ...extra,
  });
  const start = await http('GET', `/oauth/authorize?${query}`);
  expect(start.status).toBe(302);
  const consent = new URL(start.headers.get('location')!);
  expect(`${consent.origin}${consent.pathname}`).toBe(`${PUBLIC}/oauth/consent`);
  const request = consent.searchParams.get('request')!;
  const approved = await http('POST', '/oauth/authorize', { json: { request }, headers: { Authorization: `Bearer ${sessionToken}` } });
  expect(approved.status).toBe(200);
  return { request, callback: new URL(approved.json.redirect_to) };
}

beforeAll(async () => {
  await cleanDb();
  const app = express();
  app.use(express.json());
  app.use('/oauth', oauthRouter);
  app.use('/.well-known', oauthWellKnownRouter);
  app.post('/mcp', handleMcpRequest);
  app.use('/mcp', handleMcpMethodNotAllowed);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const result = await authService.register({
    email: `oauth-${Date.now()}@example.com`, password: 'password123456', displayName: 'OAuth Owner', companyName: 'OAuth Co',
  });
  sessionToken = result.tokens.accessToken;
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, result.user.tenantId) });
  companyId = company!.id;
  await db.update(companies).set({ mcpEnabled: true }).where(eq(companies.id, companyId));
  await db.insert(mcpConfig).values({ isEnabled: true, oauthEnabled: false });
}, 60000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanDb();
  await pool.end();
});

describe('OAuth sign-in is off until an administrator turns it on', () => {
  it('no discovery, no registration, and /mcp does not point clients at a sign-in', async () => {
    expect((await http('GET', '/.well-known/oauth-protected-resource')).status).toBe(404);
    expect((await http('GET', '/.well-known/oauth-authorization-server')).status).toBe(404);
    expect((await register([CLAUDE_CALLBACK])).status).toBe(404);
    const unauth = await mcp(null, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toBe('Bearer');
  });
});

describe('Connecting an MCP client with OAuth', () => {
  beforeAll(async () => {
    await db.update(mcpConfig).set({ oauthEnabled: true });
  });

  it('an unauthenticated request gets a 401 that points at the resource metadata', async () => {
    const unauth = await mcp(null, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`);
    // A bad token is a 401 too, never a 200 with an error body.
    expect((await mcp('kis_at_nope', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
  });

  it('publishes the discovery documents a client needs', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const prm = await http('GET', path);
      expect(prm.status).toBe(200);
      expect(prm.json).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC] });
    }
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const as = await http('GET', path);
      expect(as.json).toMatchObject({
        issuer: PUBLIC,
        authorization_endpoint: `${PUBLIC}/oauth/authorize`,
        token_endpoint: `${PUBLIC}/oauth/token`,
        registration_endpoint: `${PUBLIC}/oauth/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      });
      expect(as.json.token_endpoint_auth_methods_supported).toContain('none');
    }
  });

  it('registers a public client, but only for redirects that are safe to trust unseen', async () => {
    const ok = await register([CLAUDE_CALLBACK]);
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ token_endpoint_auth_method: 'none', redirect_uris: [CLAUDE_CALLBACK] });
    expect(ok.json.client_secret).toBeUndefined();
    expect((await register(['http://localhost:3334/oauth/callback'])).status).toBe(201);

    for (const bad of [['https://evil.example/callback'], ['http://evil.example/callback'], ['https://claude.ai/api/mcp/auth_callback#frag'], []]) {
      const refused = await register(bad);
      expect(refused.status, JSON.stringify(bad)).toBe(400);
      expect(refused.json.error).toBe('invalid_redirect_uri');
    }
    // A client that asks for a secret is not what this endpoint issues.
    expect((await register([CLAUDE_CALLBACK], { token_endpoint_auth_method: 'client_secret_post' })).json.error).toBe('invalid_client_metadata');
    // A name is shown on the consent screen: markup never survives.
    const named = await register([CLAUDE_CALLBACK], { client_name: '<img src=x onerror=alert(1)>Claude' });
    expect(named.json.client_name).toBe('img srcx onerroralert(1)Claude');
  });

  it('refuses an authorization request it cannot trust, without redirecting anywhere', async () => {
    const { json: client } = await register([CLAUDE_CALLBACK]);
    const { challenge } = pkce();
    const q = (over: Record<string, string>) => new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', ...over,
    });
    const unknown = await http('GET', `/oauth/authorize?${q({ client_id: 'nope' })}`);
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toBe('invalid_client');
    expect(unknown.headers.get('location')).toBeNull();
    const elsewhere = await http('GET', `/oauth/authorize?${q({ redirect_uri: 'https://evil.example/cb' })}`);
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.headers.get('location')).toBeNull();

    // Once the redirect is the client's own, problems go back to the client.
    const noPkce = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, state: 'abc' });
    const back = await http('GET', `/oauth/authorize?${noPkce}`);
    expect(back.status).toBe(302);
    const location = new URL(back.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(CLAUDE_CALLBACK);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('abc');

    const wrongResource = await http('GET', `/oauth/authorize?${q({ resource: 'https://other.example/mcp' })}`);
    expect(new URL(wrongResource.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });

  it('signs a user in with PKCE and the token works on /mcp as that user', async () => {
    const { json: client } = await register([CLAUDE_CALLBACK]);
    const { verifier, challenge } = pkce();
    const { request, callback } = await signIn(client.client_id, CLAUDE_CALLBACK, challenge);

    // What the consent page shows comes from the server, from the signed request.
    const details = await http('GET', `/oauth/authorize/details?request=${encodeURIComponent(request)}`);
    expect(details.json).toMatchObject({
      clientName: 'Claude', isDynamic: true, redirectHost: 'claude.ai', redirectIsThisComputer: false, scopes: ['read', 'write'],
    });
    // Approving needs a signed-in user.
    expect((await http('POST', '/oauth/authorize', { json: { request } })).status).toBe(401);

    expect(callback.origin + callback.pathname).toBe(CLAUDE_CALLBACK);
    expect(callback.searchParams.get('state')).toBe('st&te/=1');
    const code = callback.searchParams.get('code')!;

    const tokenForm = { grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: CLAUDE_CALLBACK, resource: `${PUBLIC}/mcp` };
    const wrong = await http('POST', '/oauth/token', { form: { ...tokenForm, code_verifier: pkce().verifier } });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe('invalid_grant');

    const tokens = await http('POST', '/oauth/token', { form: { ...tokenForm, code_verifier: verifier } });
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get('cache-control')).toBe('no-store');
    expect(tokens.json).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read write' });
    expect(tokens.json.access_token).toMatch(/^kis_at_/);

    // The code is spent.
    expect((await http('POST', '/oauth/token', { form: { ...tokenForm, code_verifier: verifier } })).json.error).toBe('invalid_grant');

    const access = tokens.json.access_token as string;
    const init = await mcp(access, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    expect(init.status).toBe(200);
    expect(init.json.result.protocolVersion).toBe('2025-11-25');
    expect(init.headers.get('mcp-session-id')).toBeTruthy();

    // Notifications are acknowledged, not answered.
    const note = await mcp(access, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note.status).toBe(202);
    expect(note.json).toBeNull();
    expect((await mcp(access, { jsonrpc: '2.0', id: 2, method: 'ping' })).json.result).toEqual({});

    const listed = await mcp(access, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_companies', arguments: {} } });
    expect(JSON.parse(listed.json.result.content[0].text).map((c: any) => c.id)).toEqual([companyId]);

    // Granted read + write: a write works, a report (not granted) does not.
    const made = await mcp(access, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_contact', arguments: { display_name: 'Via OAuth', type: 'vendor' } } });
    expect(made.json.result.isError).toBeUndefined();
    const report = await mcp(access, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_trial_balance', arguments: { start_date: '2026-01-01', end_date: '2026-12-31' } } });
    expect(report.json.result.isError).toBe(true);
    expect(report.json.result.content[0].text).toMatch(/^SCOPE_DENIED/);

    // Refresh rotates: the old pair stops, the new one works.
    const refreshed = await http('POST', '/oauth/token', { form: { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.json.refresh_token } });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.refresh_token).not.toBe(tokens.json.refresh_token);
    expect((await mcp(access, { jsonrpc: '2.0', id: 6, method: 'ping' })).status).toBe(401);
    expect((await mcp(refreshed.json.access_token, { jsonrpc: '2.0', id: 7, method: 'ping' })).status).toBe(200);
    const replay = await http('POST', '/oauth/token', { form: { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.json.refresh_token } });
    expect(replay.json.error).toBe('invalid_grant');

    // Turning OAuth sign-in off cuts connector tokens off.
    await db.update(mcpConfig).set({ oauthEnabled: false });
    expect((await mcp(refreshed.json.access_token, { jsonrpc: '2.0', id: 8, method: 'ping' })).status).toBe(401);
    await db.update(mcpConfig).set({ oauthEnabled: true });
  });

  it('a loopback client (mcp-remote, Claude Code) may come back on any port', async () => {
    const { json: client } = await register(['http://localhost/callback']);
    const { verifier, challenge } = pkce();
    const redirect = 'http://localhost:53124/callback';
    const { callback } = await signIn(client.client_id, redirect, challenge);
    expect(callback.host).toBe('localhost:53124');
    const tokens = await http('POST', '/oauth/token', {
      form: { grant_type: 'authorization_code', client_id: client.client_id, code: callback.searchParams.get('code')!, redirect_uri: redirect, code_verifier: verifier },
    });
    expect(tokens.status).toBe(200);
    // A different path is a different redirect.
    const other = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://localhost:53124/elsewhere', code_challenge: challenge, code_challenge_method: 'S256' });
    expect((await http('GET', `/oauth/authorize?${other}`)).status).toBe(400);
  });

  it('declining sends the client an access_denied and issues nothing', async () => {
    const { json: client } = await register([CLAUDE_CALLBACK]);
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    const start = await http('GET', `/oauth/authorize?${query}`);
    const request = new URL(start.headers.get('location')!).searchParams.get('request')!;
    const declined = await http('POST', '/oauth/authorize', { json: { request, approve: false }, headers: { Authorization: `Bearer ${sessionToken}` } });
    const back = new URL(declined.json.redirect_to);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
    // A tampered request is not a request.
    const forged = await http('POST', '/oauth/authorize', { json: { request: `${request.slice(0, -4)}AAAA` }, headers: { Authorization: `Bearer ${sessionToken}` } });
    expect(forged.status).toBe(400);
    // And the signed request is not a session.
    expect((await http('GET', '/oauth/apps', { headers: { Authorization: `Bearer ${request}` } })).status).toBe(401);
  });

  it('clients that registered and never signed in are swept', async () => {
    const { json: stale } = await register([CLAUDE_CALLBACK]);
    await db.update(oauthClients).set({ createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) }).where(eq(oauthClients.clientId, stale.client_id));
    const used = await db.query.oauthTokens.findFirst();
    const usedClient = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, used!.clientId) });
    await db.update(oauthClients).set({ createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) }).where(eq(oauthClients.id, usedClient!.id));
    await register([CLAUDE_CALLBACK]);
    expect(await db.query.oauthClients.findFirst({ where: eq(oauthClients.clientId, stale.client_id) })).toBeUndefined();
    expect(await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, usedClient!.id) })).toBeDefined();
    expect((await db.select().from(oauthTokens)).length).toBeGreaterThan(0);
  });
});

describe('The /mcp transport', () => {
  // The reference client from the MCP SDK: it validates every reply against
  // the protocol's own schemas, so this fails on a malformed tool list,
  // a wrong answer to a notification or a bad initialize result.
  it('works with the MCP SDK client over Streamable HTTP', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const key = 'sk_live_' + crypto.randomBytes(32).toString('hex');
    const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
    const owner = await db.query.users.findFirst({ where: eq(users.tenantId, company!.tenantId) });
    await db.insert(apiKeys).values({
      tenantId: company!.tenantId, userId: owner!.id, name: 'sdk', keyPrefix: key.slice(0, 12),
      keyHash: crypto.createHash('sha256').update(key).digest('hex'), role: 'owner', scopes: 'all',
    });
    const client = new Client({ name: 'engine-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe('kis-books');
      expect(client.getInstructions()).toContain('list_companies');
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(89);
      expect(tools.find((t) => t.name === 'complete_reconciliation')?.annotations?.readOnlyHint).toBe(false);
      const listed = await client.callTool({ name: 'list_accounts', arguments: {} });
      expect(listed.isError).toBeFalsy();
      const content = listed.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0]!.text).data.length).toBeGreaterThan(0);
      expect(content[1]!.text).toContain('OAuth Co');
      const bad = await client.callTool({ name: 'get_account_balance', arguments: { account_id: 'nope' } });
      expect(bad.isError).toBe(true);
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.length).toBeGreaterThan(10);
      const read = await client.readResource({ uri: `kisbooks://company/${companyId}/chart-of-accounts` });
      expect(read.contents.length).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('answers GET and DELETE with 405: no stream, no session to end', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await http(method, '/mcp');
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('refuses a browser origin it does not know', async () => {
    const res = await mcp(null, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.json.error.data.code).toBe('ORIGIN_DENIED');
    // Claude's own origin, and no origin at all, get as far as authentication.
    expect((await mcp(null, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://claude.ai' })).status).toBe(401);
  });
});
