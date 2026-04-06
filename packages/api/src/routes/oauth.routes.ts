import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import * as oauthService from '../services/oauth.service.js';

export const oauthRouter = Router();

// GET /oauth/authorize — show consent screen (redirects to frontend)
oauthRouter.get('/authorize', (req, res) => {
  const { client_id, redirect_uri, scope, state } = req.query;
  // Validate client_id and redirect_uri to prevent open redirect
  if (!client_id || typeof client_id !== 'string') { res.status(400).json({ error: 'client_id required' }); return; }
  if (!redirect_uri || typeof redirect_uri !== 'string') { res.status(400).json({ error: 'redirect_uri required' }); return; }
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
