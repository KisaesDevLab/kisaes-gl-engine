// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// The OAuth endpoints behind the MCP connector sign-in (see
// services/oauth.service.ts for what each step enforces):
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   what /mcp accepts
//   GET  /.well-known/oauth-authorization-server       where to sign in
//   POST /oauth/register                               a connector registers itself
//   GET  /oauth/authorize                              -> the app's consent page
//   GET  /oauth/authorize/details                      what the consent page shows
//   POST /oauth/authorize                              the signed-in user's decision
//   POST /oauth/token                                  code or refresh token -> tokens
//
// All of it answers only while Admin > MCP / API has both MCP and OAuth
// sign-in turned on.

import express, { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth.js';
import * as oauthService from '../services/oauth.service.js';
import { OAuthError, AuthorizationRedirectError } from '../services/oauth.service.js';
import { db } from '../db/index.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';

export const oauthRouter = Router();
export const oauthWellKnownRouter = Router();

async function oauthIsOn(): Promise<boolean> {
  const config = await db.query.mcpConfig.findFirst();
  return !!config && config.isEnabled === true && config.oauthEnabled === true;
}

/** OAuth off: the discovery documents do not exist, so a client falls back to a key instead of a dead sign-in. */
async function requireOAuth(_req: Request, res: Response, next: NextFunction) {
  if (await oauthIsOn()) {
    next();
    return;
  }
  res.status(404).json({ error: 'not_found', error_description: 'OAuth sign-in is not enabled on this server' });
}

function sendOAuthError(res: Response, err: unknown): boolean {
  if (!(err instanceof OAuthError)) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.status(err.status).json({ error: err.error, error_description: err.message });
  return true;
}

// Discovery and the token endpoint are fetched by connector services from
// their own origin; they carry no cookies and no ambient credentials.
function openCors(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
}

// ─── Discovery ──────────────────────────────────────────────────

const protectedResource = (_req: Request, res: Response) => { res.json(oauthService.protectedResourceMetadata()); };
const authorizationServer = (_req: Request, res: Response) => { res.json(oauthService.authorizationServerMetadata()); };

oauthWellKnownRouter.use(openCors, requireOAuth);
// RFC 9728: the path-suffixed form is tried first; the 401 from /mcp names the root form.
oauthWellKnownRouter.get('/oauth-protected-resource', protectedResource);
oauthWellKnownRouter.get('/oauth-protected-resource/mcp', protectedResource);
// RFC 8414, and the OpenID spelling some clients try instead (and the only
// one reachable when the app is served under a path prefix).
oauthWellKnownRouter.get('/oauth-authorization-server', authorizationServer);
oauthWellKnownRouter.get('/openid-configuration', authorizationServer);

// ─── Registration ───────────────────────────────────────────────

// Anyone can call this before signing in, so it is bounded twice: per
// address here, and in total by the service (unused clients are swept).
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('oauth-register'),
  message: { error: 'temporarily_unavailable', error_description: 'Too many registrations from this address; try again later' },
});

oauthRouter.post('/register', openCors, requireOAuth, registerLimiter, async (req, res) => {
  try {
    const client = await oauthService.registerClient(req.body ?? {});
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(client);
  } catch (err) {
    if (!sendOAuthError(res, err)) throw err;
  }
});

// ─── Authorization ──────────────────────────────────────────────

// GET /oauth/authorize — check the request, then show the consent page.
oauthRouter.get('/authorize', requireOAuth, async (req, res) => {
  try {
    const request = await oauthService.validateAuthorizationRequest(req.query);
    // Everything the user is about to approve travels in one signed value;
    // the page reads what to display back from the server with it.
    const signed = oauthService.signAuthorizationRequest(request);
    res.redirect(`${oauthService.publicBaseUrl()}/oauth/consent?request=${encodeURIComponent(signed)}`);
  } catch (err) {
    if (err instanceof AuthorizationRedirectError) {
      res.redirect(oauthService.redirectWith(err.redirectUri, { error: err.error, error_description: err.message, state: err.state }));
      return;
    }
    // The client or its redirect URI is not one we know: never redirect
    // there. Without this check the endpoint would forward a phishing link
    // (attacker-controlled redirect) straight to the consent page.
    if (!sendOAuthError(res, err)) throw err;
  }
});

// GET /oauth/authorize/details — what the consent page shows for a request.
oauthRouter.get('/authorize/details', requireOAuth, async (req, res) => {
  try {
    res.json(await oauthService.describeAuthorizationRequest(req.query['request']));
  } catch (err) {
    if (!sendOAuthError(res, err)) throw err;
  }
});

// POST /oauth/authorize — the signed-in user approves or declines.
oauthRouter.post('/authorize', requireOAuth, authenticate, async (req, res) => {
  try {
    const request = oauthService.readAuthorizationRequest(req.body?.request);
    if (req.body?.approve === false) {
      res.json({
        redirect_to: oauthService.redirectWith(request.redirectUri, {
          error: 'access_denied', error_description: 'The user declined', state: request.state,
        }),
      });
      return;
    }
    const code = await oauthService.createAuthorizationCode(
      request.clientId, req.userId, request.redirectUri, request.scopes,
      { codeChallenge: request.codeChallenge, resource: request.resource },
    );
    res.json({
      code,
      redirect_uri: request.redirectUri,
      redirect_to: oauthService.redirectWith(request.redirectUri, { code, state: request.state }),
    });
  } catch (err) {
    if (!sendOAuthError(res, err)) throw err;
  }
});

// ─── Token ──────────────────────────────────────────────────────

/** `client_id:client_secret` from an Authorization: Basic header (RFC 6749 §2.3.1). */
function basicCredentials(req: Request): { clientId?: string; clientSecret?: string } {
  const header = req.headers.authorization;
  if (!header || !/^Basic\s+/i.test(header)) return {};
  const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return {};
  return { clientId: decodeURIComponent(decoded.slice(0, colon)), clientSecret: decodeURIComponent(decoded.slice(colon + 1)) };
}

// POST /oauth/token — exchange a code, or refresh. Form-encoded per RFC 6749; JSON is accepted too.
oauthRouter.post('/token', openCors, express.urlencoded({ extended: false, limit: '20kb' }), requireOAuth, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const basic = basicCredentials(req);
    const tokenRequest = {
      clientId: basic.clientId ?? body['client_id'],
      clientSecret: basic.clientSecret ?? body['client_secret'],
      code: body['code'],
      redirectUri: body['redirect_uri'],
      codeVerifier: body['code_verifier'],
      refreshToken: body['refresh_token'],
      resource: body['resource'],
    };
    let result;
    if (body['grant_type'] === 'authorization_code') {
      result = await oauthService.exchangeCode(tokenRequest);
    } else if (body['grant_type'] === 'refresh_token') {
      result = await oauthService.refreshAccessToken(tokenRequest);
    } else {
      throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    if (!sendOAuthError(res, err)) throw err;
  }
});

// POST /oauth/revoke — revoke a token (RFC 7009: always 200).
oauthRouter.post('/revoke', openCors, express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
  const token = (req.body ?? {})['token'];
  if (typeof token === 'string' && token) await oauthService.revokeToken(token);
  res.json({ revoked: true });
});

// User's authorized apps
oauthRouter.get('/apps', authenticate, async (req, res) => {
  const apps = await oauthService.getUserAuthorizedApps(req.userId);
  res.json({ apps });
});

oauthRouter.delete('/apps/:clientId', authenticate, async (req, res) => {
  await oauthService.revokeUserApp(req.userId, req.params['clientId']!);
  res.json({ revoked: true });
});
