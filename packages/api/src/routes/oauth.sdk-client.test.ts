// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// The whole connector sign-in driven by the MCP SDK's own client, the code
// MCP clients are built on: it reads the 401, follows the discovery
// documents, registers itself, builds the PKCE authorization URL, exchanges
// the code and calls a tool with the token. Our tests elsewhere make these
// requests by hand; this one fails when the reference client disagrees with
// how we read the specification.
//
// The server's public URL has to be the address it listens on (a client
// refuses metadata that names another resource), so PUBLIC_URL is set before
// any module that reads the environment is loaded.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import net from 'net';
import type { Server } from 'http';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

let server: Server;
let base = '';
let sessionToken = '';
let companyId = '';
let cleanup: () => Promise<void> = async () => {};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** What a desktop MCP client keeps between steps of the sign-in. */
class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationFull | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authorizationUrl: URL | undefined;

  get redirectUrl() { return 'http://localhost:53999/callback'; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'SDK test client',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() { return this.info; }
  saveClientInformation(info: OAuthClientInformationFull) { this.info = info; }
  tokens() { return this.saved; }
  saveTokens(tokens: OAuthTokens) { this.saved = tokens; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { return this.verifier; }
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  process.env['PUBLIC_URL'] = base;

  const { default: express } = await import('express');
  const { sql, eq } = await import('drizzle-orm');
  const { db, pool } = await import('../db/index.js');
  const { companies, mcpConfig } = await import('../db/schema/index.js');
  const { env } = await import('../config/env.js');
  expect(env.PUBLIC_URL).toBe(base);
  const { errorHandler } = await import('../middleware/error-handler.js');
  const authService = await import('../services/auth.service.js');
  const { handleMcpMethodNotAllowed, handleMcpRequest } = await import('../mcp/server.js');
  const { oauthRouter, oauthWellKnownRouter } = await import('./oauth.routes.js');

  const clean = () => db.execute(sql`TRUNCATE
    audit_log, journal_lines, transactions, contacts, api_keys, mcp_request_log, sessions, user_tenant_access, mcp_config,
    oauth_tokens, oauth_authorization_codes, oauth_clients,
    accounts, companies, users, tenants
    CASCADE`);
  await clean();

  const app = express();
  app.use(express.json());
  app.use('/oauth', oauthRouter);
  app.use('/.well-known', oauthWellKnownRouter);
  app.post('/mcp', handleMcpRequest);
  app.use('/mcp', handleMcpMethodNotAllowed);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(port, '127.0.0.1', resolve); });

  const result = await authService.register({
    email: `sdk-oauth-${Date.now()}@example.com`, password: 'password123456', displayName: 'SDK Owner', companyName: 'SDK Co',
  });
  sessionToken = result.tokens.accessToken;
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, result.user.tenantId) });
  companyId = company!.id;
  await db.update(companies).set({ mcpEnabled: true }).where(eq(companies.id, companyId));
  await db.insert(mcpConfig).values({ isEnabled: true, oauthEnabled: true });

  cleanup = async () => {
    await new Promise((resolve) => server.close(resolve));
    await clean();
    await pool.end();
  };
}, 60000);

afterAll(async () => { await cleanup(); });

/** The browser's part: open the authorization URL, approve as the signed-in user, return the code. */
async function approveInBrowser(authorizationUrl: URL): Promise<string> {
  const start = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(start.status).toBe(302);
  const consent = new URL(start.headers.get('location')!);
  expect(consent.pathname).toBe('/oauth/consent');
  const approved = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ request: consent.searchParams.get('request') }),
  });
  expect(approved.status).toBe(200);
  const back = new URL(((await approved.json()) as { redirect_to: string }).redirect_to);
  expect(back.host).toBe('localhost:53999');
  return back.searchParams.get('code')!;
}

describe('The MCP SDK client signs in with OAuth and works', () => {
  it('discovers, registers, authorizes with PKCE, exchanges the code and calls tools', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js');

    const provider = new MemoryProvider();
    const url = new URL(`${base}/mcp`);

    // First contact: no token. The client follows the 401 to the metadata,
    // registers, and asks us to send the user to the authorization URL.
    const first = new StreamableHTTPClientTransport(url, { authProvider: provider });
    await expect(new Client({ name: 'sdk-oauth', version: '1.0.0' }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.info?.client_id).toMatch(/^kis_dyn_/);
    expect(provider.info?.token_endpoint_auth_method).toBe('none');
    const authorizationUrl = provider.authorizationUrl!;
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(`${base}/oauth/authorize`);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('resource')).toBe(`${base}/mcp`);

    const code = await approveInBrowser(authorizationUrl);
    await first.finishAuth(code);
    expect(provider.saved?.access_token).toMatch(/^kis_at_/);
    expect(provider.saved?.refresh_token).toMatch(/^kis_rt_/);

    // Signed in: a fresh connection works end to end.
    const client = new Client({ name: 'sdk-oauth', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(89);
      const listed = await client.callTool({ name: 'list_companies', arguments: {} });
      const content = listed.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0]!.text).map((c: { id: string }) => c.id)).toEqual([companyId]);
      const made = await client.callTool({ name: 'create_contact', arguments: { display_name: 'Made by the SDK client', type: 'customer' } });
      expect(made.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    // The access token lapses: the client refreshes by itself and carries on.
    const { db } = await import('../db/index.js');
    const { oauthTokens } = await import('../db/schema/index.js');
    await db.update(oauthTokens).set({ accessTokenExpiresAt: new Date(Date.now() - 1000) });
    const before = provider.saved!.access_token;
    const again = new Client({ name: 'sdk-oauth', version: '1.0.0' });
    await again.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
    try {
      expect((await again.listTools()).tools.length).toBeGreaterThanOrEqual(89);
      expect(provider.saved!.access_token).not.toBe(before);
    } finally {
      await again.close();
    }
  }, 60000);
});
