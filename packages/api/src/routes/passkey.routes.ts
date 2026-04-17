// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth.js';
import * as passkeyService from '../services/passkey.service.js';
import { setRefreshCookie } from '../utils/refresh-cookie.js';

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: { message: 'Too many requests, please try again later', code: 'RATE_LIMIT' } },
});

export const passkeyRouter = Router();

// ─── Public (login flow — no auth required) ────────────────────

passkeyRouter.post('/login/options', authLimiter, async (req, res) => {
  const options = await passkeyService.getAuthenticationOptions(req.body.email);
  res.json(options);
});

passkeyRouter.post('/login/verify', authLimiter, async (req, res) => {
  const result = await passkeyService.verifyAuthentication(req.body);
  setRefreshCookie(res, result.tokens.refreshToken);
  res.json({
    user: result.user,
    tokens: { accessToken: result.tokens.accessToken },
    accessibleTenants: result.accessibleTenants,
  });
});

// ─── Protected (registration + management — auth required) ─────

passkeyRouter.post('/register/options', authenticate, async (req, res) => {
  const options = await passkeyService.getRegistrationOptions(req.userId);
  res.json(options);
});

passkeyRouter.post('/register/verify', authenticate, async (req, res) => {
  const { response, name } = req.body;
  const result = await passkeyService.verifyRegistration(req.userId, response, name);
  res.status(201).json(result);
});

passkeyRouter.get('/me', authenticate, async (req, res) => {
  const list = await passkeyService.listPasskeys(req.userId);
  res.json({ passkeys: list });
});

passkeyRouter.put('/me/:id', authenticate, async (req, res) => {
  const pk = await passkeyService.renamePasskey(req.userId, req.params['id']!, req.body.name);
  res.json(pk);
});

passkeyRouter.delete('/me/:id', authenticate, async (req, res) => {
  await passkeyService.removePasskey(req.userId, req.params['id']!);
  res.json({ removed: true });
});
