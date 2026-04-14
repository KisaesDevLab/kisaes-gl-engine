import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { authenticate } from '../middleware/auth.js';
import * as oauthService from '../services/oauth.service.js';
import { db } from '../db/index.js';
import { oauthClients } from '../db/schema/index.js';

export const oauthRouter = Router();

// GET /oauth/authorize — show consent screen (redirects to frontend)
oauthRouter.get('/authorize', async (req, res) => {
  const { client_id, redirect_uri, scope, state } = req.query;
  if (!client_id || typeof client_id !== 'string') { res.status(400).json({ error: 'client_id required' }); return; }
  if (!redirect_uri || typeof redirect_uri !== 'string') { res.status(400).json({ error: 'redirect_uri required' }); return; }

  // Validate the client_id corresponds to a real, active OAuth client and
  // that the supplied redirect_uri is in its registered allowlist. Without
  // this, the GET endpoint would forward phishing URLs (non-existent
  // client, attacker-controlled redirect) straight to the consent page
  // where a hurried user could approve. The POST /authorize also
  // re-validates, so this is defense-in-depth that catches the mistake
  // before the UI renders.
  const client = await db.query.oauthClients.findFirst({
    where: eq(oauthClients.clientId, client_id),
  });
  if (!client || !client.isActive) { res.status(400).json({ error: 'unknown_client' }); return; }
  const allowedUris = (client.redirectUris || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowedUris.includes(redirect_uri)) {
    res.status(400).json({ error: 'invalid_redirect_uri' });
    return;
  }

  // Sanitize state parameter (alphanumeric + common chars only)
  const safeState = String(state || '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 128);
  const frontendUrl = process.env['CORS_ORIGIN'] || 'http://localhost:5173';
  res.redirect(`${frontendUrl}/oauth/consent?client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(redirect_uri)}&scope=${encodeURIComponent(String(scope || 'all'))}&state=${encodeURIComponent(safeState)}`);
});

// POST /oauth/authorize — user approves (frontend calls this after consent)
oauthRouter.post('/authorize', authenticate, async (req, res) => {
  const { client_id, redirect_uri, scope } = req.body;
  const scopes = (scope || 'all').split(',');
  const code = await oauthService.createAuthorizationCode(client_id, req.userId, redirect_uri, scopes);
  res.json({ code, redirect_uri });
});

// POST /oauth/token — exchange code for tokens or refresh
oauthRouter.post('/token', async (req, res) => {
  const { grant_type, client_id, client_secret, code, redirect_uri, refresh_token } = req.body;

  if (grant_type === 'authorization_code') {
    const result = await oauthService.exchangeCode(client_id, client_secret, code, redirect_uri);
    res.json(result);
  } else if (grant_type === 'refresh_token') {
    const result = await oauthService.refreshAccessToken(client_id, client_secret, refresh_token);
    res.json(result);
  } else {
    res.status(400).json({ error: 'unsupported_grant_type' });
  }
});

// POST /oauth/revoke — revoke a token
oauthRouter.post('/revoke', async (req, res) => {
  await oauthService.revokeToken(req.body.token);
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
